"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Workflow = { id: string; name: string; version: number; status: string };
type Matter = { id: string; matter_ref: string; debtor_first_name: string; debtor_last_name: string };
type Batch = { id: string; workflow_name: string; workflow_version: number; status: string; created_at: string; matter_count: number; completed_count: number; failed_count: number; active_count: number };
type BatchDetail = { batch: Batch; matters: Array<{ run_id: string; matter_id: string; matter_ref: string; debtor_first_name: string; debtor_last_name: string; status: string; current_step: string | null; scheduled_for: string | null; error_message: string | null; letters: Array<{ nodeId: string; status: string; providerId: string | null }>; tasks: Array<{ id: string; title: string; status: string }> }> };

export function RunConsole() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [matters, setMatters] = useState<Matter[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [matterIds, setMatterIds] = useState<string[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [workflowResponse, matterResponse, batchResponse] = await Promise.all([
      fetch("/api/workflows"), fetch("/api/matters?offset=0"), fetch("/api/runs"),
    ]);
    const [workflowData, matterData, batchData] = await Promise.all([workflowResponse.json(), matterResponse.json(), batchResponse.json()]);
    if (!workflowResponse.ok || !matterResponse.ok || !batchResponse.ok) throw new Error("Run data could not be loaded.");
    setWorkflows((workflowData.workflows as Workflow[]).filter((workflow) => workflow.status === "published"));
    setMatters(matterData.matters as Matter[]);
    setBatches(batchData.batches as Batch[]);
  }, []);

  useEffect(() => { refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Run data could not be loaded.")); }, [refresh]);
  useEffect(() => {
    if (!detail || !["pending", "running"].includes(detail.batch.status)) return;
    const timer = setInterval(() => {
      fetch(`/api/runs/${detail.batch.id}`).then((response) => response.json()).then((data) => { if (data.batch) setDetail(data as BatchDetail); refresh().catch(() => undefined); }).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [detail, refresh]);

  async function loadBatch(id: string) {
    const response = await fetch(`/api/runs/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Run details could not be loaded.");
    setDetail(data as BatchDetail);
  }

  async function startRun(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowId, matterIds }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Run could not be started.");
      setMatterIds([]); await refresh(); await loadBatch(data.batchId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Run could not be started."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-6 md:p-10">
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-lg font-semibold">Start a workflow run</h2>
      <p className="mb-4 text-sm text-muted-foreground">Each selected approved matter progresses independently. The worker must be running to advance steps.</p>
      <form onSubmit={startRun} className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm font-medium">Published workflow<select className="block w-full rounded-md border bg-background px-3 py-2" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} required><option value="">Choose workflow</option>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name} · v{w.version}</option>)}</select></label>
        <label className="space-y-1 text-sm font-medium">Approved matters (up to 50 shown)<select multiple className="block h-32 w-full rounded-md border bg-background px-3 py-2 font-normal" value={matterIds} onChange={(e) => setMatterIds(Array.from(e.target.selectedOptions, (o) => o.value))}>{matters.map((m) => <option key={m.id} value={m.id}>{m.matter_ref} — {m.debtor_first_name} {m.debtor_last_name}</option>)}</select></label>
        <button className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={busy || !workflowId || matterIds.length === 0 || matterIds.length > 1000}>{busy ? "Starting…" : `Start for ${matterIds.length} matter${matterIds.length === 1 ? "" : "s"}`}</button>
      </form>
    </section>
    {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
    <section className="grid gap-6 lg:grid-cols-[minmax(260px,1fr)_2fr]">
      <div className="rounded-xl border bg-card p-5"><h2 className="mb-3 font-semibold">Recent runs</h2>{batches.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet. Publish a workflow and approve matters first.</p> : <ul className="space-y-2">{batches.map((batch) => <li key={batch.id}><button onClick={() => loadBatch(batch.id).catch((e) => setError(e.message))} className={`w-full rounded-lg border p-3 text-left ${detail?.batch.id === batch.id ? "border-primary" : ""}`}><span className="block font-medium">{batch.workflow_name} · v{batch.workflow_version}</span><span className="text-xs text-muted-foreground">{batch.status} · {batch.completed_count}/{batch.matter_count} complete · {batch.failed_count} failed</span></button></li>)}</ul>}</div>
      <div className="rounded-xl border bg-card p-5"><h2 className="mb-3 font-semibold">Matter progress</h2>{!detail ? <p className="text-sm text-muted-foreground">Select a run to inspect each matter.</p> : <div className="space-y-3">{detail.matters.map((m) => <article key={m.run_id} className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><Link href={`/matters/${m.matter_id}`} className="font-medium underline">{m.matter_ref}</Link><span className="text-sm">{m.status} · {m.current_step ?? "—"}</span></div><p className="text-sm text-muted-foreground">{m.debtor_first_name} {m.debtor_last_name}{m.scheduled_for ? ` · resumes ${new Date(m.scheduled_for).toLocaleString()}` : ""}</p>{m.error_message && <p role="alert" className="mt-2 text-sm text-destructive">{m.error_message}</p>}{m.letters.map((letter) => <p key={letter.nodeId} className="mt-2 text-sm">Letter: {letter.status}{letter.providerId ? ` · provider ${letter.providerId}` : ""}</p>)}{m.tasks.map((task) => <p key={task.id} className="mt-1 text-sm">Task: {task.title} · {task.status}</p>)}</article>)}</div>}</div>
    </section>
  </main>;
}
