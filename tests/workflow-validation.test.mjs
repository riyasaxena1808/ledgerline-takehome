import assert from "node:assert/strict";
import test from "node:test";

import workflowValidation from "../node_modules/.cache/ledgerline-tests/workflow-validation.js";

const { validateWorkflow } = workflowValidation;

function validDefinition() {
  return {
    nodes: [
      { id: "start", type: "start", data: { label: "Start" } },
      {
        id: "letter",
        type: "sendLetter",
        data: {
          templateId: "payment-reminder",
          subject: "Reminder {{matter_ref}}",
          body: "Dear {{debtor_first_name}}, {{amount_owed}} on {{today_date}}",
        },
      },
      { id: "wait", type: "wait", data: { minutes: 30 } },
      { id: "task", type: "staffTask", data: { title: "Call the debtor" } },
      { id: "end", type: "end", data: { label: "End" } },
    ],
    edges: [
      { id: "e1", source: "start", target: "letter" },
      { id: "e2", source: "letter", target: "wait" },
      { id: "e3", source: "wait", target: "task" },
      { id: "e4", source: "task", target: "end" },
    ],
  };
}

test("accepts a connected workflow with configured step types and placeholders", () => {
  assert.deepEqual(validateWorkflow(validDefinition()), []);
});

test("requires a letter template to exist before saving or publishing", () => {
  const errors = validateWorkflow(validDefinition(), {
    templateIds: new Set(["letter-of-demand"]),
  });
  assert.ok(errors.some((error) => error.includes("template that does not exist")));
});

test("requires exactly one connected Start and End with no dead steps", () => {
  const definition = validDefinition();
  definition.nodes.push({ id: "orphan", type: "wait", data: { minutes: 5 } });
  const errors = validateWorkflow(definition);
  assert.ok(errors.some((error) => error.includes("exactly one incoming")));
  assert.ok(errors.some((error) => error.includes("unreachable or dead-end")));
});

test("rejects unknown placeholders and invalid step settings", () => {
  const definition = validDefinition();
  definition.nodes[1].data.body = "{{unknown_field}}";
  definition.nodes[2].data.minutes = 0;
  definition.nodes[3].data.title = " ";
  const errors = validateWorkflow(definition);
  assert.ok(errors.some((error) => error.includes("unknown placeholder")));
  assert.ok(errors.some((error) => error.includes("Wait step")));
  assert.ok(errors.some((error) => error.includes("Staff task step")));
});

test("rejects disconnected endpoints and branching edges", () => {
  const definition = validDefinition();
  definition.edges.push({ id: "branch", source: "start", target: "end" });
  const errors = validateWorkflow(definition);
  assert.ok(errors.some((error) => error.includes("exactly one next step")));
  assert.ok(errors.some((error) => error.includes("exactly one incoming")));
});
