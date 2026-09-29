import { pool } from "@/lib/db";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageSize = 100;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  const { importId } = await context.params;
  if (!uuidPattern.test(importId)) return errorResponse("Invalid import ID.", 400);

  const offsetValue = Number(new URL(request.url).searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offsetValue) || offsetValue < 0) {
    return errorResponse("Invalid page offset.", 400);
  }

  try {
    const importResult = await pool.query(
      `SELECT id, file_name, status, column_mapping, created_at
       FROM imports WHERE id = $1`,
      [importId],
    );
    if (importResult.rowCount === 0) return errorResponse("Import not found.", 404);

    const countResult = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM import_rows WHERE import_id = $1",
      [importId],
    );
    const rowResult = await pool.query(
      `SELECT id, row_number, original_data, normalized_data, validation_findings,
              review_status, reviewer_notes, reviewed_by, reviewed_at
       FROM import_rows
       WHERE import_id = $1
       ORDER BY row_number
       LIMIT $2 OFFSET $3`,
      [importId, pageSize, offsetValue],
    );

    const rowIds = rowResult.rows.map((row) => row.id);
    const decisionResult = rowIds.length
      ? await pool.query(
          `SELECT id, import_row_id, decision, reviewer, reason, changes, decided_at
           FROM review_decisions
           WHERE import_row_id = ANY($1::uuid[])
           ORDER BY decided_at, id`,
          [rowIds],
        )
      : { rows: [] };
    const decisionsByRow = new Map<string, unknown[]>();
    for (const decision of decisionResult.rows) {
      const history = decisionsByRow.get(decision.import_row_id) ?? [];
      history.push({
        id: decision.id,
        decision: decision.decision,
        reviewer: decision.reviewer,
        reason: decision.reason,
        changes: decision.changes,
        decidedAt: decision.decided_at,
      });
      decisionsByRow.set(decision.import_row_id, history);
    }

    return Response.json({
      import: importResult.rows[0],
      rowCount: countResult.rows[0].count,
      offset: offsetValue,
      pageSize,
      rows: rowResult.rows.map((row) => ({
        ...row,
        decisions: decisionsByRow.get(row.id) ?? [],
      })),
    });
  } catch {
    return errorResponse("The import review could not be loaded. Please try again.", 503);
  }
}
