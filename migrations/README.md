# Migrations

The database schema is managed with numbered SQL migration files. Apply pending
migrations with `npm run db:migrate`; the runner takes a Postgres advisory lock
and applies each file in a transaction.

`001_initial_schema.sql` creates the import, review, matter, workflow, run,
task, and letter-delivery tables. `002_import_file_uniqueness.sql` prevents an
identical CSV file from creating duplicate imports. `003_review_audit_and_matter_ref.sql`
stores reviewer corrections and prevents case-insensitive matter-reference
duplicates. `004_workflow_batches_and_leases.sql` groups per-matter runs,
supports worker leases, and prevents duplicate tasks or letter deliveries per
step. `005_task_completion_audit.sql` records who completed a staff task and
indexes open tasks for the staff queue. Add a new numbered file when changing
an already-applied schema.

`npm run db:reset` deletes the database volume and starts Postgres empty; run
`npm run db:migrate` afterward to recreate the schema.
