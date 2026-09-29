import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

import { sendLetter } from "../src/lib/letter-provider";
import { renderLetterText } from "../src/lib/letter-rendering";
import { createAzurePostgresConfig } from "../src/lib/azure-postgres";

type NodeDefinition = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
};

type Definition = {
  nodes: NodeDefinition[];
  edges: Array<{ id: string; source: string; target: string }>;
};

type ClaimedRun = {
  id: string;
  batch_id: string;
  matter_id: string;
  current_node_id: string | null;
  workflow_snapshot: Definition;
  execution_state: Record<string, unknown> | null;
};

function getDatabaseUrl() {
  if (process.env.DATABASE_URL_FILE) {
    const value = readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
    if (value) return value;
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error("Worker database configuration is missing.");
}

const pool = new Pool(createAzurePostgresConfig() ?? { connectionString: getDatabaseUrl() });
const leaseInterval = "5 minutes";
let stopping = false;

function nextNodeId(definition: Definition, currentNodeId: string) {
  return definition.edges.find((edge) => edge.source === currentNodeId)?.target ?? null;
}

async function refreshBatchStatus(batchId: string) {
  await pool.query(
    `UPDATE workflow_batches b
     SET status = CASE
           WHEN stats.nonterminal > 0 THEN 'running'
           WHEN stats.failed > 0 THEN 'failed'
           ELSE 'completed'
         END,
         started_at = COALESCE(b.started_at, NOW()),
         completed_at = CASE WHEN stats.nonterminal = 0 THEN NOW() ELSE NULL END
     FROM (
       SELECT COUNT(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'cancelled'))::int AS nonterminal,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM workflow_runs WHERE batch_id = $1
     ) stats
     WHERE b.id = $1`,
    [batchId],
  );
}

async function claimNextRun(): Promise<ClaimedRun | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<ClaimedRun>(
      `SELECT id, batch_id, matter_id, current_node_id, workflow_snapshot, execution_state
       FROM workflow_runs
       WHERE (status = 'pending' AND COALESCE(scheduled_for, NOW()) <= NOW())
          OR (status = 'waiting' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW())
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= NOW())
       ORDER BY COALESCE(scheduled_for, created_at), created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (claimed.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const run = claimed.rows[0];
    await client.query(
      `UPDATE workflow_runs
       SET status = 'running', lease_until = NOW() + $2::interval,
           worker_attempts = worker_attempts + 1, updated_at = NOW()
       WHERE id = $1`,
      [run.id, leaseInterval],
    );
    await client.query(
      "UPDATE workflow_batches SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1",
      [run.batch_id],
    );
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setPending(run: ClaimedRun, nodeId: string, executionState = run.execution_state ?? {}) {
  await pool.query(
    `UPDATE workflow_runs
     SET current_node_id = $2, execution_state = $3::jsonb, status = 'pending',
         scheduled_for = NOW(), lease_until = NULL, error_message = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [run.id, nodeId, JSON.stringify(executionState)],
  );
}

async function markFailed(run: ClaimedRun, message: string) {
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'failed', error_message = $2, scheduled_for = NULL,
         lease_until = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [run.id, message.slice(0, 1000)],
  );
  await refreshBatchStatus(run.batch_id);
}

async function markCompleted(run: ClaimedRun) {
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'completed', scheduled_for = NULL, lease_until = NULL,
         error_message = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [run.id],
  );
  await refreshBatchStatus(run.batch_id);
}

async function processStartOrEnd(run: ClaimedRun, node: NodeDefinition) {
  if (node.type === "end") {
    await markCompleted(run);
    return;
  }
  const next = nextNodeId(run.workflow_snapshot, node.id);
  if (!next) {
    await markFailed(run, `Step ${node.id} has no next connection.`);
    return;
  }
  await setPending(run, next);
}

