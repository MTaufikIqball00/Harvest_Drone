"use client";

import React, { useState } from "react";
import { useRos } from "@/lib/useRos";
import type { ClassificationResult } from "@/lib/api";
import { TelemetryPanel } from "@/components/TelemetryPanel";
import { DroneController } from "@/components/DroneController";
import { InteractiveMap } from "@/components/InteractiveMap";
import { GazeboMapView } from "@/components/GazeboMapView";
import { HarvestUploader } from "@/components/HarvestUploader";
import { ClassificationResults } from "@/components/ClassificationResults";
import { MissionHistory } from "@/components/MissionHistory";
import { SystemStatus } from "@/components/SystemStatus";
import { LayoutDashboard, MapPin, Sparkles, Database, Activity, ShieldCheck, Radio, Cpu } from "lucide-react";

export default function Home() {
  const {
    connected,
    connecting,
    telemetry,
    waypoints,
    flightPath,
    arm,
    disarm,
    takeoff,
    land,
    rth,
    setFlightMode,
    addWaypoint,
    clearWaypoints,
    sendWaypoints,
    sendCommand,
  } = useRos("ws://localhost:9090");

  const [activeTab, setActiveTab] = useState<"overview" | "map" | "harvest" | "history" | "system">("overview");
  const [classificationResult, setClassificationResult] = useState<ClassificationResult | null>(null);

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100 flex flex-col">
      {/* Top Navbar */}
      <header className="glass-panel border-b border-slate-700/60 sticky top-0 z-[1100] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
            <Radio className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg tracking-tight text-white flex items-center gap-2">
              DRONE-STACK MONOREPO
              <span className="text-[10px] font-normal px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300">
                ROS 2 Jazzy + FastAPI AI
              </span>
            </h1>
            <p className="text-xs text-slate-400">Autonomous Drone Telemetry & Rice Harvest Classification System</p>
          </div>
        </div>

        {/* Top Connection Indicator */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel border border-slate-700">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                connected ? "bg-emerald-400 shadow-[0_0_8px_#10b981]" : "bg-red-500 animate-ping"
              }`}
            />
            <span className="font-semibold text-slate-300">
              {connecting ? "CONNECTING..." : connected ? "ROSBRIDGE WS ONLINE" : "ROSBRIDGE WS OFFLINE"}
            </span>
          </div>
        </div>
      </header>

      {/* Main Container with Sidebar + Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Navigation Sidebar */}
        <aside className="w-64 glass-panel border-r border-slate-700/60 p-4 flex flex-col justify-between hidden md:flex">
          <nav className="flex flex-col gap-1.5">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-3 mb-1">
              Navigasi Terpadu
            </div>

            <button
              onClick={() => setActiveTab("overview")}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "overview"
                  ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-md"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <LayoutDashboard className="w-4 h-4" /> Overview & Control
            </button>

            <button
              onClick={() => setActiveTab("map")}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "map"
                  ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-md"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <MapPin className="w-4 h-4" /> Peta Leaflet & GIS
            </button>

            <button
              onClick={() => setActiveTab("harvest")}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "harvest"
                  ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-md"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <Sparkles className="w-4 h-4" /> Klasifikasi Panen AI
            </button>

            <button
              onClick={() => setActiveTab("history")}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "history"
                  ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-md"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <Database className="w-4 h-4" /> Mission Logs & MySQL
            </button>

            <button
              onClick={() => setActiveTab("system")}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "system"
                  ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-md"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <Activity className="w-4 h-4" /> Dual Bridge Health
            </button>
          </nav>

          <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-[10px] text-slate-400 flex flex-col gap-1">
            <div className="font-semibold text-slate-300 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Monorepo Status
            </div>
            <div>ROS 2 Jazzy • PX4 SITL</div>
            <div>FastAPI • MySQL</div>
          </div>
        </aside>

        {/* Content Area */}
        <main className="flex-1 p-6 overflow-y-auto flex flex-col gap-6">
          {/* Top Telemetry Strip */}
          <TelemetryPanel telemetry={telemetry} connected={connected} />

          {/* Active Tab View */}
          {activeTab === "overview" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 flex flex-col gap-6">
                {/* 1. Urutan Pertama: PETA SIMULASI GAZEBO */}
                <div>
                  <h2 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-emerald-400" /> 1. Peta Simulasi Gazebo (Canvas 2D World with Fields & Grid)
                  </h2>
                  <GazeboMapView
                    telemetry={telemetry}
                    waypoints={waypoints}
                    flightPath={flightPath}
                    connected={connected}
                    onSetTargetWaypoint={(wp) => (wp ? sendWaypoints([wp]) : clearWaypoints())}
                    onClearWaypoints={clearWaypoints}
                  />
                </div>

                {/* 2. Urutan Kedua: PETA ASLI */}
                <div>
                  <h2 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-cyan-400" /> 2. Peta Asli (Real Satellite & GIS Overlay Map)
                  </h2>
                  <InteractiveMap
                    telemetry={telemetry}
                    waypoints={waypoints}
                    flightPath={flightPath}
                    classificationUrl={classificationResult?.visualization_url}
                    onSetTargetWaypoint={(wp) => (wp ? sendWaypoints([wp]) : clearWaypoints())}
                    onClearWaypoints={clearWaypoints}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-6">
                <DroneController
                  telemetry={telemetry}
                  waypoints={waypoints}
                  connected={connected}
                  onArm={arm}
                  onDisarm={disarm}
                  onTakeoff={takeoff}
                  onLand={land}
                  onRth={rth}
                  onSetFlightMode={setFlightMode}
                  onSendWaypoints={sendWaypoints}
                  onSendCommand={sendCommand}
                  onClearWaypoints={clearWaypoints}
                />
              </div>
            </div>
          )}

          {activeTab === "map" && (
            <InteractiveMap
              telemetry={telemetry}
              flightPath={flightPath}
              classificationUrl={classificationResult?.visualization_url}
              hideTargetOverlay={true}
            />
          )}

          {activeTab === "harvest" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <HarvestUploader onClassificationDone={(res) => setClassificationResult(res)} />
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
