#!/usr/bin/env python3
"""
field_patrol_mission.py
=======================
ROS2 Jazzy — Autonomous Drone Patrol Mission
Project : Monitoring Lahan Pertanian Jl. Aruman, Cimahi

Script ini mengirim waypoint lawnmower pattern ke drone untuk
memantau seluruh zona merah (sawah flat) dan zona biru (terrain mudun).

Prerequisite:
  - Gazebo Harmony sudah running dengan agricultural_field.sdf
  - Drone sudah di-spawn dan ready
  - PX4/ArduPilot atau autopilot custom sudah berjalan

Usage:
  ros2 run agricultural_world field_patrol_mission
  ros2 run agricultural_world field_patrol_mission \
        --ros-args -p altitude:=15.0 -p speed:=5.0 -p pattern:=lawnmower
"""

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy

import math
import time
from dataclasses import dataclass, field
from typing import List, Optional

from geometry_msgs.msg import PoseStamped, Twist
from nav_msgs.msg import Odometry
from sensor_msgs.msg import NavSatFix
from std_msgs.msg import Bool, String


# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class Waypoint:
    """Representasi satu waypoint misi."""
    x: float          # meter (local frame, NED atau ENU)
    y: float
    z: float          # ketinggian misi (AGL — Above Ground Level)
    label: str = ""   # keterangan waypoint
    loiter_sec: float = 0.0   # waktu hover di waypoint (detik)
    take_photo: bool = False   # trigger kamera di waypoint ini


