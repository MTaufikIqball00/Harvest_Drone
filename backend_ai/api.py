"""
api.py
======
FastAPI server untuk Sistem Deteksi Kesiapan Panen Padi.

Endpoints:
  GET   /                          → info API
  GET   /health                    → cek kesehatan service
  GET   /nodeodm/status            → cek NodeODM
  POST  /jobs/stitch               → upload foto + mulai stitching (async)
  GET   /jobs/{job_id}             → status job stitching
  WS    /ws/jobs/{job_id}          → progress realtime (pengganti polling)
  POST  /jobs/{job_id}/classify    → klasifikasi orthophoto hasil stitching
  POST  /classify                  → klasifikasi orthophoto langsung (skip stitching)
  GET   /files/{kategori}/{nama}   → serve file output (gambar, geotiff)
  GET   /results                   → list semua hasil yang pernah diproses

Jalankan:
    uvicorn api:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import gc
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from urllib.parse import urlparse

from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from services import stitching, classification

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent.resolve() / ".env")
    load_dotenv(Path(__file__).parent.parent.resolve() / ".env")
except ImportError:
    pass


# ============================================================================
# Konfigurasi
# ============================================================================
ROOT_DIR = Path(__file__).parent.resolve()
OUTPUT_DIR = ROOT_DIR / "output"
UPLOAD_DIR = OUTPUT_DIR / "uploads"
ORTHO_DIR = OUTPUT_DIR / "orthophoto"
CLASS_DIR = OUTPUT_DIR / "classification"
VIZ_DIR = OUTPUT_DIR / "visualization"
RESULT_DIR = OUTPUT_DIR / "results"
ORTHO_WEB_DIR = OUTPUT_DIR / "orthophoto_web"      # PNG RGBA untuk Leaflet
CLASS_WEB_DIR = OUTPUT_DIR / "classification_web"  # PNG overlay untuk Leaflet

for _d in (UPLOAD_DIR, ORTHO_DIR, CLASS_DIR, VIZ_DIR, RESULT_DIR, ORTHO_WEB_DIR, CLASS_WEB_DIR):
    _d.mkdir(parents=True, exist_ok=True)

CATEGORY_DIRS = {
    "orthophoto": ORTHO_DIR,
    "classification": CLASS_DIR,
    "visualization": VIZ_DIR,
    "results": RESULT_DIR,
    "orthophoto_web": ORTHO_WEB_DIR,
    "classification_web": CLASS_WEB_DIR,
}

# Upload ditulis per-chunk, bukan sekali baca ke memori. 1 MB adalah kompromi
# yang baik antara jumlah syscall dan jejak memori.
UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "200")) * 1024 * 1024
ALLOWED_UPLOAD_EXT = {".jpg", ".jpeg"}

# Job disimpan di memori; buang yang sudah selesai lebih dari TTL ini supaya
# proses uvicorn berumur panjang tidak terus menumpuk entri.
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", str(6 * 3600)))

# Klasifikasi memuat orthophoto penuh ke RAM (bisa >2 GB). Tanpa pembatas,
# beberapa request paralel akan meng-OOM mesin. Semaphore membatasi berapa
# banyak yang boleh berjalan bersamaan.
MAX_CONCURRENT_CLASSIFY = int(os.getenv("MAX_CONCURRENT_CLASSIFY", "2"))


def get_nodeodm_config() -> tuple[str, int, str]:
    """Baca URL dan kredensial NodeODM dari environment variables."""
    odm_url = os.getenv("ODM_NODE_URL", "http://localhost:3001")
    parsed = urlparse(odm_url)
    host = parsed.hostname or os.getenv("ODM_HOST", "localhost")
    port = parsed.port or int(os.getenv("ODM_PORT", "3001"))
    token = os.getenv("ODM_TOKEN", "")
    return host, port, token


def now_epoch_ms() -> int:
    """Unix epoch milliseconds — basis waktu yang sama dengan node ROS 2 & UI."""
    return int(time.time() * 1000)


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ============================================================================
# JOB STORE — thread-safe + broadcast progress
# ============================================================================
class JobStore:
    """Penyimpan job in-memory yang aman diakses lintas thread.

    Worker stitching berjalan di thread terpisah sementara route FastAPI
    berjalan di event loop. Versi lama memakai dict biasa tanpa kunci apa pun,
    jadi pembacaan bisa menangkap job dalam keadaan setengah ter-update.

    Kelas ini juga menyiarkan progress ke subscriber WebSocket memakai pola
    DROP-OLDEST: setiap subscriber punya antrian berkapasitas 1, dan kalau
    klien lambat membaca, update lama dibuang alih-alih menumpuk. Dengan begitu
    klien yang lambat tidak pernah membuat backlog memori di backend.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # ---------------- CRUD ----------------
    def create(self, job_id: str, payload: dict) -> dict:
        with self._lock:
            self._jobs[job_id] = payload
            return dict(payload)

    def get(self, job_id: str) -> Optional[dict]:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id: str, **fields: Any) -> Optional[dict]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.update(fields)
            snapshot = dict(job)
        self._broadcast(job_id, snapshot)
        return snapshot

    def counts(self) -> tuple[int, int]:
        with self._lock:
            running = sum(1 for j in self._jobs.values() if j["status"] == "running")
            return running, len(self._jobs)

    def purge_expired(self) -> int:
        """Buang job selesai/gagal yang sudah melewati TTL."""
        cutoff = time.time() - JOB_TTL_SECONDS
        removed = 0
        with self._lock:
            for job_id in [
                jid
                for jid, job in self._jobs.items()
                if job["status"] in ("completed", "failed")
                and job.get("finished_at", 0) < cutoff
            ]:
                self._jobs.pop(job_id, None)
                self._subscribers.pop(job_id, None)
                removed += 1
        return removed

    # ---------------- Pub/Sub ----------------
    def subscribe(self, job_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        with self._lock:
            self._subscribers.setdefault(job_id, set()).add(queue)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue) -> None:
        with self._lock:
            subs = self._subscribers.get(job_id)
            if subs:
                subs.discard(queue)
                if not subs:
                    self._subscribers.pop(job_id, None)

    def _broadcast(self, job_id: str, snapshot: dict) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with self._lock:
            queues = list(self._subscribers.get(job_id, ()))
        if not queues:
            return

        def _push() -> None:
            for queue in queues:
                # DROP-OLDEST: buang item lama supaya slot untuk yang terbaru
                # selalu tersedia. Antrian tidak pernah tumbuh, jadi klien
                # lambat tidak bisa menyebabkan kebocoran memori.
                if queue.full():
                    with suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                with suppress(asyncio.QueueFull):
                    queue.put_nowait(snapshot)

        # Dipanggil dari worker thread → harus lewat call_soon_threadsafe.
        loop.call_soon_threadsafe(_push)


