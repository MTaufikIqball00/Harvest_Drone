#!/usr/bin/env python3
"""
PX4 offboard boustrophedon coverage for agricultural_field.sdf.

This node streams TrajectorySetpoint messages to PX4.  PX4 local position
setpoints use NED, so flying 15 m above a flat Gazebo ground is z = -15.0.
The blue field in agricultural_field.sdf is 1.5 m lower than the flat field,
therefore the same 15 m AGL clearance is z = -13.5 over that zone.
"""

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import rclpy
from rclpy.node import Node

from px4_msgs.msg import OffboardControlMode, TrajectorySetpoint


Point = Tuple[float, float, float]


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
class Segment:
    kind: str
    p0: Point
    p1: Point
    p2: Optional[Point] = None


@dataclass(frozen=True)
class ZoneCandidate:
    zone: FieldZone
    start: Point
    end: Point
    segments: Tuple[Segment, ...]


class BoustrophedonNode(Node):
    """Generate efficient survey coverage for all sawah blocks in the world."""

    SPAWN_X = -65.0
    SPAWN_Y = 0.0

    FIELD_ZONES = (
        FieldZone(
            name="sawah_kiri",
            x_min=-175.0,
            x_max=45.0,
            y_min=-145.0,
            y_max=145.0,
            ground_z=0.0,
        ),
        FieldZone(
            name="sawah_kanan_atas",
            x_min=45.0,
            x_max=325.0,
            y_min=-87.5,
            y_max=87.5,
            ground_z=0.0,
        ),
        FieldZone(
            name="sawah_tengah_bawah",
            x_min=45.0,
            x_max=215.0,
            y_min=-201.5,
            y_max=-86.5,
            ground_z=0.0,
        ),
        FieldZone(
            name="sawah_biru_mudun",
            x_min=215.0,
            x_max=355.0,
            y_min=-201.5,
            y_max=-86.5,
            ground_z=-1.5,
        ),
    )

    def __init__(self) -> None:
        super().__init__("boustrophedon_node")

        self.declare_parameter("altitude", 15.0)       # meters AGL
        self.declare_parameter("sweep_spacing", 20.0)  # meters between survey lanes
        self.declare_parameter("edge_margin", 5.0)     # keeps lane centers inside edges
        self.declare_parameter("turn_radius", 8.0)     # Bezier turn control offset
        self.declare_parameter("cruise_speed", 5.0)    # m/s target setpoint motion
        self.declare_parameter("publish_rate", 10.0)   # Hz, PX4 offboard needs > 2 Hz
        self.declare_parameter("return_to_spawn", True)
        self.declare_parameter("yaw", 0.0)
        self.declare_parameter("log_every_n", 100)

        self.altitude = float(self.get_parameter("altitude").value)
        self.sweep_spacing = max(1.0, float(self.get_parameter("sweep_spacing").value))
        self.edge_margin = float(self.get_parameter("edge_margin").value)
        self.turn_radius = max(0.0, float(self.get_parameter("turn_radius").value))
        self.cruise_speed = max(0.5, float(self.get_parameter("cruise_speed").value))
        self.publish_rate = max(2.0, float(self.get_parameter("publish_rate").value))
        self.return_to_spawn = bool(self.get_parameter("return_to_spawn").value)
        self.yaw = float(self.get_parameter("yaw").value)
        self.log_every_n = max(1, int(self.get_parameter("log_every_n").value))
        self.setpoint_spacing = self.cruise_speed / self.publish_rate

        self.traj_pub = self.create_publisher(
            TrajectorySetpoint,
            "/fmu/in/trajectory_setpoint",
            10,
        )
        self.offboard_pub = self.create_publisher(
            OffboardControlMode,
            "/fmu/in/offboard_control_mode",
            10,
        )

        self.path = self.generate_path()
        self.index = 0
        self.hold_target = self.path[0] if self.path else [
            self.SPAWN_X,
            self.SPAWN_Y,
            self._target_z(0.0),
        ]
        self.finished_logged = False

        self._log_plan_summary()
        self.timer = self.create_timer(1.0 / self.publish_rate, self.publish_next)

    def generate_path(self) -> List[List[float]]:
        """Build mission segments, then sample them into timed setpoints."""
        segments = self._build_mission_segments()
        sampled = self._sample_segments(segments)
        return [[float(p[0]), float(p[1]), float(p[2])] for p in sampled]

    def _build_mission_segments(self) -> List[Segment]:
        segments: List[Segment] = []
        remaining = list(self.FIELD_ZONES)
        current = (self.SPAWN_X, self.SPAWN_Y, self._target_z(0.0))

        # Seed the path at the takeoff/survey altitude above the spawn marker.
        segments.append(Segment("line", current, current))

        while remaining:
            candidate = self._select_next_zone(current, remaining)
            if self._distance(current, candidate.start) > 1e-3:
                segments.append(Segment("line", current, candidate.start))
            segments.extend(candidate.segments)
            current = candidate.end
            remaining.remove(candidate.zone)

        if self.return_to_spawn:
            home = (self.SPAWN_X, self.SPAWN_Y, self._target_z(0.0))
            if self._distance(current, home) > 1e-3:
                segments.append(Segment("line", current, home))

        return segments

    def _select_next_zone(
        self,
        current: Point,
        remaining: Sequence[FieldZone],
    ) -> ZoneCandidate:
        best_candidate: Optional[ZoneCandidate] = None
        best_score = math.inf

        for zone in remaining:
            for candidate in self._zone_candidates(zone):
                approach_cost = self._distance(current, candidate.start)
                lookahead_cost = self._nearest_following_zone_cost(candidate, zone, remaining)
                score = approach_cost + 0.35 * lookahead_cost
                if score < best_score:
                    best_score = score
                    best_candidate = candidate

        if best_candidate is None:
            raise RuntimeError("No field zone candidate could be generated")
        return best_candidate

    def _nearest_following_zone_cost(
        self,
        candidate: ZoneCandidate,
        candidate_zone: FieldZone,
        remaining: Sequence[FieldZone],
    ) -> float:
        following_starts: List[Point] = []
        for zone in remaining:
            if zone == candidate_zone:
                continue
            following_starts.extend(option.start for option in self._zone_candidates(zone))

        if not following_starts:
            return 0.0
        return min(self._distance(candidate.end, start) for start in following_starts)

    def _zone_candidates(self, zone: FieldZone) -> Tuple[ZoneCandidate, ...]:
        x_min, x_max, y_min, y_max = zone.bounds_with_margin(self.edge_margin)
        width = x_max - x_min
        height = y_max - y_min
        long_axis = "y" if height >= width else "x"

        candidates: List[ZoneCandidate] = []
        for reverse_lanes in (False, True):
            for first_starts_at_max in (False, True):
                candidates.append(
                    self._build_zone_candidate(
                        zone=zone,
                        bounds=(x_min, x_max, y_min, y_max),
                        long_axis=long_axis,
                        reverse_lanes=reverse_lanes,
                        first_starts_at_max=first_starts_at_max,
                    )
                )
        return tuple(candidates)

    def _build_zone_candidate(
        self,
        zone: FieldZone,
        bounds: Tuple[float, float, float, float],
        long_axis: str,
        reverse_lanes: bool,
        first_starts_at_max: bool,
    ) -> ZoneCandidate:
        x_min, x_max, y_min, y_max = bounds
        z = self._target_z(zone.ground_z)
        segments: List[Segment] = []
        turn_radius = min(self.turn_radius, self.sweep_spacing * 0.75)

        if long_axis == "y":
            lanes = self._make_sweep_positions(x_min, x_max, self.sweep_spacing)
            if reverse_lanes:
                lanes.reverse()
            center_y = (y_min + y_max) * 0.5
            previous_end: Optional[Point] = None
            first_point: Optional[Point] = None

            for idx, x in enumerate(lanes):
                start_at_max = first_starts_at_max if idx % 2 == 0 else not first_starts_at_max
                y_start = y_max if start_at_max else y_min
                y_end = y_min if start_at_max else y_max
                lane_start = (x, y_start, z)
                lane_end = (x, y_end, z)

                if first_point is None:
                    first_point = lane_start
                if previous_end is not None:
                    segments.append(
                        self._turn_segment(
                            previous_end,
                            lane_start,
                            control=(
                                (previous_end[0] + lane_start[0]) * 0.5,
                                previous_end[1]
                                + (turn_radius if previous_end[1] >= center_y else -turn_radius),
                                z,
                            ),
                        )
                    )
                segments.append(Segment("line", lane_start, lane_end))
                previous_end = lane_end

        else:
            lanes = self._make_sweep_positions(y_min, y_max, self.sweep_spacing)
            if reverse_lanes:
                lanes.reverse()
            center_x = (x_min + x_max) * 0.5
            previous_end = None
            first_point = None

            for idx, y in enumerate(lanes):
                start_at_max = first_starts_at_max if idx % 2 == 0 else not first_starts_at_max
                x_start = x_max if start_at_max else x_min
                x_end = x_min if start_at_max else x_max
                lane_start = (x_start, y, z)
                lane_end = (x_end, y, z)

                if first_point is None:
                    first_point = lane_start
                if previous_end is not None:
                    segments.append(
                        self._turn_segment(
                            previous_end,
                            lane_start,
                            control=(
                                previous_end[0]
                                + (turn_radius if previous_end[0] >= center_x else -turn_radius),
                                (previous_end[1] + lane_start[1]) * 0.5,
                                z,
                            ),
                        )
                    )
                segments.append(Segment("line", lane_start, lane_end))
                previous_end = lane_end

        if first_point is None or previous_end is None:
            raise RuntimeError(f"Zone {zone.name} did not generate any lanes")

        return ZoneCandidate(
            zone=zone,
            start=first_point,
            end=previous_end,
            segments=tuple(segments),
        )

    def _turn_segment(self, start: Point, end: Point, control: Point) -> Segment:
        if self.turn_radius <= 1e-3:
            return Segment("line", start, end)
        return Segment("bezier", start, control, end)

    def _make_sweep_positions(self, lower: float, upper: float, spacing: float) -> List[float]:
        if upper < lower:
            lower, upper = upper, lower

        width = upper - lower
        if width <= spacing:
            return [round((lower + upper) * 0.5, 3)]

        values = [lower]
        cursor = lower + spacing
        while cursor < upper:
            values.append(cursor)
            cursor += spacing

        if upper - values[-1] > 1e-6:
            values.append(upper)

        return [round(value, 3) for value in values]

    def _sample_segments(self, segments: Sequence[Segment]) -> List[Point]:
        points: List[Point] = []
        for segment in segments:
            if segment.kind == "line":
                self._append_line(points, segment.p0, segment.p1)
            elif segment.kind == "bezier":
                if segment.p2 is None:
                    raise RuntimeError("Bezier segment missing end point")
                self._append_bezier(points, segment.p0, segment.p1, segment.p2)
            else:
                raise RuntimeError(f"Unsupported segment type: {segment.kind}")
        return points

    def _append_line(self, points: List[Point], start: Point, end: Point) -> None:
        if not points:
            points.append(start)

        distance = self._distance(start, end)
        if distance <= 1e-6:
            return

        steps = max(1, math.ceil(distance / self.setpoint_spacing))
        for idx in range(1, steps + 1):
            ratio = idx / steps
            points.append(self._lerp(start, end, ratio))

    def _append_bezier(self, points: List[Point], start: Point, control: Point, end: Point) -> None:
        if not points:
            points.append(start)

        approx_len = self._distance(start, control) + self._distance(control, end)
        steps = max(1, math.ceil(approx_len / self.setpoint_spacing))
        for idx in range(1, steps + 1):
            t = idx / steps
            points.append(self.bezier(start, control, end, t))

    def bezier(self, p0: Point, p1: Point, p2: Point, t: float) -> Point:
        one_minus_t = 1.0 - t
        return (
            one_minus_t * one_minus_t * p0[0]
            + 2.0 * one_minus_t * t * p1[0]
            + t * t * p2[0],
            one_minus_t * one_minus_t * p0[1]
            + 2.0 * one_minus_t * t * p1[1]
            + t * t * p2[1],
            one_minus_t * one_minus_t * p0[2]
            + 2.0 * one_minus_t * t * p1[2]
            + t * t * p2[2],
        )

    def publish_next(self) -> None:
        timestamp = int(self.get_clock().now().nanoseconds / 1000)

        offboard_msg = OffboardControlMode()
        offboard_msg.timestamp = timestamp
        offboard_msg.position = True
        offboard_msg.velocity = False
        offboard_msg.acceleration = False
        offboard_msg.attitude = False
        offboard_msg.body_rate = False
        self.offboard_pub.publish(offboard_msg)

        if self.index < len(self.path):
            target = self.path[self.index]
            self.hold_target = target
            self.index += 1

            if self.index == 1 or self.index % self.log_every_n == 0:
                self.get_logger().info(
                    f"Target {self.index}/{len(self.path)}: "
                    f"x={target[0]:.1f}, y={target[1]:.1f}, z={target[2]:.1f}"
                )
        else:
            target = self.hold_target
            if not self.finished_logged:
                self.get_logger().info("Coverage path complete, holding final setpoint.")
                self.finished_logged = True

        traj_msg = TrajectorySetpoint()
        traj_msg.timestamp = timestamp
        traj_msg.position = target
        traj_msg.yaw = self.yaw
        self.traj_pub.publish(traj_msg)

    def _target_z(self, ground_z_enu: float) -> float:
        return -self.altitude - ground_z_enu

    def _path_length(self) -> float:
        if len(self.path) < 2:
            return 0.0
        return sum(
            self._distance_tuple(self.path[idx - 1], self.path[idx])
            for idx in range(1, len(self.path))
        )

    def _log_plan_summary(self) -> None:
        zone_names = ", ".join(zone.name for zone in self.FIELD_ZONES)
        duration = len(self.path) / self.publish_rate if self.publish_rate > 0.0 else 0.0
        self.get_logger().info("=" * 60)
        self.get_logger().info("Boustrophedon coverage plan generated")
        self.get_logger().info(f"Zones           : {zone_names}")
        self.get_logger().info(f"Setpoints       : {len(self.path)}")
        self.get_logger().info(f"Approx length   : {self._path_length():.1f} m")
        self.get_logger().info(f"Approx duration : {duration:.1f} s at {self.cruise_speed:.1f} m/s")
        self.get_logger().info(f"Altitude        : {self.altitude:.1f} m AGL")
        self.get_logger().info(f"Sweep spacing   : {self.sweep_spacing:.1f} m")
        self.get_logger().info(f"Edge margin     : {self.edge_margin:.1f} m")
        self.get_logger().info("=" * 60)

    @staticmethod
    def _lerp(start: Point, end: Point, ratio: float) -> Point:
        return (
            start[0] + (end[0] - start[0]) * ratio,
            start[1] + (end[1] - start[1]) * ratio,
            start[2] + (end[2] - start[2]) * ratio,
        )

    @staticmethod
    def _distance(start: Point, end: Point) -> float:
        return math.sqrt(
            (end[0] - start[0]) ** 2
            + (end[1] - start[1]) ** 2
            + (end[2] - start[2]) ** 2
        )

    @staticmethod
    def _distance_tuple(start: Sequence[float], end: Sequence[float]) -> float:
        return math.sqrt(
            (end[0] - start[0]) ** 2
            + (end[1] - start[1]) ** 2
            + (end[2] - start[2]) ** 2
        )


def main(args=None) -> None:
    rclpy.init(args=args)
    node = BoustrophedonNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
