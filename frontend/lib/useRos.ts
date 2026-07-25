"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import ROSLIB from "roslib";

export interface TelemetryData {
  x: number;
  y: number;
  z: number;
  lat: number;
  lon: number;
  alt: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  yaw: number;
  pitch: number;
  roll: number;
  heading: number;
  battery: number;
  voltage: number;
  flightMode: string;
  armed: boolean;
  navState: string;
}

export interface Waypoint {
  id: number;
  x: number;
  y: number;
  z: number;
  lat?: number;
  lon?: number;
}

const defaultTelemetry: TelemetryData = {
  x: 0,
  y: 0,
  z: 0,
  lat: -6.9175,
  lon: 107.6191,
  alt: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  speed: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  heading: 0,
  battery: 100,
  voltage: 15.6,
  flightMode: "MANUAL",
  armed: false,
  navState: "STANDBY",
};

export function useRos(wsUrl: string = "ws://localhost:9090") {
  const [connected, setConnected] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(true);
  const [telemetry, setTelemetry] = useState<TelemetryData>(defaultTelemetry);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [flightPath, setFlightPath] = useState<{ x: number; y: number }[]>([]);
  const rosRef = useRef<ROSLIB.Ros | null>(null);

  useEffect(() => {
    let ros: ROSLIB.Ros | null = null;
    let isMounted = true;

    try {
      ros = new ROSLIB.Ros({
        url: wsUrl,
      });

      ros.on("connection", () => {
        if (isMounted) {
          console.log("[ROSBridge] Connected to WebSocket at:", wsUrl);
          setConnected(true);
          setConnecting(false);
        }
      });

      ros.on("error", (error: any) => {
        if (isMounted) {
          console.warn("[ROSBridge] Connection error:", error);
          setConnected(false);
          setConnecting(false);
        }
      });

      ros.on("close", () => {
        if (isMounted) {
          console.log("[ROSBridge] Connection closed");
          setConnected(false);
          setConnecting(false);
        }
      });

      rosRef.current = ros;

      // Subscribe to telemetry topic /drone/telemetry or /px4_telemetry
      const telemTopic = new ROSLIB.Topic({
        ros: ros,
        name: "/drone/telemetry",
        messageType: "std_msgs/msg/String",
      });

      telemTopic.subscribe((message: any) => {
        if (!isMounted) return;
        try {
          const data = typeof message.data === "string" ? JSON.parse(message.data) : message;
          setTelemetry((prev) => {
            const nextTelem = { ...prev, ...data };
            if (data.x !== undefined && data.y !== undefined) {
              setFlightPath((path) => [...path.slice(-100), { x: data.x, y: data.y }]);
            }
            return nextTelem;
          });
        } catch (e) {
          // ignore parse errors
        }
      });

      // Subscribe to pose topic /drone/pose if available
      const poseTopic = new ROSLIB.Topic({
        ros: ros,
        name: "/drone/pose",
        messageType: "geometry_msgs/msg/PoseStamped",
      });

      poseTopic.subscribe((msg: any) => {
        if (!isMounted) return;
        const pos = msg.pose?.position;
        if (pos) {
          setTelemetry((prev) => ({
            ...prev,
            x: pos.x || 0,
            y: pos.y || 0,
            z: pos.z || 0,
            alt: pos.z || 0,
          }));
          setFlightPath((path) => [...path.slice(-100), { x: pos.x || 0, y: pos.y || 0 }]);
        }
      });
    } catch (err) {
      console.error("[ROSBridge] Error initializing ROSLIB:", err);
      setConnecting(false);
    }

    return () => {
      isMounted = false;
      if (ros) {
        try {
          ros.close();
        } catch (e) {}
      }
    };
  }, [wsUrl]);

  const sendCommand = useCallback((command: string, params: any = {}) => {
    if (!rosRef.current || !rosRef.current.isConnected) {
      console.warn("[ROSBridge] Cannot send command, ROS not connected");
      return false;
    }
    try {
      const cmdTopic = new ROSLIB.Topic({
        ros: rosRef.current,
        name: "/drone/cmd",
        messageType: "std_msgs/msg/String",
      });

      const payload = JSON.stringify({ command, ...params });
      cmdTopic.publish(new ROSLIB.Message({ data: payload }));
      console.log(`[ROSBridge] Published command: ${command}`, params);
      return true;
    } catch (e) {
      console.error("[ROSBridge] Error publishing command:", e);
      return false;
    }
  }, []);

  const arm = useCallback(() => sendCommand("ARM"), [sendCommand]);
  const disarm = useCallback(() => sendCommand("DISARM"), [sendCommand]);
  const takeoff = useCallback((altitude: number = 5.0) => sendCommand("TAKEOFF", { altitude }), [sendCommand]);
  const land = useCallback(() => sendCommand("LAND"), [sendCommand]);
  const rth = useCallback(() => sendCommand("RTH"), [sendCommand]);
  const setFlightMode = useCallback((mode: string) => sendCommand("SET_MODE", { mode }), [sendCommand]);
  
  const addWaypoint = useCallback((wp: Waypoint) => {
    setWaypoints((prev) => [...prev, wp]);
  }, []);

  const clearWaypoints = useCallback(() => {
    setWaypoints([]);
  }, []);

  const sendWaypoints = useCallback(
    (wpList: Waypoint[]) => {
      setWaypoints(wpList);
      return sendCommand("UPLOAD_WAYPOINTS", { waypoints: wpList });
    },
    [sendCommand]
  );

  return {
    connected,
    connecting,
    telemetry,
    waypoints,
    flightPath,
    arm,
    disarm,
    takeoff,
    land,
    rth,
    setFlightMode,
    addWaypoint,
    clearWaypoints,
    sendWaypoints,
    sendCommand,
  };
}
