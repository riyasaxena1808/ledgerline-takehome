ALTER TABLE tasks
    ADD COLUMN completed_by TEXT;

CREATE INDEX idx_tasks_open_created
    ON tasks (created_at DESC)
    WHERE status IN ('pending', 'in_progress');
