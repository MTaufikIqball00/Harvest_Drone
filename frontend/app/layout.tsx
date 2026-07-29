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
    // suppressHydrationWarning: ekstensi browser (mis. Bitdefender) menyuntikkan
    // atribut seperti bis_skin_checked="1" dan bis_register="..." ke <body> serta
    // <div> SEBELUM React sempat hydrate. React lalu melihat HTML server berbeda
    // dari DOM klien dan melempar peringatan hydration mismatch.
    //
    // Ini bukan cacat aplikasi — markup kita deterministik. Flag ini hanya
    // memberi tahu React untuk mengabaikan selisih atribut pada level ini, dan
    // TIDAK menyembunyikan mismatch yang berasal dari kode kita sendiri (mis.
    // Date.now()/Math.random() saat render), karena efeknya tidak diturunkan
    // ke seluruh pohon komponen.
    <html lang="id" suppressHydrationWarning>
      <body
        className="bg-[#0b0f19] text-slate-100 min-h-screen antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
