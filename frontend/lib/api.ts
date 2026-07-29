/**
 * lib/api.ts
 * =============================================================================
 * Client FastAPI untuk klasifikasi panen padi & pemrosesan geospasial.
 *
 * Setiap fungsi menerima AbortSignal opsional supaya komponen bisa membatalkan
 * request saat unmount — tanpa itu, request yang menggantung akan menyelesaikan
 * promise-nya lalu memanggil setState pada komponen yang sudah mati.
 */

/** Status job HARUS cocok dengan yang dikirim backend (`api.py`). Versi lama
 *  mendeklarasikan "pending"|"processing" padahal backend mengirim
 *  "queued"|"running", jadi pengecekan status tidak pernah cocok. */
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobInfo {
  job_id: string;
  status: JobStatus;
  progress?: number;
  message?: string;
  created_at?: string;
  n_images?: number;
  orthophoto_path?: string | null;
  error?: string | null;
}

export interface ClassificationClass {
  name: string;
  pixels: number;
  /** null bila CRS orthophoto tidak terproyeksi — luas m² tak bisa dihitung. */
  area_m2: number | null;
  percentage: number;
  color?: string;
}

export interface ClassificationResult {
  job_id?: string | null;
  success?: boolean;
  status?: string;
  verdict: "SIAP PANEN" | "BELUM SIAP PANEN" | "UNKNOWN";
  threshold_used?: number;
  yellow_pct_of_rice?: number;
  green_pct_of_rice?: number;
  rice_pct_of_valid?: number;
  confidence_margin_pp?: number;
  n_pixels_valid?: number;
  n_pixels_rice?: number;
  n_pixels_yellow?: number;
  n_pixels_green?: number;
  summary?: {
    total_area_m2: number | null;
    harvest_ready_m2: number | null;
    harvest_ready_percentage: number;
    estimated_yield_tons?: number | null;
    pixel_area_m2?: number | null;
    area_available?: boolean;
  };
  classes?: ClassificationClass[];
  files?: Record<string, string>;
  visualization_url?: string;
  orthophoto_url?: string;
  bounds?: [number, number, number, number];
  bounds_wgs84?: [number, number, number, number];
  duration_seconds?: number;
}

const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://127.0.0.1:8000";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Di browser lewat rewrite Next.js (/api/ai/*) agar tidak kena CORS;
  // di server langsung ke FastAPI.
  const url = typeof window !== "undefined" ? `/api/ai${path}` : `${API_BASE}${path}`;

  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.detail || body?.message || detail;
    } catch {
      /* body bukan JSON — pakai statusText */
    }
    throw new Error(`API ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  getHealth: (signal?: AbortSignal) =>
    request<{ status: string; timestamp: string; active_jobs: number }>("/health", { signal }),

  submitStitchJob: (files: File[], threshold = 0.6, signal?: AbortSignal): Promise<JobInfo> => {
    const formData = new FormData();
    files.forEach((f) => formData.append("images", f));
    formData.append("threshold", threshold.toString());
    return request<JobInfo>("/jobs/stitch", { method: "POST", body: formData, signal });
  },

  getJobStatus: (jobId: string, signal?: AbortSignal): Promise<JobInfo> =>
    request<JobInfo>(`/jobs/${encodeURIComponent(jobId)}`, { signal }),

  classifyJob: (
    jobId: string,
    threshold = 0.6,
    signal?: AbortSignal
  ): Promise<ClassificationResult> =>
    request<ClassificationResult>(
      `/jobs/${encodeURIComponent(jobId)}/classify?threshold=${threshold}`,
      { method: "POST", signal }
    ),

  classifyDirect: (
    orthophotoPath: string,
    threshold = 0.6,
    signal?: AbortSignal
  ): Promise<ClassificationResult> =>
    request<ClassificationResult>("/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orthophoto_path: orthophotoPath, threshold }),
      signal,
    }),

  listResults: (signal?: AbortSignal): Promise<{ count: number; results: ClassificationResult[] }> =>
    request<{ count: number; results: ClassificationResult[] }>("/results", { signal }),

  /** URL file output. Kategori & nama file di-encode agar aman dipakai di <img>. */
  fileUrl: (kategori: string, filename: string): string =>
    `/api/ai/files/${encodeURIComponent(kategori)}/${encodeURIComponent(filename)}`,
};