JOBS = JobStore()


# ============================================================================
# Model Pydantic
# ============================================================================
class ClassifyRequest(BaseModel):
    """Request klasifikasi orthophoto yang sudah ada di server."""

    orthophoto_path: str = Field(..., description="Path file ortho.tif")
    threshold: float = Field(
        0.60, ge=0.01, le=0.99, description="Threshold siap panen 0.01-0.99"
    )


class JobInfo(BaseModel):
    """Informasi status job stitching."""

    job_id: str
    status: str = Field(..., description="queued | running | completed | failed")
    progress: int = Field(0, ge=0, le=100)
    message: str = ""
    created_at: str
    n_images: int = 0
    orthophoto_path: Optional[str] = None
    error: Optional[str] = None


# ============================================================================
# Lifespan — resource dibuat & dilepas eksplisit
# ============================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    JOBS.bind_loop(loop)

    # Executor terpisah untuk stitching. Job ODM berjalan 30 menit - 3 jam;
    # kalau memakai threadpool default anyio, job-job itu akan menghabiskan
    # worker thread yang juga dipakai SEMUA route sync lain sehingga API macet.
    app.state.stitch_executor = ThreadPoolExecutor(
        max_workers=int(os.getenv("MAX_CONCURRENT_STITCH", "2")),
        thread_name_prefix="stitch",
    )
    app.state.classify_semaphore = asyncio.Semaphore(MAX_CONCURRENT_CLASSIFY)

    stop_event = asyncio.Event()

    async def janitor() -> None:
        """Bersihkan job kedaluwarsa secara berkala."""
        while not stop_event.is_set():
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop_event.wait(), timeout=600)
            if stop_event.is_set():
                break
            removed = JOBS.purge_expired()
            if removed:
                print(f"[janitor] {removed} job kedaluwarsa dibersihkan.")

    janitor_task = asyncio.create_task(janitor())

    try:
        yield
    finally:
        stop_event.set()
        janitor_task.cancel()
        with suppress(asyncio.CancelledError):
            await janitor_task
        # wait=False: jangan menahan shutdown selama berjam-jam menunggu ODM.
        app.state.stitch_executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(
    title="Rice Harvest Classification API",
    description="Backend untuk Sistem Deteksi Kesiapan Panen Padi via UAV+HSV",
    version="1.1.0",
    lifespan=lifespan,
)

