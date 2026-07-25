import os

path = '/home/iqball/drone-stack/project/ros2_ws/src/agricultural_world/worlds/agricultural_field.sdf'

with open(path, 'r') as f:
    content = f.read()

content = content.replace('model://ground_materials/materials/textures/paddy_field_albedo.png', 'model://paddy_ground/materials/textures/albedo.jpg')
content = content.replace('model://ground_materials/materials/textures/paddy_field_normal.png', 'model://paddy_ground/materials/textures/normal.jpg')
content = content.replace('model://ground_materials/materials/textures/paddy_field_roughness.png', 'model://paddy_ground/materials/textures/roughness.jpg')

with open(path, 'w') as f:
    f.write(content)
