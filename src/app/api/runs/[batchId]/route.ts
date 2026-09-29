import { pool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return Response.json({ error: "Run not found." }, { status: 404 });
  try {
    const batch = await pool.query(
      `SELECT b.id, b.workflow_id, w.name AS workflow_name, b.workflow_version, b.status,
              b.created_at, b.started_at, b.completed_at
       FROM workflow_batches b JOIN workflows w ON w.id = b.workflow_id WHERE b.id = $1`, [batchId]);
    if (!batch.rowCount) return Response.json({ error: "Run not found." }, { status: 404 });
    const { rows: matters } = await pool.query(
      `SELECT r.id AS run_id, r.matter_id, m.matter_ref, m.debtor_first_name, m.debtor_last_name,
              r.status, r.current_node_id, r.scheduled_for, r.error_message,
              COALESCE(node.value->'data'->>'title', CASE node.value->>'type' WHEN 'sendLetter' THEN 'Send letter' WHEN 'wait' THEN 'Wait' WHEN 'start' THEN 'Start' WHEN 'end' THEN 'End' END) AS current_step,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('nodeId', d.node_id, 'status', d.status, 'providerId', d.provider_response->>'providerId', 'attemptedAt', d.attempted_at) ORDER BY d.created_at) FROM letter_deliveries d WHERE d.run_id = r.id), '[]'::jsonb) AS letters,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'completedBy', t.completed_by, 'completedAt', t.completed_at) ORDER BY t.created_at) FROM tasks t WHERE t.run_id = r.id), '[]'::jsonb) AS tasks
       FROM workflow_runs r JOIN matters m ON m.id = r.matter_id
       LEFT JOIN LATERAL jsonb_array_elements(r.workflow_snapshot->'nodes') AS node(value) ON node.value->>'id' = r.current_node_id
       WHERE r.batch_id = $1 ORDER BY m.matter_ref`, [batchId]);
    return Response.json({ batch: batch.rows[0], matters });
  } catch { return Response.json({ error: "Run details could not be loaded." }, { status: 503 }); }
}
