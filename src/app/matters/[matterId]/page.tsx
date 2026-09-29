import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { pool } from "@/lib/db";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function display(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default async function MatterDetailPage({
  params,
}: {
  params: Promise<{ matterId: string }>;
}) {
  const { matterId } = await params;
  if (!uuidPattern.test(matterId)) notFound();

  const result = await pool.query(
    `SELECT m.id, m.matter_ref, m.client_firm, m.debtor_first_name,
            m.debtor_last_name, m.email, m.phone, m.amount_owed::text,
            m.currency, m.address_line1, m.address_line2, m.town, m.county,
            m.eircode, to_char(m.instruction_date, 'DD/MM/YYYY') AS instruction_date,
            m.matter_type, m.notes, m.created_at AS approved_at,
            i.id AS source_import_id, i.file_name AS source_file,
            r.id AS import_row_id, r.row_number AS csv_row,
            r.original_data, r.validation_findings
     FROM matters m
     JOIN import_rows r ON r.id = m.import_row_id
     JOIN imports i ON i.id = r.import_id
     WHERE m.id = $1`,
    [matterId],
  );
  if (result.rowCount === 0) notFound();
  const matter = result.rows[0];

  const decisions = await pool.query(
    `SELECT decision, reviewer, reason, changes, decided_at
     FROM review_decisions
     WHERE import_row_id = $1
     ORDER BY decided_at, id`,
    [matter.import_row_id],
  );

  const details: Array<[string, unknown]> = [
    ["Matter reference", matter.matter_ref],
    ["Client firm", matter.client_firm],
    ["Debtor", `${matter.debtor_first_name} ${matter.debtor_last_name}`],
    ["Email", matter.email],
    ["Phone", matter.phone],
    ["Amount owed", `${matter.amount_owed} ${matter.currency}`],
    ["Address", [matter.address_line1, matter.address_line2, matter.town, matter.county, matter.eircode].filter(Boolean).join(", ")],
    ["Instruction date", matter.instruction_date],
    ["Matter type", matter.matter_type],
    ["Notes", matter.notes],
  ];

  return (
    <>
      <PageHeader title={matter.matter_ref} description="Approved matter details" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 md:p-10">
        <div>
          <Link href="/matters" className="text-sm underline underline-offset-2">← Back to matters</Link>
        </div>

        <section className="rounded-lg border p-5">
          <h2 className="text-lg font-semibold">Matter information</h2>
          <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {details.map(([label, value]) => (
              <div key={label} className="space-y-1">
                <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
                <dd className="break-words text-sm">{display(value)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-lg border p-5">
          <h2 className="text-lg font-semibold">Import and approval</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Source CSV</dt>
              <dd className="text-sm">{matter.source_file}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">CSV row</dt>
              <dd className="text-sm">{matter.csv_row}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Approved at</dt>
              <dd className="text-sm">{new Date(matter.approved_at).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Import</dt>
              <dd className="text-sm">
                <Link href="/review" className="underline underline-offset-2">Review import {matter.source_import_id}</Link>
              </dd>
            </div>
          </dl>
        </section>

        {decisions.rows.length > 0 && (
          <section className="rounded-lg border p-5">
            <h2 className="text-lg font-semibold">Review audit</h2>
            <ol className="mt-3 space-y-3">
              {decisions.rows.map((decision, index) => (
                <li key={`${decision.decided_at}-${index}`} className="border-l-2 pl-3 text-sm">
                  <p className="font-medium capitalize">{decision.decision} by {decision.reviewer}</p>
                  <p className="text-muted-foreground">{new Date(decision.decided_at).toLocaleString()}</p>
                  {decision.reason && <p className="mt-1">{decision.reason}</p>}
                  {Array.isArray(decision.changes) && decision.changes.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {decision.changes.map((change: { field: string; before: string; after: string }) => (
                        <li key={change.field}>{change.field}: “{change.before}” → “{change.after}”</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        <details className="rounded-lg border p-5">
          <summary className="cursor-pointer font-semibold">Original imported row</summary>
          <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(matter.original_data, null, 2)}</pre>
        </details>
      </main>
    </>
  );
}
