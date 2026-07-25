from setuptools import setup

package_name = "drone_dashboard_bridge"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
        (f"share/{package_name}/launch", [
            "launch/dashboard_bridge.launch.py",
            "launch/mysql_telemetry_logger.launch.py",
        ]),
    ],
    install_requires=["setuptools", "mysql-connector-python", "PyMySQL"],
    zip_safe=True,
    maintainer="Drone Dashboard",
    maintainer_email="user@example.com",
    description="ROS 2 bridge node for the web drone dashboard.",
    license="MIT",
    entry_points={
        "console_scripts": [
            "dashboard_bridge_node = drone_dashboard_bridge.dashboard_bridge_node:main",
            "dashboard_bridge_node_px4 = drone_dashboard_bridge.dashboard_bridge_node_px4:main",
            "mysql_telemetry_logger = drone_dashboard_bridge.mysql_telemetry_logger:main",
            "field_patrol_mission = drone_dashboard_bridge.field_patrol_mission:main",
            "boustrophedon = drone_dashboard_bridge.boustrophedon:main",
        ],
    },
)
