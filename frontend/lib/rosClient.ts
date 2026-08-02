"use client";

/**
 * lib/rosClient.ts
 * =============================================================================
 * Singleton koneksi rosbridge untuk seluruh dashboard.
 *
 * Kenapa singleton, bukan satu koneksi per hook/komponen?
 *   - Setiap `new ROSLIB.Ros()` membuka WebSocket baru. Dengan React StrictMode
 *     atau beberapa komponen yang memanggil useRos(), kita mendapat koneksi
 *     ganda yang masing-masing menerima telemetry 20Hz — beban parse & render
 *     berlipat tanpa manfaat apa pun.
 *   - Topik command harus di-advertise SEKALI. Versi lama membuat ROSLIB.Topic
 *     baru pada setiap pemanggilan command, artinya rosbridge menerima pesan
 *     `advertise` berulang-ulang untuk topik yang sama dan handler-nya bocor.
 *
 * Tanggung jawab modul ini:
 *   1. Auto-reconnect dengan exponential backoff + jitter.
 *   2. Registry subscription supaya reconnect memasang ulang semua handler.
 *   3. Full state resynchronization lewat service /dashboard/resync setiap kali
 *      koneksi pulih — UI tidak boleh menampilkan state basah/stale.
 *   4. Command berbasis service dengan ACK (success + message), bukan
 *      fire-and-forget.
 */

import ROSLIB, { type Ros, type Topic } from "roslib";

export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface ServiceAck {
  success: boolean;
  message: string;
}

type MessageHandler = (msg: any) => void;

interface Subscription {
  name: string;
  messageType: string;
  handler: MessageHandler;
  topic?: Topic;
}

interface PublisherEntry {
  topic: Topic;
  messageType: string;
}

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

export class RosClient {
  private ros: Ros | null = null;
  private url: string;
  private subscriptions = new Map<string, Subscription>();
  private publishers = new Map<string, PublisherEntry>();
  private phaseListeners = new Set<(phase: ConnectionPhase) => void>();
  private resyncListeners = new Set<() => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private disposed = false;
  private _phase: ConnectionPhase = "idle";

  constructor(url: string) {
    this.url = url;
  }

  get phase(): ConnectionPhase {
    return this._phase;
  }

