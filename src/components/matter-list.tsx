"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type MatterSummary = {
  id: string;
  matter_ref: string;
  client_firm: string;
  debtor_first_name: string;
  debtor_last_name: string;
  amount_owed: string;
  currency: string;
  instruction_date: string;
  import_id: string;
  source_file: string;
};

type MatterResponse = {
  matters: MatterSummary[];
  total: number;
  offset: number;
  limit: number;
};

export function MatterList() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<MatterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setSearch(searchInput.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ offset: String(offset) });
    if (search) query.set("search", search);

    fetch(`/api/matters?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Matters could not be loaded.");
        setResult(body as MatterResponse);
      })
      .catch((cause) => {
        if (cause instanceof Error && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Matters could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [offset, search]);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-6 md:p-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="w-full max-w-md space-y-1 text-sm font-medium">
          Search matters
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            maxLength={100}
            placeholder="Reference, debtor or client firm"
            className="w-full rounded-md border bg-background px-3 py-2 font-normal"
          />
        </label>
        <p className="text-sm text-muted-foreground">
          {loading ? "Loading…" : `${result?.total ?? 0} approved matters`}
        </p>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

      {!loading && result?.total === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <h2 className="font-semibold">No approved matters found</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Approve rows in the review queue before they appear here.
          </p>
          <Link href="/review" className="mt-3 inline-block text-sm font-medium underline underline-offset-2">
            Open review queue
          </Link>
        </div>
      )}

      {result && result.matters.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-3">Matter</th>
                <th className="px-3 py-3">Debtor</th>
                <th className="px-3 py-3">Client firm</th>
                <th className="px-3 py-3">Amount</th>
                <th className="px-3 py-3">Instruction date</th>
                <th className="px-3 py-3">Source import</th>
              </tr>
            </thead>
            <tbody>
              {result.matters.map((matter) => (
                <tr key={matter.id} className="border-t">
                  <td className="px-3 py-3 font-medium">
                    <Link href={`/matters/${matter.id}`} className="underline underline-offset-2">
                      {matter.matter_ref}
                    </Link>
                  </td>
                  <td className="px-3 py-3">{matter.debtor_first_name} {matter.debtor_last_name}</td>
                  <td className="px-3 py-3">{matter.client_firm}</td>
                  <td className="px-3 py-3">{matter.amount_owed} {matter.currency}</td>
                  <td className="px-3 py-3">{matter.instruction_date}</td>
                  <td className="px-3 py-3">{matter.source_file}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && result.total > result.limit && (
        <div className="flex items-center justify-between text-sm">
          <span>Rows {offset + 1}–{Math.min(offset + result.limit, result.total)} of {result.total}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOffset((value) => Math.max(0, value - result.limit))}
              disabled={offset === 0 || loading}
              className="rounded-md border px-3 py-2 disabled:opacity-50"
            >Previous</button>
            <button
              type="button"
              onClick={() => setOffset((value) => value + result.limit)}
              disabled={offset + result.limit >= result.total || loading}
              className="rounded-md border px-3 py-2 disabled:opacity-50"
            >Next</button>
          </div>
        </div>
      )}
    </main>
  );
}
