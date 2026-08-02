"use client";

/**
 * components/DroneController.tsx
 * =============================================================================
 * Panel komando penerbangan.
 *
 * PERBAIKAN UTAMA
 * ---------------
 * 1. KEY-REPEAT FLOOD. Handler keydown lama mengirim command pada SETIAP event
 *    keydown. Saat tombol ditahan, OS memancarkan auto-repeat ~30x/detik,
 *    jadi menahan "W" satu detik membanjiri rosbridge dengan 30 pesan. Sekarang
 *    tombol yang sedang ditahan dilacak di Set, dan vektor kecepatan dikirim
 *    pada rate tetap 10Hz lewat satu interval — persis seperti RC transmitter.
 * 2. STATE MENUMPUK. Efek `[waypoints]` menimpa input target setiap kali array
 *    waypoint berubah identitasnya, jadi angka yang sedang diketik pengguna
 *    tertimpa. Sekarang hanya disinkronkan saat koordinat benar-benar berubah.
 * 3. STATUS OPTIMISTIS. Tombol dulu langsung "berhasil". Sekarang setiap
 *    command menunggu ACK dari service ROS dan menampilkan hasil sebenarnya.
 * 4. Panel di-memo & membaca posisi realtime lewat selector store sendiri,
 *    jadi menekan tombol tidak me-render ulang peta dan sebaliknya.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Waypoint } from "@/lib/telemetryStore";
import type { ServiceAck } from "@/lib/rosClient";
import { useTelemetry, useVehicleState } from "@/lib/useRos";
import {
  Power,
  PlaneTakeoff,
  PlaneLanding,
  Home,
  Navigation,
  ShieldAlert,
  Zap,
  MapPin,
  Radio,
  Timer,
  Crosshair,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  RotateCw,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

/** Rate pengiriman kontrol manual. 10Hz = standar RC, cukup responsif tanpa
 *  membanjiri WebSocket maupun MAVROS. */
const MANUAL_CONTROL_HZ = 10;
const MANUAL_INTERVAL_MS = 1000 / MANUAL_CONTROL_HZ;

const KEY_BINDINGS: Record<string, { vx: number; vy: number; vz: number; yaw: number }> = {
  w: { vx: 1, vy: 0, vz: 0, yaw: 0 },
  s: { vx: -1, vy: 0, vz: 0, yaw: 0 },
  a: { vx: 0, vy: -1, vz: 0, yaw: 0 },
  d: { vx: 0, vy: 1, vz: 0, yaw: 0 },
  r: { vx: 0, vy: 0, vz: 0.5, yaw: 0 },
  f: { vx: 0, vy: 0, vz: -0.5, yaw: 0 },
  q: { vx: 0, vy: 0, vz: 0, yaw: -0.5 },
  e: { vx: 0, vy: 0, vz: 0, yaw: 0.5 },
};

interface Props {
  waypoints?: Waypoint[];
  connected: boolean;
  onArm: () => Promise<ServiceAck>;
  onDisarm: () => Promise<ServiceAck>;
  onTakeoff: (alt: number) => Promise<ServiceAck>;
  onLand: () => Promise<ServiceAck>;
  onRth: () => Promise<ServiceAck>;
  onForceArmTakeoff: () => Promise<ServiceAck>;
  onStartAutoSurvey: () => Promise<ServiceAck>;
  onEmergencyStop: () => Promise<ServiceAck>;
  onSendVelocity: (vx: number, vy: number, vz: number, yawRate: number) => boolean;
  /** Mengembalikan seq pengiriman (>= 1) bila berhasil, null bila gagal. */
  onSendWaypoints: (wps: Waypoint[]) => number | null;
  onClearWaypoints?: () => void;
}

/** Bar posisi realtime — satu-satunya bagian panel yang render pada rate telemetry. */
const LivePositionBar = React.memo(function LivePositionBar() {
  const telemetry = useTelemetry();
  return (
    <div className="grid grid-cols-3 gap-2 text-xs font-mono text-slate-300 bg-slate-950/80 p-2 rounded border border-slate-800/80 tabular-nums">
      <div>
        X: <span className="text-cyan-300 font-bold">{telemetry.x.toFixed(2)}</span>
      </div>
      <div>
        Y: <span className="text-cyan-300 font-bold">{telemetry.y.toFixed(2)}</span>
      </div>
      <div>
        Z: <span className="text-cyan-300 font-bold">{telemetry.alt.toFixed(2)}m</span>
      </div>
    </div>
  );
});