  get isConnected(): boolean {
    return this._phase === "connected";
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  connect(): void {
    if (this.disposed || this.ros) return;
    this.setPhase(this.attempt === 0 ? "connecting" : "reconnecting");

    let ros: Ros;
    try {
      ros = new ROSLIB.Ros({ url: this.url });
    } catch (err) {
      console.error("[rosClient] Gagal membuat instance ROSLIB:", err);
      this.scheduleReconnect();
      return;
    }
    this.ros = ros;

    ros.on("connection", () => {
      if (this.disposed) return;
      this.attempt = 0;
      this.setPhase("connected");
      // Pasang ulang SEMUA subscription: setelah reconnect, objek Topic lama
      // menempel pada socket yang sudah mati.
      this.subscriptions.forEach((sub) => this.attachSubscription(sub));
      this.publishers.clear();
      // Beri tahu konsumen agar melakukan full state resync.
      this.resyncListeners.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error("[rosClient] Resync handler error:", err);
        }
      });
    });

    ros.on("error", (error: any) => {
      // rosbridge memancarkan 'error' sebelum 'close'. Jangan jadwalkan
      // reconnect di sini supaya tidak dobel dengan handler 'close'.
      if (!this.disposed) console.warn("[rosClient] Socket error:", error?.message || error);
    });

    ros.on("close", () => {
      if (this.disposed) return;
      this.detachSubscriptions();
      this.ros = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.setPhase("reconnecting");

    // Exponential backoff + jitter. Jitter mencegah semua tab browser
    // menghantam rosbridge pada milidetik yang sama setelah node restart.
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = backoff * (0.7 + Math.random() * 0.6);
    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.detachSubscriptions();
    this.subscriptions.clear();
    this.publishers.clear();
    this.phaseListeners.clear();
    this.resyncListeners.clear();
    if (this.ros) {
      try {
        this.ros.close();
      } catch {
        /* socket sudah tertutup */
      }
      this.ros = null;
    }
    this.setPhase("idle");
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------
  private attachSubscription(sub: Subscription): void {
    if (!this.ros) return;
    try {
      const topic = new ROSLIB.Topic({
        ros: this.ros,
        name: sub.name,
        messageType: sub.messageType,
      });
      topic.subscribe(sub.handler);
      sub.topic = topic;
    } catch (err) {
      console.error(`[rosClient] Gagal subscribe ${sub.name}:`, err);
    }
  }

  private detachSubscriptions(): void {
    this.subscriptions.forEach((sub) => {
      if (sub.topic) {
        try {
          sub.topic.unsubscribe();
        } catch {
          /* socket sudah mati */
        }
        sub.topic = undefined;
      }
    });
  }

  /** Subscribe ke satu topik. Mengembalikan fungsi unsubscribe. */
  subscribe(name: string, messageType: string, handler: MessageHandler): () => void {
    const sub: Subscription = { name, messageType, handler };
    this.subscriptions.set(name, sub);
    if (this.isConnected) this.attachSubscription(sub);

    return () => {
      const current = this.subscriptions.get(name);
      if (current !== sub) return;
      if (sub.topic) {
        try {
          sub.topic.unsubscribe();
        } catch {
          /* noop */
        }
      }
      this.subscriptions.delete(name);
    };
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------
  /** Publish ke topik. Publisher di-cache supaya advertise hanya sekali. */
  publish(name: string, messageType: string, payload: Record<string, unknown>): boolean {
    if (!this.ros || !this.isConnected) {
      console.warn(`[rosClient] Publish ${name} dibatalkan: belum terhubung.`);
      return false;
    }
    try {
      let entry = this.publishers.get(name);
      if (!entry || entry.messageType !== messageType) {
        entry = {
          topic: new ROSLIB.Topic({ ros: this.ros, name, messageType }),
          messageType,
        };
        this.publishers.set(name, entry);
      }
      entry.topic.publish(new ROSLIB.Message(payload));
      return true;
    } catch (err) {
      console.error(`[rosClient] Gagal publish ${name}:`, err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Services (pola ACK)
  // ---------------------------------------------------------------------------
  /**
   * Panggil service ROS dan tunggu ACK-nya.
   *
   * Ini yang membuat UI tidak pernah menampilkan state optimistis: tombol ARM
   * baru dianggap berhasil setelah node membalas success=true. Timeout dipasang
   * karena rosbridge tidak memberi callback error saat service tidak ada.
   */
  callService(
    name: string,
    serviceType: string,
    request: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<ServiceAck> {
    return new Promise((resolve) => {
      if (!this.ros || !this.isConnected) {
        resolve({ success: false, message: "ROSBridge tidak terhubung." });
        return;
      }

      let settled = false;
      const finish = (ack: ServiceAck) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ack);
      };

      const timer = setTimeout(
        () => finish({ success: false, message: `Timeout ${timeoutMs}ms menunggu ${name}.` }),
        timeoutMs
      );

      try {
        const service = new ROSLIB.Service({ ros: this.ros, name, serviceType });
        service.callService(
          new ROSLIB.ServiceRequest(request),
          (response: any) =>
            finish({
              success: Boolean(response?.success ?? true),
              message: String(response?.message ?? ""),
            }),
          (error: any) => finish({ success: false, message: String(error ?? "Service gagal") })
        );
      } catch (err: any) {
        finish({ success: false, message: err?.message || "Pemanggilan service gagal" });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------
  onPhaseChange(listener: (phase: ConnectionPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  /** Dipanggil setiap koneksi (re)berhasil — tempat memicu full resync. */
  onReconnect(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this._phase === phase) return;
    this._phase = phase;
    this.phaseListeners.forEach((fn) => {
      try {
        fn(phase);
      } catch (err) {
        console.error("[rosClient] Phase listener error:", err);
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Singleton per-URL
// -----------------------------------------------------------------------------
const clients = new Map<string, RosClient>();

export function getRosClient(url: string): RosClient {
  let client = clients.get(url);
  if (!client) {
    client = new RosClient(url);
    clients.set(url, client);
    client.connect();
  }
  return client;
}

function resolveDefaultRosbridgeUrl(): string {
  if (process.env.NEXT_PUBLIC_ROSBRIDGE_URL) {
    return process.env.NEXT_PUBLIC_ROSBRIDGE_URL;
  }
  // Tanpa env var, ikuti host yang dipakai browser membuka dashboard
  // (mis. IP laptop di LAN) alih-alih hardcode 127.0.0.1 — hardcode itu
  // selalu berarti "localhost milik si browser", jadi patah begitu
  // dashboard dibuka dari perangkat lain (HP, laptop lain di LAN).
  if (typeof window !== "undefined" && window.location.hostname) {
    return `ws://${window.location.hostname}:9090`;
  }
  return "ws://127.0.0.1:9090";
}

export const DEFAULT_ROSBRIDGE_URL = resolveDefaultRosbridgeUrl();
