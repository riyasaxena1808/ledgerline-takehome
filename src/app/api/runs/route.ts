import { pool } from "@/lib/db";
import { listTemplates } from "@/lib/templates";
import { validateWorkflow, type WorkflowDefinition } from "@/lib/workflow-validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.workflow_id, w.name AS workflow_name, b.workflow_version,
              b.status, b.created_at, b.started_at, b.completed_at,
              COUNT(r.id)::int AS matter_count,
              COUNT(r.id) FILTER (WHERE r.status = 'completed')::int AS completed_count,
              COUNT(r.id) FILTER (WHERE r.status = 'failed')::int AS failed_count,
              COUNT(r.id) FILTER (WHERE r.status IN ('pending','running','waiting'))::int AS active_count
       FROM workflow_batches b JOIN workflows w ON w.id = b.workflow_id
       LEFT JOIN workflow_runs r ON r.batch_id = b.id
       GROUP BY b.id, w.name ORDER BY b.created_at DESC LIMIT 50`,
    );
    return Response.json({ batches: rows });
  } catch {
    return Response.json({ error: "Workflow runs could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send run details as JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Run details are required." }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (typeof input.workflowId !== "string" || !Array.isArray(input.matterIds) || input.matterIds.length < 1 || input.matterIds.length > 1000 || input.matterIds.some((id) => typeof id !== "string")) {
    return Response.json({ error: "Choose a published workflow and between 1 and 1,000 matters." }, { status: 400 });
  }
  const matterIds = [...new Set(input.matterIds as string[])];
  if (matterIds.length !== input.matterIds.length || matterIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) return Response.json({ error: "Matter IDs must be unique UUIDs." }, { status: 400 });
  const client = await pool.connect().catch(() => null);
  if (!client) return Response.json({ error: "The database is unavailable." }, { status: 503 });
  try {
    const found = await client.query<{ id: string; version: number; definition: WorkflowDefinition }>("SELECT id, version, definition FROM workflows WHERE id = $1 AND status = 'published'", [input.workflowId]);
    if (!found.rowCount) return Response.json({ error: "Select a published workflow." }, { status: 422 });
    const workflow = found.rows[0];
    const templateIds = new Set((await listTemplates()).map((t) => t.id));
    const definitionErrors = validateWorkflow(workflow.definition, { templateIds });
    if (definitionErrors.length) return Response.json({ error: "The published workflow is no longer valid.", details: definitionErrors }, { status: 422 });
    await client.query("BEGIN");
    const validMatters = await client.query<{ id: string }>("SELECT id FROM matters WHERE id = ANY($1::uuid[]) FOR SHARE", [matterIds]);
    if (validMatters.rowCount !== matterIds.length) {
      await client.query("ROLLBACK");
      return Response.json({ error: "One or more selected matters no longer exist." }, { status: 422 });
    }
    const start = workflow.definition.nodes.find((node) => node.type === "start");
    const batch = await client.query<{ id: string }>(
      `INSERT INTO workflow_batches (workflow_id, workflow_version, workflow_snapshot, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [workflow.id, workflow.version, JSON.stringify(workflow.definition)],
    );
    for (const matterId of matterIds) {
      await client.query(
        `INSERT INTO workflow_runs (workflow_id, matter_id, workflow_version, workflow_snapshot, batch_id, current_node_id, scheduled_for)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())`,
        [workflow.id, matterId, workflow.version, JSON.stringify(workflow.definition), batch.rows[0].id, start?.id],
      );
    }
    await client.query("COMMIT");
    return Response.json({ batchId: batch.rows[0].id, matterCount: matterIds.length }, { status: 201 });
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return Response.json({ error: "The workflow run could not be started." }, { status: 500 });
  } finally { client.release(); }
}
