"""
dashboard_bridge.launch.py
=============================================================================
Launcher node bridge dashboard, bisa memilih flight stack.

MASALAH VERSI LAMA
------------------
1. `executable` di-hardcode ke "dashboard_bridge_node" (varian ArduPilot/MAVROS).
   Akibatnya saat menjalankan simulasi PX4/Gazebo, node bridge yang aktif tetap
   varian MAVROS yang menunggu topik /mavros/* — PX4 tidak pernah mem-publish
   topik itu (PX4 memakai uORB /fmu/*), jadi telemetry selamanya kosong dan
   semua tombol kontrol tidak berefek.
2. Mengirim parameter tree_x, tree_y, tree_radius, tree_clearance yang TIDAK
   dideklarasikan node mana pun. ROS 2 mengabaikan override yang tak
   dideklarasikan tanpa peringatan, jadi keempatnya adalah konfigurasi mati
   yang menyesatkan siapa pun yang mencoba menyetel posisi pohon dari sini.

PEMAKAIAN
---------
    ros2 launch drone_dashboard_bridge dashboard_bridge.launch.py
    ros2 launch drone_dashboard_bridge dashboard_bridge.launch.py flight_stack:=px4
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node

# Parameter yang dipahami KEDUA varian node. Nilai di sini adalah tuning
# lapangan dan sengaja berbeda dari default di dalam kode.
COMMON_PARAMS = {
    "marker_frame": "map",
    "spawn_x": -65.0,
    "spawn_y": 0.0,
    "takeoff_altitude": 8.0,
    "landing_altitude": 0.3,
    "manual_speed": 3.0,
    "vertical_speed": 3.0,
    "yaw_rate": 0.9,
    "cruise_speed": 3.5,
    "sweep_spacing": 20.0,   # Jarak antar garis zigzag boustrophedon
    "edge_margin": 5.0,      # Jarak aman dari pinggir petak sawah
    "goal_acceptance_radius": 1.6,
    # PENTING: 5.0 (bukan default kode 1.0). Pada resolusi 1 m, A* di dunia
    # 560x380 m memakan ~1.6 detik CPU per perencanaan.
    "planner_resolution": 5.0,
    "low_battery_threshold": 0.10,
    "wind_abort_threshold": 8.0,
    "offboard_setpoint_rate": 20.0,
    # Rate telemetry ROS 2 -> rosbridge -> dashboard.
    # 20Hz: cukup halus untuk UI, tidak membuat CPU starvation.
    "telemetry_rate": 20.0,
}


def generate_launch_description() -> LaunchDescription:
    flight_stack = LaunchConfiguration("flight_stack")

    declare_stack = DeclareLaunchArgument(
        "flight_stack",
        default_value="ardupilot",
        choices=["ardupilot", "px4"],
        description=(
            "Flight stack yang dipakai. 'ardupilot' -> jembatan MAVROS; "
            "'px4' -> jembatan uORB/XRCE-DDS untuk PX4 SITL + Gazebo."
        ),
    )

    is_ardupilot = IfCondition(PythonExpression(["'", flight_stack, "' == 'ardupilot'"]))
    is_px4 = IfCondition(PythonExpression(["'", flight_stack, "' == 'px4'"]))

    ardupilot_node = Node(
        package="drone_dashboard_bridge",
        executable="dashboard_bridge_node",
        name="dashboard_bridge_node",
        output="screen",
        condition=is_ardupilot,
        parameters=[COMMON_PARAMS],
    )

    px4_node = Node(
        package="drone_dashboard_bridge",
        executable="dashboard_bridge_node_px4",
        name="dashboard_bridge_node",
        output="screen",
        condition=is_px4,
        parameters=[COMMON_PARAMS],
    )

    return LaunchDescription([declare_stack, ardupilot_node, px4_node])
