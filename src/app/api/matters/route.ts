import { pool } from "@/lib/db";

export const runtime = "nodejs";

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const search = (parameters.get("search") ?? "").trim().slice(0, 100);
  const rawOffset = Number(parameters.get("offset") ?? "0");
  if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) {
    return errorResponse("Invalid page offset.", 400);
  }
  const offset = rawOffset;
  const limit = 50;
  const searchPattern = search ? `%${search}%` : null;

  try {
    const [countResult, matterResult] = await Promise.all([
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM matters m
         WHERE $1::text IS NULL
            OR m.matter_ref ILIKE $1
            OR m.client_firm ILIKE $1
            OR m.debtor_first_name ILIKE $1
            OR m.debtor_last_name ILIKE $1`,
        [searchPattern],
      ),
      pool.query(
        `SELECT m.id, m.matter_ref, m.client_firm, m.debtor_first_name,
                m.debtor_last_name, m.amount_owed::text, m.currency,
                to_char(m.instruction_date, 'DD/MM/YYYY') AS instruction_date,
                m.created_at, i.id AS import_id,
                i.file_name AS source_file
         FROM matters m
         JOIN import_rows r ON r.id = m.import_row_id
         JOIN imports i ON i.id = r.import_id
         WHERE $1::text IS NULL
            OR m.matter_ref ILIKE $1
            OR m.client_firm ILIKE $1
            OR m.debtor_first_name ILIKE $1
            OR m.debtor_last_name ILIKE $1
         ORDER BY m.created_at DESC, m.id
         LIMIT $2 OFFSET $3`,
        [searchPattern, limit, offset],
      ),
    ]);

    return Response.json({
      matters: matterResult.rows,
      total: countResult.rows[0].count,
      offset,
      limit,
    });
  } catch {
    return errorResponse("Matters could not be loaded. Please try again.", 503);
  }
}
