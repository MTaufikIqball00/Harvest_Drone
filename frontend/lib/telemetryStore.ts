"use client";

/**
 * lib/telemetryStore.ts
 * =============================================================================
 * Store telemetry terisolasi berbasis `useSyncExternalStore`.
 *
 * MASALAH YANG DIPECAHKAN
 * -----------------------
 * Sebelumnya seluruh telemetry disimpan sebagai `useState` di dalam `page.tsx`.
 * Karena state itu berada di root pohon komponen, SETIAP pesan telemetry
 * (20-50Hz) me-render ulang seluruh halaman: dua peta, panel kontrol dengan 20+
 * tombol, tabel riwayat — semuanya. Itulah sumber utama lag dan frame drop.
 *
 * ARSITEKTUR SEKARANG
 * -------------------
 *   live      : objek MUTABLE, ditulis pada setiap pesan yang masuk. Konsumen
 *               imperatif (canvas rAF, marker Leaflet) membacanya langsung
 *               tanpa memicu render React sama sekali — nol alokasi per frame.
 *   snapshot  : salinan IMMUTABLE yang diterbitkan maksimal `UI_HZ` kali per
 *               detik. Hanya ini yang dilihat React, sehingga jumlah render
 *               dibatasi walau data masuk jauh lebih cepat.
 *   vehicle   : slice frekuensi RENDAH (armed, flightMode, journeyStatus...).
 *               Listener-nya hanya dipanggil saat nilainya benar-benar berubah,
 *               jadi tombol ARM/DISARM tidak ikut render 20x/detik.
 *
 * Pemisahan ini yang membuat komponen HUD bisa berlangganan hanya slice yang
 * dibutuhkannya (selective selector) tanpa memasang Zustand/Redux.
 */

export interface TelemetryData {
  x: number;
  y: number;
  z: number;
  lat: number;
  lon: number;
  alt: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  yaw: number;
  pitch: number;
  roll: number;
  heading: number;
  battery: number;
  voltage: number;
  flightMode: string;
  armed: boolean;
  navState: string;
  /** Unix epoch ms dari node ROS 2 — basis waktu tunggal lintas sistem. */
  stampMs: number;
  /**
   * true bila autopilot punya fix GPS dan lat/lon di atas adalah koordinat
   * bumi SESUNGGUHNYA. Bila false, lat/lon hanyalah proyeksi dari posisi
   * lokal (meter) terhadap origin peta — cukup untuk menggambar marker,
   * tetapi bukan lokasi geografis nyata.
   */
  gpsValid: boolean;
  /**
   * Jarak (meter) ke rintangan terdekat di sektor depan hasil LiDAR, atau null
   * bila tidak ada yang terdeteksi. Ikut jalur telemetry 20Hz agar bar
   * penghindaran rintangan (ODI) bereaksi realtime, bukan pada state 2Hz.
   */
  nearestObstacle: number | null;
  /**
   * false untuk flight stack yang tidak punya konsep "arm" terpisah dari
   * takeoff (mis. DJI Spark — motor auto-nyala saat startTakeoff()). Default
   * true (tidak dikirim) supaya ArduPilot/PX4 tidak perlu berubah apa pun.
   */
  armDisarmSupported: boolean;
  /**
   * false untuk flight stack yang tidak mengimplementasikan fitur misi lanjutan
   * (RTH, emergency stop, force-arm-takeoff, auto-survey/orbit) maupun world
   * simulasi Gazebo — mis. jembatan DJI Spark (RosBridgeClient.java) yang hanya
   * meneruskan kontrol dasar (manual, takeoff, land, satu waypoint GPS).
   */
  advancedFeaturesSupported: boolean;
}

