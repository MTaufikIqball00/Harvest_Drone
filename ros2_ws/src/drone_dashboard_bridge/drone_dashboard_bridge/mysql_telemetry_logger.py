#!/usr/bin/env python3

import json
import math
import os
import time
import threading
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, Iterable, List, Optional, Tuple

try:
    import mysql.connector as mysql_driver
    from mysql.connector import Error as MySqlError

    MYSQL_DRIVER = "mysql_connector"
except ModuleNotFoundError:
    import pymysql as mysql_driver
    from pymysql import MySQLError as MySqlError

    MYSQL_DRIVER = "pymysql"

import rclpy
from nav_msgs.msg import Odometry
from rclpy.executors import MultiThreadedExecutor, ExternalShutdownException
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.node import Node
from std_msgs.msg import String


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_json(data: str, fallback: Any) -> Any:
    try:
        return json.loads(data or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def finite_or_none(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


from drone_dashboard_bridge.math_utils import quaternion_to_euler


def heading_from_yaw(yaw: Optional[float]) -> Optional[float]:
    if yaw is None:
        return None
    return (math.degrees(yaw) + 360.0) % 360.0


class MySqlBatchWriter:
    def __init__(self, node: Node) -> None:
        self.node = node
        self.connection = None
        self.queues: Dict[str, Deque[Dict[str, Any]]] = defaultdict(deque)
        self.max_queue_size = int(node.get_parameter("max_queue_size").value)
        self.lock = threading.Lock()

    def connect(self) -> bool:
        if self.connection and self._is_connected():
            return True

        try:
            kwargs = {
                "host": str(self.node.get_parameter("db_host").value),
                "port": int(self.node.get_parameter("db_port").value),
                "user": str(self.node.get_parameter("db_user").value),
                "password": str(self.node.get_parameter("db_password").value),
                "database": str(self.node.get_parameter("db_name").value),
                "autocommit": False,
            }
            if MYSQL_DRIVER == "mysql_connector":
                kwargs["connection_timeout"] = 3
            else:
                kwargs["connect_timeout"] = 3
                kwargs["charset"] = "utf8mb4"

            self.connection = mysql_driver.connect(**kwargs)
            self.node.get_logger().info(f"MySQL telemetry logger connected using {MYSQL_DRIVER}.")
            return True
        except MySqlError as exc:
            self.connection = None
            self.node.get_logger().warning(f"MySQL connect failed: {exc}")
            return False

    def _is_connected(self) -> bool:
        if not self.connection:
            return False
        if MYSQL_DRIVER == "mysql_connector":
            return bool(self.connection.is_connected())
        return bool(getattr(self.connection, "open", False))

    def enqueue(self, table: str, row: Dict[str, Any]) -> None:
        with self.lock:
            queue = self.queues[table]
            if len(queue) >= self.max_queue_size:
                queue.popleft()
                self.node.get_logger().warning(f"MySQL queue for {table} is full; dropping oldest row.")
            queue.append(row)

    def flush(self, batch_size: int) -> None:
        with self.lock:
            if not any(self.queues.values()):
                return
            snapshot = {}
            for table, queue in self.queues.items():
                if queue:
                    snapshot[table] = [queue.popleft() for _ in range(min(batch_size, len(queue)))]
                    
        if not snapshot:
            return

        if not self.connect():
            return

        try:
            cursor = self.connection.cursor()
            for table, rows in snapshot.items():
                self._insert_many(cursor, table, rows)
            self.connection.commit()
            cursor.close()
        except MySqlError as exc:
            self.node.get_logger().error(f"MySQL flush failed: {exc}")
            try:
                self.connection.rollback()
                self.connection.close()
            except MySqlError:
                pass
            self.connection = None

    def _insert_many(self, cursor: Any, table: str, rows: List[Dict[str, Any]]) -> None:
        if not rows:
            return

        columns = list(rows[0].keys())
        placeholders = ", ".join(["%s"] * len(columns))
        column_sql = ", ".join(columns)
        sql = f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders})"
        values = [tuple(row.get(column) for column in columns) for row in rows]
        cursor.executemany(sql, values)

    def close(self) -> None:
        if self.connection:
            try:
                self.connection.close()
            except MySqlError:
                pass


