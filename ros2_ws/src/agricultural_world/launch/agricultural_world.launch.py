#!/usr/bin/env python3
"""
agricultural_world_launch.py
============================
ROS2 Jazzy — Gazebo Harmony (Ionic) launch file
Project : Autonomous Drone Monitoring - Lahan Pertanian Jl. Aruman, Cimahi

Usage:
  ros2 launch agricultural_world agricultural_world.launch.py
  ros2 launch agricultural_world agricultural_world.launch.py \
        drone_model:=iris spawn_x:=-65.0 spawn_y:=0.0 spawn_z:=2.0 verbose:=false

Drone model yang didukung: iris, x500, custom_agri_drone
"""

import os
from pathlib import Path

from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    ExecuteProcess,
    IncludeLaunchDescription,
    OpaqueFunction,
    RegisterEventHandler,
    LogInfo,
    TimerAction,
)
from launch.conditions import IfCondition, UnlessCondition
from launch.event_handlers import OnProcessExit, OnProcessStart
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import (
    LaunchConfiguration,
    PathJoinSubstitution,
    FindExecutable,
    Command,
)

from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from ament_index_python.packages import get_package_share_directory


# ─────────────────────────────────────────────────────────────────────────────
# Helper: resolve package share directory safely
# ─────────────────────────────────────────────────────────────────────────────
def get_pkg(package_name: str) -> str:
    try:
        return get_package_share_directory(package_name)
    except Exception:
        return ""


