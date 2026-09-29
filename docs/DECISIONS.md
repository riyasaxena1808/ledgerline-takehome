# Decision log

## CSV import persistence

- Keep Papa Parse in the browser for preview, but parse and validate the raw
  uploaded file again on the server. Client validation improves feedback; only
  server validation controls what gets stored.
- Require all matter fields that the current `matters` table marks non-null.
  Reject ambiguous mappings, duplicate mapped targets, missing headers, bad
  UTF-8, malformed CSV syntax, files over 5 MB, and imports over 10,000 rows.
- Preserve the source row in `import_rows.original_data`; save normalized
  values separately. Store safe normalization notes and validation errors in
  `validation_findings` with a `kind` of `tidy` or `error`.
- Safely trim whitespace, normalize email/currency casing, format valid amounts
  to two decimals, and convert valid `DD/MM/YYYY` dates to ISO. Do not guess at
  malformed values: flag them for the reviewer.
- Persist every parsed row with `review_status = 'pending'` and the import with
  `status = 'awaiting_review'`. This stage never creates a matter; later review
  code must be the only path that does so.
- Treat identical file bytes as a duplicate and return HTTP 409 with the
  existing import ID. A partial unique index on the file hash closes the race
  between concurrent requests. Mark every occurrence of a repeated matter
  reference in one file, and any reference already present in matters, as an
  error finding.
- Retain the uploaded file name/hash and each original row. If object storage is
  configured, save the original CSV in Blob Storage/Azurite and keep its key in
  Postgres; without object storage, retain the row data only. The UI reports
  which behavior applied to each import.

## Human review and matter creation

- Show imports and rows from Postgres, paginating rows in pages of 100. This
  keeps every row reviewable without putting a large CSV into one page render.
- Require a reviewer name for each decision and a reason for rejection. Local
  sign-in is not implemented yet; production identity must come from Entra ID,
  not from this manually entered name.
- Let reviewers correct row values before approval. Re-run the same server
  validation on the corrected values, and refuse approval while required data
  is invalid or the reference conflicts with an active row or saved matter.
- Create the matter, update the import row, and write its audit decision in one
  transaction. Rejection creates no matter. The import becomes completed after
  its last pending row is decided.
- Preserve original validation findings and write reviewer corrections to a
  separate audit `changes` array. Rejected CSV export includes original source
  values and the rejection reason, with spreadsheet formula prefixes neutralized.
- Add a case-insensitive unique matter-reference index so a concurrent review
  cannot create differently capitalized duplicates.

## Approved matters

- List/search only rows in `matters`, never rows from CSV imports. Pagination is
  50 rows; search covers matter reference, debtor names, and client firm.
- Keep the source import and CSV row number attached to every matter, and show
  the original row plus approval audit on the detail page.
- These local pages do not authenticate users yet; production access must be
  protected by the planned work-account sign-in before exposing debtor data.

## Workflow authoring

- Store a workflow definition as JSONB nodes/edges in a versioned workflow row.
  Saving creates a new draft version; publishing is a separate explicit action
  and archives the previously published version with the same name.
- Treat the current supported flow as a single path: exactly one Start and End,
  each step has one predecessor and successor, every step is reachable, and
  node configuration/placeholders must validate before saving or publishing.
- Check letter template IDs on the server against files under `templates/`.
  The browser preview uses an approved matter loaded from Postgres and shares
  the same placeholder renderer intended for the worker.
- Add a workflow batch above per-matter executions so one user action can start
  a workflow for many matters while each matter retains independent durable
  progress. Leases let a worker recover executions left running by a crash.
- Give tasks and letter deliveries a unique `(run_id, node_id)` key so a
  retried worker step cannot create duplicate records.

## Durable runs and staff tasks

- Create a workflow batch for each user action and one independent run per
  selected approved matter. Each run carries the published workflow snapshot,
  so later edits do not change work already in progress.
- Run a separate worker process. It claims due work with `FOR UPDATE SKIP
  LOCKED`, records a lease, and stores step transitions in Postgres. Expired
  leases can be claimed again after a worker crash or restart.
