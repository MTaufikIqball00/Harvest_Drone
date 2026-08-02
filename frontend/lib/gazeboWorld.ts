/**
 * lib/gazeboWorld.ts
 * =============================================================================
 * Konstanta dunia simulasi Gazebo yang dipakai lintas komponen.
 *
 * Nilai-nilai ini MENCERMINKAN world SDF & daftar obstacle statis di node ROS
 * (dashboard_bridge_node_px4.py -> self.obstacles). Karena posisinya tetap,
 * frontend bisa menghitung jarak/ODI langsung dari posisi drone tanpa menunggu
 * topik /dashboard/obstacles — sehingga indikator penghindaran tetap realtime
 * walau topik itu belum/ tidak terbit.
 */

export interface GazeboTree {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  radius: number;
  clearance: number;
}

export const GAZEBO_SPAWN = { x: -65.0, y: 0.0 };

export const GAZEBO_TREES: GazeboTree[] = [
  { id: "pohon_sawit_01", name: "🌴 Pohon Sawit 1", kind: "tree", x: -40.0, y: 0.0, radius: 4.0, clearance: 2.0 },
  { id: "pohon_sawit_02", name: "🌴 Pohon Sawit 2", kind: "tree", x: -20.0, y: 0.0, radius: 4.0, clearance: 2.0 },
  { id: "pohon_sawit_03", name: "🌴 Pohon Sawit 3", kind: "tree", x: 0.0, y: 0.0, radius: 4.0, clearance: 2.0 },
];