function DroneControllerImpl({
  waypoints = [],
  connected,
  onArm,
  onDisarm,
  onTakeoff,
  onLand,
  onRth,
  onForceArmTakeoff,
  onStartAutoSurvey,
  onEmergencyStop,
  onSendVelocity,
  onSendWaypoints,
  onClearWaypoints,
}: Props) {
  const vehicle = useVehicleState();

  // Default 1 m: aman untuk uji coba pertama drone asli (DJI Spark) sebelum
  // menaikkan target altitude setelah kontrol terbukti stabil.
  const [takeoffAlt, setTakeoffAlt] = useState<number>(1.0);
  const [targetX, setTargetX] = useState<string>("20.0");
  const [targetY, setTargetY] = useState<string>("15.0");
  const [targetZ, setTargetZ] = useState<string>("8.0");

  const [manualFlightTime, setManualFlightTime] = useState<number>(0);
  const [autoFlightTime, setAutoFlightTime] = useState<number>(0);
  const [activeKeys, setActiveKeys] = useState<string>("IDLE");
  const [pending, setPending] = useState<string | null>(null);
  const [ack, setAck] = useState<{ ok: boolean; text: string } | null>(null);

  const lastWp = waypoints.length > 0 ? waypoints[waypoints.length - 1] : null;

  // ---------------------------------------------------------------------------
  // Sinkronisasi waypoint -> input, hanya saat koordinatnya benar-benar berubah
  // ---------------------------------------------------------------------------
  const wpKey = lastWp ? `${lastWp.x}|${lastWp.y}|${lastWp.z}` : null;
  useEffect(() => {
    if (!wpKey) return;
    const [x, y, z] = wpKey.split("|");
    setTargetX(x);
    setTargetY(y);
    if (z && z !== "0") setTargetZ(z);
  }, [wpKey]);

  // ---------------------------------------------------------------------------
  // Timer penerbangan
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!vehicle.armed) return;
    const isManual = vehicle.navState === "manual";
    const interval = setInterval(() => {
      if (isManual) setManualFlightTime((prev) => prev + 1);
      else setAutoFlightTime((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [vehicle.armed, vehicle.navState]);

  // ---------------------------------------------------------------------------
  // Kontrol manual: keyboard ditahan -> pengiriman rate tetap
  // ---------------------------------------------------------------------------
  const heldKeys = useRef<Set<string>>(new Set());
  const manualTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendVelocityRef = useRef(onSendVelocity);
  sendVelocityRef.current = onSendVelocity;

  const stopManualLoop = useCallback(() => {
    if (manualTimer.current !== null) {
      clearInterval(manualTimer.current);
      manualTimer.current = null;
      // Kirim vektor nol sekali supaya drone berhenti, bukan melayang terus
      // dengan setpoint terakhir kalau operator melepas tombol.
      sendVelocityRef.current(0, 0, 0, 0);
    }
    setActiveKeys("IDLE");
  }, []);

  const startManualLoop = useCallback(() => {
    if (manualTimer.current !== null) return;
    manualTimer.current = setInterval(() => {
      const keys = heldKeys.current;
      if (keys.size === 0) {
        stopManualLoop();
        return;
      }
      let vx = 0;
      let vy = 0;
      let vz = 0;
      let yaw = 0;
      keys.forEach((key) => {
        const binding = KEY_BINDINGS[key];
        if (!binding) return;
        vx += binding.vx;
        vy += binding.vy;
        vz += binding.vz;
        yaw += binding.yaw;
      });
      sendVelocityRef.current(vx, vy, vz, yaw);
    }, MANUAL_INTERVAL_MS);
  }, [stopManualLoop]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
      const key = e.key.toLowerCase();
      if (!(key in KEY_BINDINGS)) return;
      e.preventDefault();
      // e.repeat = event auto-repeat OS. Diabaikan: status "ditahan" sudah
      // dilacak di Set, jadi tidak ada gunanya memproses ulang.
      if (e.repeat) return;
      heldKeys.current.add(key);
      setActiveKeys(Array.from(heldKeys.current).join("+").toUpperCase());
      startManualLoop();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!heldKeys.current.delete(key)) return;
      if (heldKeys.current.size === 0) stopManualLoop();
      else setActiveKeys(Array.from(heldKeys.current).join("+").toUpperCase());
    };

    // Kalau jendela kehilangan fokus saat tombol ditahan, keyup tidak pernah
    // sampai — drone akan terus bergerak. Blur wajib membersihkan state.
    const handleBlur = () => {
      heldKeys.current.clear();
      stopManualLoop();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      heldKeys.current.clear();
      if (manualTimer.current !== null) {
        clearInterval(manualTimer.current);
        manualTimer.current = null;
      }
    };
  }, [startManualLoop, stopManualLoop]);

  /** Tombol joystick sentuh memakai loop rate-limit yang sama. */
  const holdVector = useCallback(
    (key: string) => {
      heldKeys.current.add(key);
      setActiveKeys(Array.from(heldKeys.current).join("+").toUpperCase());
      startManualLoop();
    },
    [startManualLoop]
  );

  const releaseVector = useCallback(
    (key: string) => {
      heldKeys.current.delete(key);
      if (heldKeys.current.size === 0) stopManualLoop();
    },
    [stopManualLoop]
  );

  // ---------------------------------------------------------------------------
  // Command dengan ACK
  // ---------------------------------------------------------------------------
  const runCommand = useCallback(
    async (label: string, action: () => Promise<ServiceAck>) => {
      setPending(label);
      setAck(null);
      try {
        const result = await action();
        setAck({ ok: result.success, text: result.message || label });
      } catch (err: any) {
        setAck({ ok: false, text: err?.message || `${label} gagal.` });
      } finally {
        setPending(null);
      }
    },
    []
  );

  const handleSendPointToPointMission = useCallback(() => {
    const destX = parseFloat(targetX);
    const destY = parseFloat(targetY);
    const destZ = parseFloat(targetZ) || takeoffAlt;
    if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
      setAck({ ok: false, text: "Koordinat target tidak valid." });
      return;
    }
    const ok = onSendWaypoints([{ id: 1, x: destX, y: destY, z: destZ }]);
    setAck(
      ok
        ? { ok: true, text: "Waypoint terkirim, menunggu ACK node..." }
        : { ok: false, text: "Gagal mengirim: ROSBridge tidak terhubung." }
    );
  }, [targetX, targetY, targetZ, takeoffAlt, onSendWaypoints]);

  const formatTimer = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, []);

  const busy = pending !== null;
  const ackBanner = useMemo(() => {
    if (pending) {
      return (
        <div className="flex items-center gap-2 text-[11px] text-slate-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
          Menunggu ACK: {pending}...
        </div>
      );
    }
    if (!ack) return null;
    return (
      <div
        className={`flex items-center gap-2 text-[11px] ${
          ack.ok ? "text-emerald-300" : "text-red-300"
        }`}
      >
        {ack.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
        <span className="truncate">{ack.text}</span>
      </div>
    );
  }, [pending, ack]);

  return (
    <div className="glass-panel p-5 rounded-2xl border border-slate-700/60 shadow-xl flex flex-col gap-5 text-slate-200">
      {/* Header Status */}
      <div className="flex items-center justify-between border-b border-slate-700/50 pb-3">
        <div className="flex items-center gap-2.5">
          <Radio className="w-5 h-5 text-cyan-400" />
          <h3 className="font-bold text-slate-100 tracking-wide text-base">
            Drone Flight Command Center
          </h3>
        </div>
        <span
          className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
            vehicle.armed
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "bg-slate-700/60 text-slate-400 border border-slate-600"
          }`}
        >
          {vehicle.armed ? "● ARMED" : "○ DISARMED"}
        </span>
      </div>

      {/* Mode + ACK */}
      <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800 flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-400 font-medium">Flight Mode</span>
          <span className="font-mono font-bold text-cyan-300">{vehicle.flightMode}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-400 font-medium">Journey</span>
          <span className="font-mono text-emerald-300">{vehicle.journeyStatus}</span>
        </div>
        {ackBanner}
      </div>

      {/* Flight Timers */}
      <div className="grid grid-cols-2 gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-slate-400 font-medium">Manual</span>
          </div>
          <span className="text-sm font-mono font-bold text-amber-300 tabular-nums">
            {formatTimer(manualFlightTime)}
          </span>
        </div>
        <div className="flex items-center justify-between px-2 border-l border-slate-800">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4 text-cyan-400" />
            <span className="text-xs text-slate-400 font-medium">Auto</span>
          </div>
          <span className="text-sm font-mono font-bold text-cyan-300 tabular-nums">
            {formatTimer(autoFlightTime)}
          </span>
        </div>
      </div>

      {/* Primary Flight Controls */}
      <div className="flex flex-col gap-2.5">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Main Flight Controls
        </span>

        {/*
          DJI Spark (dan flight stack lain yang tidak punya konsep arm
          terpisah) mengirim armDisarmSupported=false lewat telemetry —
          lihat RosBridgeClient.java. Tombol disembunyikan sepenuhnya alih-
          alih dibuat no-op, supaya tidak menjanjikan perilaku yang tidak
          ada: DJI motor auto-nyala saat TAKEOFF, tidak ada langkah arm
          terpisah untuk ditekan operator.
        */}
        {vehicle.armDisarmSupported && (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={() => runCommand("ARM", onArm)}
              disabled={!connected || vehicle.armed || busy}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold transition-all shadow-md text-xs"
            >
              <Power className="w-4 h-4" /> ARM MOTORS
            </button>

            <button
              onClick={() => runCommand("DISARM", onDisarm)}
              disabled={!connected || busy}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-red-600/90 hover:bg-red-500 disabled:opacity-40 text-white font-semibold transition-all shadow-md text-xs"
            >
              <ShieldAlert className="w-4 h-4" /> DISARM / STOP
            </button>
          </div>
        )}

        {/* RTH tidak di-serve jembatan DJI (lihat RosBridgeClient.java) —
            grid menyesuaikan jadi 2 kolom saat tombol itu disembunyikan. */}
        <div className={`grid gap-2 ${vehicle.advancedFeaturesSupported ? "grid-cols-3" : "grid-cols-2"}`}>
          <button
            onClick={() => runCommand("TAKEOFF", () => onTakeoff(takeoffAlt))}
            disabled={!connected || busy}
            className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-medium text-xs transition-all"
          >
            <PlaneTakeoff className="w-4 h-4" /> Takeoff
          </button>

          <button
            onClick={() => runCommand("LAND", onLand)}
            disabled={!connected || busy}
            className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-medium text-xs transition-all"
          >
            <PlaneLanding className="w-4 h-4" /> Land
          </button>

          {vehicle.advancedFeaturesSupported && (
            <button
              onClick={() => runCommand("RTH", onRth)}
              disabled={!connected || busy}
              className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-medium text-xs transition-all"
            >
              <Home className="w-4 h-4" /> Return Home
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-400 whitespace-nowrap">Takeoff Alt (m)</label>
          <input
            type="number"
            min={1}
            max={50}
            step={0.5}
            value={takeoffAlt}
            onChange={(e) => setTakeoffAlt(Number(e.target.value) || 1)}
            className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
          />
          <span className="text-[10px] text-slate-500">Dikirim ke node sebelum takeoff</span>
        </div>

        {/* Force Arm+Takeoff, Auto Survey (boustrophedon/A*), dan Emergency
            Stop (LOITER) adalah fitur khusus ArduPilot/PX4 — tidak ada
            padanan yang di-serve jembatan DJI, jadi disembunyikan total
            alih-alih tampil lalu timeout. */}
        {vehicle.advancedFeaturesSupported && (
          <>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                onClick={() => runCommand("FORCE ARM + TAKEOFF", onForceArmTakeoff)}
                disabled={!connected || busy}
                className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-40 text-white font-bold text-xs shadow-lg transition-all border border-purple-400/30"
              >
                <Zap className="w-4 h-4 text-yellow-300 fill-yellow-300" /> Force Arm & Takeoff
              </button>

              <button
                onClick={() => runCommand("AUTO SURVEY", onStartAutoSurvey)}
                disabled={!connected || busy}
                className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 text-white font-bold text-xs shadow-lg transition-all border border-cyan-400/30"
              >
                <Navigation className="w-4 h-4 text-cyan-200" /> Auto Survey
              </button>
            </div>

            <button
              onClick={() => runCommand("EMERGENCY STOP", onEmergencyStop)}
              disabled={!connected}
              className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-red-900/70 hover:bg-red-800 disabled:opacity-40 text-red-100 font-bold text-xs border border-red-600/60 transition-all"
            >
              <ShieldAlert className="w-4 h-4" /> EMERGENCY STOP (LOITER)
            </button>
          </>
        )}
      </div>

      {/* Remote Manual Control */}
      <div className="pt-3 border-t border-slate-700/50 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Remote Manual Pilot ({MANUAL_CONTROL_HZ}Hz)
          </span>
          <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-cyan-400 font-mono">
            KEY: {activeKeys}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 bg-slate-900/80 p-3 rounded-xl border border-slate-800">
          {(
            [
              ["q", RotateCcw, "Yaw L [Q]", "text-amber-400"],
              ["w", ArrowUp, "Fwd [W]", "text-emerald-400"],
              ["e", RotateCw, "Yaw R [E]", "text-amber-400"],
              ["a", ArrowLeft, "Left [A]", "text-cyan-400"],
              [null, null, "STOP", "text-red-300"],
              ["d", ArrowRight, "Right [D]", "text-cyan-400"],
              ["f", ArrowDown, "Down [F]", "text-indigo-400"],
              ["s", ArrowDown, "Back [S]", "text-emerald-400"],
              ["r", ArrowUp, "Up [R]", "text-indigo-400"],
            ] as const
          ).map(([key, Icon, label, tone], idx) =>
            key === null ? (
              <button
                key={idx}
                disabled={!connected}
                onClick={() => {
                  heldKeys.current.clear();
                  stopManualLoop();
                }}
                className="flex items-center justify-center p-2 rounded-lg bg-red-900/60 hover:bg-red-800 disabled:opacity-40 text-red-200 font-bold text-xs border border-red-700/60"
              >
                {label}
              </button>
            ) : (
              <button
                key={idx}
                disabled={!connected}
                onMouseDown={() => holdVector(key)}
                onMouseUp={() => releaseVector(key)}
                onMouseLeave={() => releaseVector(key)}
                onTouchStart={() => holdVector(key)}
                onTouchEnd={() => releaseVector(key)}
                className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 text-xs font-medium border border-slate-700 select-none"
              >
                {Icon ? <Icon className={`w-3.5 h-3.5 mr-1 ${tone}`} /> : null} {label}
              </button>
            )
          )}
        </div>
      </div>

      {/* Point-to-Point Mission */}
      <div className="pt-3 border-t border-slate-700/50 flex flex-col gap-3">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Point-to-Point Mission Target
        </span>

        <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
            <MapPin className="w-3.5 h-3.5" /> Start Position (realtime)
          </div>
          <LivePositionBar />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-cyan-400 font-semibold">
              <Crosshair className="w-3.5 h-3.5" /> Destination Target
            </div>
            {lastWp && onClearWaypoints && (
              <button
                onClick={onClearWaypoints}
                className="text-[10px] text-amber-400 hover:text-red-400 underline"
              >
                Clear Target
              </button>
            )}
          </div>

          {lastWp && (
            <div
              className={`text-[10px] px-2 py-1 rounded border ${
                lastWp.rejected
                  ? "text-red-300 border-red-500/50 bg-red-500/10"
                  : lastWp.confirmed
                    ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
                    : "text-amber-300 border-amber-500/40 bg-amber-500/10"
              }`}
            >
              {lastWp.rejected ? (
                <>
                  {/* Alasan penolakan WAJIB ditampilkan. Sebelumnya pesan ini
                      hanya tersimpan di store tanpa pernah dirender, sehingga
                      penolakan tidak bisa dibedakan dari pesan yang hilang. */}
                  <div className="font-semibold">✕ Waypoint ditolak node</div>
                  <div className="opacity-90">
                    {vehicle.ackMessage || "Alasan tidak disertakan."}
                  </div>
                </>
              ) : lastWp.confirmed ? (
                `✓ Node mengonfirmasi ${waypoints.length} waypoint (seq ${vehicle.ackedSeq})`
              ) : (
                "⏳ Menunggu ACK dari node ROS — status belum dikonfirmasi"
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["Target X", targetX, setTargetX],
                ["Target Y", targetY, setTargetY],
                ["Target Alt (Z)", targetZ, setTargetZ],
              ] as const
            ).map(([label, value, setter]) => (
              <div key={label}>
                <label className="text-[10px] text-slate-400 block mb-1">{label}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
                />
              </div>
            ))}
          </div>

          <button
            onClick={handleSendPointToPointMission}
            disabled={!connected || busy}
            className="mt-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-bold text-xs shadow-lg transition-all"
          >
            <Navigation className="w-4 h-4" /> 🚀 Send Mission (Auto Start → Target)
          </button>
        </div>
      </div>
    </div>
  );
}

export const DroneController = React.memo(DroneControllerImpl);
