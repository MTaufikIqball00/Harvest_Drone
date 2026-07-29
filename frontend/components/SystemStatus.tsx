"use client";

import React, { useEffect, useState } from "react";
import { useVehicleState } from "@/lib/useRos";
import { Server, Wifi, Database, Cpu, Activity, CheckCircle2, XCircle } from "lucide-react";

interface StatusState {
  rosbridge: boolean;
  fastapi: boolean;
  mysql: boolean;
}

export function SystemStatus({ rosConnected }: { rosConnected: boolean }) {
  const [status, setStatus] = useState<StatusState>({
    rosbridge: rosConnected,
    fastapi: false,
    mysql: false,
  });

  // MAVROS dianggap hidup hanya kalau kita benar-benar menerima flight mode
  // darinya. Sebelumnya nilai xrceDds & mavros di-hardcode `true`, sehingga
  // panel selalu menampilkan "ONLINE" bahkan ketika autopilot mati total —
  // indikator kesehatan yang justru menyesatkan operator.
  const vehicle = useVehicleState();
  const mavrosLive = rosConnected && vehicle.flightMode !== "UNKNOWN";

  useEffect(() => {
    setStatus((prev) => ({ ...prev, rosbridge: rosConnected }));
  }, [rosConnected]);

  useEffect(() => {
    // AbortController + flag mounted: tanpa ini, respons fetch yang datang
    // setelah komponen di-unmount (pindah tab) memanggil setState pada
    // komponen mati — sumber warning React sekaligus kebocoran closure.
    const controller = new AbortController();
    let cancelled = false;

    const probe = async () => {
      const [fastapi, mysql] = await Promise.all([
        fetch("/api/ai/health", { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => data?.status === "ok")
          .catch(() => false),
        fetch("/api/missions", { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => Boolean(data?.success))
          .catch(() => false),
      ]);
      if (cancelled) return;
      setStatus((prev) => ({ ...prev, fastapi, mysql }));
    };

    probe();
    // Health check berkala supaya panel tidak membeku pada hasil pertama.
    const interval = setInterval(probe, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      controller.abort();
    };
  }, []);

  const items = [
    { name: "ROSBridge WebSocket", icon: Wifi, active: status.rosbridge, port: "9090", desc: "ROS 2 Topic & Service Gateway" },
    { name: "FastAPI AI Engine", icon: Server, active: status.fastapi, port: "8000", desc: "Rice Harvest & Geospatial REST API" },
    { name: "Dashboard Bridge Node", icon: Cpu, active: status.rosbridge, port: "—", desc: "Telemetry 20Hz & Command Services" },
    { name: "MAVROS / Autopilot", icon: Activity, active: mavrosLive, port: "14540", desc: `Flight mode: ${vehicle.flightMode}` },
    { name: "MySQL Database", icon: Database, active: status.mysql, port: "3306", desc: "Unified Telemetry & Mission Store" },
  ];

  return (
    <div className="glass-panel p-6 rounded-xl border flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-slate-700/50 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-400" />
          <h3 className="font-semibold text-slate-100">Dual Bridge & Subsystem Health Indicator</h3>
        </div>
        <span className="text-xs font-mono text-emerald-400">WSL2 Ubuntu 24.04 (UAV)</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {items.map((item, idx) => {
          const Icon = item.icon;
          return (
            <div
              key={idx}
              className={`p-3.5 rounded-xl border flex flex-col justify-between transition-all ${
                item.active
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-slate-900/60 border-slate-800 text-slate-400"
              }`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-4 h-4 ${item.active ? "text-emerald-400" : "text-slate-500"}`} />
                {item.active ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400" />
                )}
              </div>

              <div className="mt-3">
                <div className="font-bold text-xs text-slate-200">{item.name}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{item.desc}</div>
              </div>

              <div className="mt-2 pt-2 border-t border-slate-700/40 flex justify-between text-[10px] font-mono">
                <span className="text-slate-400">Port {item.port}</span>
                <span className={item.active ? "text-emerald-400 font-semibold" : "text-red-400"}>
                  {item.active ? "ONLINE" : "STANDBY"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
