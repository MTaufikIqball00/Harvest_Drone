"use client";

/**
 * components/ClassificationResults.tsx
 * =============================================================================
 * Panel hasil klasifikasi AI.
 *
 * PERBAIKAN: versi lama mengakses `result.summary.harvest_ready_percentage` dan
 * `result.classes.map(...)` tanpa pengecekan, padahal backend TIDAK PERNAH
 * mengirim field itu — respons `/classify` hanya berisi statistik piksel.
 * Begitu klasifikasi sungguhan selesai, komponen ini melempar
 * "Cannot read properties of undefined". Backend kini mengirim blok `summary`
 * dan `classes`, dan komponen ini tetap defensif kalau field-nya kosong.
 *
 * Luas (m²) hanya ditampilkan bila CRS orthophoto terproyeksi. Untuk CRS
 * geografis, backend mengirim null dan di sini kita menampilkan jumlah piksel —
 * lebih baik daripada menampilkan angka luas yang salah.
 */

import React from "react";
import type { ClassificationResult } from "@/lib/api";
import { CheckCircle2, AlertCircle, PieChart, BarChart3, Sprout, Scale, Info } from "lucide-react";

interface Props {
  result: ClassificationResult | null;
}

const nf = new Intl.NumberFormat("id-ID");

function formatArea(area: number | null | undefined, pixels?: number): string {
  if (typeof area === "number" && Number.isFinite(area)) return `${nf.format(Math.round(area))} m²`;
  if (typeof pixels === "number") return `${nf.format(pixels)} px`;
  return "—";
}

export function ClassificationResults({ result }: Props) {
  if (!result) {
    return (
      <div className="glass-panel p-6 rounded-xl border flex flex-col items-center justify-center text-slate-500 h-64 text-sm">
        <PieChart className="w-10 h-10 text-slate-600 mb-2 stroke-1" />
        <p>Belum ada data hasil klasifikasi citra.</p>
        <p className="text-xs text-slate-600 mt-1">
          Unggah citra drone di panel atas untuk memulai analisis AI.
        </p>
      </div>
    );
  }

  const isSiap = result.verdict === "SIAP PANEN";
  const summary = result.summary;
  const classes = result.classes ?? [];
  const areaAvailable = Boolean(summary?.total_area_m2);
  const readyPct = summary?.harvest_ready_percentage ?? result.yellow_pct_of_rice ?? 0;

  return (
    <div className="glass-panel p-6 rounded-xl border flex flex-col gap-4">
      {/* Verdict Banner */}
      <div
        className={`p-4 rounded-xl border flex items-center justify-between ${
          isSiap
            ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
            : "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
        }`}
      >
        <div className="flex items-center gap-3">
          {isSiap ? (
            <CheckCircle2 className="w-7 h-7 text-amber-400" />
          ) : (
            <AlertCircle className="w-7 h-7 text-emerald-400" />
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider opacity-80">
              Keputusan AI Panen Padi
            </div>
            <div className="text-xl font-extrabold tracking-tight">{result.verdict}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums">{readyPct.toFixed(1)}%</div>
          <div className="text-[10px] opacity-75">Padi matang dari total padi</div>
        </div>
      </div>

      {!areaAvailable && (
        <div className="flex items-start gap-2 text-[11px] text-slate-400 bg-slate-900/60 border border-slate-700/60 rounded-lg p-2.5">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-cyan-400" />
          <span>
            Luas dalam m² tidak dapat dihitung karena CRS orthophoto tidak terproyeksi. Nilai
            ditampilkan dalam jumlah piksel.
          </span>
        </div>
      )}

      {/* Summary Metrics */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/60">
          <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
            <Sprout className="w-3.5 h-3.5 text-emerald-400" /> Luas Total Valid
          </div>
          <div className="text-lg font-bold text-slate-200 mt-1 tabular-nums">
            {formatArea(summary?.total_area_m2, result.n_pixels_valid)}
          </div>
          {areaAvailable && summary?.total_area_m2 && (
            <div className="text-[10px] text-slate-500">
              {(summary.total_area_m2 / 10000).toFixed(2)} Hektar
            </div>
          )}
        </div>

        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/60">
          <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" /> Luas Siap Panen
          </div>
          <div className="text-lg font-bold text-amber-300 mt-1 tabular-nums">
            {formatArea(summary?.harvest_ready_m2, result.n_pixels_yellow)}
          </div>
          <div className="text-[10px] text-slate-500 tabular-nums">
            {readyPct.toFixed(1)}% dari area padi
          </div>
        </div>

        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/60">
          <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
            <Scale className="w-3.5 h-3.5 text-cyan-400" /> Estimasi Hasil
          </div>
          <div className="text-lg font-bold text-cyan-300 mt-1 tabular-nums">
            {typeof summary?.estimated_yield_tons === "number"
              ? `${summary.estimated_yield_tons.toFixed(1)} `
              : "— "}
            <span className="text-xs text-slate-400 font-normal">Ton GKP</span>
          </div>
          <div className="text-[10px] text-slate-500">Asumsi 6 ton/ha</div>
        </div>
      </div>

      {/* Class Breakdown Bars */}
      {classes.length > 0 && (
        <div className="pt-2 border-t border-slate-700/50 flex flex-col gap-2">
          <div className="text-xs text-slate-300 font-semibold flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-emerald-400" /> Distribusi Kematangan &amp; Tutupan
            Lahan
          </div>

          <div className="flex flex-col gap-2.5 mt-1">
            {classes.map((cls, idx) => {
              const pct = Number.isFinite(cls.percentage) ? cls.percentage : 0;
              return (
                <div key={`${cls.name}-${idx}`} className="flex flex-col gap-1">
                  <div className="flex justify-between text-xs text-slate-300">
                    <span className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-sm inline-block"
                        style={{ backgroundColor: cls.color || "#10b981" }}
                      />
                      {cls.name}
                    </span>
                    <span className="font-mono text-slate-400 tabular-nums">
                      {formatArea(cls.area_m2, cls.pixels)} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, Math.max(0, pct))}%`,
                        backgroundColor: cls.color || "#10b981",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {typeof result.duration_seconds === "number" && (
        <div className="text-[10px] text-slate-500 text-right">
          Diproses dalam {result.duration_seconds.toFixed(1)} detik
        </div>
      )}
    </div>
  );
}
