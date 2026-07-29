"use client";

/**
 * lib/useRos.ts
 * =============================================================================
 * Hook penghubung dashboard <-> ROS 2 bridge.
 *
 * PERBAIKAN DESINKRONISASI PALING KRITIS
 * --------------------------------------
 * Versi sebelumnya berbicara dengan protokol yang TIDAK ADA:
 *
 *   Dashboard lama          | Node ROS 2 sebenarnya
 *   ------------------------|-----------------------------------------
 *   sub  /drone/telemetry   | pub  /dashboard/telemetry, /dashboard/state
 *   sub  /drone/pose        | pub  /odom
 *   pub  /drone/cmd (JSON)  | service /arm /takeoff /land /return_home ...
 *                           | sub  /cmd_vel, /dashboard/goal_pose
 *
 * Tidak ada satu pun topik yang cocok. Akibatnya dashboard selamanya
 * menampilkan telemetry default (baterai 100%, altitude 0) dan SETIAP tombol
 * kontrol tidak berefek apa pun ke drone — pesan diterbitkan ke topik yang
 * tidak pernah didengarkan siapa pun. Modul ini memakai protokol yang benar.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_ROSBRIDGE_URL,
  getRosClient,
  type ConnectionPhase,
  type ServiceAck,
} from "./rosClient";
import {
  DEFAULT_TELEMETRY,
  telemetryStore,
  type TelemetryData,
  type TrailPoint,
  type VehicleState,
  type Waypoint,
} from "./telemetryStore";

export type { TelemetryData, Waypoint, TrailPoint, VehicleState };

const TRIGGER = "std_srvs/srv/Trigger";

// -----------------------------------------------------------------------------
// Selector hooks — komponen hanya berlangganan slice yang dibutuhkannya
// -----------------------------------------------------------------------------

/** Telemetry frekuensi tinggi, sudah dibatasi ke ~20Hz oleh store. */
export function useTelemetry(): TelemetryData {
  return useSyncExternalStore(
    telemetryStore.subscribeTelemetry,
    telemetryStore.getTelemetrySnapshot,
    () => DEFAULT_TELEMETRY
  );
}

/** State kendaraan frekuensi rendah — hanya berubah saat nilainya berubah. */
export function useVehicleState(): VehicleState {
  return useSyncExternalStore(
    telemetryStore.subscribeVehicle,
    telemetryStore.getVehicleSnapshot,
    telemetryStore.getVehicleSnapshot
  );
}

/** Jejak terbang. Terpisah supaya HUD tidak ikut render saat trail bertambah. */
export function useFlightTrail(): TrailPoint[] {
  return useSyncExternalStore(
    telemetryStore.subscribeTrail,
    telemetryStore.getTrailSnapshot,
    () => [] as TrailPoint[]
  );
}

