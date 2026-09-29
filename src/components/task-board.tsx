"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Task = { id: string; title: string; status: string; created_at: string; completed_at: string | null; completed_by: string | null; matter_id: string; matter_ref: string; debtor_first_name: string; debtor_last_name: string; batch_id: string | null; workflow_name: string };

export function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [staff, setStaff] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const refresh = useCallback(async () => {
    const response = await fetch("/api/tasks"); const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Tasks could not be loaded."); setTasks(body.tasks as Task[]);
  }, []);
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);
  async function complete(id: string) {
    setError(""); setBusy(id);
    try {
      const response = await fetch(`/api/tasks/${id}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ completedBy: staff }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Task could not be completed."); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Task could not be completed."); }
    finally { setBusy(""); }
  }
  const open = tasks.filter((task) => ["pending", "in_progress"].includes(task.status));
  return <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 p-6 md:p-10">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-lg font-semibold">Open tasks</h2><p className="text-sm text-muted-foreground">Completing a task resumes its matter’s workflow.</p></div><label className="space-y-1 text-sm font-medium">Staff name<input className="block rounded-md border bg-background px-3 py-2 font-normal" value={staff} onChange={(e) => setStaff(e.target.value)} maxLength={120} placeholder="Your name" /></label></div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
    {open.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center"><p className="font-medium">No open tasks</p><p className="mt-1 text-sm text-muted-foreground">Tasks will appear when a running workflow reaches a Staff task step.</p></div> : <div className="space-y-3">{open.map((task) => <article key={task.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4"><div><p className="font-medium">{task.title}</p><p className="text-sm text-muted-foreground"><Link className="underline" href={`/matters/${task.matter_id}`}>{task.matter_ref}</Link> · {task.debtor_first_name} {task.debtor_last_name} · {task.workflow_name}</p><p className="text-xs text-muted-foreground">Created {new Date(task.created_at).toLocaleString()}</p></div><button onClick={() => complete(task.id)} disabled={!staff.trim() || !!busy} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === task.id ? "Saving…" : "Mark complete"}</button></article>)}</div>}
    {tasks.some((task) => task.status === "completed") && <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">Completed tasks ({tasks.filter((task) => task.status === "completed").length})</summary><ul className="mt-3 space-y-2 text-sm">{tasks.filter((task) => task.status === "completed").map((task) => <li key={task.id}>{task.title} · {task.matter_ref} · completed by {task.completed_by}</li>)}</ul></details>}
  </main>;
}
