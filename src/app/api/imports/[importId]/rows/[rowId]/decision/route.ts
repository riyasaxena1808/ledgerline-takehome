import { pool } from "@/lib/db";
import {
  matterFields,
  validateMappedRows,
  type MatterField,
} from "@/lib/matter-csv-validation";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const matterFieldSet = new Set<string>(matterFields);

function errorResponse(message: string, status: number, details?: unknown) {
  return Response.json({ error: message, ...(details ? { details } : {}) }, { status });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ importId: string; rowId: string }> },
) {
  const { importId, rowId } = await context.params;
  if (!uuidPattern.test(importId) || !uuidPattern.test(rowId)) {
    return errorResponse("Invalid import or row ID.", 400);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    return errorResponse("The review decision is too large.", 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Send the review decision as JSON.", 400);
  }
  if (!isObject(body)) return errorResponse("The review decision must be an object.", 400);

  const decision = body.decision;
  const reviewer = typeof body.reviewer === "string" ? body.reviewer.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (decision !== "approved" && decision !== "rejected") {
    return errorResponse("Decision must be approved or rejected.", 400);
  }
  if (!reviewer || reviewer.length > 100) {
    return errorResponse("Enter a reviewer name up to 100 characters long.", 400);
  }
  if (decision === "rejected" && !reason) {
    return errorResponse("A reason is required when rejecting a row.", 400);
  }
  if (reason.length > 1000) return errorResponse("The reason is too long.", 400);

  const submittedCorrections = body.corrections === undefined ? {} : body.corrections;
  if (!isObject(submittedCorrections)) {
    return errorResponse("Corrections must be an object keyed by matter field.", 400);
  }
  const corrections: Partial<Record<MatterField, string>> = {};
  for (const [field, value] of Object.entries(submittedCorrections)) {
    if (!matterFieldSet.has(field) || typeof value !== "string" || value.length > 4000) {
      return errorResponse("A correction has an unknown field or invalid value.", 400);
    }
    corrections[field as MatterField] = value;
  }

  let client;
  try {
    client = await pool.connect();
  } catch {
    return errorResponse("The database is unavailable. Please try again.", 503);
  }

  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT r.id, r.import_id, r.row_number, r.normalized_data, r.review_status,
              i.status AS import_status
       FROM import_rows r
       JOIN imports i ON i.id = r.import_id
       WHERE r.id = $1 AND r.import_id = $2
       FOR UPDATE OF r`,
      [rowId, importId],
    );
    if (selected.rowCount === 0) {
      await client.query("ROLLBACK");
      return errorResponse("Import row not found.", 404);
    }

    const row = selected.rows[0];
    if (row.review_status !== "pending") {
      await client.query("ROLLBACK");
      return errorResponse("This row has already been reviewed.", 409);
    }
    if (row.import_status !== "awaiting_review") {
      await client.query("ROLLBACK");
      return errorResponse("This import is no longer accepting review decisions.", 409);
    }

    let matterId: string | null = null;
    let changes: Array<{ field: MatterField; before: string; after: string }> = [];

    if (decision === "approved") {
      if (!isObject(row.normalized_data)) {
        await client.query("ROLLBACK");
        return errorResponse("This row has no normalized matter data to approve.", 409);
      }

      const currentData = Object.fromEntries(
        matterFields.map((field) => [field, String(row.normalized_data[field] ?? "")]),
      ) as Record<MatterField, string>;
      const candidate = { ...currentData, ...corrections };
      const reference = candidate.matter_ref.trim().toLocaleLowerCase("en-IE");
      const duplicate = reference
        ? await client.query(
            `SELECT 1
             WHERE EXISTS (SELECT 1 FROM matters WHERE lower(matter_ref) = $1)
                OR EXISTS (
                  SELECT 1 FROM import_rows other
                  WHERE other.import_id = $2
                    AND other.id <> $3
                    AND other.review_status <> 'rejected'
                    AND lower(other.normalized_data->>'matter_ref') = $1
                )
             LIMIT 1`,
            [reference, importId, rowId],
          )
        : { rowCount: 0 };
      const existingRefs = new Set<string>(duplicate.rowCount ? [reference] : []);
      const mapping = Object.fromEntries(matterFields.map((field) => [field, field]));
      const [validated] = validateMappedRows(
        [candidate],
        [...matterFields],
        mapping,
        existingRefs,
      );
      const errors = validated.findings.filter((finding) => finding.kind === "error");
      if (errors.length > 0) {
        await client.query("ROLLBACK");
        return errorResponse("Correct the flagged fields before approving this matter.", 422, errors);
      }

      const finalData = validated.normalizedData;
      changes = matterFields.flatMap((field) =>
        finalData[field] === currentData[field]
          ? []
          : [{ field, before: currentData[field], after: finalData[field] }],
      );
      const matter = await client.query<{ id: string }>(
        `INSERT INTO matters (
           import_row_id, matter_ref, client_firm, debtor_first_name,
           debtor_last_name, email, phone, amount_owed, currency,
           address_line1, address_line2, town, county, eircode,
           instruction_date, matter_type, notes
         ) VALUES (
           $1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9,
           $10, NULLIF($11, ''), $12, $13, NULLIF($14, ''), $15::date,
           $16, NULLIF($17, '')
         )
         RETURNING id`,
        [
          rowId,
          finalData.matter_ref,
          finalData.client_firm,
          finalData.debtor_first_name,
          finalData.debtor_last_name,
          finalData.email,
          finalData.phone,
          finalData.amount_owed,
          finalData.currency,
          finalData.address_line1,
          finalData.address_line2,
          finalData.town,
          finalData.county,
          finalData.eircode,
          finalData.instruction_date,
          finalData.matter_type,
          finalData.notes,
        ],
      );
      matterId = matter.rows[0].id;

      await client.query(
        `UPDATE import_rows
         SET normalized_data = $2::jsonb,
             review_status = 'approved',
             reviewer_notes = NULLIF($3, ''),
             reviewed_by = $4,
             reviewed_at = NOW()
         WHERE id = $1`,
        [rowId, JSON.stringify(finalData), reason, reviewer],
      );
    } else {
      await client.query(
        `UPDATE import_rows
         SET review_status = 'rejected', reviewer_notes = $2,
             reviewed_by = $3, reviewed_at = NOW()
         WHERE id = $1`,
        [rowId, reason, reviewer],
      );
    }

    await client.query(
      `INSERT INTO review_decisions (import_row_id, decision, reviewer, reason, changes)
       VALUES ($1, $2, $3, NULLIF($4, ''), $5::jsonb)`,
      [rowId, decision, reviewer, reason, JSON.stringify(changes)],
    );

    const pending = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM import_rows WHERE import_id = $1 AND review_status = 'pending'",
      [importId],
    );
    if (pending.rows[0].count === 0) {
      await client.query(
        "UPDATE imports SET status = 'completed', updated_at = NOW() WHERE id = $1",
        [importId],
      );
    }

    await client.query("COMMIT");
    return Response.json({
      rowId,
      decision,
      matterId,
      importCompleted: pending.rows[0].count === 0,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (
      isObject(error) &&
      error.code === "23505" &&
      (error.constraint === "matters_matter_ref_key" ||
        error.constraint === "matters_matter_ref_case_insensitive_unique")
    ) {
      return errorResponse("A matter with this reference already exists.", 409);
    }
    console.error("Review decision could not be saved.");
    return errorResponse("The review decision could not be saved. Please try again.", 500);
  } finally {
    client.release();
  }
}