def generate_launch_description() -> LaunchDescription:

    # ── Package directories ──────────────────────────────────────────────────
    pkg_this       = get_pkg("agricultural_world")
    pkg_ros_gz     = get_pkg("ros_gz_sim")
    pkg_ros_gz_bri = get_pkg("ros_gz_bridge")

    world_file = os.path.join(pkg_this, "worlds", "agricultural_field.sdf")

    # ── Declare launch arguments ─────────────────────────────────────────────
    declare_args = [
        DeclareLaunchArgument(
            "world",
            default_value=world_file,
            description="Path ke file SDF world Gazebo Harmony",
        ),
        DeclareLaunchArgument(
            "drone_model",
            default_value="iris",
            description="Model drone yang akan di-spawn (iris | x500 | custom_agri_drone)",
        ),
        DeclareLaunchArgument(
            "spawn_x",
            default_value="-65.0",
            description="Spawn X drone (di tengah sawah kiri, zona merah)",
        ),
        DeclareLaunchArgument(
            "spawn_y",
            default_value="0.0",
            description="Spawn Y drone",
        ),
        DeclareLaunchArgument(
            "spawn_z",
            default_value="2.0",
            description="Spawn Z drone (ketinggian awal dalam meter)",
        ),
        DeclareLaunchArgument(
            "spawn_yaw",
            default_value="0.0",
            description="Orientasi awal drone (radian), 0 = menghadap North/X+",
        ),
        DeclareLaunchArgument(
            "verbose",
            default_value="false",
            description="Gazebo verbose output",
        ),
        DeclareLaunchArgument(
            "headless",
            default_value="false",
            description="Jalankan Gazebo tanpa GUI (server only)",
        ),
        DeclareLaunchArgument(
            "paused",
            default_value="false",
            description="Mulai simulasi dalam kondisi paused",
        ),
        DeclareLaunchArgument(
            "enable_bridge",
            default_value="true",
            description="Aktifkan ros_gz_bridge (Gazebo <-> ROS2 topic bridge)",
        ),
        DeclareLaunchArgument(
            "use_sim_time",
            default_value="true",
            description="Gunakan waktu simulasi Gazebo untuk semua node ROS2",
        ),
        DeclareLaunchArgument(
            "namespace",
            default_value="drone",
            description="ROS2 namespace untuk topic drone",
        ),
    ]

    # ── LaunchConfiguration shortcuts ────────────────────────────────────────
    world        = LaunchConfiguration("world")
    drone_model  = LaunchConfiguration("drone_model")
    spawn_x      = LaunchConfiguration("spawn_x")
    spawn_y      = LaunchConfiguration("spawn_y")
    spawn_z      = LaunchConfiguration("spawn_z")
    spawn_yaw    = LaunchConfiguration("spawn_yaw")
    verbose      = LaunchConfiguration("verbose")
    headless     = LaunchConfiguration("headless")
    paused       = LaunchConfiguration("paused")
    enable_bridge = LaunchConfiguration("enable_bridge")
    use_sim_time = LaunchConfiguration("use_sim_time")
    ns           = LaunchConfiguration("namespace")

    # ── Gazebo Harmony server launch ─────────────────────────────────────────
    gz_server = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_ros_gz, "launch", "gz_sim.launch.py")
        ),
        launch_arguments={
            "gz_args": [
                # world file
                "-r ",          # auto-start (remove -r if you want paused)
                world,
                # optional flags
                " --headless-rendering",
            ],
            "on_exit_shutdown": "true",
        }.items(),
        condition=IfCondition(headless),
    )

    gz_sim = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_ros_gz, "launch", "gz_sim.launch.py")
        ),
        launch_arguments={
            "gz_args": ["-r ", world],
            "on_exit_shutdown": "true",
        }.items(),
        condition=UnlessCondition(headless),
    )

    # ── Spawn drone di titik yang ditentukan ─────────────────────────────────
    spawn_drone = Node(
        package="ros_gz_sim",
        executable="create",
        name="spawn_drone",
        arguments=[
            "-name",  drone_model,
            "-x",     spawn_x,
            "-y",     spawn_y,
            "-z",     spawn_z,
            "-Y",     spawn_yaw,
            # Coba temukan model dari GZ_SIM_RESOURCE_PATH atau paket ROS
            "-topic", "/drone/robot_description",
        ],
        output="screen",
    )

    # ── Robot State Publisher (untuk tf tree drone) ───────────────────────────
    # Catatan: sesuaikan path URDF/xacro sesuai drone model Anda
    robot_description_cmd = Command([
        "xacro ",
        PathJoinSubstitution([
            FindPackageShare("agricultural_world"),
            "models", drone_model, "model.urdf.xacro",
        ]),
        " use_sim_time:=", use_sim_time,
        " namespace:=",    ns,
    ])

    robot_state_publisher = Node(
        package="robot_state_publisher",
        executable="robot_state_publisher",
        name="robot_state_publisher",
        namespace=ns,
        output="screen",
        parameters=[{
            "robot_description": robot_description_cmd,
            "use_sim_time": use_sim_time,
            "publish_frequency": 50.0,
        }],
    )

    # ── ros_gz_bridge — Gazebo <-> ROS2 ──────────────────────────────────────
    # Topic mapping: Gazebo topic → ROS2 topic
    bridge_config = os.path.join(pkg_this, "config", "gz_bridge.yaml")

    gz_bridge = Node(
        package="ros_gz_bridge",
        executable="parameter_bridge",
        name="gz_ros2_bridge",
        namespace=ns,
        output="screen",
        parameters=[{
            "use_sim_time": use_sim_time,
            "config_file": bridge_config,
            "expand_gz_topic_names": True,
        }],
        condition=IfCondition(enable_bridge),
    )

    # ── ros_gz_image bridge (untuk kamera drone) ─────────────────────────────
    image_bridge = Node(
        package="ros_gz_image",
        executable="image_bridge",
        name="camera_bridge",
        namespace=ns,
        arguments=[
            f"/model/iris/link/base_link/sensor/camera/image",
        ],
        output="screen",
        parameters=[{"use_sim_time": use_sim_time}],
        condition=IfCondition(enable_bridge),
    )

    # ── RViz2 visualisasi (opsional) ─────────────────────────────────────────
    rviz_config = os.path.join(pkg_this, "config", "drone_monitoring.rviz")
    rviz2 = Node(
        package="rviz2",
        executable="rviz2",
        name="rviz2",
        arguments=["-d", rviz_config],
        parameters=[{"use_sim_time": use_sim_time}],
        output="screen",
        condition=UnlessCondition(headless),
    )

    # ── Log info awal ────────────────────────────────────────────────────────
    log_start = LogInfo(msg=[
        "\n",
        "=" * 60, "\n",
        "  Agricultural Drone Monitoring World\n",
        "  Location : Jl. Aruman, Cimahi, West Java\n",
        "  GPS      : -6.8852 S, 107.5417 E\n",
        "  Zona Merah (flat)  : Z = 0.00 m\n",
        "  Zona Biru  (mudun) : Z = -1.50 m\n",
        "  Drone spawn: (", spawn_x, ", ", spawn_y, ", ", spawn_z, ")\n",
        "=" * 60, "\n",
    ])

    # ── Delay spawn setelah Gazebo siap ─────────────────────────────────────
    delayed_spawn = TimerAction(
        period=5.0,
        actions=[spawn_drone],
    )

    delayed_bridge = TimerAction(
        period=6.0,
        actions=[gz_bridge, image_bridge],
    )

    delayed_rviz = TimerAction(
        period=7.0,
        actions=[rviz2],
    )

    return LaunchDescription([
        *declare_args,
        log_start,
        gz_server,
        gz_sim,
        robot_state_publisher,
        delayed_spawn,
        delayed_bridge,
        delayed_rviz,
    ])