- Persist Wait state and its resume timestamp in the run row. A staff task leaves
  only its matter's run waiting; completing that task transactionally records
  the staff name and resumes that run.
- Create a pending letter delivery before invoking the stub provider. If the
  response cannot be saved, retain the pending delivery and stop for operator
  reconciliation rather than risk sending a duplicate letter.
- Staff names are manually entered for this local prototype. Real staff
  identity and authorization must come from Entra ID in the Azure deployment.

## Blob storage and production-like containers

- Store original CSV bytes under an import-specific Blob key and rejected CSV
  exports under a deterministic per-import key. Keep only the Blob key and
  content hash in Postgres; original rows remain queryable for review.
- Let plain local development omit Blob configuration, while Compose requires
  a connection-string secret file. In Azure, the same Blob client uses the
  account endpoint with `DefaultAzureCredential` and a managed identity.
- Build the web and worker as separate production images. Run database
  migrations as a one-shot service before either starts. Publish only the web
  port; Postgres and Azurite are attached only to an internal network.
- Accept file-backed connection configuration (`DATABASE_URL_FILE`) in the app,
  migration runner, and worker to keep Docker Compose secrets out of environment
  values. Keep secret files in the already ignored `secrets/` folder.

## Verification

- `npm.cmd run typecheck` passed.
- `npm.cmd test` passed: eleven CSV, workflow validation, and local Blob-storage
  configuration tests.
- `npm.cmd run db:migrate` applied workflow batch/lease and task-completion
  migrations; the local database has migrations 001–005 applied.
- Live API smoke test: one 3-row upload returned 201, stored all rows, and
  marked the two malformed rows; re-uploading the exact bytes returned 409.
  The synthetic test import and its rows were deleted afterward.
- Review integration smoke test: clean approval returned 200; approval with an
  unresolved validation error returned 422; a corrected approval returned
  200; rejection returned 200; two approved rows created exactly two matters;
  three audit records were written; the rejected CSV included its reason.
- Review queue API smoke test: import list and paginated detail both returned
  200; decision history showed the saved rejection.
- Matter integration smoke test: after approval, search returned the saved
  matter with its source filename and its detail page returned 200 with the
  matter and source import. Synthetic data was removed afterward.
- Workflow API smoke test: template list returned three templates, invalid
  flow returned 422, valid flow saved as draft, loaded by ID, and published;
  the synthetic workflow was removed afterward.
- `npm.cmd run worker:build` passed for the standalone worker.
- `npm.cmd run typecheck` passed after adding run/task APIs and pages.
- Live runner smoke: started a staff-task workflow for a synthetic matter,
  confirmed the persisted task paused the run, completed it through the API,
  and observed the worker advance the batch to completed. A second workflow
  persisted a Wait schedule, resumed after its schedule became due, and
  completed. Test rows and workflows were removed.
- `npm.cmd run typecheck` passed after adding Blob Storage and file-backed
  database configuration. `npm.cmd run build` passed; its first sandboxed
  attempt could not fetch the starter's Google Font, then passed with network
  access.
- `docker compose -f docker-compose.prod.yml config --quiet` passed.
- `docker compose -f docker-compose.prod.yml build web worker` built both
  optimized images successfully. No production Compose containers were started.
- Blob SDK's no-configuration path is unit-tested. The actual upload against
  Azurite awaits an approved Compose run, so storage networking and container
  health have not yet had a live container smoke test.
- Both integration smoke tests deleted their synthetic rows and matters.
- The database was empty before and after the smoke test. No secrets or row
  contents were printed.

## Azure infrastructure

- Use App Service Authentication (Microsoft Entra) for the web app, Azure
  Front Door Premium with a private origin and WAF for ingress, and a separate
  VNet-injected Container Apps worker and manual migration job.
