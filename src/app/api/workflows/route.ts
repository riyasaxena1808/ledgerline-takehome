import { pool } from "@/lib/db";
import { listTemplates } from "@/lib/templates";
import {
  validateWorkflow,
  type WorkflowDefinition,
} from "@/lib/workflow-validation";

export const runtime = "nodejs";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefinition(value: unknown): value is WorkflowDefinition {
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
  if (value.nodes.length > 100 || value.edges.length > 200) return false;
  return value.nodes.every((node) =>
    isObject(node) &&
    typeof node.id === "string" && node.id.length <= 100 &&
    typeof node.type === "string" && node.type.length <= 40 &&
    (node.data === undefined || isObject(node.data)) &&
    (node.position === undefined ||
      (isObject(node.position) && Number.isFinite(node.position.x) && Number.isFinite(node.position.y))),
  ) && value.edges.every((edge) =>
    isObject(edge) &&
    typeof edge.id === "string" && edge.id.length <= 100 &&
    typeof edge.source === "string" && typeof edge.target === "string",
  );
}

export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, version, status, created_at, updated_at
       FROM workflows
       ORDER BY updated_at DESC, name, version DESC
       LIMIT 100`,
    );
    return Response.json({ workflows: rows });
  } catch {
    return Response.json({ error: "Workflows could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 512 * 1024) {
    return Response.json({ error: "Workflow definition is too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send workflow details as JSON." }, { status: 400 });
  }
  if (!isObject(body) || typeof body.name !== "string" || !isDefinition(body.definition)) {
    return Response.json({ error: "A workflow name and valid definition are required." }, { status: 400 });
  }
  const name = body.name.trim();
  if (!name || name.length > 100) {
    return Response.json({ error: "Workflow name must be 1–100 characters." }, { status: 400 });
  }

  let templateIds: Set<string>;
  try {
    templateIds = new Set((await listTemplates()).map((template) => template.id));
  } catch {
    return Response.json({ error: "Letter templates are unavailable." }, { status: 503 });
  }
  const errors = validateWorkflow(body.definition, { templateIds });
  if (errors.length > 0) {
    return Response.json({ error: "Fix the workflow before saving.", details: errors }, { status: 422 });
  }

  const client = await pool.connect().catch(() => null);
  if (!client) return Response.json({ error: "The database is unavailable." }, { status: 503 });
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 41)", [name.toLocaleLowerCase("en-IE")]);
    const nextVersion = await client.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM workflows WHERE lower(name) = lower($1)",
      [name],
    );
    const created = await client.query(
      `INSERT INTO workflows (name, version, definition, status)
       VALUES ($1, $2, $3::jsonb, 'draft')
       RETURNING id, name, version, status, created_at`,
      [name, nextVersion.rows[0].version, JSON.stringify(body.definition)],
    );
    await client.query("COMMIT");
    return Response.json({ workflow: created.rows[0] }, { status: 201 });
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return Response.json({ error: "Workflow could not be saved." }, { status: 500 });
  } finally {
    client.release();
  }
}
