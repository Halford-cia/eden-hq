# Stage 1 · what is built, how it is tested, and where it departs from the spec

Stage 1 of [the spec](SPEC.md): Google sign-in, the two workspaces, roles and membership from the roster, projects and tasks, List and Board, the operational CSV, the access gate and the initial backup/restore procedure. Hank's setup is in [SETUP.md](SETUP.md).

## What is in the repository

| Area | Files |
| --- | --- |
| Database (forward-only migrations) | `supabase/migrations/20261127000100_stage1_foundation.sql` (schemas, roles, tables, RLS, membership helper, access gate, owner-only money guard), `…000200_stage1_api.sql` (the `eden_api` operations) |
| Browser app (Vite, no framework) | `index.html`, `src/` (`api.js` is the only data path; `views/` hold the screens) |
| Operator scripts | `scripts/roster.mjs` (`roster:pending`, `roster:apply`, `roster:show`), `scripts/access.mjs` (`access:open`, `access:close`), `scripts/restore-apply.mjs`, `scripts/restore-verify.mjs` |
| Public-repository and build guards | `scripts/check-public.mjs`, `scripts/build-guard.mjs` (runs first in `npm run build`), `scripts/check-dist.mjs`, `.githooks/pre-push` |
| Hosted backup (Cloud Run jobs) | `backup/worker.mjs`, `backup/watch.mjs`, `backup/lib.mjs`, `backup/Dockerfile`, `backup/cloudbuild.yaml` |
| Tests | `tests/db/` (each role against the migrations), `tests/web/` (the screens against the same database), `tests/scripts/` (roster, gate, guards, build, backup logic) |

## Tests

`npm test` needs no Docker and no network. The database tests run the real migrations on PostgreSQL 17 (PGlite) inside a model of a hosted Supabase project: the `anon`, `authenticated` and `service_role` roles, a **non-superuser** `postgres` that applies the migrations, `auth.users`/`auth.identities`, a `storage.objects` stub and the `supabase_realtime` publication. Every request runs as role `authenticated` (or `anon`) with JWT claims in `request.jwt.claims`, the way the Data API runs it. The front-end tests drive the real screens and `src/api.js` against that same database.

| Stage 1 acceptance item | Where it is proven |
| --- | --- |
| Owners see both workspaces, the manager only Stay Eden, a new identity the no-access screen, anon gets no rows | `tests/db/access.test.mjs` (entry), `tests/web/app.test.mjs` (entry) |
| Manager requests a Home project and tries a Home task: both fail without disclosure; supplied workspace or role claims grant nothing; revocation applies on the next request with the same token | `tests/db/access.test.mjs` |
| Assign to a member, an outside vendor and nobody; cross-workspace assignee and end-before-start rejected; board move shows after refresh; two concurrent edits keep the winner and explain the conflict | `tests/db/tasks.test.mjs`, `tests/web/app.test.mjs` |
| Phone and desktop: create, open, edit, move with touch or keyboard (no dragging); CSV with commas, quotes, newlines and formula-like text; empty project | `tests/web/app.test.mjs`, `tests/web/units.test.mjs`. Layout at 375 px is CSS (`src/styles.css`); the screen tests check the phone structure (one board column, full-screen detail, labelled controls) but cannot measure pixels |
| Empty-project rehearsal: migrations from scratch, inventory passes, six synthetic identities, read-back, rerun no change, removal revokes, downgrade, roster with no Home owner refused | `tests/db/inventory.test.mjs`, `tests/scripts/roster.test.mjs` |
| Paged reads: 50 and 300 tasks, one request per page, assignees in the row | `tests/db/tasks.test.mjs` (database), `tests/web/app.test.mjs` (request count from the screen) |
| Realtime: no Eden table in the publication | `tests/db/inventory.test.mjs`; the live subscription check is Hank's (SETUP.md §3, §6) |
| Public repository and build: secret-shaped key refused with no `dist/`; planted markers absent from assets; deny-listed value, roster-shaped file and unmarked fixture refused; no report shows a matched value | `tests/scripts/public.test.mjs`, `tests/scripts/build.test.mjs` |
| Owner-only money enforced in the database (built now, used in Stage 2) | `tests/db/money-guard.test.mjs` |
| Scheduled backup, restore drill with the roster | Hank's hosted runs (SETUP.md §10–11). Locally: `tests/scripts/restore.test.mjs` runs the worker's dump commands and the real `restore:apply` and `restore:verify` with native `psql`/`pg_dump`/`pg_restore` 17+ against local PGlite over 127.0.0.1, both sides as the non-superuser migration role, into a new project that starts with pg_graphql and no ledger; `tests/scripts/backup.test.mjs` covers the manifest, the set-file and access checks, superseded-gate closing and the watch verdict; `tests/scripts/setup-doc.test.mjs` holds SETUP.md's order |

