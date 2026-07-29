"use client";

/**
 * app/page.tsx
 * =============================================================================
 * Shell dashboard.
 *
 * Perubahan arsitektur penting: halaman ini TIDAK LAGI menyimpan telemetry.
 * Sebelumnya `const { telemetry } = useRos()` berada di root pohon komponen,
 * jadi setiap pesan telemetry (20-50Hz) me-render ulang seluruh dashboard —
 * sidebar, tab, kedua peta, tabel riwayat, semuanya. Sekarang komponen yang
 * butuh telemetry berlangganan store secara langsung, sehingga render frekuensi
 * tinggi terkurung di dalam HUD dan bar posisi saja.
 *
 * Yang tersisa sebagai state di sini hanyalah state UI frekuensi rendah: tab
 * aktif dan hasil klasifikasi terakhir.
 */

import React, { useCallback, useMemo, useState } from "react";
import { useRos } from "@/lib/useRos";
import type { Waypoint } from "@/lib/telemetryStore";
import type { ClassificationResult } from "@/lib/api";
import { TelemetryPanel } from "@/components/TelemetryPanel";
import { DroneController } from "@/components/DroneController";
import { InteractiveMap } from "@/components/InteractiveMap";
import { GazeboMapView } from "@/components/GazeboMapView";
import { HarvestUploader } from "@/components/HarvestUploader";
import { ClassificationResults } from "@/components/ClassificationResults";
import { MissionHistory } from "@/components/MissionHistory";
import { SystemStatus } from "@/components/SystemStatus";
import {
  LayoutDashboard,
  MapPin,
  Sparkles,
  Database,
  Activity,
  ShieldCheck,
  Radio,
  Cpu,
} from "lucide-react";

type TabId = "overview" | "map" | "harvest" | "history" | "system";

const TABS: { id: TabId; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview & Control", Icon: LayoutDashboard },
  { id: "map", label: "Peta Leaflet & GIS", Icon: MapPin },
  { id: "harvest", label: "Klasifikasi Panen AI", Icon: Sparkles },
  { id: "history", label: "Mission Logs & MySQL", Icon: Database },
  { id: "system", label: "Dual Bridge Health", Icon: Activity },
];

const PHASE_LABEL: Record<string, string> = {
  idle: "ROSBRIDGE IDLE",
  connecting: "CONNECTING...",
  connected: "ROSBRIDGE WS ONLINE",
  reconnecting: "RECONNECTING...",
  failed: "ROSBRIDGE WS OFFLINE",
};

export default function Home() {
  const {
    connected,
    phase,
    waypoints,
    arm,
    disarm,
    takeoff,
    land,
    rth,
    emergencyStop,
    forceArmTakeoff,
    startAutoSurvey,
    sendVelocity,
    clearWaypoints,
    sendWaypoints,
  } = useRos();

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [classificationResult, setClassificationResult] = useState<ClassificationResult | null>(
    null
  );

  // Handler di-memo supaya identitasnya stabil — kalau tidak, React.memo pada
  // peta & panel kontrol tidak ada gunanya (prop baru tiap render).
  const handleSetTarget = useCallback(
    (wp: Waypoint | null) => {
      if (wp) sendWaypoints([wp]);
      else clearWaypoints();
    },
    [sendWaypoints, clearWaypoints]
  );

  const handleClassificationDone = useCallback(
    (res: ClassificationResult) => setClassificationResult(res),
    []
  );

  const visualizationUrl = classificationResult?.visualization_url;
  const statusLabel = PHASE_LABEL[phase] ?? PHASE_LABEL.failed;

  const sidebar = useMemo(
    () =>
      TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => setActiveTab(id)}
          className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
            activeTab === id
              ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-md"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
          }`}
        >
          <Icon className="w-4 h-4" /> {label}
        </button>
      )),
    [activeTab]
  );

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100 flex flex-col">
      <header className="glass-panel border-b border-slate-700/60 sticky top-0 z-[1100] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
            <Radio className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg tracking-tight text-white flex items-center gap-2">
              DRONE-STACK MONOREPO
              <span className="text-[10px] font-normal px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300">
                ROS 2 Jazzy + FastAPI AI
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Autonomous Drone Telemetry &amp; Rice Harvest Classification System
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel border border-slate-700">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                connected
                  ? "bg-emerald-400 shadow-[0_0_8px_#10b981]"
                  : phase === "reconnecting" || phase === "connecting"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-red-500"
              }`}
            />
            <span className="font-semibold text-slate-300">{statusLabel}</span>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-64 glass-panel border-r border-slate-700/60 p-4 flex-col justify-between hidden md:flex">
          <nav className="flex flex-col gap-1.5">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-3 mb-1">
              Navigasi Terpadu
            </div>
            {sidebar}
          </nav>

          <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-[10px] text-slate-400 flex flex-col gap-1">
            <div className="font-semibold text-slate-300 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Monorepo Status
            </div>
            <div>ROS 2 Jazzy • PX4 SITL</div>
            <div>FastAPI • MySQL</div>
          </div>
        </aside>

        <main className="flex-1 p-6 overflow-y-auto flex flex-col gap-6">
          {/* HUD berlangganan store sendiri — satu-satunya bagian yang render 20Hz. */}
          <TelemetryPanel />

          {activeTab === "overview" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 flex flex-col gap-6">
                <div>
                  <h2 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-emerald-400" /> 1. Peta Simulasi Gazebo
                  </h2>
                  <GazeboMapView
                    waypoints={waypoints}
                    connected={connected}
                    onSetTargetWaypoint={handleSetTarget}
                    onClearWaypoints={clearWaypoints}
                  />
                </div>

                <div>
                  <h2 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-cyan-400" /> 2. Peta Asli (Satellite &amp; GIS)
                  </h2>
                  <InteractiveMap
                    waypoints={waypoints}
                    classificationUrl={visualizationUrl}
                    onSetTargetWaypoint={handleSetTarget}
                    onClearWaypoints={clearWaypoints}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-6">
                <DroneController
                  waypoints={waypoints}
                  connected={connected}
                  onArm={arm}
                  onDisarm={disarm}
                  onTakeoff={takeoff}
                  onLand={land}
                  onRth={rth}
                  onForceArmTakeoff={forceArmTakeoff}
                  onStartAutoSurvey={startAutoSurvey}
                  onEmergencyStop={emergencyStop}
                  onSendVelocity={sendVelocity}
                  onSendWaypoints={sendWaypoints}
                  onClearWaypoints={clearWaypoints}
                />
              </div>
            </div>
          )}

          {activeTab === "map" && (
            <InteractiveMap classificationUrl={visualizationUrl} hideTargetOverlay />
          )}

          {activeTab === "harvest" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <HarvestUploader onClassificationDone={handleClassificationDone} />
              <ClassificationResults result={classificationResult} />
            </div>
          )}

          {activeTab === "history" && <MissionHistory />}

          {activeTab === "system" && <SystemStatus rosConnected={connected} />}
        </main>
      </div>
    </div>
  );
}
