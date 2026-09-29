# Ledgerline take-home

Thanks for taking the time to do this. You'll build a small version of **Ledgerline**: importing legal matter instructions from a CSV, reviewing each one, designing a letter workflow on a canvas, running it, and **designing how it would run in production on Azure**.

**We're hiring for strong Azure infrastructure skills as well as application development**, so Part 4 carries as much weight as the app itself. Everything in it can be done for free, and you won't need an Azure subscription.

**Time:** you have up to **3 days** from when you receive this to send it back. There's deliberately more here than most people will polish in that time, so prioritise: a working end-to-end flow beats three perfect screens. When you stop, tell us what you'd do next.

**AI tools:** use whatever you normally would. We recommend **Claude Code with Opus 5.5**. If you already have a subscription, **Codex with GPT-6** is a good alternative. In your README, tell us where they helped and where you had to step in.

We'd suggest watching Matt Pocock's [complete AI coding workflow, end to end](https://www.youtube.com/watch?v=M6mYodf0dJM&t=37s) before you start. It's close to how we work: grill the idea, write a spec, break it into tickets, implement, then code review.

---

## Getting started

You need Node.js 20+ and Docker.

```bash
# 1. Create your own copy: click "Use this template" on GitHub, then clone it
npm install
npm run db:up          # starts Postgres on localhost:5433
cp .env.example .env.local
npm run db:migrate     # creates the application tables
npm run dev            # http://localhost:3000
# in another terminal, start the durable workflow worker
npm run worker
```

Check http://localhost:3000/api/health returns `{ "ok": true, "database": "connected" }`.

For a route-by-route UI tour, implementation map, local verification checklist,
and separate production-like Compose instructions, see
[docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md).

### What's in the starter

| Path | What it is |
|---|---|
| `data/matters.csv` | 50 legal matter instructions. **Some rows are bad, missing or ambiguous on purpose.** |
| `templates/*.md` | Three letter templates with `{{placeholders}}` |
| `src/lib/letter-provider.ts` | A stubbed letter provider. `sendLetter()` validates, waits, logs and returns a fake id. **Don't modify it.** |
| `src/lib/templates.ts` | Loads the templates and lists their placeholders |
| `src/lib/db.ts` | A Postgres connection pool. Use it, or bring your own ORM / query builder. |
| `infra/main.bicep` | Bicep for the private Azure production design (Part 4) |
| `ARCHITECTURE.md` | Azure service choices, architecture diagram, security and operations notes (Part 4) |
| `docker-compose.yml` | Postgres for local development only. Your production-like compose file is separate (Part 4). |
| `src/app/*` | App routes for CSV import, human review, approved matters, workflow design, durable runs, and staff tasks. |
| `src/lib/nav.ts` | The sidebar routes. Add, rename or remove routes here. |
| `src/components/ui/*` | [shadcn/ui](https://ui.shadcn.com) components. Add more with `npx shadcn@latest add <name>`. |
| `migrations/` | Numbered Postgres schema migrations, applied with `npm run db:migrate`. |

The stack is Next.js, React, TypeScript, Tailwind, [shadcn/ui](https://ui.shadcn.com), Postgres and [React Flow](https://reactflow.dev) (`@xyflow/react`). The app pages implement the import, review, matters, workflow, run and staff-task flows. The initial schema is in `migrations/001_initial_schema.sql`.

Useful scripts: `npm run typecheck`, `npm test`, `npm run worker`, `npm run smoke:workflow` (with the app and worker running), `npm run db:migrate`, `npm run db:psql` (a psql shell), and `npm run db:reset` (deletes all data and starts Postgres with an empty database; run migrations afterward).

The workflow worker claims due runs from Postgres, persists each step transition,
and recovers expired worker leases after a restart. A Wait stores its resume time
in `workflow_runs.scheduled_for`; staff tasks resume only the matter run that
created them. Letter sends are recorded before calling the provider. If a
provider accepted a letter but the worker could not save the response, the
delivery remains pending and the run is stopped for manual reconciliation to
avoid a possible duplicate send.

### Production-like Docker Compose

The production-like stack builds the optimized Next.js app and a separate worker,
runs migrations before either starts, and keeps Postgres and Azurite on an
internal-only network. Create local-only secret files first; `secrets/` is
ignored by Git and must never be committed:

```powershell
New-Item -ItemType Directory -Force secrets
# Generate a local password only for a new or confirmed-uninitialized volume.
# For an initialized volume, preserve and use its original database password.
$randomBytes = [byte[]]::new(48)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($randomBytes)
  $postgresPassword = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
} finally { $rng.Dispose() }
$databaseUrl = "postgres://ledgerline:$postgresPassword@db:5432/ledgerline"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText('secrets/postgres_password.txt', $postgresPassword, $utf8NoBom)
[System.IO.File]::WriteAllText('secrets/database_url.txt', $databaseUrl, $utf8NoBom)
Set-Content -Path secrets/azurite_connection_string.txt -Value 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;' -NoNewline

# Confirm the local secret files are present and non-empty without printing them.
$secretFiles = @(
  'secrets/postgres_password.txt',
  'secrets/database_url.txt',
  'secrets/azurite_connection_string.txt'
)
foreach ($secretFile in $secretFiles) {
  if (-not (Test-Path -LiteralPath $secretFile) -or
      [string]::IsNullOrWhiteSpace((Get-Content -Raw -LiteralPath $secretFile))) {
    throw "Required secret file is missing or empty: $secretFile"
  }
}

docker compose -f docker-compose.prod.yml up --build
```

The password above is a local development example; replace it before using the
stack beyond a disposable machine. The Azurite key is Microsoft's published
emulator-only development key, not an Azure credential. In Azure, the app uses
its managed identity and the storage account endpoint instead. The stack serves
the web app at `http://localhost:3000`; stop it with
`docker compose -f docker-compose.prod.yml down`. Add `-v` only when you intend
to delete local database and uploaded-file data.
If the PostgreSQL volume was initialized previously, keep the password file
consistent with the password already stored in that database. The Compose
configuration preserves the existing named volumes.

### Implementation notes and handoff

#### Key decisions and trade-offs

- Every CSV row enters review. Safe whitespace/date cleanup is retained beside
  the original row; ambiguous or malformed values are flagged for a person.
  File hashes prevent accidental duplicate imports, and only approved rows
  become matters.
- PostgreSQL stores workflow state, wait schedules, staff tasks, and delivery
  records. A separate worker uses leases so runs continue after a restart. If a
  letter provider outcome is uncertain, the run pauses for reconciliation
  instead of risking a duplicate send.
- The supported workflow shape is a validated single path. It provides the
  requested Start, End, Send letter, Wait, and Staff task behavior without
  introducing branching semantics the runner cannot safely execute.
- Docker Compose uses Azurite and file-mounted secrets. Azure uses private
  PostgreSQL/Blob/Key Vault networking, separate managed identities, Entra
  sign-in, Front Door Premium/WAF, and separate web/worker compute. The Azure
  template is compiled and linted, but not deployed.
- The local prototype has no user authentication; the Azure App Service
  configuration enforces Entra sign-in before access. Azure setup has a few
  documented manual steps for the app registration and secret, Front Door
  private-link approval, database grants, image push, and first migration run.

#### What I would do next

- Run the production-like Compose stack and verify uploads against Azurite,
  migration startup ordering, health checks, and restart recovery end to end.
- Add a production identity-to-staff authorization model, then add operational
  alerts for worker failures and the age of the oldest due workflow run.
- Validate the Bicep with `what-if` in a disposable Azure subscription, check
  regional SKU/quota availability, and exercise the documented manual setup.
- Add a real letter-provider integration with idempotency support and a
  reconciliation screen for deliveries left pending after uncertain outcomes.

#### AI assistance

Codex helped inspect the starter and assessment, break the work into reviewable
stages, implement application and infrastructure changes, and run focused
checks. I stepped in to set the order and approval boundaries, choose the
service architecture and failure behavior, review each stage's diff and test
results, and keep Azure deployment and production Compose startup out of scope.

---

## Part 1: Import legal matters (required)

A client firm sends us a CSV of matters to act on. Each row is one person who owes money.

1. **Upload** a CSV file.
2. **Map columns.** Show the CSV's columns and let the user map each one to a field in your schema. Pre-fill obvious matches, but let the user change them.
3. **Validate.** Decide what makes a matter valid. Tidy up anything you can fix safely and automatically, and flag anything you can't.
4. **Review queue.** A legal executive has to approve **every** matter before it goes any further, not just the flagged ones. Show every row, with what was tidied automatically and why anything was flagged. The reviewer clicks **Approve** or **Reject** on each one.
5. **Finish the import.**
   - Only approved matters are saved to the database as matters.
   - Rejected rows can be **downloaded as a CSV**, with a column explaining why each was rejected.

Think about what a real operations person would need: what should never be auto-fixed, what they'd want to see to decide quickly, how to get through a clean file fast without flagged rows getting lost in it, and what happens if the same file is uploaded twice.

## Part 2: Letter workflow canvas (required)

Build a canvas for designing a workflow that runs against imported matters. We recommend **[React Flow](https://reactflow.dev)** (`@xyflow/react`, already installed). These examples cover most of what you need:

- [Drag and drop from a sidebar](https://reactflow.dev/examples/interaction/drag-and-drop)
- [Custom nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [Save and restore](https://reactflow.dev/examples/interaction/save-and-restore)

Here's roughly what we have in mind. Treat it as a guide, not a spec. Change the layout, and improve it if you have better ideas:

![Workflow canvas mockup](docs/canvas-mockup.png)

1. A **"Add a step" library** on the right. Steps can be dragged from it onto the canvas:
   - **Send letter**: posts a letter using a template
   - **Wait**: pauses for a set number of minutes
   - **Staff task**: creates a to-do for a member of staff, e.g. "Call the debtor"
2. Every workflow has a **Start** node and an **End** node. Connect the nodes with edges to make a flow, e.g. Start → Send letter → Wait → Send letter → End.
3. Clicking a **Send letter** node lets the user **pick a template**, **edit its text**, and **preview** it with a real matter's data filled in.
4. **Validate** the workflow before it can run, e.g. exactly one Start and one End, every step connected, no dead ends. Show what needs fixing.
5. **Save** a workflow and **load it back**.

## Part 3: Run the workflow (required)

1. Run a saved workflow against the matters approved in Part 1.
2. Each matter moves through the steps independently:
   - **Send letter** renders the template for that matter and calls `sendLetter()`
   - **Wait** pauses that matter for the configured minutes
   - **Staff task** creates a task that staff can see and tick off
3. Show the **progress of each matter**: which step it's on, what's been sent (with the provider id), and anything that failed. `sendLetter()` throws on bad input, such as a missing address, so handle that sensibly.
4. Runs should **survive a server restart**. If you stop `npm run dev` halfway through a Wait, the matters should carry on when it starts again.

## Stretch goals (optional)

Only if you have time: anything you think would make this more useful to the ops person using it.

---

## Part 4: Production on Azure (required)

This is where we test your **Azure infrastructure skills**. We want to see how you'd run Ledgerline in production: securely, privately and repeatably. You don't need to spend anything. Everything below runs locally or compiles offline.

### 4a. A production-like Docker setup

Add a `Dockerfile` and a `docker-compose.prod.yml` that run the app the way it would run in Azure:

- **Separate containers** for `web` (the Next.js app), `worker` (the workflow runner from Part 3), `db` (Postgres), and `azurite` ([Microsoft's Azure Storage emulator](https://learn.microsoft.com/azure/storage/common/storage-use-azurite), used for uploaded and rejected CSVs), with a one-time migration service.
- Run the **production build**, not `npm run dev`.
- **Two networks**, mirroring subnets: a public-facing one and a private one. The database and storage must **not** be reachable from the public side.
- **Secrets come from files** (Docker secrets or mounted files), never hard-coded or committed. Add `secrets/` examples to your README, not to git.
- `docker compose -f docker-compose.prod.yml up` should bring everything up from a clean clone, with migrations running automatically.

### 4b. Azure infrastructure as code

In `infra/`, write **Bicep** for the full production setup. We're deliberately not giving you a list of services: choosing them is part of the task. Whatever you pick, the setup must meet these requirements:

- **The database and storage are private.** Nothing outside your network can reach them, not even with the right credentials.
- **No secrets in code or app settings.** The apps get what they need using their own identity, and secrets can be rotated without a redeploy.
- **Staff sign in** with their work accounts before they can use the app.
- **The public app is protected** against common web attacks and abusive traffic.
- **`web` and `worker` run and scale separately.**
- **Logs and metrics end up somewhere you can search and alert on.**

In `ARCHITECTURE.md`, say which services you chose for each requirement and why. If a piece can't be done in Bicep, document the manual steps instead.

Check it compiles and passes the linter. This is free and needs no subscription:

```bash
az bicep build --file infra/main.bicep
```

We may run `what-if` against our own subscription. You don't need to deploy anything.

### 4c. CI with GitHub Actions

Add a workflow in `.github/workflows/` that runs on every push and:

- installs dependencies, typechecks and runs your tests
- builds the Docker image(s)
- compiles and lints the Bicep

It should pass on your repo. GitHub Actions is free for public repositories.

### 4d. Architecture write-up

Fill in `ARCHITECTURE.md`: a diagram plus a few short paragraphs. Specific beats long.

- Why the database is private-only, and how the app reaches it
- How secrets reach the app, and how you'd rotate them
- How a **Wait** survives a deploy or restart
- How you'd run database migrations without downtime
- What you'd monitor, and what should wake someone up at 3am

**Optional bonus:** if you have Azure credit (for example [Azure for Students](https://azure.microsoft.com/free/students), no card needed), you're welcome to actually deploy it and send us the URL. This is entirely optional, and **nobody is marked down for not deploying**.

---

## Submitting

Reply to the person who sent you this with:

1. **A link to your GitHub repo** (public, or private and shared with us).
2. **A README section** covering:
   - how to run it (both `npm run dev` and `docker-compose.prod.yml`) and any setup steps we need
   - your key decisions and trade-offs
   - what you'd do with more time
   - where AI tools helped and where you had to step in

## What we look at

- **Judgement with messy data**: what you fix, what you flag, and why.
- **Schema and code**: readable, typed and sensibly structured, not over-engineered.
- **It works**: we can run it from your README, and import → review → design → run works end to end.
- **The runner**: matters progress independently, failures are visible, and runs survive a restart.
- **UX**: mapping and review are clear, and the canvas is pleasant to use.
- **Azure infrastructure**: a secure, private-by-default design; Bicep that compiles; sensible networking, identity and secrets; CI that actually runs.
- **Communication**: your README makes the trade-offs clear.

Everything in this repo is fictional. No real people, firms or addresses.
