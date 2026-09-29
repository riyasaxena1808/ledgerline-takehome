import { pool } from "@/lib/db";

// Quick check that the app can reach Postgres. Visit /api/health.
export async function GET() {
  try {
    await pool.query("select 1");
    return Response.json({ ok: true, database: "connected" });
  } catch {
    return Response.json(
      { ok: false, error: "Database unavailable." },
      { status: 500 },
    );
  }
}
