import { matterFields } from "./matter-csv-validation";

export type WorkflowNode = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
};

export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

const supportedTypes = new Set(["start", "end", "sendLetter", "wait", "staffTask"]);
const placeholders = new Set<string>([...matterFields, "today_date"]);

export function validateWorkflow(
  definition: WorkflowDefinition,
  options: { templateIds?: ReadonlySet<string> } = {},
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(definition.nodes) || definition.nodes.length < 2) {
    return ["A workflow needs at least one Start and one End node."];
  }
  if (!Array.isArray(definition.edges)) return ["Workflow connections are invalid."];

  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id || nodeIds.has(node.id)) errors.push("Every step must have a unique ID.");
    nodeIds.add(node.id);
    if (!supportedTypes.has(node.type)) errors.push(`Unsupported step type: ${node.type || "unknown"}.`);
  }

  const starts = definition.nodes.filter((node) => node.type === "start");
  const ends = definition.nodes.filter((node) => node.type === "end");
  if (starts.length !== 1) errors.push("A workflow must have exactly one Start node.");
  if (ends.length !== 1) errors.push("A workflow must have exactly one End node.");
  if (starts.length !== 1 || ends.length !== 1) return [...new Set(errors)];

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const edgeKeys = new Set<string>();
  for (const node of definition.nodes) adjacency.set(node.id, []);

  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push("Every connection must point to an existing step.");
      continue;
    }
    if (edge.source === edge.target) {
      errors.push("A step cannot connect to itself.");
      continue;
    }
    const key = `${edge.source}\u0000${edge.target}`;
    if (edgeKeys.has(key)) {
      errors.push("Duplicate connections are not allowed.");
      continue;
    }
    edgeKeys.add(key);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }

  const start = starts[0];
  const end = ends[0];
  if ((incoming.get(start.id) ?? 0) !== 0) errors.push("Start cannot have an incoming connection.");
  if ((outgoing.get(start.id) ?? 0) !== 1) errors.push("Start must connect to exactly one next step.");
  if ((incoming.get(end.id) ?? 0) !== 1) errors.push("End must have exactly one incoming connection.");
  if ((outgoing.get(end.id) ?? 0) !== 0) errors.push("End cannot have an outgoing connection.");

  for (const node of definition.nodes) {
    if (node.type === "start" || node.type === "end") continue;
    if ((incoming.get(node.id) ?? 0) !== 1) {
      errors.push(`${node.type} step “${node.id}” must have exactly one incoming connection.`);
    }
    if ((outgoing.get(node.id) ?? 0) !== 1) {
      errors.push(`${node.type} step “${node.id}” must connect to exactly one next step.`);
    }

    if (node.type === "sendLetter") {
      const templateId = node.data?.templateId;
      const subject = node.data?.subject;
      const body = node.data?.body;
      if (typeof templateId !== "string" || !templateId.trim()) {
        errors.push(`Send letter step “${node.id}” needs a template.`);
      } else if (options.templateIds && !options.templateIds.has(templateId)) {
        errors.push(`Send letter step “${node.id}” refers to a template that does not exist.`);
      }
      if (typeof subject !== "string" || !subject.trim()) {
        errors.push(`Send letter step “${node.id}” needs a subject.`);
      }
      if (typeof body !== "string" || !body.trim()) {
        errors.push(`Send letter step “${node.id}” needs a body.`);
      }
      for (const text of [subject, body]) {
        if (typeof text !== "string") continue;
        for (const [, name] of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
          if (!placeholders.has(name)) {
            errors.push(`Send letter step “${node.id}” uses unknown placeholder {{${name}}}.`);
          }
        }
        const withoutValidPlaceholders = text.replace(/\{\{\s*\w+\s*\}\}/g, "");
        if (withoutValidPlaceholders.includes("{{") || withoutValidPlaceholders.includes("}}")) {
          errors.push(`Send letter step “${node.id}” contains a malformed placeholder.`);
        }
      }
    }
    if (node.type === "wait") {
      const minutes = node.data?.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) {
        errors.push(`Wait step “${node.id}” must be between 1 and 43,200 whole minutes.`);
      }
    }
    if (node.type === "staffTask") {
      const title = node.data?.title;
      if (typeof title !== "string" || !title.trim()) {
        errors.push(`Staff task step “${node.id}” needs a task title.`);
      }
    }
  }

  const reachable = new Set<string>();
  const queue = [start.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  if (reachable.size !== definition.nodes.length) {
    errors.push("Every step must be connected to Start and End; remove unreachable or dead-end steps.");
  }
  if (!reachable.has(end.id)) errors.push("End must be reachable from Start.");

  return [...new Set(errors)];
}
