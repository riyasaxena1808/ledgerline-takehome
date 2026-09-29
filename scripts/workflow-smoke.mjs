import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = "http://localhost:3000";
let workflowId;
let matterId;
let importId;
let rowId;
let batchId;
let waitWorkflowId;

try {
  const unique = `SMOKE-${Date.now()}`;
  const imported = await pool.query("INSERT INTO imports (file_name, status) VALUES ($1, 'completed') RETURNING id", [`${unique}.csv`]);
  importId = imported.rows[0].id;
  const row = await pool.query(
    `INSERT INTO import_rows (import_id, row_number, original_data, normalized_data, review_status, reviewed_by, reviewed_at)
     VALUES ($1, 1, '{}'::jsonb, '{}'::jsonb, 'approved', 'Smoke tester', NOW()) RETURNING id`, [importId]);
  rowId = row.rows[0].id;
  const matter = await pool.query(
    `INSERT INTO matters (import_row_id, matter_ref, client_firm, debtor_first_name, debtor_last_name, amount_owed, currency, address_line1, town, county, instruction_date, matter_type)
     VALUES ($1,$2,'Smoke Test Firm','Test','Debtor',10,'EUR','1 Test Road','Dublin','Dublin',CURRENT_DATE,'Test') RETURNING id`, [rowId, unique]);
  matterId = matter.rows[0].id;

  const definition = { nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
    { id: "staff", type: "staffTask", position: { x: 0, y: 100 }, data: { title: "Smoke test staff task" } },
    { id: "end", type: "end", position: { x: 0, y: 200 }, data: {} },
  ], edges: [
    { id: "a", source: "start", target: "staff" },
    { id: "b", source: "staff", target: "end" },
  ] };
  const createdResponse = await fetch(`${origin}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: unique, definition }) });
  const created = await createdResponse.json();
  if (!createdResponse.ok) throw new Error(`workflow create ${createdResponse.status}: ${JSON.stringify(created)}`);
  workflowId = created.workflow.id;
  const publishResponse = await fetch(`${origin}/api/workflows/${workflowId}/publish`, { method: "POST" });
  if (!publishResponse.ok) throw new Error(`workflow publish ${publishResponse.status}: ${JSON.stringify(await publishResponse.json())}`);
  const runResponse = await fetch(`${origin}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowId, matterIds: [matterId] }) });
  const run = await runResponse.json();
  if (!runResponse.ok) throw new Error(`run create ${runResponse.status}: ${JSON.stringify(run)}`);
  batchId = run.batchId;

  let detail;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await fetch(`${origin}/api/runs/${batchId}`);
    detail = await response.json();
    if (detail.matters?.[0]?.status === "waiting") break;
  }
  if (detail?.matters?.[0]?.status !== "waiting") throw new Error(`run failed to wait: ${JSON.stringify(detail)}`);
  const taskResponse = await fetch(`${origin}/api/tasks`);
  const taskData = await taskResponse.json();
  const task = taskData.tasks.find((item) => item.batch_id === batchId);
  if (!task) throw new Error("staff task was not created");
  const completeResponse = await fetch(`${origin}/api/tasks/${task.id}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ completedBy: "Smoke Tester" }) });
  if (!completeResponse.ok) throw new Error(`task completion ${completeResponse.status}: ${JSON.stringify(await completeResponse.json())}`);
  let final;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await fetch(`${origin}/api/runs/${batchId}`);
    final = await response.json();
    if (final.batch.status === "completed") break;
  }
  if (final?.batch?.status !== "completed") throw new Error(`run failed to complete: ${JSON.stringify(final)}`);
  await pool.query("DELETE FROM tasks WHERE run_id IN (SELECT id FROM workflow_runs WHERE batch_id = $1)", [batchId]);
  await pool.query("DELETE FROM workflow_runs WHERE batch_id = $1", [batchId]);
  await pool.query("DELETE FROM workflow_batches WHERE id = $1", [batchId]);
  batchId = null;

  const waitDefinition = { nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
    { id: "wait", type: "wait", position: { x: 0, y: 100 }, data: { minutes: 1 } },
    { id: "end", type: "end", position: { x: 0, y: 200 }, data: {} },
  ], edges: [
    { id: "a", source: "start", target: "wait" },
    { id: "b", source: "wait", target: "end" },
  ] };
  const waitWorkflowResponse = await fetch(`${origin}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${unique}-wait`, definition: waitDefinition }) });
  const waitWorkflow = await waitWorkflowResponse.json();
  if (!waitWorkflowResponse.ok) throw new Error(`wait workflow create ${waitWorkflowResponse.status}: ${JSON.stringify(waitWorkflow)}`);
  waitWorkflowId = waitWorkflow.workflow.id;
  const waitPublish = await fetch(`${origin}/api/workflows/${waitWorkflowId}/publish`, { method: "POST" });
  if (!waitPublish.ok) throw new Error(`wait workflow publish ${waitPublish.status}`);
  const waitRunResponse = await fetch(`${origin}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowId: waitWorkflowId, matterIds: [matterId] }) });
  const waitRun = await waitRunResponse.json();
  if (!waitRunResponse.ok) throw new Error(`wait run create ${waitRunResponse.status}: ${JSON.stringify(waitRun)}`);
  const waitBatchId = waitRun.batchId;
  batchId = waitBatchId;
  let waitingDetail;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await fetch(`${origin}/api/runs/${waitBatchId}`);
    waitingDetail = await response.json();
    if (waitingDetail.matters?.[0]?.status === "waiting") break;
  }
  if (waitingDetail?.matters?.[0]?.status !== "waiting" || !waitingDetail.matters[0].scheduled_for) throw new Error(`wait was not persisted: ${JSON.stringify(waitingDetail)}`);
  await pool.query("UPDATE workflow_runs SET scheduled_for = NOW() - INTERVAL '1 second' WHERE batch_id = $1", [waitBatchId]);
  let resumedDetail;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await fetch(`${origin}/api/runs/${waitBatchId}`);
    resumedDetail = await response.json();
    if (resumedDetail.batch.status === "completed") break;
  }
  if (resumedDetail?.batch?.status !== "completed") throw new Error(`waited workflow did not resume: ${JSON.stringify(resumedDetail)}`);
  await pool.query("DELETE FROM workflow_runs WHERE batch_id = $1", [waitRun.batchId]);
  await pool.query("DELETE FROM workflow_batches WHERE id = $1", [waitRun.batchId]);
  await pool.query("DELETE FROM workflows WHERE id = $1", [waitWorkflowId]);
  batchId = null;
  console.log("Workflow smoke passed: staff tasks resume runs, and a persisted Wait resumes from its database schedule.");
} finally {
  if (batchId) {
    await pool.query("DELETE FROM tasks WHERE run_id IN (SELECT id FROM workflow_runs WHERE batch_id = $1)", [batchId]);
    await pool.query("DELETE FROM letter_deliveries WHERE run_id IN (SELECT id FROM workflow_runs WHERE batch_id = $1)", [batchId]);
    await pool.query("DELETE FROM workflow_runs WHERE batch_id = $1", [batchId]);
    await pool.query("DELETE FROM workflow_batches WHERE id = $1", [batchId]);
  }
  if (waitWorkflowId) await pool.query("DELETE FROM workflows WHERE id = $1", [waitWorkflowId]);
  if (workflowId) await pool.query("DELETE FROM workflows WHERE id = $1", [workflowId]);
  if (matterId) await pool.query("DELETE FROM matters WHERE id = $1", [matterId]);
  if (rowId) await pool.query("DELETE FROM import_rows WHERE id = $1", [rowId]);
  if (importId) await pool.query("DELETE FROM imports WHERE id = $1", [importId]);
  await pool.end();
}
