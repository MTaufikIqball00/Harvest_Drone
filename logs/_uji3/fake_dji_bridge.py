#!/usr/bin/env python3
"""Tiruan jembatan DJI untuk kampanye uji jarak 2-20 m.

Kecepatan sengaja ~1 m/s (bukan 11 m/s seperti versi uji sebelumnya) supaya
durasi tiap skenario cukup berbeda untuk dianalisis.
"""

import json
import math
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy
from std_msgs.msg import String

SENSOR_QOS = QoSProfile(reliability=QoSReliabilityPolicy.BEST_EFFORT,
                        history=QoSHistoryPolicy.KEEP_LAST, depth=5)
COMMAND_QOS = QoSProfile(reliability=QoSReliabilityPolicy.RELIABLE,
                         history=QoSHistoryPolicy.KEEP_LAST, depth=10)

ORIGIN_LAT = -6.8655
ORIGIN_LON = 107.5412

# 0,2 m per tick pada 5 Hz = 1,0 m/s.
STEP_M = 0.2
DEG_PER_M = 1.0 / 111320.0


class FakeDjiBridge(Node):
    def __init__(self) -> None:
        super().__init__("fake_dji_bridge")
        self.telemetry_pub = self.create_publisher(String, "/dashboard/telemetry", SENSOR_QOS)
        self.state_pub = self.create_publisher(String, "/dashboard/state", COMMAND_QOS)
        self.create_subscription(String, "/dashboard/waypoints", self.waypoints_cb, COMMAND_QOS)

        self.lat = ORIGIN_LAT
        self.lon = ORIGIN_LON
        self.target = None
        self.pending_seq = None
        self.heading = 0.0

        self.create_timer(0.2, self.publish_telemetry)
        self.create_timer(0.5, self.publish_state)
        self.get_logger().info("Tiruan jembatan DJI siap (1 m/s).")

    def waypoints_cb(self, msg: String) -> None:
        try:
            payload = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        wps = payload.get("waypoints") or []
        if not wps:
            return
        seq = int(payload.get("seq") or 0)
        wp = wps[0]
        if "lat" in wp and "lon" in wp:
            self.target = (float(wp["lat"]), float(wp["lon"]))
        else:
            self.target = (
                ORIGIN_LAT + float(wp.get("y", 0.0)) * DEG_PER_M,
                ORIGIN_LON + float(wp.get("x", 0.0)) * DEG_PER_M / math.cos(math.radians(ORIGIN_LAT)),
            )
        self.pending_seq = seq
        self.state_pub.publish(String(data=json.dumps({
            "event": "waypoints_ack", "seq": seq, "message": f"Waypoint diterima ({seq})."})))

    def publish_telemetry(self) -> None:
        if self.target:
            # Konversi selisih derajat -> meter supaya langkah benar-benar
            # 0,2 m di kedua sumbu (1 derajat bujur < 1 derajat lintang).
            dlat_m = (self.target[0] - self.lat) / DEG_PER_M
            dlon_m = (self.target[1] - self.lon) / DEG_PER_M * math.cos(math.radians(self.lat))
            dist_m = math.hypot(dlat_m, dlon_m)

            if dist_m > STEP_M:
                self.lat += (dlat_m / dist_m * STEP_M) * DEG_PER_M
                self.lon += (dlon_m / dist_m * STEP_M) * DEG_PER_M / math.cos(math.radians(self.lat))
                self.heading = math.degrees(math.atan2(dlon_m, dlat_m)) % 360.0
            else:
                self.lat, self.lon = self.target
                self.target = None
                if self.pending_seq is not None:
                    self.state_pub.publish(String(data=json.dumps({
                        "event": "mission_complete",
                        "seq": self.pending_seq,
                        "message": "Waypoint tercapai."})))
                    self.get_logger().info(f"TIBA seq={self.pending_seq}")
                    self.pending_seq = None

        self.telemetry_pub.publish(String(data=json.dumps({
            "x": 0.0, "y": 0.0, "z": 15.0, "alt": 15.0,
            "lat": self.lat, "lon": self.lon,
            "vx": 1.0, "vy": 0.0, "vz": 0.0, "speed": 1.0,
            "yaw": math.radians(self.heading), "pitch": 0.0, "roll": 0.0,
            "heading": self.heading, "battery": 82.0, "voltage": 11.8,
            "armed": True, "gpsValid": True,
            "flightMode": "GPS", "navState": "DJI-ASLI",
            "armDisarmSupported": False, "advancedFeaturesSupported": False,
            "stamp_ms": int(time.time() * 1000)})))

    def publish_state(self) -> None:
        self.state_pub.publish(String(data=json.dumps({
            "mode": "GPS",
            "battery": {"remaining": 0.82, "voltage": 11.8, "current": 7.9,
                        "timeRemaining": 700, "warning": "none"},
            "wind": {"speed": 1.8, "direction": 80, "north": 0.3,
                     "east": 1.77, "safety": "safe"}})))


def main() -> None:
    rclpy.init()
    node = FakeDjiBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
