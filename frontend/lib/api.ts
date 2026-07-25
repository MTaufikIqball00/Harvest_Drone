/**
 * lib/api.ts
 * FastAPI Backend AI Client for Rice Harvest Classification & Geospatial Processing.
 */

export interface JobInfo {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  message?: string;
  created_at?: string;
}

export interface ClassificationClass {
  name: string;
  pixels: number;
  area_m2: number;
  percentage: number;
  color?: string;
}

export interface ClassificationResult {
  job_id: string;
  status: string;
  threshold: number;
  verdict: "SIAP PANEN" | "BELUM SIAP PANEN" | "UNKNOWN";
  summary: {
    total_area_m2: number;
    harvest_ready_m2: number;
    harvest_ready_percentage: number;
    estimated_yield_tons?: number;
  };
  classes: ClassificationClass[];
  visualization_url?: string;
  orthophoto_url?: string;
  bounds?: [number, number, number, number]; // [min_lat, min_lon, max_lat, max_lon]
}

const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://127.0.0.1:8000";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = typeof window !== "undefined" ? `/api/ai${path}` : `${API_BASE}${path}`;

  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API Error ${res.status}: ${errText}`);
    }
    return (await res.json()) as T;
  } catch (err: any) {
    console.warn(`[FastAPI API Client Error] ${path}:`, err.message);
    throw err;
  }
}

export const api = {
  getHealth: () => request<{ status: string; version: string; environment: string }>("/health"),
  
  submitStitchJob: (files: File[], threshold: number = 0.60): Promise<JobInfo> => {
    const formData = new FormData();
    files.forEach((f) => formData.append("images", f));
    formData.append("threshold", threshold.toString());
    return request<JobInfo>("/jobs/stitch", {
      method: "POST",
      body: formData,
    });
  },

  getJobStatus: (jobId: string): Promise<JobInfo> => request<JobInfo>(`/jobs/${jobId}`),

  classifyJob: (jobId: string, threshold: number = 0.60): Promise<ClassificationResult> =>
    request<ClassificationResult>(`/jobs/${jobId}/classify?threshold=${threshold}`, { method: "POST" }),

  classifyDirect: (orthophotoPath: string, threshold: number = 0.60): Promise<ClassificationResult> =>
    request<ClassificationResult>("/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orthophoto_path: orthophotoPath, threshold }),
    }),

  listResults: (): Promise<{ results: ClassificationResult[] }> => request<{ results: ClassificationResult[] }>("/results"),

  fileUrl: (filename: string): string => `${API_BASE}/output/${filename}`,
};
