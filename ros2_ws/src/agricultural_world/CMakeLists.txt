cmake_minimum_required(VERSION 3.16)
project(agricultural_world)

# ── C++17 Standard ───────────────────────────────────────────────────────────
if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

# ── Find ament_cmake ──────────────────────────────────────────────────────────
find_package(ament_cmake REQUIRED)
# find_package(ament_cmake_python REQUIRED)

# ── Install world files ───────────────────────────────────────────────────────
install(
  DIRECTORY worlds/
  DESTINATION share/${PROJECT_NAME}/worlds
)

# ── Install model files ───────────────────────────────────────────────────────
install(
  DIRECTORY models/
  DESTINATION share/${PROJECT_NAME}/models
)

# ── Install launch files ──────────────────────────────────────────────────────
install(
  DIRECTORY launch/
  DESTINATION share/${PROJECT_NAME}/launch
)

# ── Install config files ──────────────────────────────────────────────────────
install(
  DIRECTORY config/
  DESTINATION share/${PROJECT_NAME}/config
)

# ── Install scripts ───────────────────────────────────────────────────────────
install(
  DIRECTORY scripts/
  DESTINATION share/${PROJECT_NAME}/scripts
  USE_SOURCE_PERMISSIONS
)

# ── Install Python scripts sebagai executables ────────────────────────────────
# ament_python_install_package(${PROJECT_NAME})

# ── Tests ─────────────────────────────────────────────────────────────────────
if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
