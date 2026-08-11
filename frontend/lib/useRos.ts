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
  type ObstacleMarker,
  type PlannedPathPoint,
  type TelemetryData,
  type TrailPoint,
  type VehicleState,
  type Waypoint,
} from "./telemetryStore";

export type { TelemetryData, Waypoint, TrailPoint, VehicleState, PlannedPathPoint, ObstacleMarker };

const TRIGGER = "std_srvs/srv/Trigger";

/**
 * Snapshot server untuk slice yang berupa array kosong.
 *
 * WAJIB konstanta modul, BUKAN `() => []` inline. useSyncExternalStore
 * membandingkan hasil getServerSnapshot dengan ===; literal `[]` inline
 * menghasilkan array BARU tiap pemanggilan sehingga perbandingan selalu gagal,
 * React menganggap store berubah terus, lalu memperingatkan "The result of
 * getServerSnapshot should be cached to avoid an infinite loop".
 *
 * Dibekukan supaya tidak ada konsumen yang tanpa sadar memutasinya — satu
 * instance ini dipakai bersama oleh semua hook di bawah.
 */
const EMPTY_TRAIL: readonly TrailPoint[] = Object.freeze([]);
const EMPTY_PLANNED_PATH: readonly PlannedPathPoint[] = Object.freeze([]);
const EMPTY_OBSTACLES: readonly ObstacleMarker[] = Object.freeze([]);

const getEmptyTrail = () => EMPTY_TRAIL as TrailPoint[];
const getEmptyPlannedPath = () => EMPTY_PLANNED_PATH as PlannedPathPoint[];
const getEmptyObstacles = () => EMPTY_OBSTACLES as ObstacleMarker[];

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
    getEmptyTrail
  );
}

/** Rute misi terencana (mis. jalur boustrophedon auto survey). Frekuensi
 *  rendah — hanya berubah saat misi baru dimulai/dihapus. */
export function usePlannedPath(): PlannedPathPoint[] {
  return useSyncExternalStore(
    telemetryStore.subscribePlannedPath,
    telemetryStore.getPlannedPathSnapshot,
    getEmptyPlannedPath
  );
}

/** Daftar rintangan aktif (pohon SDF + deteksi LiDAR). Frekuensi rendah (2Hz) —
 *  dipakai bar ODI untuk mengenali rintangan mana yang sedang dihindari. */
