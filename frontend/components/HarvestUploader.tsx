"use client";

/**
 * components/HarvestUploader.tsx
 * =============================================================================
 * Uploader + orkestrator job klasifikasi panen.
 *
 * PERBAIKAN
 * ---------
 * 1. KEBOCORAN INTERVAL. Versi lama memanggil `setInterval` di dalam handler
 *    klik tanpa pernah menyimpan handle-nya di ref/cleanup. Kalau komponen
 *    di-unmount (pindah tab!) saat job berjalan, interval terus hidup selamanya,
 *    memanggil `setState` pada komponen yang sudah mati dan membocorkan closure
 *    beserta seluruh objek File yang dirujuknya.
 * 2. DATA FIKTIF. Setelah 15 kali polling gagal, versi lama MEMBUAT hasil
 *    klasifikasi palsu ("SIAP PANEN", 7.8 ton) dan menyerahkannya ke UI seolah
 *    itu keluaran AI sungguhan. Untuk sistem pendukung keputusan panen ini
 *    berbahaya. Sekarang kegagalan dilaporkan apa adanya.
 * 3. Request dibatalkan lewat AbortController saat unmount, jadi tidak ada
 *    fetch yatim.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, type JobInfo, type ClassificationResult } from "@/lib/api";
import { UploadCloud, AlertTriangle, Loader2, FileImage, Sparkles } from "lucide-react";

const POLL_INTERVAL_MS = 2000;
/** Stitching ODM bisa lama; batasi total tunggu, jangan polling selamanya. */
const MAX_POLL_ATTEMPTS = 900; // ~30 menit

interface Props {
  onClassificationDone: (result: ClassificationResult) => void;
}

export function HarvestUploader({ onClassificationDone }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [threshold, setThreshold] = useState<number>(0.6);
  const [loading, setLoading] = useState<boolean>(false);
  const [jobStatus, setJobStatus] = useState<JobInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Dibatalkan saat unmount — mematikan polling DAN request yang menggantung. */
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setFiles(Array.from(e.target.files));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) setFiles(Array.from(e.dataTransfer.files));
  }, []);

  /** Sleep yang menghormati sinyal abort — pengganti setInterval yang bocor. */
  const delay = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    });

  const handleUploadAndAnalyze = useCallback(async () => {
    if (files.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setLoading(true);
    setErrorMsg(null);

    try {
      const job = await api.submitStitchJob(files, threshold, signal);
      if (signal.aborted) return;
      setJobStatus(job);

      // Loop polling sekuensial. Berbeda dari setInterval, loop ini tidak
      // pernah menumpuk request kalau backend lambat merespons.
      let attempts = 0;
      let consecutiveErrors = 0;

      while (!signal.aborted) {
        await delay(POLL_INTERVAL_MS, signal);
        attempts += 1;

        if (attempts > MAX_POLL_ATTEMPTS) {
          throw new Error(
            `Job belum selesai setelah ${Math.round(
              (MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60000
            )} menit. Periksa log NodeODM.`
          );
        }

        let status: JobInfo;
        try {
          status = await api.getJobStatus(job.job_id, signal);
          consecutiveErrors = 0;
        } catch (err) {
          if (signal.aborted) return;
          consecutiveErrors += 1;
          // Backend mungkin sedang restart — toleransi beberapa kegagalan,
          // tetapi JANGAN mengarang hasil kalau akhirnya menyerah.
          if (consecutiveErrors >= 10) {
            throw new Error(
              "Backend AI tidak merespons setelah 10 percobaan. Pastikan FastAPI & NodeODM berjalan."
            );
          }
          continue;
        }

        if (!mountedRef.current) return;
        setJobStatus(status);

        if (status.status === "completed") {
          const result = await api.classifyJob(job.job_id, threshold, signal);
          if (!mountedRef.current || signal.aborted) return;
          onClassificationDone(result);
          setLoading(false);
          return;
        }

        if (status.status === "failed") {
          throw new Error(status.message || status.error || "Pengolahan citra gagal di backend.");
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || !mountedRef.current) return;
      setErrorMsg(err?.message || "Gagal mengunggah foto drone.");
      setLoading(false);
    }
  }, [files, threshold, onClassificationDone]);

  return (
    <div className="glass-panel p-6 rounded-xl border flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-slate-700/50 pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold text-slate-100">AI Rice Harvest Image Classification</h3>
        </div>
        <span className="text-xs text-slate-400">FastAPI AI Engine</span>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className="border-2 border-dashed border-slate-700 hover:border-emerald-500/60 bg-slate-900/50 hover:bg-slate-900/80 rounded-xl p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-3"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,.jpg,.jpeg"
          onChange={handleFileChange}
          className="hidden"
        />
        <UploadCloud className="w-10 h-10 text-emerald-400" />
        <div>
          <p className="text-sm font-medium text-slate-200">
            Drag &amp; drop foto udara drone di sini
          </p>
          <p className="text-xs text-slate-400 mt-1">
            JPG/JPEG dengan EXIF GPS aktif — minimum 4 foto, overlap 70-80%
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-200 truncate">
            <FileImage className="w-4 h-4 text-cyan-400 flex-shrink-0" />
            <span className="truncate">
              {files.length} file dipilih: {files.map((f) => f.name).join(", ")}
            </span>
          </div>
          <button
            onClick={() => setFiles([])}
            disabled={loading}
            className="text-slate-400 hover:text-red-400 disabled:opacity-40 ml-2 text-xs"
          >
            Clear
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 pt-2">
        <div className="flex flex-col gap-1 flex-1">
          <div className="flex justify-between text-xs text-slate-300">
            <span>Ambang Siap Panen (Threshold)</span>
            <span className="font-semibold text-amber-400">{Math.round(threshold * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.3}
            max={0.9}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="accent-amber-500"
          />
        </div>

        <button
          onClick={handleUploadAndAnalyze}
          disabled={files.length < 4 || loading}
          title={files.length < 4 ? "Minimum 4 foto" : undefined}
          className="py-2.5 px-6 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold transition-all text-xs flex items-center gap-2 shadow-lg"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Processing AI...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" /> Jalankan Klasifikasi AI
            </>
          )}
        </button>
      </div>

      {jobStatus && (
        <div className="p-3 rounded-lg bg-slate-900 border border-slate-700/80 text-xs flex items-center gap-3">
          {loading && <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0" />}
          <div className="flex-1">
            <div className="flex justify-between text-slate-300 font-medium">
              <span>Job #{jobStatus.job_id?.slice(0, 8)}</span>
              <span className="uppercase text-amber-400">{jobStatus.status}</span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full mt-1.5 overflow-hidden">
              <div
                className="bg-amber-400 h-full transition-all duration-300"
                style={{ width: `${jobStatus.progress ?? 0}%` }}
              />
            </div>
            {jobStatus.message && (
              <div className="text-[10px] text-slate-400 mt-1">{jobStatus.message}</div>
            )}
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}