export interface VehicleState {
  armed: boolean;
  flightMode: string;
  navState: string;
  journeyStatus: string;
  rtlTriggered: boolean;
  /** Selisih jam UI vs stamp node ROS, dalam milidetik. */
  latencyMs: number;
  /** Waypoint seq terakhir yang di-ACK node. */
  ackedSeq: number;
  /**
   * Waypoint seq terakhir yang DITOLAK node (waypoints_nack).
   *
   * Terpisah dari ackedSeq karena penolakan harus ikut MEMBERSIHKAN status
   * pending di UI. Tanpa field ini, penolakan hanya mengisi ackMessage dan
   * badge "Menunggu ACK" bertahan selamanya — gejalanya jadi identik dengan
   * "pesan tidak pernah sampai", padahal penyebabnya berbeda jauh.
   */
  nackedSeq: number;
  /**
   * Waypoint seq yang drone-nya sudah BENAR-BENAR TIBA di tujuan
   * (event "mission_complete" dari jembatan, dipicu saat jarak <= radius
   * terima). Berbeda dari ackedSeq yang hanya berarti "perintah diterima".
   */
  completedSeq: number;
  ackMessage: string;
  nearestObstacle: number | null;
  /** Autopilot punya fix GPS -> waypoint bisa dikirim sebagai lat/lon. */
  gpsValid: boolean;
  /** Dashboard menyembunyikan tombol ARM/DISARM saat ini false (lihat
   *  DroneController.tsx) — dipakai untuk mode DJI Spark. */
  armDisarmSupported: boolean;
  /** Dashboard menyembunyikan RTH/Emergency Stop/Force Arm+Takeoff/Auto Survey
   *  dan peta simulasi Gazebo saat ini false — dipakai untuk mode DJI Spark. */
  advancedFeaturesSupported: boolean;
}

export interface Waypoint {
  id: number;
  x: number;
  y: number;
  z: number;
  lat?: number;
  lon?: number;
  /** true setelah node membalas ACK untuk seq pengiriman ini. */
  confirmed?: boolean;
  /** true bila node MENOLAK waypoint ini (waypoints_nack). Marker sengaja
   *  dipertahankan agar operator melihat titik mana yang gagal, bukan hilang
   *  diam-diam. Alasannya ada di VehicleState.ackMessage. */
  rejected?: boolean;
  /**
   * true setelah perintah BENAR-BENAR dikirim ke drone (tombol "Send Goal"),
   * false bila marker baru dipasang di peta tapi belum dikirim.
   *
   * Dipakai peta untuk memutuskan apakah menggambar garis rute drone -> target:
   * menggambarnya sebelum dikirim akan menyiratkan drone sedang menuju ke sana,
   * padahal perintahnya belum berangkat sama sekali.
   */
  sent?: boolean;
}

export interface TrailPoint {
  x: number;
  y: number;
}

/** Satu titik pada rute misi terencana (mis. jalur boustrophedon auto survey). */
export interface PlannedPathPoint {
  x: number;
  y: number;
  z: number;
}

/** Rintangan yang dilacak node (pohon SDF statis atau deteksi LiDAR dinamis),
 *  diterima lewat /dashboard/obstacles. Dipakai bar ODI untuk mengenali
 *  rintangan mana yang sedang dihindari drone. */
export interface ObstacleMarker {
  id: string;
  kind: string;
  x: number;
  y: number;
  radius: number;
  clearance: number;
  source: string;
  active: boolean;
}

/** Rate publish snapshot ke React. 20Hz cukup halus untuk mata, 3x lebih murah
 *  daripada render tiap pesan pada 60Hz. */
const UI_HZ = 20;
const UI_INTERVAL_MS = 1000 / UI_HZ;

/** Batas titik trail yang disimpan. Ring buffer, bukan array yang tumbuh terus. */
const TRAIL_CAPACITY = 600;
/** Jarak minimum antar titik trail (meter) — hindari ribuan titik menumpuk saat hover. */
const TRAIL_MIN_DISTANCE_M = 0.4;

export const DEFAULT_TELEMETRY: TelemetryData = {
  x: 0,
  y: 0,
  z: 0,
  lat: -6.9175,
  lon: 107.6191,
  alt: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  speed: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  heading: 0,
  battery: 100,
  voltage: 15.6,
  flightMode: "UNKNOWN",
  armed: false,
  navState: "idle",
  stampMs: 0,
  gpsValid: false,
  nearestObstacle: null,
  armDisarmSupported: true,
  advancedFeaturesSupported: true,
};

const DEFAULT_VEHICLE: VehicleState = {
  armed: false,
  flightMode: "UNKNOWN",
  navState: "idle",
  journeyStatus: "Idle",
  rtlTriggered: false,
  latencyMs: 0,
  ackedSeq: 0,
  nackedSeq: 0,
  completedSeq: 0,
  ackMessage: "",
  nearestObstacle: null,
  gpsValid: false,
  armDisarmSupported: true,
  advancedFeaturesSupported: true,
};

type Listener = () => void;

class TelemetryStore {
  /** Objek mutable untuk konsumen imperatif (canvas/Leaflet). JANGAN di-render. */
  readonly live: TelemetryData = { ...DEFAULT_TELEMETRY };

