#!/usr/bin/env python3

import heapq
import json
import math
import threading
import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

import rclpy
from geometry_msgs.msg import Point, PoseStamped, Quaternion, Twist
from nav_msgs.msg import Odometry, Path
from mavros_msgs.msg import State
from mavros_msgs.srv import CommandBool, SetMode, CommandTOL
from sensor_msgs.msg import BatteryState
from rclpy.executors import MultiThreadedExecutor, ExternalShutdownException
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile,
    QoSReliabilityPolicy,
    QoSDurabilityPolicy,
    QoSHistoryPolicy,
    qos_profile_sensor_data,
)
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from std_srvs.srv import Trigger

WORLD = {"x_min": -190.0, "x_max": 370.0, "y_min": -220.0, "y_max": 160.0}

@dataclass
class Pose2D:
    x: float
    y: float
    z: float
    yaw: float = 0.0

@dataclass(frozen=True)
class FieldZone:
    name: str
    x_min: float
    x_max: float
    y_min: float
    y_max: float
    ground_z: float

    def bounds_with_margin(self, margin: float) -> Tuple[float, float, float, float]:
        max_margin = min(self.x_max - self.x_min, self.y_max - self.y_min) * 0.45
        safe_margin = max(0.0, min(margin, max_margin))
        return (
            self.x_min + safe_margin,
            self.x_max - safe_margin,
            self.y_min + safe_margin,
            self.y_max - safe_margin,
        )

@dataclass(frozen=True)
class SurveySegment:
    kind: str
    p0: Tuple[float, float, float]
    p1: Tuple[float, float, float]
    p2: Optional[Tuple[float, float, float]] = None

def yaw_to_quaternion(yaw: float) -> Quaternion:
    q = Quaternion()
    q.z = math.sin(yaw * 0.5)
    q.w = math.cos(yaw * 0.5)
    return q

def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))

import concurrent.futures