async function processWait(run: ClaimedRun, node: NodeDefinition) {
  const state = run.execution_state ?? {};
  if (state.waiting_node === node.id) {
    const next = nextNodeId(run.workflow_snapshot, node.id);
    if (!next) {
      await markFailed(run, `Wait step ${node.id} has no next connection.`);
      return;
    }
    const nextState = { ...state };
    delete nextState.waiting_node;
    await setPending(run, next, nextState);
    return;
  }

  const minutes = Number(node.data?.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) {
    await markFailed(run, `Wait step ${node.id} has an invalid duration.`);
    return;
  }
  await pool.query(
    `UPDATE workflow_runs
     SET execution_state = $2::jsonb, status = 'waiting',
         scheduled_for = NOW() + ($3 * INTERVAL '1 minute'),
         lease_until = NULL, updated_at = NOW()
     WHERE id = $1`,
    [run.id, JSON.stringify({ ...state, waiting_node: node.id }), minutes],
  );
}

async function processStaffTask(run: ClaimedRun, node: NodeDefinition) {
  const title = typeof node.data?.title === "string" ? node.data.title.trim() : "";
  if (!title) {
    await markFailed(run, `Staff task step ${node.id} has no title.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tasks (run_id, node_id, title, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (run_id, node_id) DO NOTHING`,
      [run.id, node.id, title],
    );
    const task = await client.query<{ status: string }>(
      "SELECT status FROM tasks WHERE run_id = $1 AND node_id = $2",
      [run.id, node.id],
    );

    if (task.rows[0]?.status === "completed") {
      const next = nextNodeId(run.workflow_snapshot, node.id);
      if (!next) {
        await client.query("ROLLBACK");
        await markFailed(run, `Staff task step ${node.id} has no next connection.`);
        return;
      }
      await client.query(
        `UPDATE workflow_runs SET current_node_id = $2, status = 'pending',
           scheduled_for = NOW(), lease_until = NULL, execution_state = '{}'::jsonb,
           updated_at = NOW() WHERE id = $1`,
        [run.id, next],
      );
    } else {
      await client.query(
        `UPDATE workflow_runs SET status = 'waiting', scheduled_for = NULL,
           lease_until = NULL, execution_state = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [run.id, JSON.stringify({ waiting_task_node: node.id })],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadMatter(matterId: string) {
  const result = await pool.query(
    `SELECT matter_ref, client_firm, debtor_first_name, debtor_last_name,
            email, phone, amount_owed::text, currency, address_line1,
            address_line2, town, county, eircode,
            to_char(instruction_date, 'DD/MM/YYYY') AS instruction_date,
            matter_type, notes
     FROM matters WHERE id = $1`,
    [matterId],
  );
  return result.rows[0] ?? null;
}

async function saveDelivery(
  client: PoolClient,
  run: ClaimedRun,
  node: NodeDefinition,
  providerResponse: unknown,
  status: "sent" | "failed",
  errorMessage?: string,
) {
  await client.query(
    `UPDATE letter_deliveries
     SET status = $3, provider_response = $4::jsonb,
         error_message = NULLIF($5, ''), attempted_at = NOW()
     WHERE run_id = $1 AND node_id = $2`,
    [run.id, node.id, status, JSON.stringify(providerResponse ?? {}), errorMessage ?? ""],
  );
}

async function processLetter(run: ClaimedRun, node: NodeDefinition) {
  const data = node.data ?? {};
  const templateId = typeof data.templateId === "string" ? data.templateId : "";
  const subjectTemplate = typeof data.subject === "string" ? data.subject : "";
  const bodyTemplate = typeof data.body === "string" ? data.body : "";
  const matter = await loadMatter(run.matter_id);
  if (!matter) {
    await markFailed(run, "Matter data could not be loaded for the letter.");
    return;
  }

  const client = await pool.connect();
  let deliveryStatus: string | undefined;
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO letter_deliveries (run_id, node_id, recipient, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (run_id, node_id) DO NOTHING
       RETURNING id`,
      [run.id, node.id, `${matter.debtor_first_name} ${matter.debtor_last_name}`],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ status: string }>(
        "SELECT status FROM letter_deliveries WHERE run_id = $1 AND node_id = $2",
        [run.id, node.id],
      );
      deliveryStatus = existing.rows[0]?.status;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (deliveryStatus === "sent") {
    const next = nextNodeId(run.workflow_snapshot, node.id);
    if (next) await setPending(run, next);
    else await markFailed(run, `Send letter step ${node.id} has no next connection.`);
    return;
  }
  if (deliveryStatus) {
    await markFailed(
      run,
      deliveryStatus === "pending"
        ? "A previous letter attempt has no recorded outcome. Check the provider before retrying."
        : "A previous letter attempt failed; manual review is required before retrying.",
    );
    return;
  }

  const addressLines = [
    matter.address_line1,
    matter.address_line2,
    matter.town,
    matter.county,
    matter.eircode,
  ].filter((line): line is string => typeof line === "string" && !!line.trim());
  const request = {
    recipient: {
      name: `${matter.debtor_first_name} ${matter.debtor_last_name}`.trim(),
      addressLines,
      ...(matter.eircode ? { eircode: matter.eircode } : {}),
    },
    subject: renderLetterText(subjectTemplate, matter),
    body: renderLetterText(bodyTemplate, matter),
    reference: matter.matter_ref,
  };

  let response;
  try {
    response = await sendLetter(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Letter provider failed.";
    const failureClient = await pool.connect();
    try {
      await failureClient.query("BEGIN");
      await saveDelivery(failureClient, run, node, {}, "failed", message);
      await failureClient.query(
        `UPDATE workflow_runs SET status = 'failed', error_message = $2,
           scheduled_for = NULL, lease_until = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [run.id, message.slice(0, 1000)],
      );
      await failureClient.query("COMMIT");
    } catch (saveError) {
      await failureClient.query("ROLLBACK").catch(() => undefined);
      throw saveError;
    } finally {
      failureClient.release();
    }
    await refreshBatchStatus(run.batch_id);
    return;
  }

  const next = nextNodeId(run.workflow_snapshot, node.id);
  const finalClient = await pool.connect();
  try {
    await finalClient.query("BEGIN");
    await saveDelivery(finalClient, run, node, response, "sent");
    if (next) {
      await finalClient.query(
        `UPDATE workflow_runs SET current_node_id = $2, status = 'pending',
           scheduled_for = NOW(), lease_until = NULL, updated_at = NOW()
         WHERE id = $1`,
        [run.id, next],
      );
    } else {
      await finalClient.query(
        `UPDATE workflow_runs SET status = 'failed', error_message = $2,
           scheduled_for = NULL, lease_until = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [run.id, `Send letter step ${node.id} has no next connection.`],
      );
    }
    await finalClient.query("COMMIT");
  } catch (error) {
    await finalClient.query("ROLLBACK").catch(() => undefined);
    // Keep the delivery pending. The provider may already have accepted it;
    // the lease retry will stop for operator review rather than send twice.
    throw error;
  } finally {
    finalClient.release();
  }
}

async function processRun(run: ClaimedRun) {
  const node = run.workflow_snapshot.nodes.find((item) => item.id === run.current_node_id);
  if (!node) {
    await markFailed(run, "The saved workflow step could not be found.");
    return;
  }

  switch (node.type) {
    case "start":
    case "end":
      await processStartOrEnd(run, node);
      return;
    case "wait":
      await processWait(run, node);
      return;
    case "staffTask":
      await processStaffTask(run, node);
      return;
    case "sendLetter":
      await processLetter(run, node);
      return;
    default:
      await markFailed(run, `Unsupported workflow step type: ${node.type}.`);
  }
}

async function runWorker() {
  console.log("Workflow worker started.");
  while (!stopping) {
    try {
      const run = await claimNextRun();
      if (run) {
        await processRun(run);
        await refreshBatchStatus(run.batch_id);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } catch {
      console.error("Workflow worker could not process the next step.");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  await pool.end();
  console.log("Workflow worker stopped.");
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

runWorker().catch(async () => {
  console.error("Workflow worker stopped after a startup failure.");
  await pool.end();
  process.exitCode = 1;
});
