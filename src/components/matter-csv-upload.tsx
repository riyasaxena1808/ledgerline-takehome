"use client";

import { useState, type ChangeEvent } from "react";
import Link from "next/link";
import Papa from "papaparse";

import {
  matterFields,
  validateColumnMapping,
  validateMappedRows,
  type CsvRow,
} from "@/lib/matter-csv-validation";

const fieldLabels: Record<(typeof matterFields)[number], string> = {
  matter_ref: "Matter reference",
  client_firm: "Client firm",
  debtor_first_name: "Debtor first name",
  debtor_last_name: "Debtor last name",
  email: "Email address",
  phone: "Phone number",
  amount_owed: "Amount owed",
  currency: "Currency",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  town: "Town",
  county: "County",
  eircode: "Eircode",
  instruction_date: "Instruction date",
  matter_type: "Matter type",
  notes: "Notes",
};

type ValidationMessage = { rowNumber: number; errors: string[] };
type ImportResult = {
  importId: string;
  fileName: string;
  rowCount: number;
  flaggedRows: number;
  status: string;
  sourceFileStored: boolean;
};

function normalizeForValidation(
  rows: CsvRow[],
  headers: string[],
  mapping: Record<string, string>,
) {
  const cleanHeaders = headers.map((header) => header.trim());
  const cleanMapping = Object.fromEntries(
    headers.map((header, index) => [cleanHeaders[index], mapping[header] ?? ""]),
  );
  const cleanRows = rows.map((row) =>
    Object.fromEntries(
      headers.map((header, index) => [cleanHeaders[index], row[header] ?? ""]),
    ),
  );
  return { cleanHeaders, cleanMapping, cleanRows };
}

