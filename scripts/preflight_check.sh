#!/usr/bin/env bash
# =============================================================================
# scripts/preflight_check.sh - Pre-flight environment validator
# =============================================================================

GREEN='\030[0;32m'
RED='\030[0;31m'
YELLOW='\030[1;33m'
CYAN='\030[0;36m'
NC='\030[0m'

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}   DRONE-STACK MONOREPO PRE-FLIGHT CHECK SYSTEM     ${NC}"
echo -e "${CYAN}=====================================================${NC}"

ERRORS=0

check_cmd() {
    local name="$1"
    local cmd="$2"
    if command -v $cmd >/dev/null 2>&1; then
        echo -e "[CHECK] $name ... ${GREEN}PASSED${NC}"
    else
        echo -e "[CHECK] $name ... ${RED}FAILED (Command '$cmd' not found)${NC}"
        ERRORS=$((ERRORS + 1))
    fi
}

check_port() {
    local port="$1"
    local service="$2"
    if ss -tuln | grep -q ":${port} "; then
        echo -e "[PORT] Port $port ($service) ... ${YELLOW}IN USE (Will be managed by stop.sh)${NC}"
    else
        echo -e "[PORT] Port $port ($service) ... ${GREEN}AVAILABLE${NC}"
    fi
}

echo -e "\n${CYAN}--- Checking Required Binaries ---${NC}"
check_cmd "Python 3" "python3"
check_cmd "Node.js" "node"
check_cmd "npm" "npm"
check_cmd "MySQL Client" "mysql"
check_cmd "Gazebo Sim" "gz"

echo -e "\n${CYAN}--- Checking ROS 2 Environment ---${NC}"
if [ -f "/opt/ros/jazzy/setup.bash" ]; then
    echo -e "[ROS 2] ROS 2 Jazzy Installation ... ${GREEN}PASSED${NC}"
else
    echo -e "[ROS 2] ROS 2 Jazzy Installation ... ${RED}FAILED (/opt/ros/jazzy/setup.bash not found)${NC}"
    ERRORS=$((ERRORS + 1))
fi

echo -e "\n${CYAN}--- Checking Port Availability ---${NC}"
check_port 3000 "Next.js Frontend"
check_port 8000 "FastAPI AI Backend"
check_port 9090 "ROSBridge WebSocket"
check_port 8888 "Micro XRCE-DDS UDP"
check_port 14540 "MAVROS MAVLink UDP"

echo -e "\n${CYAN}-----------------------------------------------------${NC}"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}Pre-flight check completed successfully! System ready.${NC}"
    exit 0
else
    echo -e "${RED}Pre-flight check completed with $ERRORS error(s). Please fix missing dependencies.${NC}"
    exit 1
fi
