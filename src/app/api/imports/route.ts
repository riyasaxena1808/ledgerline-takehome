import { createHash, randomUUID } from "node:crypto";
import Papa from "papaparse";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db";
import { deleteCsvBlob, saveCsvBlob } from "@/lib/blob-storage";
import {
  matterFields,
  validateColumnMapping,
  validateMappedRows,
  type CsvRow,
  type ValidationFinding,
} from "@/lib/matter-csv-validation";

export const runtime = "nodejs";

const maxFileBytes = 5 * 1024 * 1024;
const maxRows = 10_000;
const maxColumns = 100;

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET() {
  try {
    const { rows } = await pool.query(`
      SELECT
        i.id,
        i.file_name,
        i.status,
        i.created_at,
        COUNT(r.id)::int AS row_count,
        COUNT(r.id) FILTER (WHERE r.review_status = 'pending')::int AS pending_count,
        COUNT(r.id) FILTER (WHERE r.review_status = 'approved')::int AS approved_count,
        COUNT(r.id) FILTER (WHERE r.review_status = 'rejected')::int AS rejected_count,
        COUNT(r.id) FILTER (
          WHERE r.validation_findings @> '[{"kind":"error"}]'::jsonb
        )::int AS flagged_count
      FROM imports i
      LEFT JOIN import_rows r ON r.import_id = i.id
      GROUP BY i.id
      ORDER BY i.created_at DESC
      LIMIT 100
    `);
    return Response.json({ imports: rows });
  } catch {
    return jsonError("Imports could not be loaded. Please try again.", 503);
  }
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxFileBytes + 256 * 1024) {
    return jsonError("CSV files must be 5 MB or smaller.", 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("Send the CSV as a multipart form upload.", 400);
  }

  const file = formData.get("file");
  const mappingValue = formData.get("mapping");
  if (!(file instanceof File) || typeof mappingValue !== "string") {
    return jsonError("Both a CSV file and its column mapping are required.", 400);
  }
  if (file.name.length > 255) return jsonError("The CSV filename is too long.", 400);
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return jsonError("Choose a file with a .csv extension.", 400);
  }
  if (file.size === 0) return jsonError("The CSV file is empty.", 400);
  if (file.size > maxFileBytes) {
    return jsonError("CSV files must be 5 MB or smaller.", 413);
  }
  if (mappingValue.length > 32_000) {
    return jsonError("The column mapping is too large.", 400);
  }

  let submittedMapping: unknown;
  try {
    submittedMapping = JSON.parse(mappingValue);
  } catch {
    return jsonError("The column mapping is not valid JSON.", 400);
  }
  if (!isObject(submittedMapping)) {
    return jsonError("The column mapping must be an object.", 400);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let csvText: string;
  try {
    csvText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return jsonError("The CSV must use UTF-8 text encoding.", 400);
  }

  const parsed = Papa.parse<string[]>(csvText, {
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length > 0) {
    return jsonError("The CSV could not be parsed. Check its quoting and delimiters.", 400);
  }
  if (parsed.data.length < 2) {
    return jsonError("The CSV must contain a header and at least one data row.", 400);
  }

  const sourceHeaders = parsed.data[0].map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim(),
  );
  if (sourceHeaders.length > maxColumns) {
    return jsonError(`CSV files may have at most ${maxColumns} columns.`, 400);
  }
  if (sourceHeaders.some((header) => !header)) {
    return jsonError("Every CSV column must have a non-empty header.", 400);
  }
  const lowerHeaders = sourceHeaders.map((header) => header.toLocaleLowerCase("en-IE"));
  if (new Set(lowerHeaders).size !== sourceHeaders.length) {
    return jsonError("CSV column headers must be unique, ignoring capitalization.", 400);
  }

  const mapping: Record<string, string> = {};
  for (const [source, target] of Object.entries(submittedMapping)) {
    if (typeof target !== "string") {
      return jsonError("Each mapping target must be a matter field or empty.", 400);
    }
    mapping[source] = target;
  }
  const mappingErrors = validateColumnMapping(sourceHeaders, mapping);
  if (mappingErrors.length > 0) {
    return Response.json({ error: "Fix the column mapping.", details: mappingErrors }, { status: 400 });
  }

  const dataRows = parsed.data.slice(1);
  if (dataRows.length > maxRows) {
    return jsonError(`CSV files may have at most ${maxRows.toLocaleString()} data rows.`, 400);
  }

  const rows: CsvRow[] = dataRows.map((cells) =>
    Object.fromEntries(sourceHeaders.map((header, index) => [header, cells[index] ?? ""])),
  );
  const processedRows = validateMappedRows(rows, sourceHeaders, mapping);
  for (let index = 0; index < dataRows.length; index += 1) {
    if (dataRows[index].length !== sourceHeaders.length) {
      processedRows[index].findings.push({
        kind: "error",
        code: "column_count_mismatch",
        field: null,
        message: `Expected ${sourceHeaders.length} columns but found ${dataRows[index].length}.`,
      } satisfies ValidationFinding);
      if (dataRows[index].length > sourceHeaders.length) {
        processedRows[index].originalData.__extra_columns = dataRows[index].slice(sourceHeaders.length);
      }
    }
  }

  const references = [...new Set(
    processedRows
      .map((row) => row.normalizedData.matter_ref.toLocaleLowerCase("en-IE"))
      .filter(Boolean),
  )];
  const hash = createHash("sha256").update(bytes).digest("hex");
  const importId = randomUUID();
  const storageKey = `imports/${importId}.csv`;
  let blobStored = false;
  try {
    blobStored = await saveCsvBlob(storageKey, bytes);
  } catch {
    return jsonError("CSV storage is unavailable. Please try again.", 503);
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    if (blobStored) await deleteCsvBlob(storageKey);
    return jsonError("The database is unavailable. Please try again.", 503);
  }
  try {
    await client.query("BEGIN");

    const existingImport = await client.query<{ id: string }>(
      "SELECT id FROM imports WHERE file_sha256 = $1",
      [hash],
    );
    if (existingImport.rowCount) {
      await client.query("ROLLBACK");
      if (blobStored) await deleteCsvBlob(storageKey);
      return Response.json(
        {
          error: "This exact CSV file has already been imported.",
          importId: existingImport.rows[0].id,
        },
        { status: 409 },
      );
    }

    const existingMatters = references.length
      ? await client.query<{ matter_ref: string }>(
          "SELECT lower(matter_ref) AS matter_ref FROM matters WHERE lower(matter_ref) = ANY($1::text[])",
          [references],
        )
      : { rows: [] as { matter_ref: string }[] };
    const existingRefs = new Set(existingMatters.rows.map((row) => row.matter_ref));
    if (existingRefs.size > 0) {
      const refreshed = validateMappedRows(rows, sourceHeaders, mapping, existingRefs);
      refreshed.forEach((row, index) => {
        const widthMismatch = processedRows[index].findings.find(
          (finding) => finding.code === "column_count_mismatch",
        );
        if (widthMismatch) row.findings.push(widthMismatch);
        if (processedRows[index].originalData.__extra_columns) {
          row.originalData.__extra_columns = processedRows[index].originalData.__extra_columns;
        }
      });
      processedRows.splice(0, processedRows.length, ...refreshed);
    }

    await client.query(
      `INSERT INTO imports (id, file_name, file_sha256, storage_key, column_mapping, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'awaiting_review')`,
      [importId, file.name, hash, blobStored ? storageKey : null, JSON.stringify(mapping)],
    );
    const persistedRows = processedRows.map((row) => ({
      row_number: row.rowNumber,
      original_data: row.originalData,
      normalized_data: row.normalizedData,
      validation_findings: row.findings,
    }));

    await client.query(
      `INSERT INTO import_rows (
         import_id, row_number, original_data, normalized_data, validation_findings
       )
       SELECT $1, row_number, original_data, normalized_data, validation_findings
       FROM jsonb_to_recordset($2::jsonb) AS row_data(
         row_number integer,
         original_data jsonb,
         normalized_data jsonb,
         validation_findings jsonb
       )`,
      [importId, JSON.stringify(persistedRows)],
    );

    await client.query("COMMIT");
    return Response.json(
      {
        importId,
        fileName: file.name,
        rowCount: processedRows.length,
        flaggedRows: processedRows.filter((row) => row.findings.some((finding) => finding.kind === "error")).length,
        sourceFileStored: blobStored,
        status: "awaiting_review",
      },
      { status: 201 },
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (blobStored) await deleteCsvBlob(storageKey);
    if (
      isObject(error) &&
      error.code === "23505" &&
      error.constraint === "imports_file_sha256_unique"
    ) {
      return jsonError("This exact CSV file has already been imported.", 409);
    }
    console.error("CSV import could not be saved.");
    return jsonError("The import could not be saved. Please try again.", 500);
  } finally {
    client.release();
  }
}
