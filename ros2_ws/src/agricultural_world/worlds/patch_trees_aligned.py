import re

path = '/home/iqball/drone-stack/project/ros2_ws/src/agricultural_world/worlds/agricultural_field.sdf'

with open(path, 'r') as f:
    text = f.read()

# 1. Remove "pohon bulat" models (pohon_tengah_obstacle_1 and 2)
text = re.sub(r'<model name="pohon_tengah_obstacle_1">.*?</model>', '', text, flags=re.DOTALL)
text = re.sub(r'<model name="pohon_tengah_obstacle_2">.*?</model>', '', text, flags=re.DOTALL)

# 2. Remove any existing palm trees or other middle obstacle trees
text = re.sub(r'<include>\s*<name>pohon_sawit_01</name>.*?</include>', '', text, flags=re.DOTALL)
text = re.sub(r'<include>\s*<name>pohon_sawit_02</name>.*?</include>', '', text, flags=re.DOTALL)
text = re.sub(r'<include>\s*<name>pohon_sawit_03</name>.*?</include>', '', text, flags=re.DOTALL)
text = re.sub(r'<include>\s*<name>pohon_tengah_obstacle</name>.*?</include>', '', text, flags=re.DOTALL)
text = re.sub(r'<include>\s*<name>pohon_kelapa_masjid_1</name>.*?</include>', '', text, flags=re.DOTALL)
text = re.sub(r'<include>\s*<name>pohon_kelapa_masjid_2</name>.*?</include>', '', text, flags=re.DOTALL)

# 3. Add 3 oil_palm_tree obstacles aligned along the X-axis (Y = 0)
aligned_trees = """<!-- ======================================================
         POHON KELAPA SAWIT ALIGNED (3 buah di Y = 0)
    ====================================================== -->
    <include>
      <name>pohon_sawit_01</name>
      <uri>model://oil_palm_tree</uri>
      <pose>-40 0 0 0 0 0</pose>
    </include>
    <include>
      <name>pohon_sawit_02</name>
      <uri>model://oil_palm_tree</uri>
      <pose>0 0 0 0 0 0</pose>
    </include>
    <include>
      <name>pohon_sawit_03</name>
      <uri>model://oil_palm_tree</uri>
      <pose>40 0 0 0 0 0</pose>
    </include>"""

# Inject before spawn_marker
marker_pattern = r'(<model name="spawn_marker">)'
text = re.sub(marker_pattern, aligned_trees + "\n\n    \\1", text)

with open(path, 'w') as f:
    f.write(text)

print("Round trees removed, and 3 palm trees aligned at Y=0 successfully.")
