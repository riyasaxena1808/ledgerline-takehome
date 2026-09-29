-- 1. CSV imports
CREATE TABLE imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name TEXT NOT NULL,
    file_sha256 TEXT,
    storage_key TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (status IN (
            'uploaded', 'mapping', 'validating',
            'awaiting_review', 'completed', 'failed'
        )),
    column_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Individual rows from each CSV import
CREATE TABLE import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id UUID NOT NULL REFERENCES imports(id),
    row_number INTEGER NOT NULL CHECK (row_number > 0),
    original_data JSONB NOT NULL,
    normalized_data JSONB,
    validation_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'approved', 'rejected')),
    reviewer_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (import_id, row_number)
);

-- 3. Audit trail for human review decisions
CREATE TABLE review_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_row_id UUID NOT NULL REFERENCES import_rows(id),
    decision TEXT NOT NULL
        CHECK (decision IN ('approved', 'rejected')),
    reviewer TEXT NOT NULL,
    reason TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Approved legal matters
CREATE TABLE matters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_row_id UUID UNIQUE REFERENCES import_rows(id),
    matter_ref TEXT NOT NULL UNIQUE,
    client_firm TEXT NOT NULL,
    debtor_first_name TEXT NOT NULL,
    debtor_last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    amount_owed NUMERIC(12, 2) NOT NULL CHECK (amount_owed > 0),
    currency CHAR(3) NOT NULL,
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    town TEXT NOT NULL,
    county TEXT NOT NULL,
    eircode TEXT,
    instruction_date DATE NOT NULL,
    matter_type TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Saved workflow definitions
CREATE TABLE workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    definition JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published', 'archived')),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, version)
);

-- 6. Workflow executions
CREATE TABLE workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    matter_id UUID NOT NULL REFERENCES matters(id),
    workflow_version INTEGER NOT NULL,
    workflow_snapshot JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'running', 'waiting',
            'completed', 'failed', 'cancelled'
        )),
    current_node_id TEXT,
    execution_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    scheduled_for TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Staff tasks created by workflows
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES workflow_runs(id),
    node_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'in_progress', 'completed', 'cancelled'
        )),
    due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Letter sending attempts
CREATE TABLE letter_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES workflow_runs(id),
    node_id TEXT NOT NULL,
    recipient TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'failed')),
    provider_response JSONB,
    error_message TEXT,
    attempted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common lookups
CREATE INDEX idx_imports_created_at
    ON imports (created_at DESC);

CREATE INDEX idx_import_rows_review
    ON import_rows (import_id, review_status);

CREATE INDEX idx_matters_client_firm
    ON matters (client_firm);

CREATE INDEX idx_matters_debtor_name
    ON matters (debtor_last_name, debtor_first_name);

CREATE INDEX idx_workflow_runs_status_schedule
    ON workflow_runs (status, scheduled_for);

CREATE INDEX idx_tasks_status_assignee
    ON tasks (status, assigned_to);

CREATE INDEX idx_letter_deliveries_run
    ON letter_deliveries (run_id);