import Papa from "papaparse";

import { pool } from "@/lib/db";
import { saveCsvBlob } from "@/lib/blob-storage";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeSpreadsheetCell(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map((item) => String(item ?? "")).join(", ")
    : String(value ?? "");
  return /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  const { importId } = await context.params;
  if (!uuidPattern.test(importId)) {
    return Response.json({ error: "Invalid import ID." }, { status: 400 });
  }

  try {
    const importResult = await pool.query<{ id: string; file_name: string; column_mapping: Record<string, string> }>(
      "SELECT id, file_name, column_mapping FROM imports WHERE id = $1",
      [importId],
    );
    if (importResult.rowCount === 0) {
      return Response.json({ error: "Import not found." }, { status: 404 });
    }

    const rejected = await pool.query<{
      original_data: Record<string, unknown>;
      reason: string;
    }>(
      `SELECT r.original_data,
              COALESCE(
                (SELECT d.reason FROM review_decisions d
                 WHERE d.import_row_id = r.id AND d.decision = 'rejected'
                 ORDER BY d.decided_at DESC LIMIT 1),
                r.reviewer_notes,
                'Rejected by reviewer'
              ) AS reason
       FROM import_rows r
       WHERE r.import_id = $1 AND r.review_status = 'rejected'
       ORDER BY r.row_number`,
      [importId],
    );

    const headers = new Set<string>();
    for (const row of rejected.rows) {
      for (const header of Object.keys(row.original_data)) headers.add(header);
    }
    for (const header of Object.keys(importResult.rows[0].column_mapping ?? {})) {
      headers.add(header);
    }
    const fields = [...headers, "rejection_reason"];
    const data = rejected.rows.map((row) => ({
      ...Object.fromEntries(
        [...headers].map((header) => [header, safeSpreadsheetCell(row.original_data[header])]),
      ),
      rejection_reason: safeSpreadsheetCell(row.reason),
    }));
    const csv = Papa.unparse({ fields, data }, { newline: "\r\n" });
    await saveCsvBlob(`rejected/${importId}.csv`, csv);

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="rejected-${importId}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Rejected rows could not be exported. Please try again." },
      { status: 503 },
    );
  }
}