  private snapshot: TelemetryData = { ...DEFAULT_TELEMETRY };
  private vehicle: VehicleState = { ...DEFAULT_VEHICLE };

  private telemetryListeners = new Set<Listener>();
  private vehicleListeners = new Set<Listener>();
  private trailListeners = new Set<Listener>();
  private plannedPathListeners = new Set<Listener>();
  private obstacleListeners = new Set<Listener>();

  /** Trail sebagai ring buffer — tidak pernah realokasi array besar. */
  private trail: TrailPoint[] = [];
  private trailSnapshot: TrailPoint[] = [];
  private trailDirty = false;
  private lastTrailPoint: TrailPoint | null = null;

  /** Rute misi terencana (mis. jalur boustrophedon), diterima lewat
   *  /dashboard/paths_json. Frekuensi rendah — hanya berubah saat misi baru
   *  dimulai/dihapus, jadi listener-nya tidak perlu dibatasi seperti trail. */
  private plannedPath: PlannedPathPoint[] = [];

  /** Daftar rintangan aktif dari node, diterima lewat /dashboard/obstacles. */
  private obstacles: ObstacleMarker[] = [];

  private lastPublish = 0;
  private rafHandle: number | null = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // INGEST — dipanggil dari handler rosbridge
  // ---------------------------------------------------------------------------
  /**
   * Terapkan pesan telemetry. Ini jalur terpanas di seluruh aplikasi:
   * hanya menulis field pada objek yang sudah ada, tanpa alokasi objek baru.
   */
  ingestTelemetry(data: Partial<TelemetryData>): void {
    const live = this.live;
    let vehicleChanged = false;

    if (typeof data.x === "number") live.x = data.x;
    if (typeof data.y === "number") live.y = data.y;
    if (typeof data.z === "number") live.z = data.z;
    if (typeof data.alt === "number") live.alt = data.alt;
    if (typeof data.lat === "number") live.lat = data.lat;
    if (typeof data.lon === "number") live.lon = data.lon;
    if (typeof data.vx === "number") live.vx = data.vx;
    if (typeof data.vy === "number") live.vy = data.vy;
    if (typeof data.vz === "number") live.vz = data.vz;
    if (typeof data.speed === "number") live.speed = data.speed;
    if (typeof data.yaw === "number") live.yaw = data.yaw;
    if (typeof data.pitch === "number") live.pitch = data.pitch;
    if (typeof data.roll === "number") live.roll = data.roll;
    if (typeof data.heading === "number") live.heading = data.heading;
    if (typeof data.battery === "number") live.battery = data.battery;
    if (typeof data.voltage === "number") live.voltage = data.voltage;
    if (typeof data.stampMs === "number") live.stampMs = data.stampMs;
    // null valid (tidak ada rintangan terdeteksi) — jangan disaring seperti angka.
    if (data.nearestObstacle === null || typeof data.nearestObstacle === "number") {
      live.nearestObstacle = data.nearestObstacle;
    }

    if (typeof data.armed === "boolean" && data.armed !== live.armed) {
      live.armed = data.armed;
      vehicleChanged = true;
    }
    if (typeof data.flightMode === "string" && data.flightMode !== live.flightMode) {
      live.flightMode = data.flightMode;
      vehicleChanged = true;
    }
    if (typeof data.navState === "string" && data.navState !== live.navState) {
      live.navState = data.navState;
      vehicleChanged = true;
    }
    if (typeof data.gpsValid === "boolean" && data.gpsValid !== live.gpsValid) {
      live.gpsValid = data.gpsValid;
      vehicleChanged = true;
    }
    if (
      typeof data.armDisarmSupported === "boolean" &&
      data.armDisarmSupported !== live.armDisarmSupported
    ) {
      live.armDisarmSupported = data.armDisarmSupported;
      vehicleChanged = true;
    }
    if (
      typeof data.advancedFeaturesSupported === "boolean" &&
      data.advancedFeaturesSupported !== live.advancedFeaturesSupported
    ) {
      live.advancedFeaturesSupported = data.advancedFeaturesSupported;
      vehicleChanged = true;
    }

    this.appendTrail(live.x, live.y);

    // Slice frekuensi rendah hanya diberi tahu saat benar-benar berubah.
    if (vehicleChanged) {
      this.patchVehicle({
        armed: live.armed,
        flightMode: live.flightMode,
        navState: live.navState,
        gpsValid: live.gpsValid,
        armDisarmSupported: live.armDisarmSupported,
        advancedFeaturesSupported: live.advancedFeaturesSupported,
      });
    }

    if (live.stampMs > 0) {
      const latency = Date.now() - live.stampMs;
      // Hindari notifikasi untuk fluktuasi kecil; hanya update per 25ms.
      if (Math.abs(latency - this.vehicle.latencyMs) > 25) {
        this.patchVehicle({ latencyMs: latency });
      }
    }

    this.schedulePublish();
  }