# ─────────────────────────────────────────────────────────────────────────────
class FieldPatrolMission(Node):
    """
    Node ROS2 untuk misi patrol otomatis lahan pertanian.

    Pola terbang:
      1. Takeoff dari spawn point (X=-65, Y=0)
      2. Lawnmower sweep atas zona MERAH (Z=0, lahan flat)
      3. Transisi ke zona BIRU (terrain -1.5m, perlu altitude adjustment)
      4. Lawnmower sweep zona BIRU
      5. Return to Launch (RTL)

    Zona Merah  : X[-175 .. 45], Y[-145 .. 145]  — flat Z=0
    Zona Biru   : X[215  .. 355], Y[-201 .. -87]  — mudun Z=-1.5
    """

    ZONE_RED = {
        "x_min": -175.0, "x_max": 45.0,
        "y_min": -145.0, "y_max": 145.0,
        "ground_z": 0.0,
        "name": "Zona Merah (Sawah Flat)",
    }

    ZONE_BLUE = {
        "x_min": 215.0, "x_max": 355.0,
        "y_min": -201.0, "y_max": -87.0,
        "ground_z": -1.5,
        "name": "Zona Biru (Terrain Mudun)",
    }

    SPAWN_POINT = {"x": -65.0, "y": 0.0, "z": 2.0}

    def __init__(self) -> None:
        super().__init__("field_patrol_mission")

        # ── Parameters ───────────────────────────────────────────────────────
        self.declare_parameter("altitude", 15.0)        # AGL (m) misi utama
        self.declare_parameter("altitude_transition", 20.0)  # AGL saat pindah zona
        self.declare_parameter("altitude_blue_zone", 13.5)   # AGL zona biru (sudah di-offset)
        self.declare_parameter("speed", 5.0)            # m/s kecepatan cruise
        self.declare_parameter("sweep_spacing", 20.0)  # m jarak antar jalur
        self.declare_parameter("pattern", "lawnmower")  # lawnmower | grid | spiral
        self.declare_parameter("waypoint_tolerance", 2.0)  # m radius acceptance
        self.declare_parameter("photo_every_n", 3)         # ambil foto tiap N waypoint

        self.altitude        = self.get_parameter("altitude").value
        self.altitude_trans  = self.get_parameter("altitude_transition").value
        self.altitude_blue   = self.get_parameter("altitude_blue_zone").value
        self.speed           = self.get_parameter("speed").value
        self.sweep_spacing   = self.get_parameter("sweep_spacing").value
        self.pattern         = self.get_parameter("pattern").value
        self.wp_tolerance    = self.get_parameter("waypoint_tolerance").value
        self.photo_every_n   = self.get_parameter("photo_every_n").value

        # ── QoS ──────────────────────────────────────────────────────────────
        sensor_qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
            depth=10,
        )
        reliable_qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            depth=10,
        )

        # ── Publishers ───────────────────────────────────────────────────────
        self.pub_goal = self.create_publisher(
            PoseStamped, "/drone/goal_pose", reliable_qos)
        self.pub_cmd_vel = self.create_publisher(
            Twist, "/drone/cmd_vel", reliable_qos)
        self.pub_mission_status = self.create_publisher(
            String, "/drone/mission_status", reliable_qos)

        # ── Subscribers ──────────────────────────────────────────────────────
        self.sub_odom = self.create_subscription(
            Odometry, "/drone/odom", self.odom_cb, sensor_qos)
        self.sub_gps = self.create_subscription(
            NavSatFix, "/drone/gps", self.gps_cb, sensor_qos)

        # ── State variables ──────────────────────────────────────────────────
        self.current_pose: Optional[PoseStamped] = None
        self.current_gps: Optional[NavSatFix]   = None
        self.mission_active = False
        self.current_wp_idx = 0
        self.photo_counter  = 0
        self.waypoints: List[Waypoint] = []
        # FIX BUG #2: state loiter non-blocking (pengganti time.sleep di callback)
        self._loiter_until: Optional[float] = None

        # ── Generate mission waypoints ────────────────────────────────────────
        self.waypoints = self._generate_lawnmower_waypoints()
        self.get_logger().info(
            f"Mission initialized: {len(self.waypoints)} waypoints generated"
        )
        self._log_mission_summary()

        # ── Mission timer (10 Hz) ─────────────────────────────────────────────
        self.timer = self.create_timer(0.1, self.mission_tick)

    # ─────────────────────────────────────────────────────────────────────────
    def _generate_lawnmower_waypoints(self) -> List[Waypoint]:
        """
        Generate lawnmower (boustrophedon) pattern untuk kedua zona.

        Pattern:
          ┌──────────────────────────────────────────────┐
          │ ZONA MERAH                                   │
          │  →→→→→→→→→→→→→→→→→→  baris N                │
          │                      ↓                       │
          │  ←←←←←←←←←←←←←←←←←←  baris N-1            │
          │  ↓                                           │
          │  →→→→→→→→→→→→→→→→→→  ...                   │
          └──────────────────────────────────────────────┘
               Zona Biru (terrain mudun, altitude adjusted)
        """
        wps: List[Waypoint] = []
        wp_count = 0

        # ── Takeoff waypoint ──────────────────────────────────────────────────
        wps.append(Waypoint(
            x=self.SPAWN_POINT["x"],
            y=self.SPAWN_POINT["y"],
            z=self.altitude,
            label="TAKEOFF",
            loiter_sec=3.0,
        ))

        # ── ZONA MERAH — lawnmower ────────────────────────────────────────────
        zone = self.ZONE_RED
        alt  = self.altitude
        xs   = self._make_sweep_columns(zone["x_min"], zone["x_max"], self.sweep_spacing)
        wps.append(Waypoint(
            x=xs[0], y=zone["y_min"], z=alt,
            label="ZONA_MERAH_START",
        ))

        for i, x in enumerate(xs):
            y_start = zone["y_min"] if (i % 2 == 0) else zone["y_max"]
            y_end   = zone["y_max"] if (i % 2 == 0) else zone["y_min"]

            wps.append(Waypoint(
                x=x, y=y_start, z=alt,
                label=f"RED_COL{i:02d}_A",
                take_photo=(wp_count % self.photo_every_n == 0),
            ))
            wps.append(Waypoint(
                x=x, y=y_end, z=alt,
                label=f"RED_COL{i:02d}_B",
                take_photo=(wp_count % self.photo_every_n == 0),
            ))
            wp_count += 2

        # ── Transisi ke ZONA BIRU (naik ketinggian) ───────────────────────────
        wps.append(Waypoint(
            x=self.ZONE_BLUE["x_min"] - 20.0,
            y=(self.ZONE_BLUE["y_min"] + self.ZONE_BLUE["y_max"]) / 2.0,
            z=self.altitude_trans,
            label="TRANSITION_TO_BLUE",
            loiter_sec=2.0,
        ))

        # ── ZONA BIRU — lawnmower (altitude sudah dikompensasi) ───────────────
        # Terrain mudun Z=-1.5m, jadi altitude AGL tetap sama
        # Drone perlu ada di altitude_blue = altitude_mission - (-1.5) = altitude + 1.5
        zone = self.ZONE_BLUE
        alt  = self.altitude_blue  # = normal_alt + abs(ground_z)
        xs   = self._make_sweep_columns(zone["x_min"], zone["x_max"], self.sweep_spacing)
        wps.append(Waypoint(
            x=xs[0], y=zone["y_min"], z=alt,
            label="ZONA_BIRU_START",
            loiter_sec=1.0,
        ))

        for i, x in enumerate(xs):
            y_start = zone["y_min"] if (i % 2 == 0) else zone["y_max"]
            y_end   = zone["y_max"] if (i % 2 == 0) else zone["y_min"]

            wps.append(Waypoint(
                x=x, y=y_start, z=alt,
                label=f"BLUE_COL{i:02d}_A",
                take_photo=True,   # zona biru selalu foto (terrain berbeda)
            ))
            wps.append(Waypoint(
                x=x, y=y_end, z=alt,
                label=f"BLUE_COL{i:02d}_B",
                take_photo=True,
            ))
            wp_count += 2

        # ── RTL — Return to Launch ─────────────────────────────────────────────
        # FIX: sebelumnya x=self.altitude_trans (nilai ketinggian 20.0 terpakai
        # sebagai koordinat X!) — typo copy-paste. Seharusnya climb dilakukan
        # di tengah zona biru (posisi terakhir sweep) sebelum kembali ke spawn.
        wps.append(Waypoint(
            x=(self.ZONE_BLUE["x_min"] + self.ZONE_BLUE["x_max"]) / 2.0,
            y=(self.ZONE_BLUE["y_min"] + self.ZONE_BLUE["y_max"]) / 2.0,
            z=self.altitude_trans,  # naik dulu
            label="RTL_CLIMB",
        ))
        wps.append(Waypoint(
            x=self.SPAWN_POINT["x"],
            y=self.SPAWN_POINT["y"],
            z=self.altitude,
            label="RTL_OVER_SPAWN",
        ))
        wps.append(Waypoint(
            x=self.SPAWN_POINT["x"],
            y=self.SPAWN_POINT["y"],
            z=0.5,
            label="LANDING",
            loiter_sec=5.0,
        ))

        return wps

    def _make_sweep_columns(self, x_min: float, x_max: float, spacing: float) -> List[float]:
        """Generate list X positions untuk jalur lawnmower."""
        xs = []
        x = x_min
        while x <= x_max:
            xs.append(round(x, 2))
            x += spacing
        if xs[-1] < x_max:
            xs.append(x_max)
        return xs

    # ─────────────────────────────────────────────────────────────────────────
    def odom_cb(self, msg: Odometry) -> None:
        ps = PoseStamped()
        ps.header = msg.header
        ps.pose   = msg.pose.pose
        self.current_pose = ps

    def gps_cb(self, msg: NavSatFix) -> None:
        self.current_gps = msg

    # ─────────────────────────────────────────────────────────────────────────
    def mission_tick(self) -> None:
        """Dipanggil 10 Hz — logic navigasi waypoint sederhana."""
        if not self.mission_active:
            self._publish_status("IDLE")
            return

        if self.current_wp_idx >= len(self.waypoints):
            self._publish_status("MISSION_COMPLETE")
            self.mission_active = False
            self.get_logger().info("Mission complete! All waypoints reached.")
            return

        wp = self.waypoints[self.current_wp_idx]

        # Publish goal
        goal = PoseStamped()
        goal.header.stamp = self.get_clock().now().to_msg()
        goal.header.frame_id = "map"
        goal.pose.position.x = wp.x
        goal.pose.position.y = wp.y
        goal.pose.position.z = wp.z
        goal.pose.orientation.w = 1.0
        self.pub_goal.publish(goal)

        # FIX BUG #2: Loiter non-blocking. Sebelumnya time.sleep(loiter_sec)
        # di dalam timer callback membekukan SELURUH node (odom_cb, gps_cb,
        # semua publisher) selama 3-5 detik pada single-threaded executor.
        # Sekarang loiter dilakukan sebagai state: callback tetap return cepat
        # dan node terus menerima feedback odometry selama menunggu.
        if self._loiter_until is not None:
            if time.monotonic() < self._loiter_until:
                self._publish_status(f"LOITERING:{wp.label}:{self.current_wp_idx+1}/{len(self.waypoints)}")
                return  # masih loiter — goal terakhir tetap dipegang drone
            # Loiter selesai — lanjut ke waypoint berikutnya
            self._loiter_until = None
            self.get_logger().info(f"  WP reached: [{wp.label}] ({self.current_wp_idx+1}/{len(self.waypoints)})")
            self.current_wp_idx += 1
            return

        self._publish_status(f"NAVIGATING:{wp.label}:{self.current_wp_idx+1}/{len(self.waypoints)}")

        # Cek apakah sudah sampai (hanya berdasarkan pose jika tersedia)
        if self.current_pose and self._reached_waypoint(wp):
            if wp.take_photo:
                self._trigger_camera()
            if wp.loiter_sec > 0:
                # Mulai loiter non-blocking; increment wp_idx ditunda sampai selesai
                self._loiter_until = time.monotonic() + wp.loiter_sec
                return
            self.get_logger().info(f"  WP reached: [{wp.label}] ({self.current_wp_idx+1}/{len(self.waypoints)})")
            self.current_wp_idx += 1

    def _reached_waypoint(self, wp: Waypoint) -> bool:
        """Cek apakah drone sudah dalam radius acceptance waypoint."""
        if self.current_pose is None:
            return False
        dx = self.current_pose.pose.position.x - wp.x
        dy = self.current_pose.pose.position.y - wp.y
        dz = self.current_pose.pose.position.z - wp.z
        return math.sqrt(dx*dx + dy*dy + dz*dz) < self.wp_tolerance

    def _trigger_camera(self) -> None:
        """Kirim trigger ke sistem kamera (implementasi sesuai hardware)."""
        self.photo_counter += 1
        self.get_logger().info(f"  📸 Photo taken #{self.photo_counter}")
        # TODO: publish ke /drone/camera/trigger atau gunakan action camera

    def _publish_status(self, status: str) -> None:
        msg = String()
        msg.data = status
        self.pub_mission_status.publish(msg)

    def _log_mission_summary(self) -> None:
        red_count  = sum(1 for wp in self.waypoints if "RED" in wp.label)
        blue_count = sum(1 for wp in self.waypoints if "BLUE" in wp.label)
        self.get_logger().info("=" * 55)
        self.get_logger().info("  AGRICULTURAL DRONE MISSION SUMMARY")
        self.get_logger().info("=" * 55)
        self.get_logger().info(f"  Total waypoints  : {len(self.waypoints)}")
        self.get_logger().info(f"  Zona Merah (WP)  : {red_count}")
        self.get_logger().info(f"  Zona Biru  (WP)  : {blue_count}")
        self.get_logger().info(f"  Cruise altitude  : {self.altitude} m AGL")
        self.get_logger().info(f"  Blue zone alt    : {self.altitude_blue} m AGL (terrain -1.5m)")
        self.get_logger().info(f"  Sweep spacing    : {self.sweep_spacing} m")
        self.get_logger().info(f"  Pattern          : {self.pattern}")
        self.get_logger().info("=" * 55)

    # ── Public API ────────────────────────────────────────────────────────────
    def start_mission(self) -> None:
        self.mission_active = True
        self.current_wp_idx = 0
        self._loiter_until = None  # FIX BUG #2: reset state loiter
        self.get_logger().info("Mission STARTED")

    def abort_mission(self) -> None:
        self.mission_active = False
        self._loiter_until = None  # FIX BUG #2: reset state loiter
        # Hover in place
        self.pub_cmd_vel.publish(Twist())
        self.get_logger().warn("Mission ABORTED — drone hovering")


# ─────────────────────────────────────────────────────────────────────────────
def main(args=None) -> None:
    rclpy.init(args=args)
    node = FieldPatrolMission()

    # Auto-start setelah 3 detik (bisa diganti dengan service call)
    import threading
    def delayed_start():
        time.sleep(3.0)
        node.start_mission()
    threading.Thread(target=delayed_start, daemon=True).start()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        node.abort_mission()
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
