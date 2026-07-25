import subprocess
import re

cmd = "git show HEAD:project/ros2_ws/src/agricultural_world/worlds/agricultural_field.sdf"
res = subprocess.check_output(cmd, shell=True, cwd="/home/iqball/drone-stack", text=True)

# Find all includes
includes = re.findall(r'<include>.*?</include>', res, flags=re.DOTALL)
print("Includes in HEAD:")
for inc in includes:
    name = re.search(r'<name>([^<]+)</name>', inc)
    uri = re.search(r'<uri>([^<]+)</uri>', inc)
    pose = re.search(r'<pose>([^<]+)</pose>', inc)
    if name and uri:
        print(f"Name: {name.group(1)}, URI: {uri.group(1)}, Pose: {pose.group(1) if pose else 'None'}")
