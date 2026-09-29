import { pool } from "@/lib/db";
import { listTemplates } from "@/lib/templates";
import { validateWorkflow, type WorkflowDefinition } from "@/lib/workflow-validation";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  context: { params: Promise<{ workflowId: string }> },
) {
  const { workflowId } = await context.params;
  if (!uuidPattern.test(workflowId)) {
    return Response.json({ error: "Invalid workflow ID." }, { status: 400 });
  }
  const client = await pool.connect().catch(() => null);
  if (!client) return Response.json({ error: "The database is unavailable." }, { status: 503 });

  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; name: string; definition: WorkflowDefinition; status: string }>(
      "SELECT id, name, definition, status FROM workflows WHERE id = $1 FOR UPDATE",
      [workflowId],
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return Response.json({ error: "Workflow not found." }, { status: 404 });
    }
    const workflow = result.rows[0];
    const templateIds = new Set((await listTemplates()).map((template) => template.id));
    const errors = validateWorkflow(workflow.definition, { templateIds });
    if (errors.length > 0) {
      await client.query("ROLLBACK");
      return Response.json({ error: "Fix the workflow before publishing.", details: errors }, { status: 422 });
    }

    await client.query(
      "UPDATE workflows SET status = 'archived', updated_at = NOW() WHERE lower(name) = lower($1) AND status = 'published' AND id <> $2",
      [workflow.name, workflowId],
    );
    const published = await client.query(
      "UPDATE workflows SET status = 'published', updated_at = NOW() WHERE id = $1 RETURNING id, name, version, status",
      [workflowId],
    );
    await client.query("COMMIT");
    return Response.json({ workflow: published.rows[0] });
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return Response.json({ error: "Workflow could not be published." }, { status: 500 });
  } finally {
    client.release();
  }
}
