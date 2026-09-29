import { pool } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return Response.json({ error: "Task not found." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send the staff name as JSON." }, { status: 400 }); }
  const completedBy = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).completedBy === "string" ? ((body as Record<string, string>).completedBy).trim() : "";
  if (!completedBy || completedBy.length > 120) return Response.json({ error: "Enter a staff name (up to 120 characters)." }, { status: 400 });
  const client = await pool.connect().catch(() => null);
  if (!client) return Response.json({ error: "The database is unavailable." }, { status: 503 });
  try {
    await client.query("BEGIN");
    const found = await client.query<{ run_id: string; node_id: string; status: string }>("SELECT run_id, node_id, status FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
    if (!found.rowCount) { await client.query("ROLLBACK"); return Response.json({ error: "Task not found." }, { status: 404 }); }
    const task = found.rows[0];
    if (task.status !== "pending" && task.status !== "in_progress") { await client.query("ROLLBACK"); return Response.json({ error: "This task is already closed." }, { status: 409 }); }
    await client.query("UPDATE tasks SET status = 'completed', completed_by = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $1", [taskId, completedBy]);
    const resumed = await client.query(
      `UPDATE workflow_runs SET status = 'pending', scheduled_for = NOW(), lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'waiting' AND execution_state->>'waiting_task_node' = $2`, [task.run_id, task.node_id]);
    await client.query("COMMIT");
    return Response.json({ completed: true, resumed: resumed.rowCount === 1 });
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return Response.json({ error: "Task could not be completed." }, { status: 500 });
  } finally { client.release(); }
}
