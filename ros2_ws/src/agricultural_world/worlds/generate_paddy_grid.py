import re
import random

path = '/home/iqball/drone-stack/project/ros2_ws/src/agricultural_world/worlds/agricultural_field.sdf'

with open(path, 'r') as f:
    content = f.read()

# 1. Extract the header up to </model> of ground_base
# The ground_base model ends with </model>. We want everything up to the first </model> which is ground_base
# Wait, let's just find the string '<!-- ======================================================\n         ZONA SAWAH UTAMA'
split_marker = '<!-- ======================================================\n         ZONA SAWAH UTAMA'
if split_marker in content:
    header = content.split(split_marker)[0]
else:
    # fallback
    idx = content.find('<model name="sawah_utama">')
    header = content[:idx]

# Extract palm trees and drone marker from original file
trees_and_markers = ""
# We will just manually add them at the end to be safe, rather than regex matching, to ensure they are clean.

new_content = header

new_content += """
    <!-- ======================================================
         GRID SAWAH (PETAK SAWAH & PEMATANG)
    ====================================================== -->
    <!-- The ground_base (which has brown grass_bund texture) acts as the base pematang. 
         We will place the green paddies slightly above it. The gaps between paddies will become the pematang. -->
         
    <model name="sawah_grid">
      <static>true</static>
"""

# Dimensions of the total agricultural area
# X from -90 to 90 (180m)
# Y from -90 to 60 (150m)
start_x = -90.0
end_x = 90.0
start_y = -90.0
end_y = 60.0

# Plot size parameters
mean_plot_w = 20.0
mean_plot_h = 15.0
path_width = 1.2

x = start_x
plot_idx = 0

while x < end_x:
    y = start_y
    # Determine column width (randomized)
    col_width = mean_plot_w + random.uniform(-3.0, 3.0)
    if x + col_width > end_x:
        col_width = end_x - x
    
    while y < end_y:
        # Determine row height (randomized)
        row_height = mean_plot_h + random.uniform(-2.0, 2.0)
        if y + row_height > end_y:
            row_height = end_y - y
            
        # The center of the plot
        cx = x + col_width / 2.0
        cy = y + row_height / 2.0
        
        # We subtract path_width from the actual box dimensions
        # so there's a gap between boxes
        box_w = max(1.0, col_width - path_width)
        box_h = max(1.0, row_height - path_width)
        
        # Paddies are green
        # Z = 0.05, height = 0.1
        new_content += f"""
      <link name="plot_{plot_idx}">
        <pose>{cx:.2f} {cy:.2f} 0.05 0 0 0</pose>
        <visual name="v">
          <geometry><box><size>{box_w:.2f} {box_h:.2f} 0.1</size></box></geometry>
          <material>
            <pbr>
              <metal>
                <albedo_map>model://ground_materials/materials/textures/paddy_field_albedo.png</albedo_map>
                <normal_map>model://ground_materials/materials/textures/paddy_field_normal.png</normal_map>
                <roughness_map>model://ground_materials/materials/textures/paddy_field_roughness.png</roughness_map>
              </metal>
            </pbr>
          </material>
        </visual>
        <collision name="c">
          <geometry><box><size>{box_w:.2f} {box_h:.2f} 0.1</size></box></geometry>
        </collision>
      </link>"""
        
        plot_idx += 1
        y += row_height
    
    x += col_width

new_content += """
    </model>
"""

# Re-add palm trees
new_content += """
    <!-- ======================================================
         POHON KELAPA SAWIT (3 buah)
    ====================================================== -->
    <include>
      <name>pohon_sawit_01</name>
      <uri>model://oil_palm_tree</uri>
      <pose>0 -20 0 0 0 0</pose>
    </include>
    <include>
      <name>pohon_sawit_02</name>
      <uri>model://oil_palm_tree</uri>
      <pose>0 0 0 0 0 0</pose>
    </include>
    <include>
      <name>pohon_sawit_03</name>
      <uri>model://oil_palm_tree</uri>
      <pose>0 20 0 0 0 0</pose>
    </include>

    <!-- ======================================================
         DRONE SPAWN POINT MARKER
    ====================================================== -->
    <model name="drone_spawn_marker">
      <static>true</static>
      <pose>-70 -15 0.01 0 0 0</pose>
      <link name="link">
        <visual name="v">
          <geometry>
            <cylinder>
              <radius>1.5</radius>
              <length>0.02</length>
            </cylinder>
          </geometry>
          <material>
            <ambient>0.8 0.1 0.1 0.8</ambient>
            <diffuse>0.8 0.1 0.1 0.8</diffuse>
          </material>
        </visual>
      </link>
    </model>

  </world>
</sdf>
"""

with open(path, 'w') as f:
    f.write(new_content)

print(f"Generated {plot_idx} paddy plots.")
