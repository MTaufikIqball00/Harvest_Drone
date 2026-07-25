from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import EnvironmentVariable, LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription(
        [
            DeclareLaunchArgument("db_host", default_value=EnvironmentVariable("DRONE_DB_HOST", default_value="127.0.0.1")),
            DeclareLaunchArgument("db_port", default_value=EnvironmentVariable("DRONE_DB_PORT", default_value="3306")),
            DeclareLaunchArgument("db_user", default_value=EnvironmentVariable("DRONE_DB_USER", default_value="drone_app")),
            DeclareLaunchArgument("db_password", default_value=EnvironmentVariable("DRONE_DB_PASSWORD", default_value="")),
            DeclareLaunchArgument("db_name", default_value=EnvironmentVariable("DRONE_DB_NAME", default_value="drone_ops")),
            DeclareLaunchArgument("drone_id", default_value=EnvironmentVariable("DRONE_DB_DRONE_ID", default_value="1")),
            DeclareLaunchArgument("mission_id", default_value=EnvironmentVariable("DRONE_DB_MISSION_ID", default_value="0")),
            Node(
                package="drone_dashboard_bridge",
                executable="mysql_telemetry_logger",
                name="mysql_telemetry_logger",
                output="screen",
                parameters=[
                    {
                        "db_host": LaunchConfiguration("db_host"),
                        "db_port": LaunchConfiguration("db_port"),
                        "db_user": LaunchConfiguration("db_user"),
                        "db_password": LaunchConfiguration("db_password"),
                        "db_name": LaunchConfiguration("db_name"),
                        "drone_id": LaunchConfiguration("drone_id"),
                        "mission_id": LaunchConfiguration("mission_id"),
                    }
                ],
            ),
        ]
    )
