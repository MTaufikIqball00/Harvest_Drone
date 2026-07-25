import { NextResponse } from "next/server";
import { query } from "@/lib/mysql";

export async function GET() {
  try {
    const missions = await query(
      `SELECT m.*, d.name as drone_name 
       FROM missions m 
       LEFT JOIN drones d ON m.drone_id = d.id 
       ORDER BY m.start_time DESC LIMIT 50`
    );
    const telemetryLogs = await query(
      `SELECT * FROM telemetry_logs ORDER BY recorded_at DESC LIMIT 100`
    );
    const harvestJobs = await query(
      `SELECT * FROM harvest_jobs ORDER BY created_at DESC LIMIT 50`
    );

    return NextResponse.json({
      success: true,
      missions,
      telemetryLogs,
      harvestJobs,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Database query failed" },
      { status: 500 }
    );
  }
}
