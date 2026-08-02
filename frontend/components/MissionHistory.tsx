"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Database, RefreshCw } from "lucide-react";

export function MissionHistory() {
  const [data, setData] = useState<{ missions: any[]; telemetryLogs: any[]; harvestJobs: any[] }>({
    missions: [],
    telemetryLogs: [],
    harvestJobs: [],
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<"missions" | "telemetry" | "harvest">("missions");

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Simpan controller di ref supaya refresh berulang membatalkan request
  // sebelumnya, dan unmount membatalkan yang sedang berjalan.
  const abortRef = useRef<AbortController | null>(null);

  const fetchHistory = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/missions", { signal: controller.signal });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Query database gagal.");
      setData({
        missions: json.missions || [],
        telemetryLogs: json.telemetryLogs || [],
        harvestJobs: json.harvestJobs || [],
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      console.error("Gagal memuat riwayat misi:", e);
      setErrorMsg(e?.message || "Tidak bisa terhubung ke database.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    return () => abortRef.current?.abort();
  }, [fetchHistory]);

  return (
    <div className="glass-panel p-6 rounded-xl border flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-slate-700/50 pb-3">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-cyan-400" />
          <h3 className="font-semibold text-slate-100">MySQL Unified Mission & AI Telemetry Logs</h3>
        </div>
        <button
          onClick={fetchHistory}
          disabled={loading}
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all text-xs flex items-center gap-1"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
          {errorMsg}
        </div>
      )}

      {/* Sub Tabs */}
      <div className="flex border-b border-slate-700/50 gap-4 text-xs font-semibold text-slate-400">
        <button
          onClick={() => setActiveTab("missions")}
          className={`pb-2 transition-all ${activeTab === "missions" ? "text-cyan-400 border-b-2 border-cyan-400" : "hover:text-slate-200"}`}
        >
          Flight Missions ({data.missions.length})
        </button>
        <button
          onClick={() => setActiveTab("telemetry")}
          className={`pb-2 transition-all ${activeTab === "telemetry" ? "text-cyan-400 border-b-2 border-cyan-400" : "hover:text-slate-200"}`}
        >
          Live Telemetry Records ({data.telemetryLogs.length})
        </button>
        <button
          onClick={() => setActiveTab("harvest")}
          className={`pb-2 transition-all ${activeTab === "harvest" ? "text-cyan-400 border-b-2 border-cyan-400" : "hover:text-slate-200"}`}
        >
          AI Classification Jobs ({data.harvestJobs.length})
        </button>
      </div>

      {/* Table Content */}
      <div className="overflow-x-auto max-h-72">
        {activeTab === "missions" && (
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 uppercase text-[10px] text-slate-400 border-b border-slate-700">
              <tr>
                <th className="p-2">ID</th>
                <th className="p-2">Drone</th>
                <th className="p-2">Mode</th>
                <th className="p-2">Jarak ke Goal (m)</th>
                <th className="p-2">Status</th>
                <th className="p-2">Start Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.missions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-slate-500">Belum ada misi tercatat di database.</td>
                </tr>
              ) : (
                data.missions.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-800/40">
                    <td className="p-2 font-mono">#{m.id}</td>
                    <td className="p-2">{m.drone_name || "X500 SITL"}</td>
                    <td className="p-2 uppercase font-semibold text-cyan-300">{m.flight_mode}</td>
                    <td className="p-2 font-mono text-amber-300">
                      {typeof m.goal_distance_m === "number"
                        ? `${m.goal_distance_m.toFixed(1)} m`
                        : "—"}
                      {m.goal_distance_source && (
                        <span className="ml-1 text-[10px] text-slate-500 uppercase">
                          {m.goal_distance_source}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        {m.status}
                      </span>
                    </td>
                    <td className="p-2 font-mono text-slate-400">{new Date(m.start_time).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === "telemetry" && (
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 uppercase text-[10px] text-slate-400 border-b border-slate-700">
              <tr>
                <th className="p-2">Recorded At</th>
                <th className="p-2">X, Y, Z (m)</th>
                <th className="p-2">Speed (m/s)</th>
                <th className="p-2">Mode</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.telemetryLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-4 text-center text-slate-500">Belum ada log telemetri di database.</td>
                </tr>
              ) : (
                data.telemetryLogs.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-800/40">
                    <td className="p-2 font-mono text-slate-400">{new Date(t.recorded_at).toLocaleTimeString()}</td>
                    <td className="p-2 font-mono">{t.x?.toFixed(1)}, {t.y?.toFixed(1)}, {t.z?.toFixed(1)}</td>
                    <td className="p-2 font-mono text-emerald-300">{t.speed_mps?.toFixed(1) || 0}</td>
                    <td className="p-2 uppercase">{t.flight_mode}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === "harvest" && (
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 uppercase text-[10px] text-slate-400 border-b border-slate-700">
              <tr>
                <th className="p-2">Job ID</th>
                <th className="p-2">Status</th>
                <th className="p-2">Total Area (m²)</th>
                <th className="p-2">Est. Yield (Ton)</th>
                <th className="p-2">Created At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.harvestJobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-slate-500">Belum ada job klasifikasi AI tercatat.</td>
                </tr>
              ) : (
                data.harvestJobs.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-800/40">
                    <td className="p-2 font-mono">{j.id.slice(0, 8)}...</td>
                    <td className="p-2">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40">
                        {j.status}
                      </span>
                    </td>
                    <td className="p-2 font-mono">{j.total_area_m2 || 0}</td>
                    <td className="p-2 font-mono text-cyan-300">{j.estimated_yield_tons || 0}</td>
                    <td className="p-2 font-mono text-slate-400">{new Date(j.created_at).toLocaleDateString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