cors_origins_env = os.getenv("CORS_ORIGINS")
if cors_origins_env:
    allowed_origins = [o.strip() for o in cors_origins_env.split(",") if o.strip()]
else:
    allowed_origins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# ENDPOINTS — INFO
# ============================================================================
@app.get("/")
def root():
    return {
        "name": "Rice Harvest Classification API",
        "version": "1.1.0",
        "docs": "/docs",
        "endpoints": {
            "GET /health": "Cek kesehatan service",
            "GET /nodeodm/status": "Cek NodeODM",
            "POST /jobs/stitch": "Upload foto + mulai stitching",
            "GET /jobs/{job_id}": "Status job",
            "WS /ws/jobs/{job_id}": "Progress realtime (push, bukan polling)",
            "POST /jobs/{job_id}/classify": "Klasifikasi setelah stitching",
            "POST /classify": "Klasifikasi langsung (skip stitching)",
            "GET /files/{kat}/{nama}": "Serve file output",
            "GET /results": "List semua hasil",
        },
    }


@app.get("/health")
def health():
    running, total = JOBS.counts()
    return {
        "status": "ok",
        "timestamp": utc_iso(),
        "stamp_ms": now_epoch_ms(),
        "output_dir_exists": OUTPUT_DIR.exists(),
        "active_jobs": running,
        "total_jobs": total,
    }


@app.get("/nodeodm/status")
async def nodeodm_status():
    # cek_nodeodm() melakukan I/O jaringan yang memblokir; jalankan di
    # threadpool supaya event loop tetap melayani request lain.
    try:
        host, port, token = get_nodeodm_config()
        return await run_in_threadpool(stitching.cek_nodeodm, host=host, port=port, token=token)
    except stitching.StitchingError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ============================================================================
# ENDPOINTS — STITCHING JOB (async)
# ============================================================================
def _append_chunks(target: Path, chunks: list[bytes]) -> None:
    """Tambahkan chunk ke file. Dijalankan di threadpool, bukan di event loop."""
    with open(target, "ab") as f:
        for chunk in chunks:
            f.write(chunk)