class MySqlTelemetryLogger(Node):
    def __init__(self) -> None:
        super().__init__("mysql_telemetry_logger")

        self.declare_parameter("db_host", os.getenv("DRONE_DB_HOST", "127.0.0.1"))
        self.declare_parameter("db_port", int(os.getenv("DRONE_DB_PORT", "3306")))
        self.declare_parameter("db_user", os.getenv("DRONE_DB_USER", "drone_app"))
        self.declare_parameter("db_password", os.getenv("DRONE_DB_PASSWORD", ""))
        self.declare_parameter("db_name", os.getenv("DRONE_DB_NAME", "drone_ops"))
        self.declare_parameter("drone_id", int(os.getenv("DRONE_DB_DRONE_ID", "1")))
        self.declare_parameter("mission_id", int(os.getenv("DRONE_DB_MISSION_ID", "0")))
        self.declare_parameter("telemetry_hz", float(os.getenv("DRONE_DB_TELEMETRY_HZ", "2.0")))
        self.declare_parameter("state_hz", float(os.getenv("DRONE_DB_STATE_HZ", "1.0")))
        self.declare_parameter("batch_size", int(os.getenv("DRONE_DB_BATCH_SIZE", "100")))
        self.declare_parameter("flush_period_sec", float(os.getenv("DRONE_DB_FLUSH_SEC", "1.0")))
        self.declare_parameter("max_queue_size", int(os.getenv("DRONE_DB_MAX_QUEUE", "1000")))

        # Callback Groups
        self.fast_cb_group = MutuallyExclusiveCallbackGroup() # Untuk subscribe Odom berkecepatan tinggi
        self.db_cb_group = MutuallyExclusiveCallbackGroup()   # Untuk koneksi dan flush database (blocking I/O)

        self.drone_id = int(self.get_parameter("drone_id").value)
        mission_id = int(self.get_parameter("mission_id").value)
        self.mission_id: Optional[int] = mission_id if mission_id > 0 else None

        self.telemetry_period = 1.0 / max(0.2, float(self.get_parameter("telemetry_hz").value))
        self.state_period = 1.0 / max(0.2, float(self.get_parameter("state_hz").value))
        self.last_telemetry_insert = 0.0
        self.last_state_insert = 0.0
        self.latest_state: Dict[str, Any] = {}
        self.seen_obstacle_keys = set()
        self.seen_error_keys = set()

        self.writer = MySqlBatchWriter(self)

        self.create_subscription(Odometry, "/odom", self.odom_cb, 20, callback_group=self.fast_cb_group)
        self.create_subscription(String, "/dashboard/state", self.state_cb, 20, callback_group=self.fast_cb_group)
        self.create_subscription(String, "/dashboard/obstacles", self.obstacles_cb, 10, callback_group=self.fast_cb_group)
        self.create_subscription(String, "/dashboard/metrics", self.metrics_cb, 10, callback_group=self.fast_cb_group)
        self.create_subscription(String, "/dashboard/active_mission", self.active_mission_cb, 10, callback_group=self.fast_cb_group)

        flush_period = max(0.2, float(self.get_parameter("flush_period_sec").value))
        self.create_timer(flush_period, self.flush_tick, callback_group=self.db_cb_group)
        self.get_logger().info("MySQL telemetry logger ready with MultiThreadedExecutor.")

    def odom_cb(self, msg: Odometry) -> None:
        now = time.monotonic()
        if now - self.last_telemetry_insert < self.telemetry_period:
            return
        self.last_telemetry_insert = now

        pose = msg.pose.pose
        twist = msg.twist.twist
        roll, pitch, yaw = quaternion_to_euler(pose.orientation)
        vx = finite_or_none(twist.linear.x)
        vy = finite_or_none(twist.linear.y)
        vz = finite_or_none(twist.linear.z)
        speed = math.sqrt((vx or 0.0) ** 2 + (vy or 0.0) ** 2 + (vz or 0.0) ** 2)
        vehicle = self.latest_state.get("vehicle") or {}

        self.writer.enqueue(
            "telemetry_logs",
            {
                "drone_id": self.drone_id,
                "mission_id": self.mission_id,
                "recorded_at": utc_now(),
                "x": finite_or_none(pose.position.x),
                "y": finite_or_none(pose.position.y),
                "z": finite_or_none(pose.position.z),
                "latitude": None,
                "longitude": None,
                "altitude_m": finite_or_none(pose.position.z),
                "velocity_x": vx,
                "velocity_y": vy,
                "velocity_z": vz,
                "speed_mps": speed,
                "yaw_rad": yaw,
                "pitch_rad": pitch,
                "roll_rad": roll,
                "heading_deg": heading_from_yaw(yaw),
                "flight_mode": self.latest_state.get("mode"),
                "nav_state": vehicle.get("navStateName"),
                "source": "ros2",
                "raw_payload": None,
            },
        )

    def state_cb(self, msg: String) -> None:
        payload = parse_json(msg.data, {})
        if not isinstance(payload, dict):
            return

        if "event" in payload:
            self.log_event(payload)
            return

        self.latest_state.update(payload)
        now = time.monotonic()
        if now - self.last_state_insert < self.state_period:
            return
        self.last_state_insert = now

        recorded_at = utc_now()
        self.insert_battery_state(payload, recorded_at)
        self.insert_wind_state(payload, recorded_at)

    def insert_battery_state(self, payload: Dict[str, Any], recorded_at: datetime) -> None:
        battery = payload.get("battery") or {}
        if not battery:
            return

        remaining = finite_or_none(battery.get("remaining"))
        warning = battery.get("warning")
        self.writer.enqueue(
            "battery_logs",
            {
                "drone_id": self.drone_id,
                "mission_id": self.mission_id,
                "recorded_at": recorded_at,
                "battery_percent": remaining * 100.0 if remaining is not None else None,
                "voltage_v": finite_or_none(battery.get("voltage")),
                "current_a": finite_or_none(battery.get("current")),
                "estimated_remaining_sec": finite_or_none(battery.get("timeRemaining")),
                "warning_level": str(warning) if warning is not None else None,
                "raw_payload": json.dumps(battery),
            },
        )

    def insert_wind_state(self, payload: Dict[str, Any], recorded_at: datetime) -> None:
        wind = payload.get("wind") or {}
        speed = finite_or_none(wind.get("speed"))
        if speed is None:
            return

        north = finite_or_none(wind.get("north"))
        east = finite_or_none(wind.get("east"))
        direction = None
        if north is not None and east is not None:
            direction = (math.degrees(math.atan2(east, north)) + 360.0) % 360.0

        if speed >= 8.0:
            safety_status = "abort"
        elif speed >= 5.0:
            safety_status = "warning"
        else:
            safety_status = "safe"

        self.writer.enqueue(
            "wind_logs",
            {
                "drone_id": self.drone_id,
                "mission_id": self.mission_id,
                "recorded_at": recorded_at,
                "wind_speed_mps": speed,
                "wind_direction_deg": direction,
                "wind_north_mps": north,
                "wind_east_mps": east,
                "safety_status": safety_status,
                "raw_payload": json.dumps(wind),
            },
        )

    def obstacles_cb(self, msg: String) -> None:
        obstacles = parse_json(msg.data, [])
        if not isinstance(obstacles, list):
            return

        detected_at = utc_now()
        for obstacle in obstacles:
            if not isinstance(obstacle, dict):
                continue
            source = str(obstacle.get("source") or "map")
            active = bool(obstacle.get("active", source == "lidar"))
            if not active and source == "gazebo_sdf":
                continue

            obstacle_uid = str(obstacle.get("id") or f"obs-{len(self.seen_obstacle_keys)}")
            key = (
                self.mission_id,
                obstacle_uid,
                round(finite_or_none(obstacle.get("x")) or 0.0, 1),
                round(finite_or_none(obstacle.get("y")) or 0.0, 1),
            )
            if key in self.seen_obstacle_keys:
                continue
            self.seen_obstacle_keys.add(key)

            db_source = "gazebo" if source == "gazebo_sdf" else source
            if db_source not in {"gazebo", "lidar", "vision", "map", "manual"}:
                db_source = "lidar"

            self.writer.enqueue(
                "obstacle_logs",
                {
                    "obstacle_uid": obstacle_uid,
                    "drone_id": self.drone_id,
                    "mission_id": self.mission_id,
                    "detected_at": detected_at,
                    "x": finite_or_none(obstacle.get("x")),
                    "y": finite_or_none(obstacle.get("y")),
                    "z": None,
                    "latitude": None,
                    "longitude": None,
                    "radius_m": finite_or_none(obstacle.get("radius")),
                    "width_m": None,
                    "height_m": finite_or_none(obstacle.get("height")),
                    "obstacle_type": str(obstacle.get("kind") or "unknown"),
                    "source": db_source,
                    "confidence": None,
                    "avoidance_action": "replan" if active else None,
                    "raw_payload": json.dumps(obstacle),
                },
            )

    def metrics_cb(self, msg: String) -> None:
        payload = parse_json(msg.data, {})
        if isinstance(payload, dict):
            self.latest_state["metrics"] = payload

    def log_event(self, payload: Dict[str, Any]) -> None:
        event = str(payload.get("event") or "unknown")
        message = str(payload.get("message") or event)
        key = (event, message, int(float(payload.get("time") or time.time())))
        if key in self.seen_error_keys:
            return
        self.seen_error_keys.add(key)

        subsystem = "navigation"
        severity = "info"
        if "battery" in event:
            subsystem = "battery"
            severity = "warning"
        elif event in {"return_home", "emergency_stop"}:
            subsystem = "px4"
            severity = "warning"
        elif "obstacle" in event or "replan" in event:
            subsystem = "obstacle"
            severity = "warning"
        elif "rejected" in event or "failed" in event:
            subsystem = "ros2"
            severity = "error"

        self.writer.enqueue(
            "error_logs",
            {
                "drone_id": self.drone_id,
                "mission_id": self.mission_id,
                "occurred_at": utc_now(),
                "severity": severity,
                "subsystem": subsystem,
                "event_type": event,
                "error_code": None,
                "message": message,
                "context": json.dumps(payload),
                "resolved_at": None,
            },
        )

    def flush_tick(self) -> None:
        batch_size = max(1, int(self.get_parameter("batch_size").value))
        self.writer.flush(batch_size)

    def active_mission_cb(self, msg: String) -> None:
        payload = parse_json(msg.data, {})
        if isinstance(payload, dict) and "mission_id" in payload:
            self.mission_id = int(payload["mission_id"])
            self.get_logger().info(f"MySQL logger: Active mission ID updated dynamically to {self.mission_id}")

    def destroy_node(self) -> bool:
        self.writer.flush(max(1, int(self.get_parameter("batch_size").value)))
        self.writer.close()
        return super().destroy_node()


def main(args: Optional[Iterable[str]] = None) -> None:
    rclpy.init(args=args)
    node = MySqlTelemetryLogger()
    executor = MultiThreadedExecutor(num_threads=3)
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