class DashboardBridgeNode(Node):
    def __init__(self) -> None:
        super().__init__("dashboard_bridge_node")

        # Callback Groups untuk Multi-threading
        # 1. Group untuk kontrol kritis (Timer 20Hz & Odom) - Harus lancar tanpa interupsi
        self.control_cb_group = MutuallyExclusiveCallbackGroup()
        # 2. Group untuk Service berat & Planner (A*, Boustrophedon) - Boleh paralel/lambat
        self.planner_cb_group = ReentrantCallbackGroup()
        # 3. Group untuk data sensor & statis
        self.sensor_cb_group = MutuallyExclusiveCallbackGroup()

        self.declare_parameter("marker_frame", "map")
        self.declare_parameter("spawn_x", -65.0)
        self.declare_parameter("spawn_y", 0.0)
        self.declare_parameter("takeoff_altitude", 8.0)
        self.declare_parameter("landing_altitude", 0.3)
        self.declare_parameter("manual_speed", 3.5)
        self.declare_parameter("vertical_speed", 3.0)
        self.declare_parameter("yaw_rate", 1.5)
        self.declare_parameter("cruise_speed", 3.5)
        
        self.declare_parameter("sweep_spacing", 20.0)
        self.declare_parameter("edge_margin", 5.0)
        
        self.declare_parameter("goal_acceptance_radius", 2.0)
        self.declare_parameter("planner_resolution", 1.0)
        self.declare_parameter("low_battery_threshold", 0.10)
        self.declare_parameter("wind_abort_threshold", 8.0)
        self.declare_parameter("offboard_setpoint_rate", 20.0)

        self.frame_id = self.get_parameter("marker_frame").value
        self.spawn_x = float(self.get_parameter("spawn_x").value)
        self.spawn_y = float(self.get_parameter("spawn_y").value)
        self.takeoff_altitude = float(self.get_parameter("takeoff_altitude").value)
        self.landing_altitude = float(self.get_parameter("landing_altitude").value)
        self.manual_speed = float(self.get_parameter("manual_speed").value)
        self.vertical_speed = float(self.get_parameter("vertical_speed").value)
        self.yaw_rate = float(self.get_parameter("yaw_rate").value)
        self.cruise_speed = float(self.get_parameter("cruise_speed").value)
        
        self.sweep_spacing = float(self.get_parameter("sweep_spacing").value)
        self.edge_margin = float(self.get_parameter("edge_margin").value)
        
        self.goal_acceptance_radius = float(self.get_parameter("goal_acceptance_radius").value)
        self.planner_resolution = float(self.get_parameter("planner_resolution").value)
        self.low_battery_threshold = float(self.get_parameter("low_battery_threshold").value)
        self.wind_abort_threshold = float(self.get_parameter("wind_abort_threshold").value)
        self.setpoint_period = 1.0 / max(2.0, float(self.get_parameter("offboard_setpoint_rate").value))

        # 3 Palm Trees from agricultural_field.sdf
        self.obstacles = [
            {"id": "pohon_sawit_01", "kind": "tree", "x": -40.0, "y": 0.0, "radius": 4.0, "clearance": 2.0, "height": 12.0, "source": "gazebo_sdf"},
            {"id": "pohon_sawit_02", "kind": "tree", "x": -20.0, "y": 0.0, "radius": 4.0, "clearance": 2.0, "height": 12.0, "source": "gazebo_sdf"},
            {"id": "pohon_sawit_03", "kind": "tree", "x": 0.0, "y": 0.0, "radius": 4.0, "clearance": 2.0, "height": 12.0, "source": "gazebo_sdf"},
        ]

        for obs in self.obstacles:
            obs["active"] = True

        # === ORBIT MISSION PARAMETERS ===
        self.declare_parameter("orbit_radius", 5.0)       # meters from tree center
        self.declare_parameter("orbit_speed", 3.5)        # m/s tangential speed
        self.declare_parameter("orbit_altitude", 8.0)     # meters AGL
        self.declare_parameter("orbit_num_laps", 1)       # full 360° laps per tree
        self.declare_parameter("orbit_points_per_lap", 20) # waypoints per 360°

        self.orbit_radius = float(self.get_parameter("orbit_radius").value)
        self.orbit_speed = float(self.get_parameter("orbit_speed").value)
        self.orbit_altitude = float(self.get_parameter("orbit_altitude").value)
        self.orbit_num_laps = int(self.get_parameter("orbit_num_laps").value)
        self.orbit_points_per_lap = int(self.get_parameter("orbit_points_per_lap").value)

        # === ORBIT STATE ===
        self.orbit_trees: List[Dict] = []        # ordered list of trees to visit
        self.orbit_tree_index: int = 0            # which tree we're heading to / orbiting
        self.orbit_phase: str = "idle"             # "approach" | "orbit" | "transit" | "rtl" | "idle"
        self.orbit_wp_index: int = 0              # current waypoint in orbit circle
        self.orbit_waypoints: List[Pose2D] = []   # generated circle waypoints for current tree
        self.orbit_center: Optional[Dict] = None  # current tree being orbited
        self.orbit_approach_path: List[Pose2D] = []  # path from current pos to orbit entry
        self.orbit_completed_trees: List[str] = []   # IDs of orbited trees
        
        # === INTEGRATED AUTO-ORBIT SURVEY STATE ===
        self.survey_saved_path: List[Pose2D] = []
        self.survey_saved_path_index: int = 0
        self.survey_saved_active: bool = False
        self.orbit_visited_trees: set = set()

        self.current_pose: Optional[Pose2D] = None
        self.home_pose: Optional[Pose2D] = None
        self.last_goal: Optional[Pose2D] = None
        self.manual_cmd = Twist()
        self.manual_cmd_time = 0.0
        self.mode = "idle"
        
        self.total_auto_time = 0.0
        self.total_manual_time = 0.0
        self.total_auto_battery = 0.0
        self.total_manual_battery = 0.0
        self.last_tick_time = time.monotonic()
        self.last_battery = None
        
        self.planning_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.planning_future = None
        self.offboard_requested = False
        # FIX BUG #3: Lock untuk melindungi pasangan (path, path_index) dari
        # race condition antara thread ThreadPoolExecutor (done_cb planner)
        # dan thread MultiThreadedExecutor (control_tick 20Hz).
        self._path_lock = threading.Lock()
        self.path: List[Pose2D] = []
        self.path_index = 0
        self.actual_path: List[Pose2D] = []
        self.last_trail_pose: Optional[Pose2D] = None
        self.battery: Dict[str, float] = {}
        self.vehicle_status: Dict[str, object] = {}
        self.wind: Dict[str, float] = {"speed": 0.0, "north": 0.0, "east": 0.0}
        self.nearest_obstacle_m: Optional[float] = None
        self.scan_sample: List[float] = []
        self.mission_start_time = None
        self.mission_distance_m = 0.0
        self.mission_start_battery = None
        self.rtl_triggered = False
        self._auto_takeoff_pending = False
        self._auto_takeoff_time = 0.0
        self._last_lidar_replan = 0.0       
        self._lidar_replan_cooldown = 0.5   
        self.survey_active = False
        
        self._survey_start_time = 0.0

        self.sp_x = None
        self.sp_y = None
        self.sp_z = None

        # === AUTOMATIC RTH STATE VARIABLES ===
        self.journey_status = "Idle"
        self.home_pose_saved = False
        self.outbound_path: List[Pose2D] = []
        self.return_path: List[Pose2D] = []
        self.rth_wait_start_time: Optional[float] = None
        self.is_rth_waiting = False
        self.departure_time_str = None
        self.arrival_time_str = None
        self.rth_start_time_str = None
        self.landing_time_str = None
        self.battery_used_percent = 0.0
        self.total_duration_sec = 0
        self.current_mission_id = 0

        self.create_subscription(Twist, "/cmd_vel", self.cmd_vel_cb, 10, callback_group=self.control_cb_group)
        self.create_subscription(PoseStamped, "/dashboard/goal_pose", self.goal_cb, 10, callback_group=self.planner_cb_group)
        self.create_subscription(LaserScan, "/drone/lidar/scan", self.lidar_cb, qos_profile_sensor_data, callback_group=self.sensor_cb_group)
        self.create_subscription(PoseStamped, "/mavros/local_position/pose", self.local_pose_cb, 10, callback_group=self.control_cb_group)
        self.create_subscription(BatteryState, "/mavros/battery", self.battery_cb, 10, callback_group=self.sensor_cb_group)
        self.create_subscription(State, "/mavros/state", self.vehicle_state_cb, 10, callback_group=self.sensor_cb_group)
        self.create_subscription(String, "/dashboard/active_mission", self.active_mission_cb, 10, callback_group=self.sensor_cb_group)

        self.odom_pub = self.create_publisher(Odometry, "/odom", 10)
        self.state_pub = self.create_publisher(String, "/dashboard/state", 10)
        self.obstacles_pub = self.create_publisher(String, "/dashboard/obstacles", 10)
        self.sensor_pub = self.create_publisher(String, "/dashboard/sensor_scan", 10)
        self.metrics_pub = self.create_publisher(String, "/dashboard/metrics", 10)
        self.path_pub = self.create_publisher(Path, "/dashboard/planned_path", 10)
        self.actual_path_pub = self.create_publisher(Path, "/dashboard/actual_path", 10)
        self.paths_json_pub = self.create_publisher(String, "/dashboard/paths_json", 10)
        self.global_path = []
        self.local_path = []
        self.final_path = []
        self.trajectory_pub = self.create_publisher(PoseStamped, "/mavros/setpoint_position/local", 10)
        self.velocity_pub = self.create_publisher(Twist, "/mavros/setpoint_velocity/cmd_vel", 10)

        # MAVROS Service Clients
        self.arming_client = self.create_client(CommandBool, "/mavros/cmd/arming")
        self.set_mode_client = self.create_client(SetMode, "/mavros/set_mode")
        self.takeoff_client = self.create_client(CommandTOL, "/mavros/cmd/takeoff")
        self.land_client = self.create_client(CommandTOL, "/mavros/cmd/land")

        self.create_service(Trigger, "/start_gazebo", self.start_gazebo_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/arm", self.arm_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/takeoff", self.takeoff_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/land", self.land_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/return_home", self.return_home_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/emergency_stop", self.emergency_stop_cb, callback_group=self.control_cb_group)
        self.create_service(Trigger, "/force_arm_takeoff", self.force_arm_takeoff_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/start_auto_survey", self.start_auto_survey_cb, callback_group=self.planner_cb_group)
        self.create_service(Trigger, "/start_orbit_mission", self.start_orbit_mission_cb, callback_group=self.planner_cb_group)

        self.create_timer(self.setpoint_period, self.control_tick, callback_group=self.control_cb_group)
        self.create_timer(0.5, self.publish_dashboard_state, callback_group=self.sensor_cb_group)
        self.get_logger().info("ArduPilot MAVROS dashboard bridge ready. MultiThreadedExecutor Aktif.")

    def now_us(self) -> int: return int(self.get_clock().now().nanoseconds / 1000)

    def cmd_vel_cb(self, msg: Twist) -> None:
        self.manual_cmd = msg
        self.manual_cmd_time = time.monotonic()
        if self.mode not in ("auto", "survey_countdown"):
            self.mode = "manual"
            self.offboard_requested = True
            
            is_armed = self.vehicle_status.get("armed", False)
            if msg.linear.z > 0.1 and not is_armed:
                self.get_logger().info("Manual UP detected while disarmed: Auto-arming drone...")
                self.call_arm(True)

    def goal_cb(self, msg: PoseStamped) -> None:
        if self.current_pose is None:
            self.publish_status("goal_rejected", "PX4 local position belum tersedia.")
            return

        pose_age = time.monotonic() - getattr(self, '_last_pose_time', 0.0)
        if pose_age > 3.0:
            self.publish_status("goal_rejected", f"Posisi drone sudah stale ({pose_age:.1f}s). Menunggu telemetry terbaru.")
            return

        self.survey_active = False
        self.survey_saved_path = []
        self.obstacles = [obs for obs in self.obstacles if obs["source"] == "gazebo_sdf"]
        for obs in self.obstacles: obs["active"] = False

        from datetime import datetime
        goal = Pose2D(x=float(msg.pose.position.x), y=float(msg.pose.position.y), z=float(msg.pose.position.z) or self.current_pose.z, yaw=self.current_pose.yaw)
        self.last_goal = goal
        start = self.current_pose
        self.get_logger().info(f"Goal diterima. Menghitung rute: ({start.x:.1f}, {start.y:.1f}, {start.z:.1f}) → Goal: ({goal.x:.1f}, {goal.y:.1f}, {goal.z:.1f})")
        
        self.path = [] # Kosongkan path saat computing
        self.mode = "auto" # Pindah mode auto, drone akan hold position (karena path kosong)
        self.publish_status("planning", "Menghitung Global Path...")
        
        def done_cb(fut):
            if fut.cancelled(): return
            # FIX BUG #3: Update path + path_index secara atomik dalam lock
            with self._path_lock:
                self.path = fut.result()
                self.path_index = 0
                self.outbound_path = list(self.path)
                self.return_path = []
            self.offboard_requested = True
            self.mission_start_time = time.monotonic()
            self.mission_distance_m = 0.0
            self.departure_time_str = datetime.now().isoformat()
            self.arrival_time_str = None
            self.rth_start_time_str = None
            self.landing_time_str = None
            self.battery_used_percent = 0.0
            self.total_duration_sec = 0
            self.journey_status = "Navigating to Target"
            self.publish_path()
            self.get_logger().info("Global Path selesai dihitung.")
            self.publish_status("auto", "Path siap, memulai navigasi.")
            
        if self.planning_future and not self.planning_future.done():
            self.planning_future.cancel()
        self.planning_future = self.planning_executor.submit(self.plan_path, start, goal)
        self.planning_future.add_done_callback(done_cb)
        self.mission_start_battery = self.battery.get("remaining")
        self.rtl_triggered = False
        self.publish_path()
        self.publish_status("mission_started", f"A* path: {len(self.path)} waypoint, goal=({goal.x:.1f}, {goal.y:.1f}, {goal.z:.1f})")

    def start_auto_survey_cb(self, _request: Trigger.Request, response: Trigger.Response):
        if self.current_pose is None:
            response.success = False
            response.message = "Gagal memulai survey: PX4 local position belum siap."
            return response

        self.obstacles = [obs for obs in self.obstacles if obs["source"] == "gazebo_sdf"]
        for obs in self.obstacles: obs["active"] = False
        self.orbit_visited_trees = set()
        self.survey_saved_path = []

        self.get_logger().info("Menghitung rute optimal Boustrophedon untuk 4 Blok Sawah...")
        survey_wps = self.generate_boustrophedon_path()
        
        if not survey_wps:
            response.success = False
            response.message = "Matriks pembagian area gagal dihitung."
            return response

        self.path = survey_wps
        self.path_index = 0
        self.outbound_path = list(self.path)
        self.return_path = []
        self.survey_active = True
        self.offboard_requested = True
        self.last_goal = self.path[-1]

        self.mode = "survey_countdown"
        self._survey_start_time = time.monotonic() + 4.0  
        
        self.publish_path()
        response.success = True
        response.message = f"Rute Boustrophedon digambar! Drone akan bergerak dalam 4 detik."
        self.publish_status("survey_ready", response.message)
        return response

    def local_pose_cb(self, msg: PoseStamped) -> None:
        q = msg.pose.orientation
        siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
        cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
        yaw_enu = math.atan2(siny_cosp, cosy_cosp)
        
        pose = Pose2D()
        pose.x = float(msg.pose.position.x) + self.spawn_x
        pose.y = float(msg.pose.position.y) + self.spawn_y
        pose.z = float(msg.pose.position.z)
        pose.yaw = yaw_enu
        self.set_current_pose(pose)

    def battery_cb(self, msg: BatteryState) -> None:
        remaining = float(msg.percentage) if msg.percentage >= 0.0 else None
        self.battery = {
            "connected": True,
            "remaining": remaining,
            "voltage": float(msg.voltage),
            "current": float(msg.current) if math.isfinite(msg.current) else 0.0,
            "timeRemaining": None,
            "warning": 0
        }
        if remaining is not None and remaining <= self.low_battery_threshold and not self.rtl_triggered:
            self.trigger_return_home("battery_low")

    def vehicle_state_cb(self, msg: State) -> None:
        was_armed = self.vehicle_status.get("armed", False)
        self.vehicle_status = {
            "armed": bool(msg.armed),
            "navState": 14 if msg.mode == "GUIDED" else 0,
            "navStateName": str(msg.mode),
            "failsafe": False,
            "acceptsOffboard": bool(msg.guided)
        }
        if was_armed and not msg.armed and self.journey_status == "Landing":
            from datetime import datetime
            self.journey_status = "Completed"
            self.mode = "hold"
            self.landing_time_str = datetime.now().isoformat()
            if self.mission_start_time is not None:
                self.total_duration_sec = int(time.monotonic() - self.mission_start_time)
            else:
                self.total_duration_sec = 0
            if self.mission_start_battery is not None and self.battery.get("remaining") is not None:
                self.battery_used_percent = float(self.mission_start_battery - self.battery.get("remaining")) * 100.0
            else:
                self.battery_used_percent = 0.0
            self.publish_status("mission_completed_db", f"Misi selesai! Durasi: {self.total_duration_sec}s, Jarak: {self.mission_distance_m:.1f}m, Baterai terpakai: {self.battery_used_percent:.1f}%")

    def lidar_cb(self, msg: LaserScan) -> None:
        valid_ranges = []
        for i, r in enumerate(msg.ranges):
            angle_relative = msg.angle_min + (i * msg.angle_increment)
            if -1.05 <= angle_relative <= 1.05:  
                if math.isfinite(r) and 2.5 < r < msg.range_max:
                    valid_ranges.append((r, angle_relative))

        stride = max(1, len(msg.ranges) // 90)
        self.scan_sample = [float(r) if math.isfinite(r) else float(msg.range_max) for r in msg.ranges[::stride]][:90]
        if not valid_ranges:
            self.nearest_obstacle_m = None
            return

        min_range, min_angle_rel = min(valid_ranges, key=lambda x: x[0])
        self.nearest_obstacle_m = min_range
        now = time.monotonic()
        
        if (self.mode == "auto" and (now - self._last_lidar_replan) > self._lidar_replan_cooldown):
            replanned = False
            
            for dist, angle_rel in valid_ranges:
                if dist >= 15.0:
                    continue
                    
                if self.current_pose:
                    angle_absolute = self.current_pose.yaw + angle_rel
                    hit_x = self.current_pose.x + dist * math.cos(angle_absolute)
                    hit_y = self.current_pose.y + dist * math.sin(angle_absolute)
                    
                    hit_static_tree = False
                    closest_obs = None
                    min_dist = float('inf')
                    
                    for obs in self.obstacles:
                        if obs.get("source") == "gazebo_sdf":
                            dist_to_center = math.hypot(hit_x - float(obs["x"]), hit_y - float(obs["y"]))
                            if dist_to_center < min_dist:
                                min_dist = dist_to_center
                                closest_obs = obs
                    
                    if closest_obs and min_dist <= (float(closest_obs["radius"]) + 8.0):
                        if not closest_obs.get("active", False):
                            closest_obs["active"] = True  
                            self.get_logger().warn(f"LiDAR: Mengaktifkan rintangan peta statis '{closest_obs['id']}'! A* menghindari area tersebut.")
                            replanned = True
                        hit_static_tree = True
                    
                    if not hit_static_tree:
                        is_new = True
                        for obs in self.obstacles:
                            if obs.get("source") == "lidar":
                                if math.hypot(hit_x - float(obs["x"]), hit_y - float(obs["y"])) < 4.0:
                                    is_new = False
                                    break
                        if is_new:
                            # Push the obstacle center 2.0m INTO the tree to cover the trunk properly
                            obs_x = self.current_pose.x + (dist + 2.0) * math.cos(angle_absolute)
                            obs_y = self.current_pose.y + (dist + 2.0) * math.sin(angle_absolute)
                            
                            self.obstacles.append({"id": f"dyn_lidar_{int(now * 1000)}_{int(dist)}", "kind": "tree", "x": obs_x, "y": obs_y, "radius": 2.5, "clearance": 2.0, "height": 10.0, "source": "lidar"})
                            self.get_logger().warn(f"LiDAR: Obstacle BARU terdeteksi di {dist:.1f}m. Menambahkan ke A*!")
                            replanned = True
                            
            if replanned:
                self._last_lidar_replan = now
                self.replan_from_current("lidar_obstacle")

    def set_current_pose(self, pose: Pose2D) -> None:
        self._last_pose_time = time.monotonic()
        if self.home_pose is None: self.home_pose = Pose2D(pose.x, pose.y, pose.z, pose.yaw)
        if self.vehicle_status.get("armed", False) and pose.z > 0.3:
            if not self.home_pose_saved:
                self.home_pose = Pose2D(pose.x, pose.y, pose.z, pose.yaw)
                self.home_pose_saved = True
                self.get_logger().info(f"Home pose recorded at takeoff: {self.home_pose.x:.2f}, {self.home_pose.y:.2f}, {self.home_pose.z:.2f}")
        if self.current_pose is not None and self.mission_start_time is not None:
            self.mission_distance_m += self.distance_xy(self.current_pose, pose)
        self.current_pose = pose
        self.publish_odom(pose)

        if self.last_trail_pose is None or self.distance_xy(self.last_trail_pose, pose) > 0.35:
            self.actual_path.append(Pose2D(pose.x, pose.y, pose.z, pose.yaw))
            self.last_trail_pose = pose
            if len(self.actual_path) > 2000: self.actual_path = self.actual_path[-2000:]
            self.publish_actual_path()

    def control_tick(self) -> None:
        now = time.monotonic()
        dt = now - self.last_tick_time
        self.last_tick_time = now

        current_battery = self.battery.get("remaining")
        if self.last_battery is not None and current_battery is not None:
            delta = self.last_battery - current_battery
            if delta > 0:
                if self.mode in ("auto", "survey_countdown", "takeoff", "return_home"):
                    self.total_auto_battery += delta
                elif self.mode == "manual":
                    self.total_manual_battery += delta
        self.last_battery = current_battery

        if self.mode in ("auto", "return_home", "takeoff", "survey_countdown", "orbit"):
            self.total_auto_time += dt
        elif self.mode == "manual":
            self.total_manual_time += dt

        if self.current_pose is None: return
        if self.mode == "idle": self.publish_position_setpoint(self.current_pose, current_cruise_speed=1.5)

        # Hover wait timer checking before proceeding with auto navigation
        if self.is_rth_waiting and self.rth_wait_start_time is not None:
            if time.monotonic() - self.rth_wait_start_time >= 5.0:
                self.is_rth_waiting = False
                self.rth_wait_start_time = None
                self.start_automatic_rth()

        if self._auto_takeoff_pending and time.monotonic() >= self._auto_takeoff_time:
            self._auto_takeoff_pending = False
            self.mode = "takeoff"
            self._takeoff_triggered = False
            self.survey_active = False
            self.publish_status("auto_takeoff", "Takeoff otomatis dimulai...")

        if self.mode in ("auto", "return_home"): 
            self.follow_path_tick()
        elif self.mode == "grid_patrol": # fallback
            self.follow_path_tick()
        elif self.mode == "orbit":
            self.orbit_tick()
        elif self.mode == "manual": 
            self.manual_tick()
        elif self.mode == "survey_countdown":
            self.publish_position_setpoint(self.current_pose, current_cruise_speed=1.5)
            if time.monotonic() >= self._survey_start_time:
                from datetime import datetime
                self.mode = "auto"
                self.mission_start_time = time.monotonic()
                self.mission_distance_m = 0.0
                self.mission_start_battery = self.battery.get("remaining")
                self.rtl_triggered = False
                self.departure_time_str = datetime.now().isoformat()
                self.arrival_time_str = None
                self.rth_start_time_str = None
                self.landing_time_str = None
                self.battery_used_percent = 0.0
                self.total_duration_sec = 0
                self.journey_status = "Navigating to Target"
                self.publish_status("mission_started", "Waktu tunggu selesai. Misi survey dimulai!")
                
        elif self.mode == "takeoff":
            is_armed = self.vehicle_status.get("armed", False)
            is_guided = self.vehicle_status.get("navStateName") == "GUIDED"
            
            if not is_guided:
                self.call_set_mode("GUIDED")
            elif not is_armed:
                self.call_arm(True)
            else:
                if not getattr(self, "_takeoff_triggered", False):
                    self.call_takeoff(self.takeoff_altitude)
                    self._takeoff_triggered = True
                    self.publish_status("takeoff_climb", f"Takeoff dipicu menuju {self.takeoff_altitude}m.")
            
            if self.current_pose.z >= self.takeoff_altitude - 0.5:
                self.mode = "hold"
                self._takeoff_triggered = False
                self.sp_x = self.current_pose.x
                self.sp_y = self.current_pose.y
                self.sp_z = self.current_pose.z
                self.publish_status("takeoff_complete", "Takeoff selesai. Hovering.")

        elif self.mode == "hold":
            if self.path and 0 <= self.path_index < len(self.path):
                target = self.path[self.path_index]
            else:
                target = self.current_pose
            self.publish_position_setpoint(target, current_cruise_speed=1.5)

        if self.offboard_requested or (self.mode in ("manual", "takeoff") and self.vehicle_status.get("navStateName") != "GUIDED"):
            self.call_set_mode("GUIDED")
            self.offboard_requested = False

    def manual_tick(self) -> None:
        age = time.monotonic() - self.manual_cmd_time
        cmd = self.manual_cmd if age < 0.45 else Twist()
        self.publish_velocity_setpoint(cmd)

    def follow_path_tick(self) -> None:
        # FIX BUG #3: seluruh pembacaan/increment (path, path_index) dilindungi
        # lock yang sama dengan done_cb planner. Body cepat (<1ms) di 20Hz,
        # dan done_cb hanya memegang lock sesaat, jadi tidak ada risiko deadlock.
        with self._path_lock:
            self._follow_path_tick_locked()

    def _follow_path_tick_locked(self) -> None:
        if not self.path or self.current_pose is None: return

        # Check proximity to unvisited trees during autonomous flight for auto-orbit
        if self.mode == "auto" or self.survey_active:
            for obs in self.obstacles:
                if obs.get("kind") == "tree" and obs.get("id") not in self.orbit_visited_trees:
                    dist = math.hypot(self.current_pose.x - float(obs["x"]), self.current_pose.y - float(obs["y"]))
                    if dist < 8.0:  # trigger distance in meters
                        self.get_logger().warn(f"Auto-Orbit Triggered! Tree: {obs['id']} at dist: {dist:.1f}m")
                        self.orbit_visited_trees.add(obs["id"])
                        
                        # Save current survey/goal state
                        self.survey_saved_path = list(self.path)
                        self.survey_saved_path_index = self.path_index
                        self.survey_saved_active = self.survey_active
                        self.survey_active = False
                        
                        # Initialize orbit parameters
                        self.orbit_center = obs
                        self.orbit_tree_index = 0
                        self.orbit_trees = [obs]
                        self.orbit_wp_index = 0
                        self.orbit_completed_trees = []
                        self.mode = "orbit"
                        self.sp_x = None
                        
                        # Generate approach path to entry point
                        tx, ty = float(obs["x"]), float(obs["y"])
                        angle_to_drone = math.atan2(self.current_pose.y - ty, self.current_pose.x - tx)
                        entry_x = tx + self.orbit_radius * math.cos(angle_to_drone)
                        entry_y = ty + self.orbit_radius * math.sin(angle_to_drone)
                        entry_point = Pose2D(entry_x, entry_y, self.orbit_altitude, 0.0)
                        
                        self.path = [entry_point]
                        self.path_index = 0
                        self.global_path = list(self.path)
                        self.orbit_phase = "approach"
                        
                        self.orbit_waypoints = self._generate_orbit_waypoints(tx, ty, angle_to_drone)
                        self.publish_path()
                        self.publish_status("auto_orbit", f"Mendeteksi {obs['id']} pada jarak {dist:.1f}m. Memulai auto-orbit.")
                        return

        target = self.path[min(self.path_index, len(self.path) - 1)]
        
        lookahead_dist = max(self.goal_acceptance_radius, self.cruise_speed * 0.5)
        
        # Pure Pursuit Lookahead: skip points that are too close
        while self.path_index < len(self.path) - 1:
            if self.distance_xy(self.current_pose, target) <= lookahead_dist:
                self.path_index += 1
                target = self.path[self.path_index]
            else:
                break
                
        if self.path_index >= len(self.path) - 1 and self.distance_xy(self.current_pose, target) <= self.goal_acceptance_radius:
            from datetime import datetime
            if self.mode == "auto" and self.journey_status == "Navigating to Target":
                self.mode = "hold"
                self.path = []
                self.sp_x = None
                self.survey_active = False
                self.publish_position_setpoint(self.current_pose, current_cruise_speed=1.5)
                self.journey_status = "Mission Completed - Waiting 5 Seconds"
                self.arrival_time_str = datetime.now().isoformat()
                self.is_rth_waiting = True
                self.rth_wait_start_time = time.monotonic()
                self.publish_status("mission_wait_5s", "Misi selesai. Menunggu 5 detik (hover) sebelum Return to Home otomatis...")
                return
            elif self.mode == "return_home" and self.journey_status == "Returning to Home":
                self.mode = "land"
                self.path = []
                self.sp_x = None
                self.journey_status = "Landing"
                self.landing_time_str = None
                self.call_set_mode("LAND")
                self.publish_status("landing_rth", "Tiba di Home. Memulai pendaratan otomatis secara halus...")
                return
            else:
                self.mode = "hold"
                self.path = []
                self.sp_x = None
                self.survey_active = False
                self.publish_position_setpoint(self.current_pose, current_cruise_speed=1.5)
                self.publish_status("mission_complete", "Misi selesai. Holding position.")
                return
            
        # Calculate target speed based on upcoming corner (Macro Lookahead Deceleration)
        target_speed = self.cruise_speed
        
        macro_idx = self.path_index
        dist_accum = 0.0
        # Look ahead enough to brake! (at least 2.0 seconds of travel time)
        lookahead_search_dist = max(15.0, self.cruise_speed * 2.0)
        
        while macro_idx < len(self.path) - 1 and dist_accum < lookahead_search_dist:
            dist_accum += self.distance_xy(self.path[macro_idx], self.path[macro_idx+1])
            macro_idx += 1
            
        if macro_idx > self.path_index:
            macro_target = self.path[macro_idx]
            
            dx1 = target.x - self.current_pose.x
            dy1 = target.y - self.current_pose.y
            dx2 = macro_target.x - target.x
            dy2 = macro_target.y - target.y
            
            angle1 = math.atan2(dy1, dx1)
            angle2 = math.atan2(dy2, dx2)
            delta_theta = abs((angle2 - angle1 + math.pi) % (2 * math.pi) - math.pi)
            
            # Map corner speed: 0 deg -> cruise_speed, 90 deg -> 1.5 m/s
            corner_speed = max(1.5, self.cruise_speed * (1.0 - (delta_theta / (math.pi / 2.0))))
            
            dist_to_corner = math.hypot(dx1, dy1)
            braking_dist = lookahead_search_dist
            
            if dist_to_corner < braking_dist:
                target_speed = corner_speed + (self.cruise_speed - corner_speed) * (dist_to_corner / braking_dist)
                
        self.publish_position_setpoint(target, target_speed)

    def publish_offboard_control_mode(self) -> None:
        msg = OffboardControlMode()
        msg.timestamp = self.now_us()
        # FIX BUG #1: "takeoff_spinup" WAJIB masuk daftar position-control.
        # Tanpa ini, selama 1.8 detik spin-up PX4 menerima OffboardControlMode
        # dengan SEMUA field False bersamaan dengan permintaan masuk OFFBOARD,
        # menyebabkan drone bergoyang (wobble) sebelum naik vertikal.
        msg.position = self.mode in ("auto", "takeoff", "takeoff_spinup", "return_home", "hold", "idle", "survey_countdown", "orbit")
        msg.velocity = self.mode == "manual"
        msg.acceleration = False; msg.attitude = False; msg.body_rate = False; msg.thrust_and_torque = False; msg.direct_actuator = False
        self.offboard_pub.publish(msg)

    def call_arm(self, arm: bool) -> None:
        if not self.arming_client.wait_for_service(timeout_sec=1.0):
            self.get_logger().error("Arming service not available!")
            return
        req = CommandBool.Request()
        req.value = arm
        self.arming_client.call_async(req)

    def call_set_mode(self, mode: str) -> None:
        if not self.set_mode_client.wait_for_service(timeout_sec=1.0):
            self.get_logger().error("SetMode service not available!")
            return
        req = SetMode.Request()
        req.custom_mode = mode
        self.set_mode_client.call_async(req)

    def call_takeoff(self, altitude: float) -> None:
        if not self.takeoff_client.wait_for_service(timeout_sec=1.0):
            self.get_logger().error("Takeoff service not available!")
            return
        req = CommandTOL.Request()
        req.altitude = altitude
        req.latitude = 0.0
        req.longitude = 0.0
        req.min_pitch = 0.0
        req.yaw = 0.0
        self.takeoff_client.call_async(req)

    def publish_position_setpoint(self, pose: Pose2D, current_cruise_speed: float = None) -> None:
        if self.current_pose is None: return
        
        if current_cruise_speed is None:
            current_cruise_speed = self.cruise_speed

        dt = self.setpoint_period
        max_d_xy = current_cruise_speed * dt
        max_d_z = self.vertical_speed * dt

        if self.sp_x is None or not self.vehicle_status.get("armed", False):
            self.sp_x = self.current_pose.x
            self.sp_y = self.current_pose.y

        # Prevent carrot from falling behind or getting too far during aggressive maneuvers
        dist_to_drone = math.hypot(self.sp_x - self.current_pose.x, self.sp_y - self.current_pose.y)
        if dist_to_drone > 3.0:
            self.sp_x = self.current_pose.x
            self.sp_y = self.current_pose.y

        dx_sp = pose.x - self.sp_x
        dy_sp = pose.y - self.sp_y
        dist_sp = math.hypot(dx_sp, dy_sp)

        if dist_sp > max_d_xy:
            self.sp_x += (dx_sp / dist_sp) * max_d_xy
            self.sp_y += (dy_sp / dist_sp) * max_d_xy
        else:
            self.sp_x = pose.x; self.sp_y = pose.y

        if self.sp_z is None:
            self.sp_z = self.current_pose.z

        dz_sp = pose.z - self.sp_z
        
        # When close to the target altitude (within 0.5m), reduce step rate
        if abs(dz_sp) < 0.5:
            effective_max_d_z = max_d_z * 0.4
        else:
            effective_max_d_z = max_d_z

        if abs(dz_sp) > effective_max_d_z:
            self.sp_z += math.copysign(effective_max_d_z, dz_sp)
        else:
            self.sp_z = pose.z

        msg = PoseStamped()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = self.frame_id
        
        msg.pose.position.x = float(self.sp_x - self.spawn_x)
        msg.pose.position.y = float(self.sp_y - self.spawn_y)
        msg.pose.position.z = float(self.sp_z)
        
        dx_drone = pose.x - self.current_pose.x
        dy_drone = pose.y - self.current_pose.y
        dist_drone = math.hypot(dx_drone, dy_drone)
        
        if self.mode in ("auto", "return_home", "orbit") and dist_drone > 0.2:
            target_yaw_enu = math.atan2(dy_drone, dx_drone)
            msg.pose.orientation = yaw_to_quaternion(target_yaw_enu)
        else:
            msg.pose.orientation = yaw_to_quaternion(pose.yaw)
            
        self.trajectory_pub.publish(msg)

    def publish_velocity_setpoint(self, cmd: Twist) -> None:
        self.velocity_pub.publish(cmd)

    def force_arm_takeoff_cb(self, _request: Trigger.Request, response: Trigger.Response):
        self.call_arm(True)
        self._auto_takeoff_pending = True
        self._auto_takeoff_time = time.monotonic() + 4.0
        response.success = True; response.message = f"Force arm dikirim. Takeoff otomatis dalam 4 detik."
        self.publish_status("force_arm_takeoff", response.message)
        return response

    def start_gazebo_cb(self, _request: Trigger.Request, response: Trigger.Response):
        response.success = True; response.message = "Gunakan simulation launcher. Node ini tidak membuat mock Gazebo."
        return response

    def arm_cb(self, _request: Trigger.Request, response: Trigger.Response):
        self.call_arm(True)
        response.success = True; response.message = "ArduPilot arm command dikirim."
        return response

    def takeoff_cb(self, _request: Trigger.Request, response: Trigger.Response):
        if self.current_pose is None:
            response.success = False; response.message = "Tidak ada local position."
            return response
        self.mode = "takeoff"
        self._takeoff_triggered = False
        response.success = True; response.message = f"Takeoff otonom menuju {self.takeoff_altitude:.1f} m dimulai."
        return response

    def land_cb(self, _request: Trigger.Request, response: Trigger.Response):
        self.mode = "land"; self.survey_active = False
        self.call_set_mode("LAND")
        response.success = True; response.message = "ArduPilot LAND mode dikirim."
        return response

    def return_home_cb(self, _request: Trigger.Request, response: Trigger.Response):
        self.trigger_return_home("operator")
        response.success = True; response.message = "Return-to-home dikirim."
        return response

    def emergency_stop_cb(self, _request: Trigger.Request, response: Trigger.Response):
        self.mode = "hold"; self.path = []; self.sp_x = None; self.manual_cmd = Twist(); self.survey_active = False
        self.survey_saved_path = []
        if self.current_pose: self.publish_position_setpoint(self.current_pose)
        self.call_set_mode("LOITER")
        self.publish_status("emergency_stop", "EMERGENCY STOP TRIGGERED. Drone ditahan (LOITER).")
        response.success = True; response.message = "Emergency stop: Mode LOITER diaktifkan."
        return response

    def trigger_return_home(self, reason: str) -> None:
        self.rtl_triggered = True; self.survey_active = False
        self.survey_saved_path = []
        if self.home_pose and self.current_pose:
            high_home = Pose2D(self.home_pose.x, self.home_pose.y, max(self.current_pose.z, 6.0), self.home_pose.yaw)
            self.path = []
            self.mode = "return_home"
            
            def done_cb(fut):
                if fut.cancelled(): return
                with self._path_lock:
                    self.path = fut.result()
                    self.path_index = 0
                self.publish_path()
                
            if self.planning_future and not self.planning_future.done(): self.planning_future.cancel()
            self.planning_future = self.planning_executor.submit(self.plan_path, self.current_pose, high_home)
            self.planning_future.add_done_callback(done_cb)
        self.call_set_mode("RTL")
        self.publish_status("return_home", f"RTL dipicu: {reason}.")

    def replan_from_current(self, reason: str) -> None:
        if self.current_pose is None: return
        
        # --- HYBRID RRT*-A* LOCAL PLANNER DENGAN ODI (Sesuai Bab 3) ---
        if self.global_path:
            # 1. Cari titik re-entry aman terdekat di jalur Boustrophedon
            resume_idx = self.path_index
            found_safe = False
            while resume_idx < len(self.global_path):
                wp = self.global_path[resume_idx]
                wp_blocked = False
                for obs in self.obstacles:
                    if obs.get("source") == "gazebo_sdf" and not obs.get("active", False): continue
                    radius = float(obs["radius"]) + float(obs["clearance"])
                    if math.hypot(wp.x - float(obs["x"]), wp.y - float(obs["y"])) <= radius:
                        wp_blocked = True
                        break
                if not wp_blocked:
                    found_safe = True
                    break
                resume_idx += 1
        
            if found_safe:
                local_goal = self.global_path[resume_idx]
                
                # 2. Kalkulasi Obstacle Density Index (ODI) di sekitar Drone (Radius 15m)
                # Menghitung berapa banyak rintangan yang terdeteksi oleh LiDAR saat ini
                obs_count = sum(1 for obs in self.obstacles if math.hypot(self.current_pose.x - float(obs["x"]), self.current_pose.y - float(obs["y"])) < 15.0)
                
                # 3. Logika Pemilihan (Switching Logic) Hybrid RRT*-A*
                # Jika renggang (<= 2 rintangan), gunakan A* agar rute sangat optimal.
                # Jika padat (> 2 rintangan), gunakan RRT* agar kalkulasi edge computing lebih cepat.
                if obs_count <= 2:
                    self.get_logger().info(f"ODI Rendah ({obs_count} rintangan). Memilih A* untuk Detour.")
                    detour_grid = self.a_star((self.current_pose.x, self.current_pose.y), (local_goal.x, local_goal.y))
                    alg_name = "A*"
                else:
                    self.get_logger().info(f"ODI Tinggi ({obs_count} rintangan). Memilih RRT* untuk Detour.")
                    detour_grid = self.rrt((self.current_pose.x, self.current_pose.y), (local_goal.x, local_goal.y))
                    alg_name = "RRT*"

                if detour_grid:
                    # 4. Penghalusan Jalur menggunakan Kurva Bézier
                    pruned_detour = self.smooth_path(detour_grid)
                    smoothed_detour = self.bezier_corner_smoothing(pruned_detour, corner_dist=4.0, num_samples=10)
                    
                    # 5. Gabungkan Rute Halus dengan Jalur Utama
                    self.local_path = [Pose2D(x, y, local_goal.z, local_goal.yaw) for x, y in smoothed_detour]
                    # FIX BUG #3: atomic update path + path_index
                    with self._path_lock:
                        self.path = self.local_path + self.global_path[resume_idx:]
                        self.path_index = 0
                    self.publish_path()
                    self.publish_status("replan", f"Hybrid {alg_name} detour halus dibuat menghindari rintangan ({reason}).")
                    return
        # --------------------------------------------------------------

        if self.last_goal is None: return
        self.publish_status("replan", f"Menghitung ulang Global Path karena {reason}...")
        def done_cb(fut):
            if fut.cancelled(): return
            # FIX BUG #3: atomic update path + path_index
            with self._path_lock:
                self.path = fut.result()
                self.global_path = list(self.path)
                self.local_path = []
                self.path_index = 0
            self.publish_path()
            self.publish_status("replan", f"Global Path siap.")
            
        if self.planning_future and not self.planning_future.done(): self.planning_future.cancel()
        self.planning_future = self.planning_executor.submit(self.plan_path, self.current_pose, self.last_goal)
        self.planning_future.add_done_callback(done_cb)
        self.publish_status("replan", f"Global A* Path replanned karena {reason}.")

    def plan_path(self, start: Pose2D, goal: Pose2D) -> List[Pose2D]:
        self.local_path = []
        grid_path = self.a_star((start.x, start.y), (goal.x, goal.y))
        if not grid_path:
            self.get_logger().error("A*: TERJEBAK! Drone memaksa HOLD POSITION demi keamanan.")
            self.mode = "hold"; self.path = []; self.sp_x = None
            return self.path
            
        pruned_path = self.smooth_path(grid_path)
        smoothed_path = self.bezier_corner_smoothing(pruned_path, corner_dist=6.0, num_samples=10)
        
        waypoints = [Pose2D(x, y, goal.z, goal.yaw) for x, y in smoothed_path]
        return waypoints

    # ================================================================
    # ORBIT MISSION: Visit each tree and orbit 360° around it
    # ================================================================
    def start_orbit_mission_cb(self, _request: Trigger.Request, response: Trigger.Response):
        if self.current_pose is None:
            response.success = False
            response.message = "Gagal: PX4 local position belum siap."
            return response

        # Collect all static trees from obstacles list
        trees = [obs for obs in self.obstacles if obs.get("source") == "gazebo_sdf" and obs.get("kind") == "tree"]
        if not trees:
            response.success = False
            response.message = "Tidak ada pohon ditemukan dalam daftar obstacles."
            return response

        # Sort trees by Y coordinate for sequential visiting
        trees = sorted(trees, key=lambda t: (float(t["x"]), float(t["y"])))

        self.orbit_trees = trees
        self.orbit_tree_index = 0
        self.orbit_completed_trees = []
        self.orbit_phase = "approach"
        self.orbit_center = None
        self.orbit_waypoints = []
        self.orbit_wp_index = 0
        self.survey_active = False
        self.mode = "orbit"
        self.offboard_requested = True
        self.mission_start_time = time.monotonic()
        self.mission_distance_m = 0.0
        self.mission_start_battery = self.battery.get("remaining")
        self.rtl_triggered = False

        # Start approaching the first tree
        self._orbit_start_approach()

        self.publish_path()
        response.success = True
        response.message = f"Orbit mission dimulai! {len(trees)} pohon akan dikunjungi."
        self.publish_status("orbit_started", response.message)
        return response

    def _orbit_start_approach(self) -> None:
        """Generate path from current position to the orbit entry point of current tree."""
        if self.orbit_tree_index >= len(self.orbit_trees):
            # All trees visited - resume survey/goal if paused
            if self.survey_saved_path:
                self.get_logger().info("Orbit completed! Resuming flight path...")
                self.path = list(self.survey_saved_path)
                self.path_index = self.survey_saved_path_index
                self.survey_active = self.survey_saved_active
                self.mode = "auto"
                self.survey_saved_path = []
                self.sp_x = None
                self.global_path = list(self.path)
                self.publish_path()
                
                status_msg = "Melanjutkan misi survey." if self.survey_active else "Melanjutkan perjalanan ke target."
                self.publish_status("survey_resume", f"Mengorbit selesai. {status_msg}")
                return

            # All trees visited - return home
            self.orbit_phase = "rtl"
            self.get_logger().info("Orbit mission: Semua pohon selesai! Kembali ke home.")
            if self.home_pose and self.current_pose:
                high_home = Pose2D(self.home_pose.x, self.home_pose.y, self.orbit_altitude, self.home_pose.yaw)
                self.path = []
                def done_cb(fut):
                    if fut.cancelled(): return
                    # FIX BUG #3: atomic update path + path_index
                    with self._path_lock:
                        self.path = fut.result()
                        self.path_index = 0
                        self.global_path = list(self.path)
                    self.publish_path()
                    self.publish_status("orbit_rtl", "Semua pohon telah di-orbit. Kembali ke titik awal.")
                if self.planning_future and not self.planning_future.done(): self.planning_future.cancel()
                self.planning_future = self.planning_executor.submit(self.plan_path, self.current_pose, high_home)
                self.planning_future.add_done_callback(done_cb)
            return

        tree = self.orbit_trees[self.orbit_tree_index]
        self.orbit_center = tree
        tx, ty = float(tree["x"]), float(tree["y"])

        # Calculate orbit entry point: closest point on circle to drone
        if self.current_pose:
            angle_to_drone = math.atan2(self.current_pose.y - ty, self.current_pose.x - tx)
        else:
            angle_to_drone = 0.0

        entry_x = tx + self.orbit_radius * math.cos(angle_to_drone)
        entry_y = ty + self.orbit_radius * math.sin(angle_to_drone)
        entry_point = Pose2D(entry_x, entry_y, self.orbit_altitude, 0.0)

        # Plan path from current pos to entry point
        self.orbit_phase = "approach"
        self.path = []
        if self.current_pose:
            def done_cb(fut):
                if fut.cancelled(): return
                # FIX BUG #3: atomic update path + path_index
                with self._path_lock:
                    self.path = fut.result()
                    self.path_index = 0
                    self.global_path = list(self.path)
                
            if self.planning_future and not self.planning_future.done(): self.planning_future.cancel()
            self.planning_future = self.planning_executor.submit(self.plan_path, self.current_pose, entry_point)
            self.planning_future.add_done_callback(done_cb)
        else:
            self.path = [entry_point]
            self.path_index = 0
            self.global_path = list(self.path)
        self.orbit_phase = "approach"

        # Generate orbit waypoints for this tree
        self.orbit_waypoints = self._generate_orbit_waypoints(tx, ty, angle_to_drone)
        self.orbit_wp_index = 0

        self.get_logger().info(f"Orbit: Approaching tree '{tree['id']}' at ({tx:.1f}, {ty:.1f}), entry at ({entry_x:.1f}, {entry_y:.1f})")
        self.publish_path()
        self.publish_status("orbit_approach", f"Menuju pohon {tree['id']} ({self.orbit_tree_index+1}/{len(self.orbit_trees)})")

    def _generate_orbit_waypoints(self, cx: float, cy: float, start_angle: float) -> List[Pose2D]:
        """Generate circular orbit waypoints around (cx, cy) starting from start_angle."""
        waypoints = []
        total_points = self.orbit_points_per_lap * self.orbit_num_laps
        for i in range(total_points + 1):  # +1 to close the loop
            angle = start_angle + (2.0 * math.pi * i / self.orbit_points_per_lap)
            wx = cx + self.orbit_radius * math.cos(angle)
            wy = cy + self.orbit_radius * math.sin(angle)
            # Yaw faces toward tree center
            yaw_to_center = math.atan2(cy - wy, cx - wx)
            waypoints.append(Pose2D(wx, wy, self.orbit_altitude, yaw_to_center))
        return waypoints

    def orbit_tick(self) -> None:
        """State machine tick for orbit mission."""
        if self.current_pose is None:
            return

        if self.orbit_phase == "approach":
            # Follow path to orbit entry point
            if not self.path:
                self.orbit_phase = "orbit"
                self.sp_x = None  # Reset setpoint carrot
                self.get_logger().info(f"Orbit: Arrived at entry point. Starting orbit around '{self.orbit_center['id']}'.")
                self.publish_status("orbit_circling", f"Mengelilingi pohon {self.orbit_center['id']}")
                return

            target = self.path[min(self.path_index, len(self.path) - 1)]
            lookahead_dist = max(self.goal_acceptance_radius, self.cruise_speed * 0.5)

            while self.path_index < len(self.path) - 1:
                if self.distance_xy(self.current_pose, target) <= lookahead_dist:
                    self.path_index += 1
                    target = self.path[self.path_index]
                else:
                    break

            if self.path_index >= len(self.path) - 1 and self.distance_xy(self.current_pose, target) <= self.goal_acceptance_radius:
                # Reached entry point - start orbit
                self.orbit_phase = "orbit"
                self.sp_x = None
                self.get_logger().info(f"Orbit: Starting 360° orbit around '{self.orbit_center['id']}'.")
                self.publish_status("orbit_circling", f"Mengelilingi pohon {self.orbit_center['id']}")
                return

            self.publish_position_setpoint(target, self.cruise_speed)

        elif self.orbit_phase == "orbit":
            # Follow orbit waypoints with yaw facing the tree
            if self.orbit_wp_index >= len(self.orbit_waypoints):
                # Orbit complete for this tree
                tree_id = self.orbit_center["id"] if self.orbit_center else "?"
                self.orbit_completed_trees.append(tree_id)
                self.get_logger().info(f"Orbit: Completed orbit around '{tree_id}'!")
                self.publish_status("orbit_complete", f"Orbit selesai untuk {tree_id} ({len(self.orbit_completed_trees)}/{len(self.orbit_trees)})")

                # Move to next tree
                self.orbit_tree_index += 1
                self.sp_x = None
                self._orbit_start_approach()
                return

            target = self.orbit_waypoints[self.orbit_wp_index]

            # Check if close enough to advance
            if self.distance_xy(self.current_pose, target) <= 1.5:
                self.orbit_wp_index += 1
                if self.orbit_wp_index < len(self.orbit_waypoints):
                    target = self.orbit_waypoints[self.orbit_wp_index]
                else:
                    return  # Will handle completion on next tick

            # Publish position setpoint with yaw facing tree center
            self._publish_orbit_setpoint(target)

        elif self.orbit_phase == "rtl":
            # Follow path home
            self.follow_path_tick()
            # Check if we arrived home
            if not self.path or (self.path_index >= len(self.path) - 1 and self.home_pose and self.distance_xy(self.current_pose, self.home_pose) <= self.goal_acceptance_radius):
                self.mode = "hold"
                self.path = []
                self.sp_x = None
                self.orbit_phase = "idle"
                self.publish_status("orbit_mission_complete", f"Misi orbit selesai! {len(self.orbit_completed_trees)} pohon telah dikunjungi.")

    def _publish_orbit_setpoint(self, target: Pose2D) -> None:
        """Publish setpoint for orbit mode with yaw facing tree center."""
        if self.current_pose is None or self.orbit_center is None:
            return

        dt = self.setpoint_period
        max_d_xy = self.orbit_speed * dt
        max_d_z = self.vertical_speed * dt

        if self.sp_x is None:
            self.sp_x = self.current_pose.x
            self.sp_y = self.current_pose.y

        dist_to_drone = math.hypot(self.sp_x - self.current_pose.x, self.sp_y - self.current_pose.y)
        if dist_to_drone > 3.0:
            self.sp_x = self.current_pose.x
            self.sp_y = self.current_pose.y

        dx_sp = target.x - self.sp_x
        dy_sp = target.y - self.sp_y
        dist_sp = math.hypot(dx_sp, dy_sp)

        if dist_sp > max_d_xy:
            self.sp_x += (dx_sp / dist_sp) * max_d_xy
            self.sp_y += (dy_sp / dist_sp) * max_d_xy
        else:
            self.sp_x = target.x
            self.sp_y = target.y

        if self.sp_z is None:
            self.sp_z = self.current_pose.z
        dz_sp = target.z - self.sp_z
        if abs(dz_sp) > max_d_z:
            self.sp_z += math.copysign(max_d_z, dz_sp)
        else:
            self.sp_z = target.z

        msg = TrajectorySetpoint()
        msg.timestamp = self.now_us()
        local_x = self.sp_x - self.spawn_x
        local_y = self.sp_y - self.spawn_y
        msg.position = [float(local_y), float(local_x), float(-self.sp_z)]

        # Velocity feedforward
        if dist_sp > max_d_xy:
            vel_x = (dx_sp / dist_sp) * self.orbit_speed
            vel_y = (dy_sp / dist_sp) * self.orbit_speed
        else:
            vel_x = 0.0
            vel_y = 0.0
        vel_z = math.copysign(self.vertical_speed, dz_sp) if abs(dz_sp) > max_d_z else 0.0
        msg.velocity = [float(vel_y), float(vel_x), float(-vel_z)]
        msg.acceleration = [float("nan"), float("nan"), float("nan")]
        msg.jerk = [float("nan"), float("nan"), float("nan")]

        # Yaw faces the tree center
        cx = float(self.orbit_center["x"])
        cy = float(self.orbit_center["y"])
        yaw_enu = math.atan2(cy - self.current_pose.y, cx - self.current_pose.x)
        yaw_ned = math.pi / 2.0 - yaw_enu
        yaw_ned = (yaw_ned + math.pi) % (2 * math.pi) - math.pi
        msg.yaw = float(yaw_ned)
        msg.yawspeed = float("nan")
        self.trajectory_pub.publish(msg)

    def generate_boustrophedon_path(self) -> List[Pose2D]:
        zones = [
            FieldZone("sawah_kiri", -175.0, 45.0, -145.0, 145.0, 0.0),
            FieldZone("sawah_kanan_atas", 45.0, 325.0, -87.5, 87.5, 0.0),
            FieldZone("sawah_tengah_bawah", 45.0, 215.0, -201.5, -86.5, 0.0),
            FieldZone("sawah_biru_mudun", 215.0, 355.0, -201.5, -86.5, -1.5),
        ]
        
        margin = self.edge_margin
        spacing = self.sweep_spacing
        t_radius = 8.0
        
        # PERBAIKAN KRUSIAL: Memperlebar titik sampling menjadi 4.0 meter. 
        # Ini mencegah pembuatan puluhan ribu data poin yang menyebabkan UI / ROSBridge Hang.
        setpoint_space = 4.0 
        
        segments = []
        current = (self.current_pose.x, self.current_pose.y, self.takeoff_altitude)
        segments.append(SurveySegment("line", current, current))
        
        remaining = list(zones)
        while remaining:
            best_zone_candidate = None
            best_score = float("inf")
            
            for zone in remaining:
                candidates = []
                x_min, x_max, y_min, y_max = zone.bounds_with_margin(margin)
                width = x_max - x_min; height = y_max - y_min
                long_axis = "y" if height >= width else "x"
                
                for reverse_lanes in (False, True):
                    for first_starts_at_max in (False, True):
                        z_val = self.takeoff_altitude + zone.ground_z
                        lane_segments = []
                        actual_turn_radius = min(t_radius, spacing * 0.75)
                        
                        if long_axis == "y":
                            lanes = self._make_sweep_positions_helper(x_min, x_max, spacing)
                            if reverse_lanes: lanes.reverse()
                            center_y = (y_min + y_max) * 0.5
                            prev_end = None; f_point = None
                            
                            for idx, x in enumerate(lanes):
                                start_at_max = first_starts_at_max if idx % 2 == 0 else not first_starts_at_max
                                y_start = y_max if start_at_max else y_min
                                y_end = y_min if start_at_max else y_max
                                lane_start = (x, y_start, z_val)
                                lane_end = (x, y_end, z_val)
                                
                                if f_point is None: f_point = lane_start
                                if prev_end is not None:
                                    ctrl = ((prev_end[0] + lane_start[0]) * 0.5, prev_end[1] + (actual_turn_radius if prev_end[1] >= center_y else -actual_turn_radius), z_val)
                                    lane_segments.append(SurveySegment("bezier" if t_radius > 1e-3 else "line", prev_end, ctrl, lane_start) if t_radius > 1e-3 else SurveySegment("line", prev_end, lane_start))
                                lane_segments.append(SurveySegment("line", lane_start, lane_end))
                                prev_end = lane_end
                        else:
                            lanes = self._make_sweep_positions_helper(y_min, y_max, spacing)
                            if reverse_lanes: lanes.reverse()
                            center_x = (x_min + x_max) * 0.5
                            prev_end = None; f_point = None
                            
                            for idx, y in enumerate(lanes):
                                start_at_max = first_starts_at_max if idx % 2 == 0 else not first_starts_at_max
                                x_start = x_max if start_at_max else x_min
                                x_end = x_min if start_at_max else x_max
                                lane_start = (x_start, y, z_val)
                                lane_end = (x_end, y, z_val)
                                
                                if f_point is None: f_point = lane_start
                                if prev_end is not None:
                                    ctrl = (prev_end[0] + (actual_turn_radius if prev_end[0] >= center_x else -actual_turn_radius), (prev_end[1] + lane_start[1]) * 0.5, z_val)
                                    lane_segments.append(SurveySegment("bezier" if t_radius > 1e-3 else "line", prev_end, ctrl, lane_start) if t_radius > 1e-3 else SurveySegment("line", prev_end, lane_start))
                                lane_segments.append(SurveySegment("line", lane_start, lane_end))
                                prev_end = lane_end
                                
                        candidates.append({"zone": zone, "start": f_point, "end": prev_end, "segments": lane_segments})
                        
            for candidate in candidates:
                approach_cost = math.sqrt((candidate["start"][0] - current[0])**2 + (candidate["start"][1] - current[1])**2)
                following_starts = []
                for f_zone in remaining:
                    if f_zone == zone: continue
                    fx_min, fx_max, fy_min, fy_max = f_zone.bounds_with_margin(margin)
                    flanes_x = self._make_sweep_positions_helper(fx_min, fx_max, spacing)
                    flanes_y = self._make_sweep_positions_helper(fy_min, fy_max, spacing)
                    fz_val = self.takeoff_altitude + f_zone.ground_z
                    if (fy_max - fy_min) >= (fx_max - fx_min):
                        for rx in (flanes_x[0], flanes_x[-1]):
                            for ry in (fy_min, fy_max): following_starts.append((rx, ry, fz_val))
                    else:
                        for ry in (flanes_y[0], flanes_y[-1]):
                            for rx in (fx_min, fx_max): following_starts.append((rx, ry, fz_val))
                            
                lookahead_cost = min(math.sqrt((candidate["end"][0] - fs[0])**2 + (candidate["end"][1] - fs[1])**2) for fs in following_starts) if following_starts else 0.0
                score = approach_cost + 0.35 * lookahead_cost
                if score < best_score:
                    best_score = score
                    best_zone_candidate = candidate
                    
            segments.extend(best_zone_candidate["segments"])
            current = best_zone_candidate["end"]
            remaining.remove(best_zone_candidate["zone"])
            
        segments.append(SurveySegment("line", current, (self.spawn_x, self.spawn_y, self.takeoff_altitude)))
        
        sampled_points = []
        for seg in segments:
            if seg.kind == "line":
                if not sampled_points: sampled_points.append(seg.p0)
                dist = math.sqrt((seg.p1[0]-seg.p0[0])**2 + (seg.p1[1]-seg.p0[1])**2 + (seg.p1[2]-seg.p0[2])**2)
                if dist > 1e-6:
                    steps = max(1, math.ceil(dist / setpoint_space))
                    for idx in range(1, steps + 1):
                        r = idx / steps
                        sampled_points.append((seg.p0[0] + (seg.p1[0] - seg.p0[0]) * r, seg.p0[1] + (seg.p1[1] - seg.p0[1]) * r, seg.p0[2] + (seg.p1[2] - seg.p0[2]) * r))
            elif seg.kind == "bezier":
                if not sampled_points: sampled_points.append(seg.p0)
                approx_len = math.sqrt((seg.p1[0]-seg.p0[0])**2 + (seg.p1[1]-seg.p0[1])**2) + math.sqrt((seg.p2[0]-seg.p1[0])**2 + (seg.p2[1]-seg.p1[1])**2)
                steps = max(1, math.ceil(approx_len / setpoint_space))
                for idx in range(1, steps + 1):
                    t = idx / steps; one_minus_t = 1.0 - t
                    pt = (
                        one_minus_t * one_minus_t * seg.p0[0] + 2.0 * one_minus_t * t * seg.p1[0] + t * t * seg.p2[0],
                        one_minus_t * one_minus_t * seg.p0[1] + 2.0 * one_minus_t * t * seg.p1[1] + t * t * seg.p2[1],
                        one_minus_t * one_minus_t * seg.p0[2] + 2.0 * one_minus_t * t * seg.p1[2] + t * t * seg.p2[2]
                    )
                    sampled_points.append(pt)
                    
        return [Pose2D(p[0], p[1], p[2], self.current_pose.yaw) for p in sampled_points]

    def _make_sweep_positions_helper(self, lower: float, upper: float, spacing: float) -> List[float]:
        if upper < lower: lower, upper = upper, lower
        width = upper - lower
        if width <= spacing: return [round((lower + upper) * 0.5, 3)]
        values = [lower]
        cursor = lower + spacing
        while cursor < upper:
            values.append(cursor)
            cursor += spacing
        if upper - values[-1] > 1e-6: values.append(upper)
        return [round(v, 3) for v in values]


    def rrt(self, start: Tuple[float, float], goal: Tuple[float, float], step_size: float = 3.0, max_iter: int = 1500) -> List[Tuple[float, float]]:
        import random
        
        def line_crosses_obstacle_rrt(a: Tuple[float, float], b: Tuple[float, float]) -> bool:
            ax, ay = a; bx, by = b
            dx, dy = bx - ax, by - ay
            denom = dx * dx + dy * dy
            if denom <= 1e-9: return False
            for obstacle in self.obstacles:
                if obstacle.get("source") == "gazebo_sdf" and not obstacle.get("active", False): continue
                ox, oy = float(obstacle["x"]), float(obstacle["y"])
                radius = float(obstacle["radius"]) + float(obstacle["clearance"])
                
                # ESCAPE LOGIC: If starting point is inside the obstacle, but the new point is moving AWAY from the center, allow it!
                dist_sq_a = (ax - ox)**2 + (ay - oy)**2
                if dist_sq_a <= radius*radius:
                    dist_sq_b = (bx - ox)**2 + (by - oy)**2
                    if dist_sq_b > dist_sq_a:
                        continue 
                        
                t = clamp(((ox - ax) * dx + (oy - ay) * dy) / denom, 0.0, 1.0)
                closest_x, closest_y = ax + t * dx, ay + t * dy
                if (closest_x - ox)**2 + (closest_y - oy)**2 <= radius*radius: return True
            return False

        class Node:
            def __init__(self, x, y):
                self.x = x; self.y = y; self.parent = None
        
        start_node = Node(start[0], start[1])
        nodes = [start_node]
        for _ in range(max_iter):
            rnd = (goal[0], goal[1]) if random.random() < 0.2 else (random.uniform(WORLD["x_min"], WORLD["x_max"]), random.uniform(WORLD["y_min"], WORLD["y_max"]))
            nearest = min(nodes, key=lambda n: (n.x - rnd[0])**2 + (n.y - rnd[1])**2)
            theta = math.atan2(rnd[1] - nearest.y, rnd[0] - nearest.x)
            new_x = nearest.x + step_size * math.cos(theta)
            new_y = nearest.y + step_size * math.sin(theta)
            
            if not line_crosses_obstacle_rrt((nearest.x, nearest.y), (new_x, new_y)):
                new_node = Node(new_x, new_y); new_node.parent = nearest; nodes.append(new_node)
                if (new_node.x - goal[0])**2 + (new_node.y - goal[1])**2 <= step_size*step_size and not line_crosses_obstacle_rrt((new_node.x, new_node.y), goal):
                    goal_node = Node(goal[0], goal[1]); goal_node.parent = new_node; nodes.append(goal_node)
                    path = []; curr = goal_node
                    while curr is not None: path.append((curr.x, curr.y)); curr = curr.parent
                    path.reverse()
                    return path
        return []

    def a_star(self, start: Tuple[float, float], goal: Tuple[float, float]) -> List[Tuple[float, float]]:
        res = self.planner_resolution
        x_min, x_max = WORLD["x_min"], WORLD["x_max"]
        y_min, y_max = WORLD["y_min"], WORLD["y_max"]

        def to_cell(p: Tuple[float, float]) -> Tuple[int, int]:
            return (int(round((clamp(p[0], x_min, x_max) - x_min) / res)), int(round((clamp(p[1], y_min, y_max) - y_min) / res)))

        def to_world(c: Tuple[int, int]) -> Tuple[float, float]:
            return (x_min + c[0] * res, y_min + c[1] * res)

        def blocked(c: Tuple[int, int]) -> bool:
            x, y = to_world(c)
            for obstacle in self.obstacles:
                if obstacle.get("source") == "gazebo_sdf" and not obstacle.get("active", True): continue
                radius = float(obstacle["radius"]) + float(obstacle["clearance"])
                if math.hypot(x - float(obstacle["x"]), y - float(obstacle["y"])) <= radius: return True
            return False

        start_c = to_cell(start); goal_c = to_cell(goal)
        start_is_blocked = blocked(start_c)
        open_set: List[Tuple[float, Tuple[int, int]]] = [(0.0, start_c)]
        came_from: Dict[Tuple[int, int], Tuple[int, int]] = {}
        g_score: Dict[Tuple[int, int], float] = {start_c: 0.0}
        neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
        max_x, max_y = int(round((x_max - x_min) / res)), int(round((y_max - y_min) / res))

        while open_set:
            _, current = heapq.heappop(open_set)
            if current == goal_c:
                cells = [current]
                while current in came_from:
                    current = came_from[current]
                    cells.append(current)
                return [to_world(c) for c in reversed(cells)]

            for dx, dy in neighbors:
                nxt = (current[0] + dx, current[1] + dy)
                if not (0 <= nxt[0] <= max_x and 0 <= nxt[1] <= max_y): continue
                
                is_nxt_blocked = blocked(nxt)
                
                # Cannot enter a blocked cell from a free cell. Can only move through blocked if escaping.
                if is_nxt_blocked and nxt != goal_c:
                    if not blocked(current):
                        continue
                    cost_multiplier = 100.0
                else:
                    cost_multiplier = 1.0
                    
                step_cost = math.sqrt(dx * dx + dy * dy)
                tentative = g_score[current] + step_cost * cost_multiplier
                
                if tentative < g_score.get(nxt, float("inf")):
                    came_from[nxt] = current; g_score[nxt] = tentative
                    heuristic = math.hypot(nxt[0] - goal_c[0], nxt[1] - goal_c[1])
                    heapq.heappush(open_set, (tentative + heuristic, nxt))
        return []

    def smooth_path(self, points: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
        if len(points) <= 2: return points
        smoothed = [points[0]]; previous = points[0]
        for point in points[1:-1]:
            if self.line_crosses_obstacle(smoothed[-1], point): smoothed.append(previous)
            previous = point
        smoothed.append(points[-1])
        return smoothed

    def bezier_corner_smoothing(self, points: List[Tuple[float, float]], corner_dist: float = 6.0, num_samples: int = 10) -> List[Tuple[float, float]]:
        if len(points) < 3: return points
        smoothed = [points[0]]
        
        for i in range(1, len(points) - 1):
            p0_orig = points[i - 1]
            p1 = points[i]
            p2 = points[i + 1]
            
            d1 = math.hypot(p1[0] - p0_orig[0], p1[1] - p0_orig[1])
            d2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
            
            # Max corner dist is half of the shortest adjacent segment
            c_dist = min(corner_dist, d1 / 2.0, d2 / 2.0)
            
            if d1 > 1e-3:
                t1 = (d1 - c_dist) / d1
                A = (p0_orig[0] + t1 * (p1[0] - p0_orig[0]), p0_orig[1] + t1 * (p1[1] - p0_orig[1]))
            else: A = p1
            
            if d2 > 1e-3:
                t2 = c_dist / d2
                B = (p1[0] + t2 * (p2[0] - p1[0]), p1[1] + t2 * (p2[1] - p1[1]))
            else: B = p1
            
            smoothed.append(A)
            
            for j in range(1, num_samples + 1):
                t = j / num_samples
                one_minus_t = 1.0 - t
                x = one_minus_t * one_minus_t * A[0] + 2.0 * one_minus_t * t * p1[0] + t * t * B[0]
                y = one_minus_t * one_minus_t * A[1] + 2.0 * one_minus_t * t * p1[1] + t * t * B[1]
                smoothed.append((x, y))
                
        smoothed.append(points[-1])
        return smoothed

    def line_crosses_obstacle(self, a: Tuple[float, float], b: Tuple[float, float]) -> bool:
        ax, ay = a; bx, by = b
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        if denom <= 1e-9: return False
        for obstacle in self.obstacles:
            if obstacle.get("source") == "gazebo_sdf" and not obstacle.get("active", True): continue
            ox, oy = float(obstacle["x"]), float(obstacle["y"])
            radius = float(obstacle["radius"]) + float(obstacle["clearance"])
            t = clamp(((ox - ax) * dx + (oy - ay) * dy) / denom, 0.0, 1.0)
            closest_x, closest_y = ax + t * dx, ay + t * dy
            if math.hypot(closest_x - ox, closest_y - oy) <= radius: return True
        return False

    def publish_odom(self, pose: Pose2D) -> None:
        msg = Odometry()
        msg.header.stamp = self.get_clock().now().to_msg(); msg.header.frame_id = self.frame_id; msg.child_frame_id = "base_link"
        msg.pose.pose.position.x = pose.x; msg.pose.pose.position.y = pose.y; msg.pose.pose.position.z = pose.z
        msg.pose.pose.orientation = yaw_to_quaternion(pose.yaw)
        self.odom_pub.publish(msg)

    def publish_path(self) -> None:
        import json
        path = Path()
        path.header.stamp = self.get_clock().now().to_msg(); path.header.frame_id = self.frame_id
        path.poses = [self.pose_to_stamped(p) for p in self.path]
        self.path_pub.publish(path)

        paths_dict = {
            "global": [{"x": p.x, "y": p.y, "z": p.z} for p in self.global_path],
            "local": [{"x": p.x, "y": p.y, "z": p.z} for p in self.local_path],
            "final": [{"x": p.x, "y": p.y, "z": p.z} for p in self.path],
            "orbit": [{"x": p.x, "y": p.y, "z": p.z} for p in self.orbit_waypoints] if self.mode == "orbit" else [],
            "outbound": [{"x": p.x, "y": p.y, "z": p.z} for p in self.outbound_path],
            "return": [{"x": p.x, "y": p.y, "z": p.z} for p in self.return_path],
        }
        msg = String()
        msg.data = json.dumps(paths_dict)
        self.paths_json_pub.publish(msg)

    def publish_actual_path(self) -> None:
        path = Path()
        path.header.stamp = self.get_clock().now().to_msg(); path.header.frame_id = self.frame_id
        path.poses = [self.pose_to_stamped(p) for p in self.actual_path]
        self.actual_path_pub.publish(path)

    def publish_dashboard_state(self) -> None:
        # PENTING: Publish jalur secara konstan agar UI selalu mensinkronkan preview
        self.publish_path()
        
        # Build orbit info for dashboard
        orbit_info = None
        if self.mode == "orbit":
            orbit_info = {
                "phase": self.orbit_phase,
                "treeIndex": self.orbit_tree_index,
                "totalTrees": len(self.orbit_trees),
                "currentTree": self.orbit_center["id"] if self.orbit_center else None,
                "completedTrees": self.orbit_completed_trees,
                "orbitProgress": (self.orbit_wp_index / max(1, len(self.orbit_waypoints))) * 100 if self.orbit_waypoints else 0,
                "radius": self.orbit_radius,
                "altitude": self.orbit_altitude,
                "speed": self.orbit_speed,
            }

        payload = {
            "mode": self.mode, "home": self.pose_dict(self.home_pose), "goal": self.pose_dict(self.last_goal),
            "battery": self.battery, "vehicle": self.vehicle_status, "wind": self.wind,
            "nearestObstacle": self.nearest_obstacle_m, "rtlTriggered": self.rtl_triggered,
            "planner": {"algorithm": "Integrated Boustrophedon + Hybrid A* & RRT Detour", "resolution": self.planner_resolution},
            "orbit": orbit_info,
            "journey_status": self.journey_status,
            "rth_metadata": {
                "departure_time": self.departure_time_str,
                "arrival_time": self.arrival_time_str,
                "rth_start_time": self.rth_start_time_str,
                "landing_time": self.landing_time_str,
                "total_distance_m": self.mission_distance_m,
                "battery_used_percent": self.battery_used_percent,
                "total_duration_sec": self.total_duration_sec,
            }
        }
        self.state_pub.publish(String(data=json.dumps(payload)))
        self.obstacles_pub.publish(String(data=json.dumps(self.obstacles)))
        self.sensor_pub.publish(String(data=json.dumps({"nearest": self.nearest_obstacle_m, "ranges": self.scan_sample, "source": "/drone/lidar/scan"})))
        self.metrics_pub.publish(String(data=json.dumps(self.metric_payload())))

    def publish_status(self, event: str, message: str) -> None:
        self.state_pub.publish(String(data=json.dumps({"event": event, "message": message, "time": time.time()})))

    def metric_payload(self) -> Dict[str, object]:
        return {
            "mode": self.mode, 
            "autoTimeSec": self.total_auto_time,
            "manualTimeSec": self.total_manual_time,
            "autoBatteryUsed": self.total_auto_battery,
            "manualBatteryUsed": self.total_manual_battery
        }

    def pose_to_stamped(self, pose: Pose2D) -> PoseStamped:
        msg = PoseStamped()
        msg.header.stamp = self.get_clock().now().to_msg(); msg.header.frame_id = self.frame_id
        msg.pose.position.x = pose.x; msg.pose.position.y = pose.y; msg.pose.position.z = pose.z
        msg.pose.orientation = yaw_to_quaternion(pose.yaw)
        return msg

    @staticmethod
    def pose_dict(pose: Optional[Pose2D]) -> Optional[Dict[str, float]]:
        return {"x": pose.x, "y": pose.y, "z": pose.z, "yaw": pose.yaw} if pose else None

    @staticmethod
    def ned_to_enu_pose(north: float, east: float, down: float, yaw: float) -> Pose2D:
        return Pose2D(x=east, y=north, z=-down, yaw=yaw)

    @staticmethod
    def distance_xy(a: Pose2D, b: Pose2D) -> float:
        return math.hypot(a.x - b.x, a.y - b.y)

    def start_automatic_rth(self) -> None:
        from datetime import datetime
        if self.home_pose is None or self.current_pose is None:
            self.get_logger().error("Automatic RTH failed: Home pose or current pose is None!")
            return
        self.get_logger().info("Hover wait complete. Starting automatic Return To Home...")
        self.journey_status = "Returning to Home"
        self.rth_start_time_str = datetime.now().isoformat()
        self.mode = "return_home"
        
        # Calculate return path back to home at a safe altitude
        safe_altitude = max(self.current_pose.z, 6.0)
        high_home = Pose2D(self.home_pose.x, self.home_pose.y, safe_altitude, self.home_pose.yaw)
        
        self.path = []
        
        def done_cb(fut):
            if fut.cancelled(): return
            with self._path_lock:
                self.path = fut.result()
                self.return_path = list(self.path)
                self.path_index = 0
            self.publish_path()
            self.publish_status("rth_path_ready", "Jalur RTH otonom berhasil dihitung.")
            
        if self.planning_future and not self.planning_future.done():
            self.planning_future.cancel()
            
        self.planning_future = self.planning_executor.submit(self.plan_path, self.current_pose, high_home)
        self.planning_future.add_done_callback(done_cb)

    def active_mission_cb(self, msg: String) -> None:
        try:
            payload = json.loads(msg.data)
            if isinstance(payload, dict) and "mission_id" in payload:
                self.current_mission_id = int(payload["mission_id"])
                self.get_logger().info(f"Bridge Node: Active mission ID updated to {self.current_mission_id}")
        except Exception as e:
            self.get_logger().error(f"Error parsing active mission ID: {e}")

    @staticmethod
    def nav_state_name(nav_state: int) -> str:
        names = {
            0: "MANUAL", 1: "ALTCTL", 2: "POSCTL", 3: "AUTO_MISSION", 4: "AUTO_LOITER",
            5: "AUTO_RTL", 10: "ACRO", 14: "OFFBOARD", 15: "STABILIZED", 17: "AUTO_TAKEOFF", 18: "AUTO_LAND"
        }
        return names.get(nav_state, f"NAV_{nav_state}")

def main(args=None) -> None:
    rclpy.init(args=args)
    node = DashboardBridgeNode()
    
    # Gunakan MultiThreadedExecutor untuk kestabilan pengiriman setpoint
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)
    
    try: 
        executor.spin()
    except (KeyboardInterrupt, ExternalShutdownException): 
        pass
    finally:
        node.destroy_node()
        if rclpy.ok(): 
            rclpy.shutdown()

if __name__ == "__main__":
    main()