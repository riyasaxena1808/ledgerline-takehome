"use client";

import { useEffect, useMemo, useState } from "react";

import {
  matterFields,
  type MatterField,
  type ValidationFinding,
} from "@/lib/matter-csv-validation";

type ImportSummary = {
  id: string;
  file_name: string;
  status: string;
  created_at: string;
  row_count: number;
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  flagged_count: number;
};

type ReviewDecision = {
  id: string;
  decision: "approved" | "rejected";
  reviewer: string;
  reason: string | null;
  changes: Array<{ field: MatterField; before: string; after: string }>;
  decidedAt: string;
};

type ReviewRow = {
  id: string;
  row_number: number;
  original_data: Record<string, unknown>;
  normalized_data: Record<string, string> | null;
  validation_findings: ValidationFinding[];
  review_status: "pending" | "approved" | "rejected";
  reviewer_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decisions: ReviewDecision[];
};

type ImportDetail = {
  import: { id: string; file_name: string; status: string; created_at: string };
  rowCount: number;
  offset: number;
  pageSize: number;
  rows: ReviewRow[];
};

const labels: Record<MatterField, string> = {
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

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

export function ReviewQueue() {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selectedImportId, setSelectedImportId] = useState("");
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [reviewer, setReviewer] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [corrections, setCorrections] = useState<Record<string, Record<string, string>>>({});
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState("");
  const [loadingImports, setLoadingImports] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadingImports(true);
    fetch("/api/imports")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Imports could not be loaded.");
        if (cancelled) return;
        const items = body.imports as ImportSummary[];
        setImports(items);
        setSelectedImportId((current) => current || items[0]?.id || "");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Imports could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoadingImports(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedImportId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingRows(true);
    setError("");
    fetch(`/api/imports/${selectedImportId}?offset=${offset}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Review rows could not be loaded.");
        if (!cancelled) setDetail(body as ImportDetail);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Review rows could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });
    return () => { cancelled = true; };
  }, [selectedImportId, offset, refreshKey]);

  const selectedSummary = useMemo(
    () => imports.find((item) => item.id === selectedImportId),
    [imports, selectedImportId],
  );

  function editCorrection(row: ReviewRow, field: MatterField, value: string) {
    setCorrections((current) => ({
      ...current,
      [row.id]: {
        ...(current[row.id] ?? row.normalized_data ?? {}),
        [field]: value,
      },
    }));
    setRowErrors((current) => ({ ...current, [row.id]: "" }));
  }

  async function submitDecision(row: ReviewRow, decision: "approved" | "rejected") {
    setBusyRow(row.id);
    setRowErrors((current) => ({ ...current, [row.id]: "" }));
    try {
      const response = await fetch(
        `/api/imports/${selectedImportId}/rows/${row.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            reviewer,
            reason: reasons[row.id] ?? "",
            corrections: corrections[row.id] ?? {},
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        const detailText = Array.isArray(body.details)
          ? body.details.map((finding: ValidationFinding) => finding.message).join(" ")
          : "";
        throw new Error([body.error, detailText].filter(Boolean).join(" "));
      }
      setRefreshKey((current) => current + 1);
    } catch (cause) {
      setRowErrors((current) => ({
        ...current,
        [row.id]: cause instanceof Error ? cause.message : "The review decision could not be saved.",
      }));
    } finally {
      setBusyRow("");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-6 md:p-10">
      {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

      <section className="grid gap-4 rounded-lg border p-4 md:grid-cols-2 md:items-end">
        <div className="space-y-2">
          <label htmlFor="review-import" className="text-sm font-medium">Import file</label>
          {loadingImports ? (
            <p className="text-sm text-muted-foreground">Loading imports…</p>
          ) : imports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No imports yet. Upload a CSV first.</p>
          ) : (
            <select
              id="review-import"
              value={selectedImportId}
              onChange={(event) => { setSelectedImportId(event.target.value); setOffset(0); }}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {imports.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.file_name} · {item.pending_count} pending · {new Date(item.created_at).toLocaleDateString()}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="reviewer-name" className="text-sm font-medium">Reviewer name</label>
          <input
            id="reviewer-name"
            value={reviewer}
            onChange={(event) => setReviewer(event.target.value)}
            maxLength={100}
            autoComplete="name"
            placeholder="Enter your name before reviewing"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            This local prototype records the name you enter; production sign-in is a separate security stage.
          </p>
        </div>
      </section>

      {selectedSummary && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-muted/50 p-4">
          <div>
            <h2 className="font-semibold">{selectedSummary.file_name}</h2>
            <p className="text-sm text-muted-foreground">
              {selectedSummary.row_count} rows · {selectedSummary.pending_count} pending · {selectedSummary.approved_count} approved · {selectedSummary.rejected_count} rejected · {selectedSummary.flagged_count} flagged
            </p>
          </div>
          {selectedSummary.rejected_count > 0 && (
            <a
              href={`/api/imports/${selectedSummary.id}/rejected`}
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-background"
            >
              Download rejected CSV
            </a>
          )}
        </section>
      )}

      {loadingRows && <p role="status" className="text-sm text-muted-foreground">Loading rows…</p>}
      {!loadingImports && imports.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Upload a CSV on the Import page. Every row will appear here and require a decision.
        </div>
      )}

      {detail && detail.rows.length > 0 && (
        <section className="space-y-4">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-3">CSV row</th>
                  <th className="px-3 py-3">Matter reference</th>
                  <th className="px-3 py-3">Debtor</th>
                  <th className="px-3 py-3">Amount</th>
                  <th className="px-3 py-3">Review</th>
                  <th className="px-3 py-3">Decision</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row) => {
                  const findings = row.validation_findings ?? [];
                  const errors = findings.filter((finding) => finding.kind === "error");
                  const tidies = findings.filter((finding) => finding.kind === "tidy");
                  const data = corrections[row.id] ?? row.normalized_data ?? {};
                  const isExpanded = expandedRows[row.id] ?? false;
                  const isPending = row.review_status === "pending";
                  return (
                    <tr key={row.id} className="border-t align-top">
                      <td colSpan={6} className="p-0">
                        <div className="grid grid-cols-[5rem_minmax(10rem,1fr)_minmax(10rem,1fr)_8rem_8rem_minmax(10rem,auto)] items-start gap-2 px-3 py-3">
                          <span>{row.row_number}</span>
                          <span className="break-all">{row.normalized_data?.matter_ref || "—"}</span>
                          <span>{[row.normalized_data?.debtor_first_name, row.normalized_data?.debtor_last_name].filter(Boolean).join(" ") || "—"}</span>
                          <span>{row.normalized_data?.amount_owed ? `${row.normalized_data.amount_owed} ${row.normalized_data.currency ?? ""}` : "—"}</span>
                          <span className={errors.length ? "text-destructive" : "text-muted-foreground"}>
                            {errors.length ? `${errors.length} issue${errors.length === 1 ? "" : "s"}` : "No errors"}
                            {tidies.length > 0 && <span className="block text-xs text-muted-foreground">{tidies.length} auto-fix{tidies.length === 1 ? "" : "es"}</span>}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="capitalize">{row.review_status}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedRows((current) => ({ ...current, [row.id]: !isExpanded }));
                                if (!corrections[row.id] && row.normalized_data) {
                                  setCorrections((current) => ({ ...current, [row.id]: { ...row.normalized_data } }));
                                }
                              }}
                              className="underline underline-offset-2"
                            >
                              {isExpanded ? "Hide details" : "Review details"}
                            </button>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="space-y-5 border-t bg-muted/20 p-4">
                            {tidies.length > 0 && (
                              <section>
                                <h3 className="font-semibold">Automatically tidied</h3>
                                <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                                  {tidies.map((finding, index) => (
                                    <li key={`${finding.code}-${index}`}>
                                      {finding.message} {finding.originalValue !== undefined && (
                                        <span>“{finding.originalValue}” → “{finding.normalizedValue}”</span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            )}
                            {errors.length > 0 && (
                              <section>
                                <h3 className="font-semibold text-destructive">Needs attention</h3>
                                <ul className="mt-1 list-disc pl-5 text-sm text-destructive">
                                  {errors.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.message}</li>)}
                                </ul>
                              </section>
                            )}

                            {isPending && (
                              <section className="space-y-3">
                                <h3 className="font-semibold">Check or correct the matter data</h3>
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                  {matterFields.map((field) => (
                                    <label key={field} className="space-y-1 text-sm">
                                      <span className="font-medium">{labels[field]}</span>
                                      {field === "notes" ? (
                                        <textarea
                                          value={data[field] ?? ""}
                                          onChange={(event) => editCorrection(row, field, event.target.value)}
                                          disabled={busyRow === row.id}
                                          rows={2}
                                          className="w-full rounded-md border bg-background px-3 py-2"
                                        />
                                      ) : (
                                        <input
                                          value={data[field] ?? ""}
                                          onChange={(event) => editCorrection(row, field, event.target.value)}
                                          disabled={busyRow === row.id}
                                          inputMode={field === "amount_owed" ? "decimal" : "text"}
                                          className="w-full rounded-md border bg-background px-3 py-2"
                                        />
                                      )}
                                    </label>
                                  ))}
                                </div>
                                <details>
                                  <summary className="cursor-pointer text-sm font-medium">Original CSV values</summary>
                                  <pre className="mt-2 max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs">{JSON.stringify(row.original_data, null, 2)}</pre>
                                </details>
                              </section>
                            )}

                            {isPending && (
                              <section className="space-y-3 border-t pt-4">
                                <label htmlFor={`reason-${row.id}`} className="block text-sm font-medium">
                                  Rejection reason (required to reject)
                                </label>
                                <textarea
                                  id={`reason-${row.id}`}
                                  value={reasons[row.id] ?? ""}
                                  onChange={(event) => setReasons((current) => ({ ...current, [row.id]: event.target.value }))}
                                  maxLength={1000}
                                  rows={2}
                                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                />
                                {rowErrors[row.id] && <p role="alert" className="text-sm text-destructive">{rowErrors[row.id]}</p>}
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => submitDecision(row, "approved")}
                                    disabled={!reviewer.trim() || busyRow === row.id}
                                    className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                                  >
                                    {busyRow === row.id ? "Saving…" : "Approve"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => submitDecision(row, "rejected")}
                                    disabled={!reviewer.trim() || !reasons[row.id]?.trim() || busyRow === row.id}
                                    className="rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive disabled:opacity-50"
                                  >
                                    Reject
                                  </button>
                                </div>
                              </section>
                            )}

                            {!isPending && (
                              <p className="text-sm text-muted-foreground">
                                Reviewed by {row.reviewed_by ?? "unknown"}{row.reviewed_at ? ` on ${formatDate(row.reviewed_at)}` : ""}.
                                {row.reviewer_notes ? ` Note: ${row.reviewer_notes}` : ""}
                              </p>
                            )}
                            {row.decisions.length > 0 && (
                              <section>
                                <h3 className="font-semibold">Decision audit</h3>
                                <ul className="mt-1 space-y-2 text-sm text-muted-foreground">
                                  {row.decisions.map((entry) => (
                                    <li key={entry.id}>
                                      {entry.decision} by {entry.reviewer} on {formatDate(entry.decidedAt)}
                                      {entry.reason ? ` — ${entry.reason}` : ""}
                                      {entry.changes.length > 0 && (
                                        <ul className="list-disc pl-5">
                                          {entry.changes.map((change) => (
                                            <li key={change.field}>{labels[change.field]}: “{change.before}” → “{change.after}”</li>
                                          ))}
                                        </ul>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span>
              Rows {detail.rowCount === 0 ? 0 : offset + 1}–{Math.min(offset + detail.pageSize, detail.rowCount)} of {detail.rowCount}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOffset((value) => Math.max(0, value - detail.pageSize))}
                disabled={offset === 0 || loadingRows}
                className="rounded-md border px-3 py-2 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setOffset((value) => value + detail.pageSize)}
                disabled={offset + detail.pageSize >= detail.rowCount || loadingRows}
                className="rounded-md border px-3 py-2 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
