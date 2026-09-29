import { pool } from "@/lib/db";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ workflowId: string }> },
) {
  const { workflowId } = await context.params;
  if (!uuidPattern.test(workflowId)) {
    return Response.json({ error: "Invalid workflow ID." }, { status: 400 });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, version, status, definition, created_at, updated_at
       FROM workflows WHERE id = $1`,
      [workflowId],
    );
    if (result.rowCount === 0) {
      return Response.json({ error: "Workflow not found." }, { status: 404 });
    }
    return Response.json({ workflow: result.rows[0] });
  } catch {
    return Response.json({ error: "Workflow could not be loaded." }, { status: 503 });
  }
}