export function useObstacles(): ObstacleMarker[] {
  return useSyncExternalStore(
    telemetryStore.subscribeObstacles,
    telemetryStore.getObstaclesSnapshot,
    getEmptyObstacles
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
            // Jarak rintangan terdekat (LiDAR) — bisa null bila tidak ada.
            nearestObstacle:
              data.nearestObstacle === null || typeof data.nearestObstacle === "number"
                ? data.nearestObstacle
                : undefined,
            // lat/lon hanya dikirim node saat GPS fix; kalau tidak ada,
            // store mempertahankan proyeksi lokal sebagai fallback.
            lat: typeof data.lat === "number" ? data.lat : undefined,
            lon: typeof data.lon === "number" ? data.lon : undefined,
            gpsValid: Boolean(data.gpsValid),
            // PENTING: TIDAK di-coerce ke Boolean() seperti gpsValid. Node
            // ArduPilot/PX4 tidak pernah mengirim field ini sama sekali, jadi
            // Boolean(undefined) akan selalu jadi false dan menyembunyikan
            // ARM/DISARM yang seharusnya tetap tampil untuk stack itu. Hanya
            // diteruskan saat node (mis. jembatan DJI) benar-benar mengirim
            // nilai eksplisit — telemetryStore lalu mempertahankan default
            // true selama field ini tidak pernah muncul.
            armDisarmSupported:
              typeof data.armDisarmSupported === "boolean"
                ? data.armDisarmSupported
                : undefined,
            // Pola sama: hanya diteruskan saat eksplisit ada, supaya node
            // ArduPilot/PX4 yang tidak pernah mengirim field ini tetap
            // mempertahankan default true (fitur lanjutan tetap tampil).
            advancedFeaturesSupported:
              typeof data.advancedFeaturesSupported === "boolean"
                ? data.advancedFeaturesSupported
                : undefined,
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

    // Rute misi terencana (boustrophedon auto survey, dll) — frekuensi rendah,
    // hanya diterbitkan node saat rute baru dihitung.
    const unsubPaths = client.subscribe(
      "/dashboard/paths_json",
      "std_msgs/msg/String",
      (message: any) => {
        try {
          const payload = JSON.parse(message.data);
          const final = Array.isArray(payload?.final) ? payload.final : [];
          telemetryStore.ingestPlannedPath(
            final.map((p: any) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 }))
          );
        } catch (err) {
          console.warn("[useRos] Payload paths_json tidak bisa diparse:", err);
        }
      }
    );

    // Daftar rintangan (pohon SDF statis + deteksi LiDAR dinamis), 2Hz.
    // Dipakai bar ODI untuk mengenali rintangan mana yang sedang dihindari.
    const unsubObstacles = client.subscribe(
      "/dashboard/obstacles",
      "std_msgs/msg/String",
      (message: any) => {
        try {
          const payload = JSON.parse(message.data);
          if (!Array.isArray(payload)) return;
          telemetryStore.ingestObstacles(
            payload.map((o: any) => ({
              id: String(o.id ?? ""),
              kind: String(o.kind ?? "obstacle"),
              x: Number(o.x) || 0,
              y: Number(o.y) || 0,
              radius: Number(o.radius) || 0,
              clearance: Number(o.clearance) || 0,
              source: String(o.source ?? ""),
              active: o.active !== false,
            }))
          );
        } catch (err) {
          console.warn("[useRos] Payload obstacles tidak bisa diparse:", err);
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
      unsubPaths();
      unsubObstacles();
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
    // `sent` dan `rejected` WAJIB ditulis ulang di sini. pending.list adalah
    // daftar MENTAH yang dioper ke sendWaypoints() dan belum punya kedua flag
    // itu — flag-nya baru ditambahkan pada setWaypoints() saat pengiriman.
    // Tanpa baris ini, `sent` kembali undefined begitu ACK tiba, dan garis rute
    // (yang syaratnya `targetWp?.sent`) LENYAP justru pada detik drone mulai
    // bergerak — persis saat operator paling butuh melihatnya.
    setWaypoints(
      pending.list.map((wp) => ({ ...wp, confirmed: true, rejected: false, sent: true }))
    );
  }, [vehicle.ackedSeq]);

  // Penolakan (waypoints_nack) juga MENGAKHIRI penantian — ini pasangan wajib
  // dari efek di atas. Tanpa ini, satu-satunya jalan keluar dari status
  // "Menunggu ACK" adalah ACK yang sukses, sehingga setiap penolakan tampak
  // seperti pesan yang hilang di jalan.
  useEffect(() => {
    const pending = pendingWaypointsRef.current;
    if (!pending || vehicle.nackedSeq === 0 || vehicle.nackedSeq !== pending.seq) {
      return;
    }
    pendingWaypointsRef.current = null;
    // Marker DIPERTAHANKAN (bukan dihapus) supaya operator melihat titik mana
    // yang ditolak dan bisa langsung memperbaikinya; alasannya dibaca dari
    // vehicle.ackMessage.
    setWaypoints(pending.list.map((wp) => ({ ...wp, confirmed: false, rejected: true })));
  }, [vehicle.nackedSeq]);

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
    if (ok) setWaypoints([{ ...wp, confirmed: false, rejected: false, sent: true }]);
    return ok;
  }, []);

  /**
   * Kirim daftar waypoint dengan pola ACK.
   *
   * UI TIDAK langsung menandai waypoint sebagai aktif. Ia menyimpan seq di ref,
   * dan status baru diperbarui setelah node membalas "waypoints_ack" dengan seq
   * yang sama (lihat efek rekonsiliasi di atas). Kalau node menolak, UI tetap
   * menampilkan status pending, bukan berbohong bahwa misi sudah terkirim.
   *
   * Mengembalikan SEQ pengiriman (bukan sekadar boolean) supaya pemanggil bisa
   * mencocokkannya dengan event kedatangan "mission_complete" yang datang
   * belakangan. Seq selalu >= 1, jadi pemakaian lama `if (ok)` tetap benar.
   */
  const sendWaypoints = useCallback((wpList: Waypoint[]): number | null => {
    const client = clientRef.current;
    if (!client || wpList.length === 0) return null;

    const seq = ++seqRef.current;
    // PEMILIHAN MODE NAVIGASI.
    // Bila autopilot punya fix GPS DAN waypoint membawa lat/lon (mis. hasil klik
    // peta), kirim sebagai koordinat bumi — drone asli akan terbang ke titik
    // geografis yang sesungguhnya. Bila tidak, kirim sebagai jarak lokal dalam
    // meter, sehingga drone tanpa GPS tetap bisa dipakai tanpa perubahan alur.
    const useGps = telemetryStore.getVehicleSnapshot().gpsValid;
    const payload = wpList.map((wp) =>
      useGps && typeof wp.lat === "number" && typeof wp.lon === "number"
        ? { lat: wp.lat, lon: wp.lon, z: wp.z }
        : { x: wp.x, y: wp.y, z: wp.z }
    );

    const ok = client.publish("/dashboard/waypoints", "std_msgs/msg/String", {
      data: JSON.stringify({ seq, waypoints: payload }),
    });

    if (!ok) return null;

    pendingWaypointsRef.current = { seq, list: wpList };
    setWaypoints(wpList.map((wp) => ({ ...wp, confirmed: false, rejected: false, sent: true })));
    return seq;
  }, []);

  const clearWaypoints = useCallback(() => {
    pendingWaypointsRef.current = null;
    setWaypoints([]);
    telemetryStore.clearTrail();
  }, []);

  const addWaypoint = useCallback((wp: Waypoint) => {
    setWaypoints((prev) => [...prev, { ...wp, confirmed: false, rejected: false, sent: true }]);
  }, []);

  /** Taruh SATU target (marker kuning) secara lokal TANPA mengirim ke drone.
   *  Dipakai peta Gazebo: klik memasang marker, tombol "Send Goal" yang
   *  benar-benar mengirimnya ke planner A*. */
  const setTargetLocal = useCallback((wp: Waypoint) => {
    pendingWaypointsRef.current = null;
    // sent: false -> marker tampil, TAPI garis rute belum digambar.
    setWaypoints([{ ...wp, confirmed: false, rejected: false, sent: false }]);
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
    setTargetLocal,
    clearWaypoints,
    sendWaypoints,
  };
}