  /** Terapkan payload /dashboard/state (frekuensi rendah, 2Hz). */
  ingestState(payload: any): void {
    if (!payload || typeof payload !== "object") return;

    const patch: Partial<VehicleState> = {};
    if (typeof payload.journey_status === "string") patch.journeyStatus = payload.journey_status;
    if (typeof payload.rtlTriggered === "boolean") patch.rtlTriggered = payload.rtlTriggered;
    if (payload.nearestObstacle === null || typeof payload.nearestObstacle === "number") {
      patch.nearestObstacle = payload.nearestObstacle;
    }
    if (payload.vehicle && typeof payload.vehicle === "object") {
      if (typeof payload.vehicle.armed === "boolean") patch.armed = payload.vehicle.armed;
      if (typeof payload.vehicle.navStateName === "string") {
        patch.flightMode = payload.vehicle.navStateName;
      }
    }
    if (typeof payload.mode === "string") patch.navState = payload.mode;

    // Baterai ikut jalur telemetry supaya HUD tetap satu sumber kebenaran.
    if (payload.battery && typeof payload.battery === "object") {
      const remaining = payload.battery.remaining;
      if (typeof remaining === "number") this.live.battery = remaining * 100;
      if (typeof payload.battery.voltage === "number") this.live.voltage = payload.battery.voltage;
      this.schedulePublish();
    }

    if (Object.keys(patch).length > 0) this.patchVehicle(patch);
  }

  /** Terapkan event ACK/status dari node ROS. */
  ingestEvent(payload: any): void {
    if (!payload || typeof payload !== "object") return;
    const event = String(payload.event || "");
    if (event === "waypoints_ack") {
      this.patchVehicle({
        ackedSeq: Number(payload.seq) || 0,
        ackMessage: String(payload.message || ""),
      });
    } else if (event === "waypoints_nack") {
      // seq WAJIB ikut dipatch. Versi lama hanya mengisi ackMessage, sehingga
      // UI tidak punya cara mengetahui bahwa pengiriman ini sudah selesai
      // (dengan hasil ditolak) dan terus menampilkan "Menunggu ACK".
      this.patchVehicle({
        nackedSeq: Number(payload.seq) || 0,
        ackMessage: `DITOLAK: ${payload.message || "tidak diketahui"}`,
      });
    } else if (event === "mission_complete") {
      // Drone benar-benar TIBA di waypoint. Jembatan DJI mengirim ini dari
      // loop kontrolnya saat jarak <= radius terima; inilah satu-satunya
      // sinyal kedatangan yang tersedia — posisi live saja tidak cukup karena
      // dashboard tidak tahu ambang radius yang dipakai jembatan.
      this.patchVehicle({
        completedSeq: Number(payload.seq) || 0,
        ackMessage: String(payload.message || "Waypoint tercapai."),
      });
    } else if (payload.message) {
      this.patchVehicle({ ackMessage: String(payload.message) });
    }
  }

  /** Reset ke nilai default — dipakai saat koneksi putus agar UI tidak stale. */
  resetForDisconnect(): void {
    this.patchVehicle({
      journeyStatus: "Disconnected",
      ackMessage: "Koneksi terputus, menunggu resync...",
    });
  }

