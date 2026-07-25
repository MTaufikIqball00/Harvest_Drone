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
  POST  /jobs/{job_id}/classify    → klasifikasi orthophoto hasil stitching
  POST  /classify                  → klasifikasi orthophoto langsung (skip stitching)
  GET   /files/{kategori}/{nama}   → serve file output (gambar, geotiff)
  GET   /results                   → list semua hasil yang pernah diproses

Jalankan:
    uvicorn api:app --host 0.0.0.0 --port 8000 --reload

Atau pakai script:
    start_api.bat
"""
from __future__ import annotations
import asyncio
import json
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from services import stitching, classification


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
ORTHO_WEB_DIR = OUTPUT_DIR / "orthophoto_web"   # PNG RGBA untuk Leaflet
CLASS_WEB_DIR = OUTPUT_DIR / "classification_web"  # PNG overlay untuk Leaflet

for d in (UPLOAD_DIR, ORTHO_DIR, CLASS_DIR, VIZ_DIR, RESULT_DIR, ORTHO_WEB_DIR, CLASS_WEB_DIR):
    d.mkdir(parents=True, exist_ok=True)

# In-memory job store (cukup untuk demo skripsi; production pakai Redis/DB)
JOBS: dict[str, dict] = {}


# ============================================================================
# Model Pydantic untuk request/response
# ============================================================================
class ClassifyRequest(BaseModel):
    """Request klasifikasi orthophoto yang sudah ada di server."""
    orthophoto_path: str = Field(..., description="Path file ortho.tif")
    threshold: float = Field(0.60, ge=0.01, le=0.99,
                             description="Threshold siap panen 0.01-0.99")


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


import os
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.resolve() / ".env")
    load_dotenv(Path(__file__).parent.parent.resolve() / ".env")
except ImportError:
    pass

# ============================================================================
# FastAPI app
# ============================================================================
app = FastAPI(
    title="Rice Harvest Classification API",
    description="Backend untuk Sistem Deteksi Kesiapan Panen Padi via UAV+HSV",
    version="1.0.0",
)

# CORS: izinkan Next.js dan origin dari .env jika dikonfigurasi
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
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "GET /health":                 "Cek kesehatan service",
            "GET /nodeodm/status":         "Cek NodeODM",
            "POST /jobs/stitch":           "Upload foto + mulai stitching",
            "GET /jobs/{job_id}":          "Status job",
            "POST /jobs/{job_id}/classify": "Klasifikasi setelah stitching",
            "POST /classify":              "Klasifikasi langsung (skip stitching)",
            "GET /files/{kat}/{nama}":     "Serve file output",
            "GET /results":                "List semua hasil",
        },
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "output_dir_exists": OUTPUT_DIR.exists(),
        "active_jobs": len([j for j in JOBS.values() if j["status"] == "running"]),
        "total_jobs": len(JOBS),
    }


@app.get("/nodeodm/status")
def nodeodm_status():
    try:
        return stitching.cek_nodeodm()
    except stitching.StitchingError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ============================================================================
# ENDPOINTS — STITCHING JOB (async)
# ============================================================================
@app.post("/jobs/stitch", response_model=JobInfo)
async def submit_stitch_job(
    background_tasks: BackgroundTasks,
    images: list[UploadFile] = File(..., description="Foto drone JPG (min 4)"),
    threshold: float = 0.60,
):
    """
    Upload foto drone + jalankan stitching di background.
    Klien polling GET /jobs/{job_id} untuk status.
    """
    if len(images) < 4:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum 4 foto, dapat {len(images)}",
        )

    # Buat job ID & folder upload terpisah per job
    job_id = uuid.uuid4().hex[:12]
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)

    # Simpan upload ke disk
    saved_paths = []
    for img in images:
        # Validasi ekstensi
        ext = Path(img.filename).suffix.lower()
        if ext not in {".jpg", ".jpeg"}:
            raise HTTPException(
                status_code=400,
                detail=f"Hanya JPG/JPEG didukung, dapat: {img.filename}",
            )

        # Cek ukuran file
        target = job_upload_dir / img.filename
        content = await img.read()
        if len(content) == 0:
            raise HTTPException(
                status_code=400,
                detail=f"File kosong: {img.filename}",
            )
        with open(target, "wb") as f:
            f.write(content)
        saved_paths.append(target)

    # Daftarkan job
    JOBS[job_id] = {
        "job_id": job_id,
        "status": "queued",
        "progress": 0,
        "message": "Menunggu di antrian",
        "created_at": datetime.now().isoformat(),
        "n_images": len(saved_paths),
        "threshold": threshold,
        "upload_dir": str(job_upload_dir),
        "orthophoto_path": None,
        "error": None,
    }

    # Dispatch ke background
    background_tasks.add_task(_run_stitch_job, job_id, saved_paths)

    return JobInfo(**JOBS[job_id])


def _run_stitch_job(job_id: str, image_paths: list[Path]):
    """Worker yang jalankan stitching di background thread."""
    job = JOBS[job_id]
    try:
        job["status"] = "running"
        job["message"] = "Stitching dimulai"

        def on_progress(pct, status):
            job["progress"] = pct
            job["message"] = status

        ortho_path = stitching.stitch(
            image_paths=image_paths,
            output_dir=ORTHO_DIR / job_id,
            task_name=f"rice_paddy_{job_id}",
            progress_callback=on_progress,
        )

        job["orthophoto_path"] = str(ortho_path)
        job["status"] = "completed"
        job["progress"] = 100
        job["message"] = "Stitching selesai"

    except stitching.StitchingError as e:
        job["status"] = "failed"
        job["error"] = str(e)
        job["message"] = f"Gagal: {e}"
    except Exception as e:
        job["status"] = "failed"
        job["error"] = f"Error tak terduga: {e}"
        job["message"] = job["error"]


@app.get("/jobs/{job_id}", response_model=JobInfo)
def get_job_status(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail=f"Job {job_id} tidak ditemukan")
    return JobInfo(**JOBS[job_id])


# ============================================================================
# ENDPOINTS — CLASSIFICATION
# ============================================================================
@app.post("/jobs/{job_id}/classify")
def classify_after_stitch(job_id: str, threshold: float = 0.60):
    """Klasifikasi orthophoto hasil stitching job tertentu."""
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail=f"Job {job_id} tidak ditemukan")

    job = JOBS[job_id]
    if job["status"] != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"Job belum selesai (status: {job['status']})",
        )

    ortho_path = job.get("orthophoto_path")
    if not ortho_path or not Path(ortho_path).exists():
        raise HTTPException(status_code=404, detail="Orthophoto tidak ada")

    return _classify_orthophoto(Path(ortho_path), threshold, job_id=job_id)


@app.post("/classify")
def classify_standalone(request: ClassifyRequest):
    """Klasifikasi orthophoto yang sudah di server (skip stitching)."""
    ortho_path = Path(request.orthophoto_path)
    if not ortho_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Orthophoto tidak ditemukan: {ortho_path}",
        )
    return _classify_orthophoto(ortho_path, request.threshold)


def _classify_orthophoto(ortho_path: Path, threshold: float,
                          job_id: Optional[str] = None) -> dict:
    """Fungsi internal: jalankan klasifikasi & ekspor."""
    t_start = time.time()

    # Normalisasi path: resolve agar absolute, lalu jadikan relative ke ROOT_DIR
    # untuk konsistensi response API
    def to_rel(p: Path) -> str:
        """Convert path ke relative dari ROOT_DIR, jika gagal pakai absolute."""
        try:
            return str(Path(p).resolve().relative_to(ROOT_DIR))
        except ValueError:
            # Path di luar ROOT_DIR — pakai absolute
            return str(Path(p).resolve())

    try:
        ortho_data = classification.load_orthophoto(ortho_path)
        img_hsv = classification.preprocess(ortho_data["rgb"])
        masks = classification.segment(img_hsv, ortho_data["mask_valid"])
        stats = classification.classify_verdict(
            masks["mask_yellow"], masks["mask_green"],
            ortho_data["mask_valid"], threshold=threshold,
        )

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = ortho_path.stem

        class_tif = CLASS_DIR / f"{stem}_class_{timestamp}.tif"
        classification.export_classification_geotiff(
            masks["mask_yellow"], masks["mask_green"],
            ortho_data["crs"], ortho_data["transform"],
            class_tif,
            verdict_text=stats["verdict"],
            yellow_pct=stats["yellow_pct_of_rice"],
        )

        # PNG RGBA orthophoto untuk Leaflet ImageOverlay (NoData = transparan)
        ortho_web_png = ORTHO_WEB_DIR / f"{stem}_ortho_web_{timestamp}.png"
        _, bounds_wgs84 = classification.export_orthophoto_web_png(ortho_path, ortho_web_png)

        # PNG RGBA overlay klasifikasi (kuning/hijau di atas transparan)
        class_overlay_png = CLASS_WEB_DIR / f"{stem}_class_overlay_{timestamp}.png"
        classification.export_classification_overlay_png(
            masks["mask_yellow"], masks["mask_green"], class_overlay_png,
        )

        png_path = VIZ_DIR / f"{stem}_map_{timestamp}.png"
        classification.export_visualization_png(
            ortho_data["rgb"], masks["mask_yellow"], masks["mask_green"],
            stats, png_path,
        )

        result_json = RESULT_DIR / f"{stem}_result_{timestamp}.json"
        full_result = {
            "timestamp": timestamp,
            "job_id": job_id,
            "orthophoto_file": str(ortho_path),
            "orthophoto_width": ortho_data["width"],
            "orthophoto_height": ortho_data["height"],
            "crs": str(ortho_data["crs"]),
            "bounds": list(ortho_data["bounds"]),
            "bounds_wgs84": bounds_wgs84,
            **stats,
            "files": {
                "orthophoto":                 to_rel(ortho_path),
                "classification":             to_rel(class_tif),
                "orthophoto_web_png":         to_rel(ortho_web_png),
                "classification_overlay_png": to_rel(class_overlay_png),
                "visualization":              to_rel(png_path),
            },
            "duration_seconds": round(time.time() - t_start, 2),
        }
        with open(result_json, "w", encoding="utf-8") as f:
            json.dump(full_result, f, ensure_ascii=False, indent=2)

        return {"success": True, **full_result}

    except classification.ClassificationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error: {e}")


# ============================================================================
# ENDPOINTS — FILES & RESULTS
# ============================================================================
@app.get("/files/{kategori}/{nama_file}")
def serve_file(kategori: str, nama_file: str):
    """Serve file output. Kategori: orthophoto, classification, visualization, results."""
    kategori_map = {
        "orthophoto":          ORTHO_DIR,
        "classification":      CLASS_DIR,
        "visualization":       VIZ_DIR,
        "results":             RESULT_DIR,
        "orthophoto_web":      ORTHO_WEB_DIR,
        "classification_web":  CLASS_WEB_DIR,
    }
    if kategori not in kategori_map:
        raise HTTPException(status_code=400, detail=f"Kategori tidak valid: {kategori}")

    file_path = kategori_map[kategori] / nama_file
    if not file_path.exists():
        # Coba scan recursive (untuk file dalam subfolder job_id)
        candidates = list(kategori_map[kategori].rglob(nama_file))
        if not candidates:
            raise HTTPException(status_code=404, detail=f"File tidak ditemukan: {nama_file}")
        file_path = candidates[0]

    return FileResponse(file_path)


@app.get("/results")
def list_results():
    """List semua hasil klasifikasi yang pernah dibuat."""
    results = []
    for json_file in sorted(RESULT_DIR.glob("*.json"), reverse=True):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            results.append({
                "filename": json_file.name,
                "timestamp": data.get("timestamp"),
                "verdict": data.get("verdict"),
                "yellow_pct": data.get("yellow_pct_of_rice"),
                "threshold": data.get("threshold_used"),
            })
        except Exception:
            continue
    return {"count": len(results), "results": results}