Two mutation checks were run while building: weakening the owner check in `eden_private.is_member` fails six database tests; breaking the conflict mapping or the page size in the front end fails three screen tests.

## Stage 1 code review fixes

Each item has tests that failed before its fix.

| Review item | Fix | Tests |
| --- | --- | --- |
| P0-1 open tab keeps the previous account's screen | Auth events compared with the rendered account; screen and caches cleared at once; late answers for the old account dropped | `tests/web/app.test.mjs` ("account change on an open tab") |
| P0-2 RPC return columns unchecked | Inventory pins every operation's result fields; every operation called as owner and member with seeded money, keys checked at every depth | `tests/db/inventory.test.mjs`, `tests/db/money-guard.test.mjs` ("every published operation"). Mutations: a null `estimated_cents` on `get_project` fails 4; an estimate in the export's JSON fails 2 |
| P0-3 GraphQL test started without GraphQL | The fixture starts like a hosted project, with a pg_graphql stand-in | `tests/db/inventory.test.mjs`. Omitting the drop fails 2 |
| P0-4 private term printed from a file name | Paths holding a deny-listed term are withheld in every finding | `tests/scripts/public.test.mjs` |
| P1-1, P1-2 restore and verification | `restore:apply`; set files, RLS, helper owner and grants verified | `tests/scripts/restore.test.mjs`, `tests/scripts/backup.test.mjs` |
| P1-3, P1-4 setup order and the drill | SETUP.md rewritten: synthetic stage, drill, then real users | `tests/scripts/setup-doc.test.mjs` |
| P1-5 to P1-9 screens | Thread refresh in place; failed-move message kept; one record per tap; phone board fetches one column; owner Edit/Archive project | `tests/web/views.test.mjs`, `tests/db/access.test.mjs` |
| P1-10, P1-11 public guard range and unreadable files | Event SHAs in CI, outgoing refs in the hook; NUL-delimited entries; an uninspectable entry fails | `tests/scripts/public.test.mjs` |
| P1-12 failed sign-out | Local sign-out fallback; no data shown from a surviving session | `tests/web/app.test.mjs` ("sign-out when the server cannot be reached") |

The P2 note (assignee picker capped at 100 rows) is not fixed in this round.

## Open review items carried as tests

The spec's round-3 review left two blockers open. They are stage tests where they apply:

- **P0-1 (receipt bytes after an owner downgrade, CDN cache)** is Stage 2. Three pending tests (`it.todo`) in `tests/db/money-guard.test.mjs` name the cases the Stage 2 receipt path must pass.
- **P0-2 (positive isolation of a former project)** applies to Stage 1's `access:open`. It now refuses to open a gate unless every other register entry that is not `deleted` **reads back closed**; an unreachable project, or one marked `keys removed` that cannot be read, blocks the opening. Test: `tests/scripts/access.test.mjs` ("P0-2"). This is stricter than the spec text, which accepted deleted keys. **Hank to confirm**; reverting to the spec's fallback is a small change in `scripts/lib/access-core.mjs`.