  // ---------------------------------------------------------------------------
  // TRAIL
  // ---------------------------------------------------------------------------
  private appendTrail(x: number, y: number): void {
    const last = this.lastTrailPoint;
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy < TRAIL_MIN_DISTANCE_M * TRAIL_MIN_DISTANCE_M) return;
    }
    const point = { x, y };
    this.trail.push(point);
    if (this.trail.length > TRAIL_CAPACITY) this.trail.shift();
    this.lastTrailPoint = point;
    this.trailDirty = true;
  }

  clearTrail(): void {
    this.trail = [];
    this.lastTrailPoint = null;
    this.trailSnapshot = [];
    this.trailListeners.forEach((fn) => fn());
  }

  /** Array live untuk konsumen canvas — jangan dimutasi dari luar. */
  getLiveTrail(): TrailPoint[] {
    return this.trail;
  }

  getTrailSnapshot = (): TrailPoint[] => this.trailSnapshot;

  subscribeTrail = (listener: Listener): (() => void) => {
    this.trailListeners.add(listener);
    return () => this.trailListeners.delete(listener);
  };

  // ---------------------------------------------------------------------------
  // PLANNED PATH — rute misi (mis. boustrophedon auto survey)
  // ---------------------------------------------------------------------------
  /** Terapkan payload /dashboard/paths_json — dipakai rute "final" node. */
  ingestPlannedPath(points: PlannedPathPoint[]): void {
    this.plannedPath = points;
    this.plannedPathListeners.forEach((fn) => fn());
  }

  clearPlannedPath(): void {
    if (this.plannedPath.length === 0) return;
    this.plannedPath = [];
    this.plannedPathListeners.forEach((fn) => fn());
  }

  getPlannedPathSnapshot = (): PlannedPathPoint[] => this.plannedPath;

  subscribePlannedPath = (listener: Listener): (() => void) => {
    this.plannedPathListeners.add(listener);
    return () => this.plannedPathListeners.delete(listener);
  };

  // ---------------------------------------------------------------------------
  // OBSTACLES — pohon SDF statis + deteksi LiDAR dinamis (/dashboard/obstacles)
  // ---------------------------------------------------------------------------
  /** Terapkan payload /dashboard/obstacles (2Hz). Referensi baru tiap update
   *  supaya useSyncExternalStore mendeteksi perubahan. */
  ingestObstacles(list: ObstacleMarker[]): void {
    this.obstacles = list;
    this.obstacleListeners.forEach((fn) => fn());
  }

  getObstaclesSnapshot = (): ObstacleMarker[] => this.obstacles;

  subscribeObstacles = (listener: Listener): (() => void) => {
    this.obstacleListeners.add(listener);
    return () => this.obstacleListeners.delete(listener);
  };

  // ---------------------------------------------------------------------------
  // PUBLISH — coalescing ke rate UI
  // ---------------------------------------------------------------------------
  /**
   * Jadwalkan penerbitan snapshot. Beberapa pesan yang tiba dalam satu jendela
   * `UI_INTERVAL_MS` digabung jadi SATU render, bukan satu render per pesan.
   * requestAnimationFrame dipakai supaya penerbitan selaras dengan frame paint
   * browser dan otomatis berhenti saat tab tidak terlihat.
   */
  private schedulePublish(): void {
    if (this.rafHandle !== null || this.timerHandle !== null) return;
    if (typeof window === "undefined") return;

    const elapsed = performance.now() - this.lastPublish;
    if (elapsed >= UI_INTERVAL_MS) {
      this.rafHandle = window.requestAnimationFrame(() => {
        this.rafHandle = null;
        this.publish();
      });
    } else {
      this.timerHandle = setTimeout(() => {
        this.timerHandle = null;
        this.rafHandle = window.requestAnimationFrame(() => {
          this.rafHandle = null;
          this.publish();
        });
      }, UI_INTERVAL_MS - elapsed);
    }
  }

  private publish(): void {
    this.lastPublish = performance.now();
    // Satu alokasi objek per frame UI (maks 20/detik), bukan per pesan.
    this.snapshot = { ...this.live };
    this.telemetryListeners.forEach((fn) => fn());

    if (this.trailDirty) {
      this.trailDirty = false;
      this.trailSnapshot = this.trail.slice();
      this.trailListeners.forEach((fn) => fn());
    }
  }

  private patchVehicle(patch: Partial<VehicleState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof VehicleState)[]) {
      if (this.vehicle[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.vehicle = { ...this.vehicle, ...patch };
    this.vehicleListeners.forEach((fn) => fn());
  }

  /** Hentikan semua timer — dipanggil saat provider di-unmount. */
  dispose(): void {
    if (this.rafHandle !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  // ---------------------------------------------------------------------------
  // SUBSCRIPTION API (useSyncExternalStore)
  // ---------------------------------------------------------------------------
  subscribeTelemetry = (listener: Listener): (() => void) => {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  };

  getTelemetrySnapshot = (): TelemetryData => this.snapshot;

  subscribeVehicle = (listener: Listener): (() => void) => {
    this.vehicleListeners.add(listener);
    return () => this.vehicleListeners.delete(listener);
  };

  getVehicleSnapshot = (): VehicleState => this.vehicle;
}

export const telemetryStore = new TelemetryStore();
