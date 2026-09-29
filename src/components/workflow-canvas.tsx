"use client";

import {
  addEdge,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { matterFields } from "@/lib/matter-csv-validation";
import { renderLetterText } from "@/lib/letter-rendering";
import { validateWorkflow, type WorkflowDefinition } from "@/lib/workflow-validation";
import type { LetterTemplate } from "@/lib/templates";

type StepType = "start" | "end" | "sendLetter" | "wait" | "staffTask";
type StepData = {
  label: string;
  templateId?: string;
  subject?: string;
  body?: string;
  minutes?: number;
  title?: string;
};
type CanvasNode = Node<StepData, StepType>;
type Matter = Record<string, string | null> & { id: string; matter_ref: string };
type SavedWorkflow = { id: string; name: string; version: number; status: string };

const fieldLabels: Record<string, string> = {
  matter_ref: "Matter reference",
  client_firm: "Client firm",
  debtor_first_name: "Debtor first name",
  debtor_last_name: "Debtor last name",
  amount_owed: "Amount owed",
  today_date: "Today’s date",
};

function createInitialNodes(): CanvasNode[] {
  return [
    { id: "start", type: "start", position: { x: 80, y: 220 }, data: { label: "Start" }, deletable: false },
    { id: "end", type: "end", position: { x: 680, y: 220 }, data: { label: "End" }, deletable: false },
  ];
}

function StartNode({ data }: NodeProps<CanvasNode>) {
  return (
    <div className="rounded-full border-2 border-emerald-600 bg-emerald-50 px-7 py-3 text-sm font-semibold text-emerald-950 shadow-sm dark:bg-emerald-950 dark:text-emerald-100">
      <span>{data.label || "Start"}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function EndNode({ data }: NodeProps<CanvasNode>) {
  return (
    <div className="rounded-full border-2 border-slate-500 bg-slate-100 px-7 py-3 text-sm font-semibold text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100">
      <Handle type="target" position={Position.Left} />
      <span>{data.label || "End"}</span>
    </div>
  );
}

function StepNode({ data }: NodeProps<CanvasNode>) {
  return (
    <div className="min-w-40 rounded-xl border bg-card px-4 py-3 shadow-sm">
      <Handle type="target" position={Position.Left} />
      <div className="text-sm font-semibold">{data.label}</div>
      {data.templateId && <div className="mt-1 max-w-48 truncate text-xs text-muted-foreground">{data.templateId}</div>}
      {data.minutes !== undefined && <div className="mt-1 text-xs text-muted-foreground">{data.minutes} minute{data.minutes === 1 ? "" : "s"}</div>}
      {data.title && <div className="mt-1 max-w-48 truncate text-xs text-muted-foreground">{data.title}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = {
  start: StartNode,
  end: EndNode,
  sendLetter: StepNode,
  wait: StepNode,
  staffTask: StepNode,
};

function makeDefinition(nodes: CanvasNode[], edges: Edge[]): WorkflowDefinition {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? "",
      position: node.position,
      data: { ...node.data },
    })),
    edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

function WorkflowEditor() {
  const [nodes, setNodes, baseNodesChange] = useNodesState<CanvasNode>(createInitialNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [workflowName, setWorkflowName] = useState("New workflow");
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [templates, setTemplates] = useState<LetterTemplate[]>([]);
  const [matters, setMatters] = useState<Array<{ id: string; matter_ref: string }>>([]);
  const [previewMatterId, setPreviewMatterId] = useState("");
  const [previewMatter, setPreviewMatter] = useState<Matter | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const flowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const definition = useMemo(() => makeDefinition(nodes, edges), [nodes, edges]);
  const validationErrors = useMemo(() => validateWorkflow(definition), [definition]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/workflows").then((response) => response.json()),
      fetch("/api/templates").then((response) => response.json()),
      fetch("/api/matters").then((response) => response.json()),
    ])
      .then(([workflowResult, templateResult, matterResult]) => {
        if (cancelled) return;
        setWorkflows(workflowResult.workflows ?? []);
        setTemplates(templateResult.templates ?? []);
        setMatters(matterResult.matters ?? []);
      })
      .catch(() => {
        if (!cancelled) setMessage("Saved workflows or preview data could not be loaded.");
      });
    return () => { cancelled = true; };
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const safeChanges = changes.filter((change) =>
      change.type !== "remove" || !["start", "end"].includes(change.id),
    );
    baseNodesChange(safeChanges);
  }, [baseNodesChange]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: crypto.randomUUID() }, current));
  }, [setEdges]);

  const addStep = useCallback((type: Exclude<StepType, "start" | "end">, position?: { x: number; y: number }) => {
    const data: StepData = type === "sendLetter"
      ? { label: "Send letter", templateId: "", subject: "", body: "" }
      : type === "wait"
        ? { label: "Wait", minutes: 5 }
        : { label: "Staff task", title: "Call the debtor" };
    const node: CanvasNode = {
      id: crypto.randomUUID(),
      type,
      position: position ?? { x: 300 + Math.random() * 160, y: 120 + Math.random() * 240 },
      data,
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(node.id);
    setErrors([]);
    setMessage("");
  }, [setNodes]);

  function updateSelectedData(key: keyof StepData, value: string | number) {
    if (!selectedNode) return;
    setNodes((current) => current.map((node) =>
      node.id === selectedNode.id
        ? { ...node, data: { ...node.data, [key]: value } }
        : node,
    ));
    setMessage("");
  }

  function onDragStart(event: React.DragEvent, type: Exclude<StepType, "start" | "end">) {
    event.dataTransfer.setData("application/ledgerline-step", type);
    event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(event: React.DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/ledgerline-step") as Exclude<StepType, "start" | "end">;
    if (!["sendLetter", "wait", "staffTask"].includes(type)) return;
    const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addStep(type, position);
  }

  async function loadWorkflow(id: string) {
    if (!id) {
      setWorkflowId("");
      return;
    }
    setMessage("");
    try {
      const response = await fetch(`/api/workflows/${id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Workflow could not be loaded.");
      const workflow = body.workflow;
      setWorkflowId(workflow.id);
      setWorkflowName(workflow.name);
      setNodes(workflow.definition.nodes as CanvasNode[]);
      setEdges(workflow.definition.edges as Edge[]);
      setSelectedNodeId("");
      setMessage(`Loaded ${workflow.name} · version ${workflow.version} · ${workflow.status}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Workflow could not be loaded.");
    }
  }

  async function saveWorkflow() {
    setIsSaving(true);
    setMessage("");
    setErrors([]);
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workflowName, definition }),
      });
      const body = await response.json();
      if (!response.ok) {
        setErrors(Array.isArray(body.details) ? body.details : []);
        throw new Error(body.error ?? "Workflow could not be saved.");
      }
      const saved = body.workflow as SavedWorkflow;
      setWorkflowId(saved.id);
      setWorkflows((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setMessage(`Saved draft version ${saved.version}.`);
    } catch (cause) {
      if (cause instanceof Error && !errors.length) setMessage(cause.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function publishWorkflow() {
    if (!workflowId) return;
    setIsPublishing(true);
    setMessage("");
    setErrors([]);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/publish`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setErrors(Array.isArray(body.details) ? body.details : []);
        throw new Error(body.error ?? "Workflow could not be published.");
      }
      const published = body.workflow as SavedWorkflow;
      setWorkflows((current) => current.map((item) =>
        item.name.toLowerCase() === published.name.toLowerCase()
          ? { ...item, status: item.id === published.id ? "published" : item.status === "published" ? "archived" : item.status }
          : item,
      ));
      setMessage(`Published version ${published.version}.`);
    } catch (cause) {
      if (cause instanceof Error && !errors.length) setMessage(cause.message);
    } finally {
      setIsPublishing(false);
    }
  }

  async function loadPreviewMatter(id: string) {
    setPreviewMatterId(id);
    setPreviewMatter(null);
    if (!id) return;
    setLoadingPreview(true);
    try {
      const response = await fetch(`/api/matters/${id}`);
      const body = await response.json();
      if (response.ok) setPreviewMatter(body.matter as Matter);
      else setMessage(body.error ?? "Matter preview could not be loaded.");
    } catch {
      setMessage("Matter preview could not be loaded.");
    } finally {
      setLoadingPreview(false);
    }
  }

  function chooseTemplate(templateId: string) {
    const template = templates.find((item) => item.id === templateId);
    updateSelectedData("templateId", templateId);
    if (template) {
      updateSelectedData("subject", template.subject);
      updateSelectedData("body", template.body);
    }
  }

  const previewSubject = selectedNode?.type === "sendLetter" && previewMatter
    ? renderLetterText(selectedNode.data.subject ?? "", previewMatter)
    : "";
  const previewBody = selectedNode?.type === "sendLetter" && previewMatter
    ? renderLetterText(selectedNode.data.body ?? "", previewMatter)
    : "";

  return (
    <div className="grid h-[78vh] min-h-[720px] grid-cols-1 overflow-hidden rounded-lg border bg-background xl:grid-cols-[190px_minmax(0,1fr)_320px]">
      <aside className="space-y-4 border-b p-4 xl:border-b-0 xl:border-r">
        <div>
          <h2 className="font-semibold">Add a step</h2>
          <p className="mt-1 text-xs text-muted-foreground">Drag onto the canvas or select to add.</p>
        </div>
        <div className="grid gap-2">
          {([
            ["sendLetter", "Send letter"],
            ["wait", "Wait"],
            ["staffTask", "Staff task"],
          ] as const).map(([type, label]) => (
            <button
              key={type}
              type="button"
              draggable
              onDragStart={(event) => onDragStart(event, type)}
              onClick={() => addStep(type)}
              className="cursor-grab rounded-md border px-3 py-2 text-left text-sm font-medium hover:bg-muted active:cursor-grabbing"
            >
              + {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Start and End are always on the canvas and cannot be removed.</p>
      </aside>

      <div className="relative min-h-[400px]" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 p-2 shadow-sm backdrop-blur">
          <input
            aria-label="Workflow name"
            value={workflowName}
            onChange={(event) => setWorkflowName(event.target.value)}
            maxLength={100}
            className="min-w-36 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
          <select
            aria-label="Load a saved workflow"
            value={workflowId}
            onChange={(event) => void loadWorkflow(event.target.value)}
            className="max-w-52 rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Load workflow…</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name} · v{workflow.version} · {workflow.status}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void saveWorkflow()}
            disabled={isSaving || validationErrors.length > 0 || !workflowName.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >{isSaving ? "Saving…" : "Save draft"}</button>
          <button
            type="button"
            onClick={() => void publishWorkflow()}
            disabled={!workflowId || isPublishing || validationErrors.length > 0}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >{isPublishing ? "Publishing…" : "Publish"}</button>
        </div>
        <ReactFlow<CanvasNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId("")}
          onInit={(instance) => { flowRef.current = instance; }}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          deleteKeyCode="Backspace"
          defaultEdgeOptions={{ animated: false, style: { strokeWidth: 2 } }}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={20} />
          <Controls />
        </ReactFlow>
      </div>

      <aside className="overflow-y-auto border-t p-4 xl:border-l xl:border-t-0">
        <h2 className="font-semibold">Step settings</h2>
        {!selectedNode && <p className="mt-2 text-sm text-muted-foreground">Select a step on the canvas to edit it.</p>}

        {selectedNode?.type === "sendLetter" && (
          <div className="mt-4 space-y-4">
            <label className="block space-y-1 text-sm font-medium">
              Template
              <select
                value={selectedNode.data.templateId ?? ""}
                onChange={(event) => chooseTemplate(event.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 font-normal"
              >
                <option value="">Choose a template</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Subject
              <input
                value={selectedNode.data.subject ?? ""}
                onChange={(event) => updateSelectedData("subject", event.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 font-normal"
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Letter text
              <textarea
                value={selectedNode.data.body ?? ""}
                onChange={(event) => updateSelectedData("body", event.target.value)}
                rows={10}
                className="w-full rounded-md border bg-background px-3 py-2 font-normal"
              />
            </label>
            <div className="space-y-2 rounded-md bg-muted/60 p-3">
              <label className="block space-y-1 text-sm font-medium">
                Preview with a real matter
                <select
                  value={previewMatterId}
                  onChange={(event) => void loadPreviewMatter(event.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 font-normal"
                >
                  <option value="">Choose a matter</option>
                  {matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.matter_ref}</option>)}
                </select>
              </label>
              {matters.length === 0 && <p className="text-xs text-muted-foreground">Approve a matter before previewing.</p>}
              {loadingPreview && <p role="status" className="text-xs text-muted-foreground">Loading preview…</p>}
              {previewMatter && (
                <div className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs">
                  <p className="font-semibold">{previewSubject}</p>
                  <pre className="mt-2 whitespace-pre-wrap font-sans">{previewBody}</pre>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Placeholders: {matterFields.slice(0, 4).map((field) => `{{${field}}}`).join(", ")}, {"{{amount_owed}}"}, {"{{today_date}}"}
              </p>
            </div>
          </div>
        )}

        {selectedNode?.type === "wait" && (
          <label className="mt-4 block space-y-1 text-sm font-medium">
            Wait duration (minutes)
            <input
              type="number"
              min={1}
              max={43_200}
              step={1}
              value={selectedNode.data.minutes ?? 1}
              onChange={(event) => updateSelectedData("minutes", Number(event.target.value))}
              className="w-full rounded-md border bg-background px-3 py-2 font-normal"
            />
          </label>
        )}

        {selectedNode?.type === "staffTask" && (
          <label className="mt-4 block space-y-1 text-sm font-medium">
            Task title
            <input
              value={selectedNode.data.title ?? ""}
              onChange={(event) => updateSelectedData("title", event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 font-normal"
            />
          </label>
        )}

        {selectedNode && !["start", "end"].includes(selectedNode.type ?? "") && (
          <button
            type="button"
            onClick={() => {
              const removedId = selectedNode.id;
              setNodes((current) => current.filter((node) => node.id !== removedId));
              setEdges((current) => current.filter((edge) => edge.source !== removedId && edge.target !== removedId));
              setSelectedNodeId("");
            }}
            className="mt-4 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
          >
            Remove this step
          </button>
        )}

        {selectedNode && ["start", "end"].includes(selectedNode.type ?? "") && (
          <p className="mt-2 text-sm text-muted-foreground">This system node is fixed and has no settings.</p>
        )}

        <section className="mt-6 border-t pt-4">
          <h3 className="font-semibold">Workflow checks</h3>
          {validationErrors.length === 0 ? (
            <p className="mt-2 text-sm text-emerald-700">Connected and ready to save.</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-destructive">
              {validationErrors.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          )}
          {errors.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-destructive">
              {errors.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          )}
          {message && <p role="status" className="mt-3 text-sm text-muted-foreground">{message}</p>}
        </section>
      </aside>
    </div>
  );
}

export function WorkflowCanvas() {
  return (
    <ReactFlowProvider>
      <WorkflowEditor />
    </ReactFlowProvider>
  );
}