## Departures from the spec, and why

1. **Caller identity.** The membership helper reads the caller from the verified JWT claims (`request.jwt.claims`, the value `auth.uid()` returns) instead of calling `auth.uid()`, so its owner role needs no access to Supabase's `auth` schema (review round 3, P1-1). Its grants are exactly: USAGE on `eden` and `eden_private`; SELECT on `workspace_members (workspace_id, user_id, role, revoked_at)` and `access_gate (id, is_open)`, each through a `USING (true)` policy for the role.
2. **One definer function in Stage 1.** Only `eden_private.is_member` exists. The receipt verifier and the audit trigger arrive with their Stage 2 migration and are added to the reviewed inventory then (review P1-5).
3. **The money guard exists before budgets.** `eden.task_budgets` is created now with RLS, an owner-only SELECT policy and no write privilege for any app role. No Stage 1 operation reads or returns it. Stage 2 adds the audited write path.
4. **Stage 1 already carries task updates and the Stay Eden item kinds** (request, maintenance, note, follow-up, with a follow-up date), because the operational CSV includes updates and a property can hold an item. The manager's filters and thread polish remain Stage 4.
5. **No Waiting fields yet.** `list_tasks` returns no dependency fields until Stage 3; the CSV keeps a `predecessor_ids` column, blank in Stage 1, so its column order is stable.
6. **The operational export downloads two files** (`<project>-tasks.csv`, `<project>-updates.csv`), built in the browser from one database snapshot (`export_project`, a single statement).
7. **Inventory scope.** The local inventory covers the Eden schemas and `public`. Supabase-owned schemas exist only on the hosted project; SETUP.md §6 checks the hosted exposure (anon, `Accept-Profile: eden`, GraphQL).
8. **Verified TLS.** The operator scripts refuse a remote connection string without `sslmode=verify-full` and the Supabase CA certificate. The backup worker receives the (public) certificate as `EDEN_DB_CA_PEM` and verifies every connection.
9. **Backup sets record their migrations and table list**, and `restore:verify` fails on a mismatch, so a Stage 2 restore missing a financial migration fails (review P1-5). Stage 1 sets hold no receipts. The image is built with Cloud Build (review P1-6), and the heartbeat has its own log-based metric for the absence alert (review P1-7).
10. **CI workflow location.** The agent's GitHub token has no workflow scope, so the workflow is at `docs/ci/github-actions-ci.yml` for Hank to move (SETUP.md §7). It reviews the event's base..head and installs the PostgreSQL 17 client tools.
11. **Dump rows as column-named INSERTs** (`--column-inserts`), in the worker and the local test alike: robust to column-order differences between Supabase versions, small at Eden's size, and restorable by PGlite, which cannot take `COPY FROM STDIN` over the wire.
12. **Restore without owners, then hand the helper over.** `restore:apply` restores the Eden dump with `--no-owner` and repeats the migration's ownership transfer of `eden_private.is_member`, because a non-superuser cannot restore that owner directly (the new owner needs CREATE on the schema during the ALTER). The ledger is dumped with its table definition.
13. **Synthetic stage before real users.** SETUP.md enrolls six test Google accounts first, runs the drill on that data, and enrolls the real people only after it passes (review P1-3).

## Not verified here

Nothing hosted was created or run: no Supabase project, Netlify site, Google client or Cloud Run job. The dump and restore commands ran locally against PGlite (PostgreSQL 17) with libpq 18 client tools; on hosted Supabase they run for the first time in Hank's drill. In particular, writing `auth` rows as Supabase's `postgres` role is modelled locally by a grant, not verified. `age` and the Cloud Storage uploads are unverified. The 375 px layout was not rendered in a real browser; the phone tests set a 375 px viewport in happy-dom and check structure and request counts, not pixels.