// -----------------------------------------------------------------------------
// Hook utama
// -----------------------------------------------------------------------------
export function useRos(wsUrl: string = DEFAULT_ROSBRIDGE_URL) {
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [lastAck, setLastAck] = useState<ServiceAck | null>(null);

  const clientRef = useRef<ReturnType<typeof getRosClient> | null>(null);
  const seqRef = useRef(0);
  /** Waypoint yang menunggu ACK; disimpan di ref agar tidak memicu render. */
  const pendingWaypointsRef = useRef<{ seq: number; list: Waypoint[] } | null>(null);

  const vehicle = useVehicleState();

  // ---------------------------------------------------------------------------
  // Koneksi, subscription, dan resync
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const client = getRosClient(wsUrl);
    clientRef.current = client;
    setPhase(client.phase);

    const unsubPhase = client.onPhaseChange((next) => {
      setPhase(next);
      if (next !== "connected") telemetryStore.resetForDisconnect();
    });

    // Telemetry padat 20Hz dari node — satu pesan, satu parse.
    const unsubTelemetry = client.subscribe(
      "/dashboard/telemetry",
      "std_msgs/msg/String",
      (message: any) => {
        try {
          const data = JSON.parse(message.data);
          telemetryStore.ingestTelemetry({
            x: data.x,
            y: data.y,
            z: data.z,
            alt: data.alt,
            vx: data.vx,
            vy: data.vy,
            vz: data.vz,
            speed: data.speed,
            yaw: data.yaw,
            heading: data.heading,
            battery: data.battery ?? undefined,
            voltage: data.voltage,
            armed: data.armed,
            flightMode: data.flightMode,
            navState: data.navState,
            stampMs: data.stamp_ms,
          });
        } catch (err) {
          console.warn("[useRos] Payload telemetry tidak bisa diparse:", err);
        }
      }
    );

    // State 2Hz: mode, home, goal, journey status, dan event ACK.
    const unsubState = client.subscribe(
      "/dashboard/state",
      "std_msgs/msg/String",
      (message: any) => {
        try {
          const payload = JSON.parse(message.data);
          if (payload && typeof payload.event === "string") {
            telemetryStore.ingestEvent(payload);
          } else {
            telemetryStore.ingestState(payload);
          }
        } catch (err) {
          console.warn("[useRos] Payload state tidak bisa diparse:", err);
        }
      }
    );

    // FULL STATE RESYNCHRONIZATION.
    // Setiap kali socket pulih, minta node menerbitkan snapshot lengkap segera
    // agar UI tidak menampilkan state basi selama menunggu tick periodik.
    const unsubReconnect = client.onReconnect(() => {
      client
        .callService("/dashboard/resync", TRIGGER, {}, 4000)
        .then((ack) => {
          if (!ack.success) {
            console.warn("[useRos] Resync ditolak node:", ack.message);
            return;
          }
          try {
            telemetryStore.ingestState(JSON.parse(ack.message));
          } catch {
            /* node membalas pesan teks biasa — abaikan */
          }
        })
        .catch((err) => console.warn("[useRos] Resync gagal:", err));
    });

    return () => {
      unsubPhase();
      unsubTelemetry();
      unsubState();
      unsubReconnect();
      telemetryStore.dispose();
      // Client sengaja TIDAK di-dispose: ia singleton per URL dan dipakai
      // ulang antar-navigasi, jadi tidak perlu handshake WebSocket baru.
    };
  }, [wsUrl]);

  // ---------------------------------------------------------------------------
  // Rekonsiliasi ACK waypoint
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const pending = pendingWaypointsRef.current;
    if (!pending || vehicle.ackedSeq !== pending.seq) return;
    // Node mengonfirmasi seq ini — baru sekarang UI menandai waypoint valid.
    pendingWaypointsRef.current = null;
    setWaypoints(pending.list.map((wp) => ({ ...wp, confirmed: true })));
  }, [vehicle.ackedSeq]);

  // ---------------------------------------------------------------------------
  // Command helpers
  // ---------------------------------------------------------------------------
  const callTrigger = useCallback(async (service: string): Promise<ServiceAck> => {
    const client = clientRef.current;
    if (!client) return { success: false, message: "Client ROS belum siap." };
    const ack = await client.callService(service, TRIGGER);
    setLastAck(ack);
    if (!ack.success) console.warn(`[useRos] ${service} ditolak:`, ack.message);
    return ack;
  }, []);

  const arm = useCallback(() => callTrigger("/arm"), [callTrigger]);
  const disarm = useCallback(() => callTrigger("/disarm"), [callTrigger]);
  const land = useCallback(() => callTrigger("/land"), [callTrigger]);
  const rth = useCallback(() => callTrigger("/return_home"), [callTrigger]);
  const emergencyStop = useCallback(() => callTrigger("/emergency_stop"), [callTrigger]);
  const startAutoSurvey = useCallback(() => callTrigger("/start_auto_survey"), [callTrigger]);
  const startOrbitMission = useCallback(() => callTrigger("/start_orbit_mission"), [callTrigger]);
  const forceArmTakeoff = useCallback(() => callTrigger("/force_arm_takeoff"), [callTrigger]);

  /** Takeoff. Altitude dikirim lebih dulu supaya node memakai nilai dari UI. */
  const takeoff = useCallback(
    async (altitude: number = 8.0): Promise<ServiceAck> => {
      const client = clientRef.current;
      if (!client) return { success: false, message: "Client ROS belum siap." };
      client.publish("/dashboard/takeoff_altitude", "std_msgs/msg/Float32", {
        data: Number(altitude) || 8.0,
      });
      return callTrigger("/takeoff");
    },
    [callTrigger]
  );

  /** Kontrol manual berbasis kecepatan lewat /cmd_vel. */
  const sendVelocity = useCallback(
    (vx: number, vy: number, vz: number, yawRate: number): boolean => {
      const client = clientRef.current;
      if (!client) return false;
      return client.publish("/cmd_vel", "geometry_msgs/msg/Twist", {
        linear: { x: vx, y: vy, z: vz },
        angular: { x: 0, y: 0, z: yawRate },
      });
    },
    []
  );

  /** Kirim satu target tunggal ke planner A* node. */
  const setGoal = useCallback((wp: Waypoint): boolean => {
    const client = clientRef.current;
    if (!client) return false;
    const ok = client.publish("/dashboard/goal_pose", "geometry_msgs/msg/PoseStamped", {
      header: { frame_id: "map", stamp: { sec: 0, nanosec: 0 } },
      pose: {
        position: { x: wp.x, y: wp.y, z: wp.z },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    if (ok) setWaypoints([{ ...wp, confirmed: false }]);
    return ok;
  }, []);

  /**
   * Kirim daftar waypoint dengan pola ACK.
   *
   * UI TIDAK langsung menandai waypoint sebagai aktif. Ia menyimpan seq di ref,
   * dan status baru diperbarui setelah node membalas "waypoints_ack" dengan seq
   * yang sama (lihat efek rekonsiliasi di atas). Kalau node menolak, UI tetap
   * menampilkan status pending, bukan berbohong bahwa misi sudah terkirim.
   */
  const sendWaypoints = useCallback((wpList: Waypoint[]): boolean => {
    const client = clientRef.current;
    if (!client || wpList.length === 0) return false;

    const seq = ++seqRef.current;
    const ok = client.publish("/dashboard/waypoints", "std_msgs/msg/String", {
      data: JSON.stringify({
        seq,
        waypoints: wpList.map((wp) => ({ x: wp.x, y: wp.y, z: wp.z })),
      }),
    });

    if (ok) {
      pendingWaypointsRef.current = { seq, list: wpList };
      setWaypoints(wpList.map((wp) => ({ ...wp, confirmed: false })));
    }
    return ok;
  }, []);

  const clearWaypoints = useCallback(() => {
    pendingWaypointsRef.current = null;
    setWaypoints([]);
    telemetryStore.clearTrail();
  }, []);

  const addWaypoint = useCallback((wp: Waypoint) => {
    setWaypoints((prev) => [...prev, { ...wp, confirmed: false }]);
  }, []);

  return {
    connected: phase === "connected",
    connecting: phase === "connecting" || phase === "reconnecting",
    phase,
    waypoints,
    lastAck,
    vehicle,
    arm,
    disarm,
    takeoff,
    land,
    rth,
    emergencyStop,
    forceArmTakeoff,
    startAutoSurvey,
    startOrbitMission,
    sendVelocity,
    setGoal,
    addWaypoint,
    clearWaypoints,
    sendWaypoints,
  };
}
