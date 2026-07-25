import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Autonomous Drone & Rice Harvest AI Monorepo Dashboard",
  description: "Unified control system for autonomous drones (ROS 2, PX4 SITL, Gazebo, Dual Bridge) and Rice Harvest AI classification (FastAPI, OpenCV, Leaflet).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body className="bg-[#0b0f19] text-slate-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