async def _save_upload(img: UploadFile, target: Path) -> int:
    """Simpan satu upload secara streaming.

    Versi lama melakukan `content = await img.read()` (SELURUH file masuk RAM)
    lalu `open(...).write(content)` — penulisan disk yang MEMBLOKIR event loop.
    Dengan 100 foto drone @10 MB itu berarti 1 GB RAM plus event loop macet
    beberapa detik sehingga semua request lain (termasuk telemetry) tertunda.
    """
    total = 0
    buffer: list[bytes] = []
    # Truncate dulu: penulisan berikutnya memakai mode append, jadi sisa file
    # dari percobaan sebelumnya tidak boleh ikut terbawa.
    await run_in_threadpool(target.write_bytes, b"")
    while True:
        chunk = await img.read(UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File {img.filename} melebihi batas {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            )
        buffer.append(chunk)
        # Flush berkala supaya buffer tidak menyimpan seluruh file di memori.
        if len(buffer) >= 8:
            await run_in_threadpool(_append_chunks, target, buffer)
            buffer = []

    if buffer:
        await run_in_threadpool(_append_chunks, target, buffer)
    return total


@app.post("/jobs/stitch", response_model=JobInfo)
async def submit_stitch_job(
    images: list[UploadFile] = File(..., description="Foto drone JPG (min 4)"),
    threshold: float = 0.60,
):
    """Upload foto drone + jalankan stitching di background."""
    if len(images) < 4:
        raise HTTPException(status_code=400, detail=f"Minimum 4 foto, dapat {len(images)}")

    job_id = uuid.uuid4().hex[:12]
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)

    saved_paths: list[Path] = []
    for img in images:
        raw_name = Path(img.filename or "").name  # buang komponen direktori
        if not raw_name:
            raise HTTPException(status_code=400, detail="Nama file upload kosong.")
        if Path(raw_name).suffix.lower() not in ALLOWED_UPLOAD_EXT:
            raise HTTPException(
                status_code=400, detail=f"Hanya JPG/JPEG didukung, dapat: {raw_name}"
            )

        target = job_upload_dir / raw_name
        # Cegah traversal lewat nama file (mis. "..%2F..%2Fetc%2Fpasswd").
        if not target.resolve().is_relative_to(job_upload_dir.resolve()):
            raise HTTPException(status_code=400, detail=f"Nama file tidak valid: {raw_name}")

        written = await _save_upload(img, target)
        if written == 0:
            raise HTTPException(status_code=400, detail=f"File kosong: {raw_name}")
        saved_paths.append(target)

    JOBS.create(
        job_id,
        {
            "job_id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "Menunggu di antrian",
            "created_at": utc_iso(),
            "n_images": len(saved_paths),
            "threshold": threshold,
            "upload_dir": str(job_upload_dir),
            "orthophoto_path": None,
            "error": None,
            "finished_at": 0.0,
        },
    )

    # Dikirim ke executor khusus stitching, bukan BackgroundTasks. Dengan
    # BackgroundTasks, job berjam-jam menempati worker thread bersama yang juga
    # dipakai route lain.
    loop = asyncio.get_running_loop()
    loop.run_in_executor(app.state.stitch_executor, _run_stitch_job, job_id, saved_paths)

    job = JOBS.get(job_id)
    assert job is not None
    return JobInfo(**{k: v for k, v in job.items() if k in JobInfo.model_fields})


def _run_stitch_job(job_id: str, image_paths: list[Path]) -> None:
    """Worker stitching. Berjalan di thread executor, bukan di event loop."""
    JOBS.update(job_id, status="running", message="Stitching dimulai")

    def on_progress(pct: int, status: str) -> None:
        JOBS.update(job_id, progress=int(pct), message=str(status))

    try:
        host, port, token = get_nodeodm_config()
        ortho_path = stitching.stitch(
            image_paths=image_paths,
            output_dir=ORTHO_DIR / job_id,
            task_name=f"rice_paddy_{job_id}",
            host=host,
            port=port,
            token=token,
            progress_callback=on_progress,
        )
        JOBS.update(
            job_id,
            orthophoto_path=str(ortho_path),
            status="completed",
            progress=100,
            message="Stitching selesai",
            finished_at=time.time(),
        )
    except stitching.StitchingError as e:
        JOBS.update(
            job_id, status="failed", error=str(e), message=f"Gagal: {e}", finished_at=time.time()
        )
    except Exception as e:  # noqa: BLE001 - worker tidak boleh mematikan thread diam-diam
        message = f"Error tak terduga: {type(e).__name__}: {e}"
        JOBS.update(job_id, status="failed", error=message, message=message, finished_at=time.time())


@app.get("/jobs/{job_id}", response_model=JobInfo)
def get_job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} tidak ditemukan")
    return JobInfo(**{k: v for k, v in job.items() if k in JobInfo.model_fields})