export function MatterCsvUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [validationResults, setValidationResults] = useState<ValidationMessage[]>([]);
  const [hasValidated, setHasValidated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    event.target.value = "";
    setFile(null);
    setFileName("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setError("");
    setValidationResults([]);
    setHasValidated(false);
    setImportResult(null);

    if (!selectedFile) return;
    if (!selectedFile.name.toLowerCase().endsWith(".csv")) {
      setError("Please select a CSV file.");
      return;
    }
    if (selectedFile.size > 5 * 1024 * 1024) {
      setError("CSV files must be 5 MB or smaller.");
      return;
    }

    Papa.parse<CsvRow>(selectedFile, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (result) => {
        const fields = result.meta.fields ?? [];
        if (result.errors.some((parseError) =>
          parseError.code !== "TooFewFields" && parseError.code !== "TooManyFields",
        )) {
          setError("The CSV could not be parsed. Check its quoting and delimiters.");
          return;
        }
        if (fields.length === 0 || fields.some((field) => !field.trim())) {
          setError("The CSV must have non-empty column headers.");
          return;
        }
        if (result.data.length === 0) {
          setError("The CSV file contains no data rows.");
          return;
        }
        if (fields.length > 100) {
          setError("CSV files may have at most 100 columns.");
          return;
        }

        const cleanFields = fields.map((field) => field.trim().toLocaleLowerCase("en-IE"));
        if (new Set(cleanFields).size !== fields.length) {
          setError("CSV column headers must be unique, ignoring capitalization.");
          return;
        }

        const initialMapping = Object.fromEntries(
          fields.map((field) => {
            const cleanField = field.trim();
            return [
              field,
              matterFields.includes(cleanField as (typeof matterFields)[number])
                ? cleanField
                : "",
            ];
          }),
        );
        setFile(selectedFile);
        setFileName(selectedFile.name);
        setHeaders(fields);
        setRows(result.data);
        setMapping(initialMapping);
      },
      error: () => setError("Unable to read this CSV file."),
    });
  }

  function handleMappingChange(header: string, target: string) {
    setMapping((current) => ({ ...current, [header]: target }));
    setValidationResults([]);
    setHasValidated(false);
    setImportResult(null);
    setError("");
  }

  function validateInBrowser() {
    setError("");
    setImportResult(null);
    const { cleanHeaders, cleanMapping, cleanRows } = normalizeForValidation(
      rows,
      headers,
      mapping,
    );
    const mappingErrors = validateColumnMapping(cleanHeaders, cleanMapping);
    if (mappingErrors.length > 0) {
      setValidationResults([{ rowNumber: 0, errors: mappingErrors }]);
    } else {
      const results = validateMappedRows(cleanRows, cleanHeaders, cleanMapping)
        .map((row) => ({
          rowNumber: row.rowNumber,
          errors: row.findings
            .filter((finding) => finding.kind === "error")
            .map((finding) => finding.message),
        }))
        .filter((row) => row.errors.length > 0);
      setValidationResults(results);
    }
    setHasValidated(true);
  }

  async function saveImport() {
    if (!file) return;
    setIsSubmitting(true);
    setError("");
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("mapping", JSON.stringify(mapping));
      const response = await fetch("/api/imports", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      if (!response.ok) {
        const duplicateId = typeof result.importId === "string"
          ? ` Existing import: ${result.importId}.`
          : "";
        const details = Array.isArray(result.details)
          ? ` ${result.details.join(" ")}`
          : "";
        throw new Error(`${result.error ?? "The import could not be saved."}${duplicateId}${details}`);
      }
      setImportResult(result as ImportResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The import could not be saved.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const cleanHeaders = headers.map((header) => header.trim());
  const cleanMapping = Object.fromEntries(
    headers.map((header, index) => [cleanHeaders[index], mapping[header] ?? ""]),
  );
  const mappingIsValid = validateColumnMapping(cleanHeaders, cleanMapping).length === 0;

  return (
    <section className="w-full max-w-5xl space-y-6">
      <div className="rounded-lg border border-dashed p-8 text-center">
        <h2 className="text-lg font-semibold">Upload matters CSV</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a CSV file up to 5 MB. Each row will be saved for human review.
        </p>
        <label htmlFor="matter-csv-file" className="sr-only">CSV file</label>
        <input
          id="matter-csv-file"
          type="file"
          accept=".csv,text/csv"
          disabled={isSubmitting}
          onChange={handleFileChange}
          className="mx-auto mt-5 block max-w-full text-sm"
        />
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {importResult && (
        <div role="status" className="space-y-1 rounded-lg border border-green-700/30 bg-green-700/5 p-4">
          <h3 className="font-semibold">Import saved for review</h3>
          <p className="text-sm">
            {importResult.rowCount} rows saved; {importResult.flaggedRows} need attention.
          </p>
          <p className="text-sm text-muted-foreground">
            Import ID: <code>{importResult.importId}</code>.{" "}
            {importResult.sourceFileStored
              ? "The original CSV is retained in configured object storage."
              : "Object storage is not configured, so only the imported row data is retained."}
          </p>
          <Link href="/review" className="inline-block text-sm font-medium underline underline-offset-2">
            Open the review queue
          </Link>
        </div>
      )}

      {fileName && (
        <div className="space-y-6">
          <div>
            <h3 className="font-semibold">{fileName}</h3>
            <p className="text-sm text-muted-foreground">
              {rows.length} data rows and {headers.length} columns
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-lg font-semibold">Map CSV columns</h3>
            <p className="text-sm text-muted-foreground">
              Match source columns to matter fields. Unmapped columns are kept in the row data for review.
            </p>
            <div className="space-y-3">
              {headers.map((header) => (
                <div key={header} className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:items-center">
                  <label htmlFor={`mapping-${header}`} className="text-sm font-medium">{header}</label>
                  <select
                    id={`mapping-${header}`}
                    value={mapping[header] ?? ""}
                    disabled={isSubmitting}
                    onChange={(event) => handleMappingChange(header, event.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Do not map</option>
                    {matterFields.map((field) => (
                      <option key={field} value={field}>{fieldLabels[field]}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={validateInBrowser}
                className="rounded-md border px-4 py-2 text-sm font-medium"
              >
                Validate CSV
              </button>
              {hasValidated && mappingIsValid && (
                <button
                  type="button"
                  onClick={saveImport}
                  disabled={isSubmitting || !!importResult}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {isSubmitting ? "Saving import…" : "Save all rows for review"}
                </button>
              )}
            </div>

            {hasValidated && validationResults.length > 0 && (
              <div className="space-y-2 rounded-md border p-3" role="status">
                <h3 className="font-semibold">
                  {validationResults.length} row{validationResults.length === 1 ? "" : "s"} with findings
                </h3>
                <p className="text-sm text-muted-foreground">
                  Rows with findings are still saved so a reviewer can decide what to do.
                </p>
                {validationResults.slice(0, 100).map((result) => (
                  <div key={result.rowNumber} className="text-sm">
                    <p className="font-medium">
                      {result.rowNumber === 0 ? "Column mapping" : `CSV row ${result.rowNumber}`}
                    </p>
                    <ul className="list-disc pl-5 text-red-600">
                      {result.errors.map((message, index) => <li key={index}>{message}</li>)}
                    </ul>
                  </div>
                ))}
                {validationResults.length > 100 && (
                  <p className="text-sm text-muted-foreground">
                    Showing the first 100 flagged rows. All rows remain included in the import.
                  </p>
                )}
              </div>
            )}
            {hasValidated && validationResults.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                No validation errors found. Every row still requires human approval.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <h3 className="text-lg font-semibold">CSV preview</h3>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted">
                  <tr>
                    {headers.map((header) => (
                      <th key={header} className="whitespace-nowrap px-4 py-3 font-medium">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, index) => (
                    <tr key={index} className="border-t">
                      {headers.map((header) => (
                        <td key={header} className="whitespace-nowrap px-4 py-3">
                          {row[header] || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 5 && (
              <p className="text-sm text-muted-foreground">Showing the first 5 of {rows.length} rows.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