- Keep PostgreSQL Flexible Server, Blob Storage, and Key Vault private with
  private DNS/endpoints. Web and worker use separate managed identities for
  Blob access and PostgreSQL Entra tokens. A secure bootstrap PostgreSQL
  password is needed only to provision the server; password authentication is
  disabled in the resulting server configuration.
- Use Log Analytics for searchable App Service, Container Apps, PostgreSQL,
  and Front Door telemetry. Azure Monitor alerts notify the operations email
  for web 5xx responses and sustained PostgreSQL CPU. The app itself does not
  emit Application Insights SDK traces.
- The Entra app registration, Key Vault secret seed, Front Door private-link
  approval, PostgreSQL principal/grants, ACR image push, and migration-job run
  are documented manual deployment steps. No Azure deployment was performed.
- `bicep build infra/main.bicep` and `bicep lint infra/main.bicep` passed with
  the standalone Bicep CLI 0.47.16. This validates template compilation and
  linting, but does not validate Azure quota, regional service availability,
  authorization, or deployment-time resource behavior.

## Continuous integration

- Run CI for every push and pull request on Node.js 22. It installs from the
  lockfile, typechecks, runs the unit suite, builds both production Docker
  targets without publishing them, and compiles/lints `infra/main.bicep`.
- CI uses no Azure credentials, does not deploy infrastructure, and does not
  push images. Local equivalents are `npm ci`, `npm run typecheck`, `npm test`,
  `docker compose -f docker-compose.prod.yml build web worker`, and the Bicep
  build/lint commands.
- `npm run typecheck`, `npm test` (11 tests), Bicep build, and Bicep lint all
  passed after the CI workflow was added. Both production image targets had
  already built successfully in the Docker stage; the CI workflow does the
  equivalent image builds on every push and pull request.

## Assessment handoff

- README now records local and Compose startup, application and Azure design
  trade-offs, known manual setup, deferred production validation, next steps,
  and where AI assistance was used versus human direction and review.
- The final documentation review does not run or deploy services. The Compose
  Azurite integration smoke and Azure what-if/deployment remain unverified.
- Added `docs/IMPLEMENTATION_GUIDE.md` with the assessment-to-code map, sidebar
  URLs, local/Compose run steps, UI walkthrough, and verification commands.
- Corrected the Overview's starter placeholder copy and made each import result
  state whether its original CSV was saved to configured object storage.
- During this guide update, `/api/health` returned `ok: true` and
  `database: connected`; typecheck and all eleven unit tests passed again.

## Local Docker setup

- Keep `docker-compose.yml` as the lightweight local-development Postgres
  service. It publishes host port 5433 for the existing Node.js app/worker
  workflow and was left unchanged.
- Update `docker-compose.prod.yml` to name the four runtime services
  `web`, `worker`, `db`, and `azurite`, plus the one-shot `migrate`
  service. Keep the existing Dockerfile targets, file-backed secrets, named
  data volumes, health checks, and dependency ordering.
- Only the web service publishes a host port in the full-stack file. The
  worker, database, migration service, and Azurite use the private network;
  worker and web receive the internal Azurite endpoint through the secret file.
- `docker compose -f docker-compose.prod.yml config --quiet` passed and
  `docker compose -f docker-compose.prod.yml build web worker` built both
  images. No containers were started. Docker-to-Docker DNS, database migration
  startup, and Azurite API connectivity therefore remain to be smoke-tested
  with an approved Compose run.
- The production Compose configuration lists exactly `db`, `migrate`,
  `azurite`, `web`, and `worker`; the extra service is the required
  one-time migration job.
- Align each in-container `*_FILE` path with the matching secret target name
  including its `.txt` suffix. The host source remains the existing ignored
  `secrets/*.txt` file.
- The three local secret files exist but each has a reported size of one byte;
  access controls prevented reading their contents. Re-enter/verify the local
  values using the README instructions before startup. Secret values were not
  printed or changed, and database volumes were not modified.
- Re-ran `docker compose -f docker-compose.prod.yml config --quiet`: passed.
  No containers were started, so this does not establish that PostgreSQL can
  initialize with the current secret file or that migrations complete.