@app.websocket("/ws/jobs/{job_id}")
async def job_progress_ws(websocket: WebSocket, job_id: str):
    """Push progress job secara realtime.

    Menggantikan polling HTTP 2 detik: latensi turun dari rata-rata ~1 detik ke
    ~0, dan beban request hilang sama sekali. Backpressure ditangani dengan
    antrian drop-oldest berkapasitas 1 (lihat JobStore._broadcast).
    """
    await websocket.accept()

    job = JOBS.get(job_id)
    if job is None:
        await websocket.send_json({"error": f"Job {job_id} tidak ditemukan"})
        await websocket.close(code=1008)
        return

    queue = JOBS.subscribe(job_id)
    try:
        await websocket.send_json(_ws_payload(job))
        if job["status"] in ("completed", "failed"):
            return

        while True:
            try:
                snapshot = await asyncio.wait_for(queue.get(), timeout=30)
            except asyncio.TimeoutError:
                # Ping berkala supaya proxy tidak memutus koneksi idle.
                await websocket.send_json({"type": "ping", "stamp_ms": now_epoch_ms()})
                continue

            await websocket.send_json(_ws_payload(snapshot))
            if snapshot["status"] in ("completed", "failed"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        # Cleanup wajib: tanpa ini setiap klien yang putus meninggalkan antrian
        # yatim yang terus menerima broadcast selamanya.
        JOBS.unsubscribe(job_id, queue)


def _ws_payload(job: dict) -> dict:
    return {
        "type": "job",
        "stamp_ms": now_epoch_ms(),
        "job_id": job["job_id"],
        "status": job["status"],
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "error": job.get("error"),
    }


# ============================================================================
# ENDPOINTS — CLASSIFICATION
# ============================================================================
@app.post("/jobs/{job_id}/classify")
async def classify_after_stitch(job_id: str, threshold: float = 0.60):
    """Klasifikasi orthophoto hasil stitching job tertentu."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} tidak ditemukan")
    if job["status"] != "completed":
        raise HTTPException(
            status_code=409, detail=f"Job belum selesai (status: {job['status']})"
        )

    ortho_path = job.get("orthophoto_path")
    if not ortho_path or not Path(ortho_path).exists():
        raise HTTPException(status_code=404, detail="Orthophoto tidak ada")

    return await _classify_guarded(Path(ortho_path), threshold, job_id=job_id)


@app.post("/classify")
async def classify_standalone(request: ClassifyRequest):
    """Klasifikasi orthophoto yang sudah di server (skip stitching)."""
    ortho_path = Path(request.orthophoto_path).resolve()

    # Batasi ke dalam ROOT_DIR: tanpa ini endpoint bisa dipakai untuk menguji
    # keberadaan file apa pun di filesystem lewat pesan error.
    if not ortho_path.is_relative_to(ROOT_DIR):
        raise HTTPException(
            status_code=400, detail="orthophoto_path harus berada di dalam direktori backend."
        )
    if not ortho_path.exists():
        raise HTTPException(status_code=404, detail=f"Orthophoto tidak ditemukan: {ortho_path}")

    return await _classify_guarded(ortho_path, request.threshold)


async def _classify_guarded(
    ortho_path: Path, threshold: float, job_id: Optional[str] = None
) -> dict:
    """Jalankan klasifikasi di threadpool dengan pembatas konkurensi.

    Pekerjaan OpenCV/rasterio bersifat CPU-bound dan blocking. Menjalankannya
    langsung di dalam `async def` akan membekukan event loop selama puluhan
    detik. `run_in_threadpool` memindahkannya keluar dari loop, dan semaphore
    menjaga agar tidak ada dua orthophoto raksasa di RAM sekaligus.
    """
    async with app.state.classify_semaphore:
        return await run_in_threadpool(_classify_orthophoto, ortho_path, threshold, job_id)


def _to_rel(p: Path) -> str:
    """Path relatif terhadap ROOT_DIR, fallback ke absolute kalau di luar."""
    try:
        return str(Path(p).resolve().relative_to(ROOT_DIR))
    except ValueError:
        return str(Path(p).resolve())


def _pixel_area_m2(ortho_data: dict) -> Optional[float]:
    """Luas satu piksel dalam m².

    Hanya valid kalau CRS terproyeksi (mis. UTM). Untuk CRS geografis satuannya
    derajat, dan mengalikannya menjadi "m²" akan menghasilkan angka yang salah
    total — lebih baik mengembalikan None daripada melaporkan luas palsu.
    """
    crs = ortho_data.get("crs")
    transform = ortho_data.get("transform")
    if crs is None or transform is None:
        return None
    try:
        if not getattr(crs, "is_projected", False):
            return None
        return abs(float(transform.a) * float(transform.e))
    except (AttributeError, TypeError, ValueError):
        return None


def _classify_orthophoto(
    ortho_path: Path, threshold: float, job_id: Optional[str] = None
) -> dict:
    """Pipeline klasifikasi. Dipanggil HANYA dari threadpool."""
    t_start = time.time()
    ortho_data: dict | None = None
    img_hsv = None
    masks: dict | None = None

    try:
        ortho_data = classification.load_orthophoto(ortho_path)
        img_hsv = classification.preprocess(ortho_data["rgb"])
        masks = classification.segment(img_hsv, ortho_data["mask_valid"])
        stats = classification.classify_verdict(
            masks["mask_yellow"],
            masks["mask_green"],
            ortho_data["mask_valid"],
            threshold=threshold,
        )

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = ortho_path.stem

        class_tif = CLASS_DIR / f"{stem}_class_{timestamp}.tif"
        classification.export_classification_geotiff(
            masks["mask_yellow"],
            masks["mask_green"],
            ortho_data["crs"],
            ortho_data["transform"],
            class_tif,
            verdict_text=stats["verdict"],
            yellow_pct=stats["yellow_pct_of_rice"],
        )

        ortho_web_png = ORTHO_WEB_DIR / f"{stem}_ortho_web_{timestamp}.png"
        _, bounds_wgs84 = classification.export_orthophoto_web_png(ortho_path, ortho_web_png)

        class_overlay_png = CLASS_WEB_DIR / f"{stem}_class_overlay_{timestamp}.png"
        classification.export_classification_overlay_png(
            masks["mask_yellow"], masks["mask_green"], class_overlay_png
        )

        png_path = VIZ_DIR / f"{stem}_map_{timestamp}.png"
        classification.export_visualization_png(
            ortho_data["rgb"], masks["mask_yellow"], masks["mask_green"], stats, png_path
        )

        # -------- Blok ringkasan untuk dashboard --------
        # Frontend mengharapkan `summary`, `classes`, dan URL overlay. Tanpa ini
        # panel hasil klasifikasi crash saat membaca `result.summary.*`.
        pixel_area = _pixel_area_m2(ortho_data)
        n_rice = stats["n_pixels_rice"]
        n_yellow = stats["n_pixels_yellow"]
        n_green = stats["n_pixels_green"]
        n_valid = stats["n_pixels_valid"]

        def area(pixels: int) -> Optional[float]:
            return round(pixels * pixel_area, 2) if pixel_area else None

        summary = {
            "total_area_m2": area(n_valid),
            "harvest_ready_m2": area(n_yellow),
            "harvest_ready_percentage": stats["yellow_pct_of_rice"],
            # Estimasi produktivitas GKP ~6 ton/ha untuk padi sawah irigasi.
            # Disertakan hanya kalau luas benar-benar bisa dihitung.
            "estimated_yield_tons": (
                round((area(n_yellow) or 0) / 10_000 * 6.0, 2) if pixel_area else None
            ),
            "pixel_area_m2": pixel_area,
            "area_available": pixel_area is not None,
        }

        classes = [
            {
                "name": "Padi Matang (Siap Panen)",
                "pixels": n_yellow,
                "area_m2": area(n_yellow),
                "percentage": stats["yellow_pct_of_rice"],
                "color": "#f59e0b",
            },
            {
                "name": "Padi Hijau (Belum Matang)",
                "pixels": n_green,
                "area_m2": area(n_green),
                "percentage": stats["green_pct_of_rice"],
                "color": "#10b981",
            },
            {
                "name": "Non-Padi (Air/Tanah/Lainnya)",
                "pixels": max(0, n_valid - n_rice),
                "area_m2": area(max(0, n_valid - n_rice)),
                "percentage": round(max(0.0, 100.0 - stats["rice_pct_of_valid"]), 2),
                "color": "#64748b",
            },
        ]

        result_json = RESULT_DIR / f"{stem}_result_{timestamp}.json"
        full_result = {
            "timestamp": timestamp,
            "stamp_ms": now_epoch_ms(),
            "job_id": job_id,
            "orthophoto_file": str(ortho_path),
            "orthophoto_width": ortho_data["width"],
            "orthophoto_height": ortho_data["height"],
            "crs": str(ortho_data["crs"]),
            "bounds": list(ortho_data["bounds"]),
            "bounds_wgs84": bounds_wgs84,
            **stats,
            "summary": summary,
            "classes": classes,
            "files": {
                "orthophoto": _to_rel(ortho_path),
                "classification": _to_rel(class_tif),
                "orthophoto_web_png": _to_rel(ortho_web_png),
                "classification_overlay_png": _to_rel(class_overlay_png),
                "visualization": _to_rel(png_path),
            },
            # URL siap pakai untuk Leaflet ImageOverlay di frontend.
            "orthophoto_url": f"/api/ai/files/orthophoto_web/{ortho_web_png.name}",
            "visualization_url": f"/api/ai/files/classification_web/{class_overlay_png.name}",
            "duration_seconds": round(time.time() - t_start, 2),
        }
        with open(result_json, "w", encoding="utf-8") as f:
            json.dump(full_result, f, ensure_ascii=False, indent=2)

        return {"success": True, **full_result}

    except classification.ClassificationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    finally:
        # Pelepasan memori eksplisit. Array orthophoto bisa ratusan MB sampai
        # beberapa GB; tanpa melepas referensi ini, memori baru dikembalikan
        # saat GC generasi tua berjalan — bisa lama sekali di worker yang sibuk.
        if masks is not None:
            masks.clear()
        if ortho_data is not None:
            ortho_data.clear()
        del img_hsv
        gc.collect()


# ============================================================================
# ENDPOINTS — FILES & RESULTS
# ============================================================================
@app.get("/files/{kategori}/{nama_file:path}")
def serve_file(kategori: str, nama_file: str):
    """Serve file output.

    KEAMANAN: versi lama menggabungkan `kategori_map[kategori] / nama_file`
    langsung dari input pengguna, sehingga `GET /files/orthophoto/../../../../etc/passwd`
    keluar dari direktori output (path traversal). Sekarang path hasil resolve
    diverifikasi harus berada di dalam direktori kategori.
    """
    base_dir = CATEGORY_DIRS.get(kategori)
    if base_dir is None:
        raise HTTPException(status_code=400, detail=f"Kategori tidak valid: {kategori}")

    base_resolved = base_dir.resolve()
    candidate = (base_dir / nama_file).resolve()

    if not candidate.is_relative_to(base_resolved):
        raise HTTPException(status_code=400, detail="Path file tidak valid.")

    if not candidate.is_file():
        # Pencarian rekursif hanya memakai nama dasar, jadi tidak bisa dipakai
        # untuk menembus keluar direktori.
        safe_name = Path(nama_file).name
        matches = [p for p in base_resolved.rglob(safe_name) if p.is_file()]
        if not matches:
            raise HTTPException(status_code=404, detail=f"File tidak ditemukan: {safe_name}")
        candidate = matches[0]

    return FileResponse(candidate)


@app.get("/results")
async def list_results():
    """List semua hasil klasifikasi yang pernah dibuat."""
    return await run_in_threadpool(_scan_results)


def _scan_results() -> dict:
    results = []
    errors = 0
    for json_file in sorted(RESULT_DIR.glob("*.json"), reverse=True):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            # Sebelumnya `except Exception: continue` menelan semua error tanpa
            # jejak, jadi file hasil yang korup mustahil didiagnosis.
            errors += 1
            print(f"[results] Lewati {json_file.name}: {type(e).__name__}: {e}")
            continue

        results.append(
            {
                "filename": json_file.name,
                "timestamp": data.get("timestamp"),
                "verdict": data.get("verdict"),
                "yellow_pct": data.get("yellow_pct_of_rice"),
                "threshold": data.get("threshold_used"),
                "visualization_url": data.get("visualization_url"),
            }
        )

    return {"count": len(results), "skipped": errors, "results": results}
