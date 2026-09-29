import { pool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.description, t.status, t.due_at, t.created_at,
              t.completed_at, t.completed_by, m.id AS matter_id, m.matter_ref,
              m.debtor_first_name, m.debtor_last_name, b.id AS batch_id, w.name AS workflow_name
       FROM tasks t JOIN workflow_runs r ON r.id = t.run_id
       JOIN matters m ON m.id = r.matter_id LEFT JOIN workflow_batches b ON b.id = r.batch_id
       JOIN workflows w ON w.id = r.workflow_id
       ORDER BY CASE WHEN t.status IN ('pending','in_progress') THEN 0 ELSE 1 END, t.created_at DESC LIMIT 200`,
    );
    return Response.json({ tasks: rows });
  } catch { return Response.json({ error: "Tasks could not be loaded." }, { status: 503 }); }
}
