"use client";

import React from "react";
import type { ClassificationResult } from "@/lib/api";
import { CheckCircle2, AlertCircle, PieChart, BarChart3, Sprout, Scale } from "lucide-react";

interface Props {
  result: ClassificationResult | null;
}

export function ClassificationResults({ result }: Props) {
  if (!result) {
    return (
      <div className="glass-panel p-6 rounded-xl border flex flex-col items-center justify-center text-slate-500 h-64 text-sm">
        <PieChart className="w-10 h-10 text-slate-600 mb-2 stroke-1" />
        <p>Belum ada data hasil klasifikasi citra.</p>
        <p className="text-xs text-slate-600 mt-1">Unggah citra drone di panel atas untuk memulai analisis AI.</p>
      </div>
    );
  }

  const isSiap = result.verdict === "SIAP PANEN";

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
          {isSiap ? <CheckCircle2 className="w-7 h-7 text-amber-400" /> : <AlertCircle className="w-7 h-7 text-emerald-400" />}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider opacity-80">Keputusan AI Panen Padi</div>
            <div className="text-xl font-extrabold tracking-tight">{result.verdict}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold">{result.summary.harvest_ready_percentage}%</div>
          <div className="text-[10px] opacity-75">Cakupan Padi Matang</div>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/60">
          <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
            <Sprout className="w-3.5 h-3.5 text-emerald-400" /> Luas Total Lahan
          </div>
          <div className="text-lg font-bold text-slate-200 mt-1">
            {result.summary.total_area_m2.toLocaleString()} <span className="text-xs text-slate-400 font-normal">m²</span>
          </div>
          <div className="text-[10px] text-slate-500">{(result.summary.total_area_m2 / 10000).toFixed(2)} Hektar</div>
        </div>

        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/60">
          <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" /> Luas Siap Panen
          </div>
          <div className="text-lg font-bold text-amber-300 mt-1">
            {result.summary.harvest_ready_m2.toLocaleString()} <span className="text-xs text-slate-400 font-normal">m²</span>
          </div>
          <div className="text-[10px] text-slate-500">{result.summary.harvest_ready_percentage}% Dari total lahan</div>
        </div>

        <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/60">
          <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
            <Scale className="w-3.5 h-3.5 text-cyan-400" /> Estimasi Hasil Panen
          </div>
          <div className="text-lg font-bold text-cyan-300 mt-1">
            {result.summary.estimated_yield_tons || (result.summary.harvest_ready_m2 * 0.0006).toFixed(1)}{" "}
            <span className="text-xs text-slate-400 font-normal">Ton GKP</span>
          </div>
          <div className="text-[10px] text-slate-500">Gabah Kering Panen</div>
        </div>
      </div>

      {/* Class Breakdown Bars */}
      <div className="pt-2 border-t border-slate-700/50 flex flex-col gap-2">
        <div className="text-xs text-slate-300 font-semibold flex items-center gap-1.5">
          <BarChart3 className="w-4 h-4 text-emerald-400" /> Distribusi Kematangan Padi & Tutupan Lahan
        </div>

        <div className="flex flex-col gap-2.5 mt-1">
          {result.classes.map((cls, idx) => (
            <div key={idx} className="flex flex-col gap-1">
              <div className="flex justify-between text-xs text-slate-300">
                <span className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-sm inline-block"
                    style={{ backgroundColor: cls.color || "#10b981" }}
                  />
                  {cls.name}
                </span>
                <span className="font-mono text-slate-400">
                  {cls.area_m2.toLocaleString()} m² ({cls.percentage.toFixed(1)}%)
                </span>
              </div>
              <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${cls.percentage}%`,
                    backgroundColor: cls.color || "#10b981",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
