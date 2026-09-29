CREATE TABLE workflow_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    workflow_version INTEGER NOT NULL,
    workflow_snapshot JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

ALTER TABLE workflow_runs
    ADD COLUMN batch_id UUID REFERENCES workflow_batches(id),
    ADD COLUMN lease_until TIMESTAMPTZ,
    ADD COLUMN worker_attempts INTEGER NOT NULL DEFAULT 0 CHECK (worker_attempts >= 0),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX idx_workflow_batches_created
    ON workflow_batches (created_at DESC);

CREATE INDEX idx_workflow_runs_batch_status
    ON workflow_runs (batch_id, status, scheduled_for);

CREATE UNIQUE INDEX tasks_run_node_unique
    ON tasks (run_id, node_id);

CREATE UNIQUE INDEX letter_deliveries_run_node_unique
    ON letter_deliveries (run_id, node_id);
