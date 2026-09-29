ALTER TABLE review_decisions
    ADD COLUMN changes JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(changes) = 'array');

CREATE UNIQUE INDEX matters_matter_ref_case_insensitive_unique
    ON matters (lower(matter_ref));

CREATE INDEX idx_import_rows_import_order
    ON import_rows (import_id, row_number);

CREATE INDEX idx_review_decisions_row_time
    ON review_decisions (import_row_id, decided_at DESC);
