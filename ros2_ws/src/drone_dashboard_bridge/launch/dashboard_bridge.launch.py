from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
    return LaunchDescription(
        [
            Node(
                package="drone_dashboard_bridge",
                executable="dashboard_bridge_node",
                name="dashboard_bridge_node",
                output="screen",
                parameters=[
                    {
                        "marker_frame": "map",
                        "spawn_x": -65.0,  
                        "spawn_y": 0.0,    
                        "takeoff_altitude": 8.0,
                        "landing_altitude": 0.3,
                        "manual_speed": 3.0,
                        "vertical_speed": 3.0,
                        "yaw_rate": 0.9,
                        "cruise_speed": 3.5,
                        "sweep_spacing": 20.0,  # Parameter baru: Jarak antar garis zigzag
                        "edge_margin": 5.0,     # Parameter baru: Jarak aman dari pinggir petak sawah
                        "goal_acceptance_radius": 1.6,
                        "planner_resolution": 5.0,
                        "tree_x": 0.0,
                        "tree_y": 0.0,
                        "tree_radius": 8.0,
                        "tree_clearance": 2.5, 
                        "low_battery_threshold": 0.10,
                        "wind_abort_threshold": 8.0,
                        "offboard_setpoint_rate": 20.0,
                    }
                ],
            )
        ]
    )