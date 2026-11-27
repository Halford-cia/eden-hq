# Eden HQ v1

Hank and his dad can open their first home build on a phone, see who is doing each job and what it waits on, and compare the estimate with the bill. In a separate workspace, the Stay Eden cleaning manager can open a property, see what needs attention, and tell the family what happened. Eden HQ serves about ten internal users.

| Workspace | Initial access | What people do |
| --- | --- | --- |
| Home building | Hank, his dad, Victoria and his sister, each an owner | Enter the rough build plan by hand as the first project. Track tasks, trades, dates, dependencies, budgets and receipts. |
| Stay Eden operations | The four owners and the cleaning manager | Pass requests, maintenance items, notes and follow-ups to the manager by property. The manager updates the work and records the outcome. |

Google is the only sign-in method. Hank grants additional internal users membership per workspace. Vendors and subcontractors can be named on work without accounts. V1 starts fresh. Cleaner checklists stay in Guesty. Guesty integration, QuickBooks, imports and notifications are outside v1.

## Screens and everyday use

**Entry.** Sign in with Google. One active membership opens that workspace directly. Several memberships open a workspace picker. An unassigned account sees “Ask Hank for workspace access” and a sign-out action. The workspace name is the switcher on every project screen. Recheck access on deep links and refresh. Missing and inaccessible projects show the same unavailable screen.

**Home project.** Hank creates a project, adds tasks from his plan, and chooses a workspace member, a recorded person or company, or “Unassigned.” He can create an outside name in the picker. List, Board and Timeline edit the same task. On desktop, show detail beside the current view. On a phone, open details as a full screen with a back action that preserves filters and scroll position.

```text
Home building ▾                   [Projects]
First build                       [+ Task]
[List]  [Board]  [Timeline]       [Export]
Assignee ▾  Status ▾
Frame walls          Ready       Jun 8–12
  Framing crew
Rough plumbing       Waiting     Jun 15–17
  Dad · waits on Frame walls

Board        [Ready 2 ▾]         [Next column]
  Frame walls        Framing crew     [Open]

Timeline        Week of Jun 8      [‹] [›]
                 08 09 10 11 12 | 15 16 17
Frame walls      ██ ██ ██ ██ ██ |
Rough plumbing                  | ██ ██ ██
Unscheduled (1)                  [Show]
```

**Task detail.** Tap a card or bar, edit the task, then save. Status changes work without dragging. The dependency picker shows tasks in this project. Waiting lists the unfinished predecessors. Failed saves preserve input. A stale edit offers reload and reapply. Empty projects offer “Add first task.” Stage 2 adds a Budget action for build project owners.

```text
‹ First build          Rough plumbing
Assignee   [Dad ▾]     Status [Ready ▾]
Start [Jun 15]         Due    [Jun 17]
Waits on   Frame walls          [Edit]
Description [...]               [Save]

Budget                          [History]
Estimate [$1,200.00]   Actual [$1,350.00]
Category [Plumbing]    Vendor [Example Co.]
Payment  [Unpaid ▾]    [+ Receipt photo]
Variance +$150.00 over          [Save budget]
```

The project Budget screen shows estimate, actual, variance and missing-value counts for the whole project and for each category. Tap a category for its tasks. History lists the actor, time, field and old and new values. Tap a receipt to view the private photo. Camera capture and file selection both return to this task.

**Stay Eden handoff.** Each property is a project in this workspace. An owner records an item and assigns it to the manager. The manager opens “Assigned to me,” adds an update, records a follow-up date, or marks the item Done. Owners see the same thread when they next open the property. A property note can stand alone as a Note item. Operational text is shared with the workspace. Enter costs and payment details only in Budget.

```text
Stay Eden operations ▾           [Properties]
Example Cottage                  [+ Item]
[Open] [Due for follow-up] [Assigned to me]
Maintenance · Leaking tap        In progress
  Cleaning manager · Follow up Fri
Note · Spare key location        [Open]

‹ Example Cottage                Leaking tap
Updates   “Plumber booked for Thursday.”
[Add update…]     Follow up [Fri]    [Save]
Status [In progress ▾]           [Mark done]
```

Use a single column at phone width, labeled touch controls, visible focus and text labels for status and variance. Keep horizontal scrolling inside the timeline. On desktop, show board columns side by side and filters beside the property list.

## Postgres data model

Supabase Auth owns Google identities in `auth.users`. Eden references the stable user UUID. Below, IDs and foreign keys are UUIDs unless specified, dates are calendar dates, timestamps are `timestamptz`, labels are text, and versions increase on each change. Each entity has an `id` primary key unless another key is given. A question mark marks a nullable column. Keep app tables in the unexposed schema `eden` and private helpers in `eden_private`. The only schema the Data API exposes is `eden_api`.

| Table | Columns | Meaning and constraints |
| --- | --- | --- |
| `workspaces` | `id, kind, name, time_zone` | Use an IANA time zone for calendar-day filters. Seed exactly one `home_building` and one `stay_eden_ops`. Unique, immutable kind. |
| `workspace_members` | `workspace_id, user_id, display_name, role, granted_at, revoked_at?` | Primary key `(workspace_id, user_id)`. User references Auth. Roles are `owner` and `member`. A null revocation time means active. Keep past assignments and names. |
| `outside_contacts` | `id, workspace_id, display_name, kind, linked_user_id?, archived_at?` | A recorded person or vendor. Scope names to the workspace. Reserve the optional member link for later and keep it empty in v1. A contact grants no access. |
| `projects` | `id, workspace_id, name, description?, created_by, created_at, archived_at?, version` | A build in Home building or one property in Stay Eden. Workspace is immutable. |
| `tasks` | `id, workspace_id, project_id, kind, title, description?, assignee_user_id?, assignee_contact_id?, start_on?, due_on?, follow_up_on?, status, created_by, created_at, updated_at, archived_at?, version` | Home uses `task`. Operations uses `request`, `maintenance`, `note` or `follow_up`. Both assignee fields can be empty or exactly one set. New assignments require active members or unarchived contacts. |
| `task_updates` | `id, workspace_id, project_id, task_id, author_user_id, body, created_at` | Append-only operational notes. Display by time and author. |
| `task_dependencies` | `workspace_id, project_id, predecessor_id, successor_id, created_by, created_at` | Key `(predecessor_id, successor_id)`. A predecessor must finish before its successor starts. Both ends belong to the same home project. |
| `task_budgets` | `task_id, workspace_id, project_id, estimated_cents?, actual_cents?, vendor_name?, category?, payment_state, version, updated_at` | Primary key `task_id`. One optional owner-only budget per build task. Both amounts are nonnegative bigint USD cents. Payment is `paid` or `unpaid`, initially unpaid. |
| `receipts` | `id, workspace_id, project_id, task_id, object_key, mime_type, byte_count?, state, created_by, created_at, attached_at?, removed_at?, disposed_at?` | Unique immutable object key in the private bucket. States are `pending`, `attached` and `removed`. Reserve only for a budgeted task. A set `attached_at` means the receipt was attached at some point; it is never cleared. `disposed_at` is set only by the backup job once no object remains at the key. Retain metadata for removed receipts. |
| `money_audit` | `id, workspace_id, project_id, task_id, actor_user_id, actor_label, occurred_at, entity, entity_key, action, before?, after?` | One immutable event per changed financial row. Before/after are JSONB snapshots of budget fields or receipt metadata. Keep the actor ID and label as they were at edit time. |
| `access_gate` (in `eden_private`) | `id, is_open, changed_by, changed_at` | One row, `id = 1`. A migration creates it closed. Backups leave out its data, and a missing row counts as closed, so every restore starts closed. While it is closed the membership helper denies everyone, so no app read, write or receipt download succeeds. |

Use unique parent keys and composite foreign keys carrying workspace, project and task IDs wherever applicable. Both dependency ends must match the project. Member and contact references must match the workspace. Derive creator, author, timestamps and audit actor on the server. Freeze parent IDs after insert. Index membership by user/workspace and children by workspace/project, task, due date and dependency endpoint. Archive tasks, contacts and projects in place. Restrict destructive cascades.

Start must be on or before due when both are set. Either can be unknown. Status is Ready, In progress or Done. Waiting is derived from open dependencies. Reject self-links, duplicates and cycles of any length. Serialize graph and status writes on the project before validation. Reject starting or finishing a waiting successor. Reject reopening a predecessor or adding an unfinished prerequisite if that would invalidate a started or completed successor. Resolve or remove edges before archiving a linked task. Date edits never reschedule another task. Draw a bar for two dates, a labeled point for one, and an Unscheduled list for neither.

## Access at the database boundary

Enable Postgres row-level security (RLS) on **every Eden table**, including all private financial tables. The Data API exposes exactly one schema, `eden_api`, holding explicit operations only. Remove `public` and `graphql_public` from the exposed schemas, and have the migrations disable the GraphQL extension. Use caller-privilege (`SECURITY INVOKER`) operations with named return fields. There are exactly three exceptions, each a narrow `SECURITY DEFINER` function in `eden_private` with `search_path` set to `''` (every name schema-qualified), owned by its own non-login role that holds only the privileges listed for it:

| Definer function | Owner role | What the role holds, and nothing else |
| --- | --- | --- |
| `eden_private.is_member(workspace_id, need_owner)` | `eden_membership_reader` | USAGE on `eden` and `eden_private`. SELECT on `workspace_members (workspace_id, user_id, role, revoked_at)` and `eden_private.access_gate (id, is_open)`, each through a policy for this role with `USING (true)`. EXECUTE on `auth.uid()`. Callable by `authenticated` and `eden_receipt_verifier` only. |
| `eden_private.verify_receipt_upload(receipt_id)` | `eden_receipt_verifier` | Listed under Budgets and receipts. Callable by `authenticated` only, and reached only through `eden_api.finalize_receipt`. |
| `eden_private.audit_money_change()` (trigger) | `eden_audit_writer` | Listed under Money edits. |

The inventory test fails on any other definer function in any Eden schema. Grant the minimum underlying table and column privileges. Revoke default function execution from `PUBLIC` and `anon`, and grant published operations only to `authenticated`. Keep base tables, relationship expansion and generic row-to-JSON endpoints off the exposed API. Return role-checked financial responses only after authorization, and avoid account-wide role claims in tokens. No Eden table belongs to the `supabase_realtime` publication, and v1 uses no Realtime channels. [Supabase custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas) · [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

The predicates below look up the current `auth.uid()` in active `workspace_members` for the row’s workspace. **M** means active member or owner. **O** means active owner. Policies call `eden_private.is_member`, which reads membership through its own role’s nonrecursive policy. It returns only the caller’s yes/no decision, and denies everyone while the access gate is closed or missing. It accepts the workspace and reads the caller ID itself. The browser never holds table-owner or RLS-bypass privileges. Submitted roles and editable Google profile metadata cannot establish membership.

| Relation | SELECT policy | Create / change policy |
| --- | --- | --- |
| Workspaces | M for the row | Seeded and changed by migrations only. |
| Workspace members | M for that workspace, exposing names needed for assignments and history | Only the roster procedure below adds, revokes or changes roles, applying Hank’s private roster. App users cannot promote themselves. |
| Projects | M | O creates, edits and archives projects. |
| Outside contacts | M | O creates, edits and archives names. M can assign an existing contact. Linking a login requires a future migration. |
| Tasks | M | M creates and edits operational fields in active projects. O may archive or restore a task. |
| Task updates | M | M appends in an active project for an active task. The server sets the author. |
| Dependencies | M | M adds or removes same-project edges through the validated graph operation. |
| Task budgets | O | O creates, revises or clears a budget on an active build task. |
| Receipts | O | O reserves, attaches or removes through the receipt workflow. |
| Money audit | O | Only the trigger function `eden_private.audit_money_change`, running as `eden_audit_writer`, inserts, through an insert-only policy for that role. App roles have no insert, update, truncate or delete privilege, and no policy lets them write. |
| Storage objects in the receipts bucket | O for the matching attached receipt, and only when `storage.operation()` is `storage.object.get_authenticated`. List, sign (`storage.object.sign`, `sign_many`), signed-upload and public operations match no policy. The receipt verifier role alone reads object metadata, limited to this bucket. | O uploads once (`storage.object.upload`) at the exact path of a pending reservation the caller created. No update, move, copy or client delete. The hosted backup job disposes of objects. |

Reads and deletes check the existing row (`USING`). Inserts check the proposed row (`WITH CHECK`), and updates check both. Deny operations absent from the matrix. Use column privileges, constraints and triggers to enforce state transitions and immutable parentage. An unenrolled or signed-out caller receives no workspace data. Revocation, and a downgrade from owner to member, take effect on the next server request even with the same unexpired token.

**Published operations.** Screens read through paged `eden_api` operations that return each row ready to display. One request fills one page however many assignees or dependencies the page shows. Pages use keyset cursors and hold at most 100 rows.

| Operation | Returns |
| --- | --- |
| `list_tasks(project_id, filters, after, page_size)` | List and each Board column: operational fields, assignee display name and kind, Waiting flag, open-predecessor count and up to five predecessor titles, next cursor. |
| `list_timeline(project_id, from_on, to_on, after, page_size)` | Tasks overlapping the window with the same fields, plus the count of unscheduled tasks. |
| `get_task(task_id)`, `list_updates(task_id, after)` | Detail with predecessors, successors and the first page of updates, then later pages of updates. |
| `list_items(workspace_id, property_id?, view, after)` | Stay Eden Open, Due for follow-up and Assigned to me, with assignee and latest update. |
| Owner only: `budget_summary(project_id)` | One project row and one row per category, Uncategorized included: estimated and actual totals in cents, missing-estimate and missing-actual counts (tasks without a budget count as missing), comparable-task count and paired variance. |
| Owner only: `list_budget_tasks(project_id, category, after)`, `get_task_budget(task_id)`, `list_money_history(task_id, after)` | Category drill-down, one task’s budget and receipts, money history. |
| Owner only: budget and receipt writes, `finalize_receipt(receipt_id)` | Described under Budgets and receipts. |
| Exports | Described under CSV per project. |

The browser never sums amounts or counts tasks to make a total. It shows the `budget_summary` result, computed in one statement over every task in the project, and the CSV totals file comes from the same function in the same snapshot. `budget_summary` checks O and then returns `eden_private.budget_totals(project_id)`, a caller-privilege SQL function in the unexposed schema that holds the whole calculation. The backup job and the offline restore check call that same function over a direct database connection, so a manifest, a restored copy and the screen compute totals one way.

**Roster of record.** Memberships come only from Hank’s private roster: a CSV he keeps in his password manager, outside this repository, the database and the backup bucket. Each line holds a workspace kind (`home_building` or `stay_eden_ops`), a Supabase Auth user UUID, the person’s Google account subject (the stable `sub` Google issues, stored by Supabase as the Google identity’s provider ID), a role and a display name. The UUID is per Supabase project; the Google subject is the same in every project. Every access change edits the roster first, then applies it. The Stage 1 scripts:

- `npm run roster:pending` lists Auth accounts without an active membership (UUID, Google subject and verified address), so Hank can copy a new person’s UUID and subject after their first sign-in.
- `npm run roster:apply -- <private-roster-file> [--dry-run]` prompts for the database connection string, which it never echoes, stores or logs. It checks that every UUID is an Auth user whose Google identity has the listed subject. In one transaction it adds missing memberships, sets the listed roles and display names, clears revocation on listed rows and timestamps every active membership the roster leaves out. It refuses the whole roster, changing nothing, if any line names a UUID missing from Auth or a subject that does not match, leaves a workspace without an owner, or names an unknown workspace kind; the refusal lists each failing line by display name. A rerun with the same file changes nothing. `--dry-run` prints the changes and makes none.
- `npm run roster:show` prints the read-back: for each workspace, each active member’s display name and role, and the number of revoked rows. For v1 Hank expects four owners in Home building, the same four owners plus the manager as a member in Stay Eden, and nothing else.
- `npm run access:open -- <private-project-register>` and `npm run access:close` set the access gate. `access:open` enforces the one-serving-project rule (Backup and restore).

All four scripts need the database connection string, which only eligible recovery owners hold (Backup and restore). Output goes to the terminal only. No script writes UUIDs, subjects, addresses or names to a file or log.

List, board, timeline, task detail and notes return only operational fields, even to an owner. The separately entered budget vendor is private. Owner operations check O **before** building any financial result or CSV header. A failed check returns a generic unavailable/permission error without cost fields, receipt metadata, totals, audit values or payment information. Omit these values from logs, error text, client analytics, URLs, static assets and persistent browser caches. Clear loaded project data and receipt previews on workspace/account change or sign-out.

## Budgets, receipts and export

**Budget math.** Enter costs by hand to the cent. Blank means unknown. An entered zero counts as known. Suggest existing trimmed category labels case-insensitively and group blanks under Uncategorized. Sum known estimate and actual amounts independently, once per task, including archived tasks. Show missing-value counts including tasks with no budget. Task variance is actual minus estimate when both exist. For project and category variance, sum differences for tasks that have both amounts and label the number of comparable tasks. Show a dash when none are comparable. Positive means over estimate. Payment and receipt count do not change totals. Clearing a budget removes its amounts from totals and preserves its history. Resolve pending and remove attached receipts before clearing.

**Money edits.** Every create, edit, clear, attachment, removal and replacement uses an owner-authorized operation. Database triggers capture inserts, updates and deletes on both financial tables, including receipt state changes. In the same transaction record the actor, database time, scoped IDs and old/new values. Fail the write if the audit insert fails. Controlled maintenance, including the backup job’s receipt claims and disposals, uses an attributable operator or the dedicated system actor `eden-backup`. There is no FK from audit to a deletable budget.

The triggers on `task_budgets` and `receipts` (`AFTER INSERT OR UPDATE OR DELETE`, for each row) call `eden_private.audit_money_change()`, the third definer exception. It runs as the non-login role `eden_audit_writer`, with `search_path` set to `''`. That role holds USAGE on `eden` and `eden_private`; INSERT on every `money_audit` column, through a policy `FOR INSERT TO eden_audit_writer WITH CHECK (true)`; SELECT on `workspace_members (workspace_id, user_id, display_name)`, through a policy for this role with `USING (true)`, to record the actor label; and EXECUTE on `auth.uid()`. It holds no SELECT, UPDATE or DELETE on `money_audit`, and the function inserts without `RETURNING`. The function takes nothing from the caller beyond the trigger row. Because it runs inside the triggering statement, an audit failure aborts the budget or receipt change. An unchanged retry produces no duplicate event. Compare the expected budget or task version on update and reject stale writes. Allocate a fresh budget version on recreation so a stale save cannot match a replacement row. Replace a photo by uploading a new immutable object, then attaching it and removing the previous attachment in one database transaction.

**Private receipt lifecycle.** An owner saves a budget, taps Add receipt, and chooses or takes a photo. Normalize camera images to JPEG when needed. Accept JPEG or PNG up to 10 MiB after conversion. Enforce size/type limits in a private Supabase Storage bucket named `receipts`. Use the generated path `<workspace-id>/<project-id>/<task-id>/<receipt-id>`. [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)

1. Reserve a pending receipt for the task. An upload policy on `storage.objects` matches the bucket, complete reserved path, current active owner and reservation creator. Permit a new upload only, with overwrite and client deletion disabled.
2. Finalize with `eden_api.finalize_receipt(receipt_id)`. It checks O, then calls `eden_private.verify_receipt_upload(receipt_id)`. That function has `search_path` set to `''`, runs as `SECURITY DEFINER`, and is owned by the dedicated non-login role `eden_receipt_verifier`. PostgreSQL needs SELECT on every column a statement reads, filters or locks on, and `SELECT … FOR UPDATE` also needs UPDATE on at least one column, so the migration grants the role exactly:

   | Object | Column privileges | RLS policy for `eden_receipt_verifier` |
   | --- | --- | --- |
   | `eden.receipts` | SELECT `id, workspace_id, task_id, object_key, created_by, state, byte_count, attached_at`; UPDATE `state, byte_count, attached_at` | SELECT `USING (state IN ('pending', 'attached'))`. UPDATE `USING (state IN ('pending', 'attached')) WITH CHECK (state = 'attached')`, so the lock also finds an already-attached row on a retry. |
   | `eden.task_budgets` | SELECT `task_id, workspace_id` | SELECT `USING (true)`. |
   | `storage.objects` | SELECT `bucket_id, name, owner_id, metadata` | SELECT `USING (bucket_id = 'receipts')`. |
   | Schemas and functions | USAGE on `eden`, `eden_private` and `storage`. EXECUTE on `eden_private.is_member` and `auth.uid()`. | — |

   Nothing else: no INSERT or DELETE anywhere, no other column, no other bucket. The receipt audit row comes from the audit trigger, which runs as its own role. The verifier reads the caller from `auth.uid()` and accepts only the receipt ID. In one transaction it locks the reservation (`SELECT … FOR UPDATE` by ID) and confirms:
   - the caller is still an active owner of the receipt’s workspace and created the reservation;
   - the reservation is pending and its task has a budget;
   - an object exists in `receipts` at exactly the reserved key, uploaded by the caller;
   - Storage’s recorded size is 1 byte to 10 MiB and its recorded type is `image/jpeg` or `image/png`.

   It then records the size and marks the receipt attached, and the audit trigger records the change. A missing object or any mismatch leaves the receipt pending and returns a generic not-ready result. A retry on an attached receipt returns the attached result without a new audit event. Pending photos stay off the task and its export. Their bytes stay unreadable even to the uploader, because object SELECT requires an attached row.
3. Fetch bytes with the current owner’s JWT through Storage’s authenticated download. Limit object SELECT to that operation and an attached matching row. The app lists receipts from Postgres. Exclude public URLs, bearer share links and signing operations. Discard in-memory image URLs when the screen closes. [Supabase Storage operation policies](https://supabase.com/docs/guides/storage/schema/helper-functions)
4. Removal first marks the receipt removed and records the audit event, cutting off subsequent reads. The hosted backup job (Backup and restore) claims stale reservations older than 24 hours by atomically marking them removed. A claimed reservation may have bytes (an upload that was never finalized) or none (the owner closed the camera before uploading); both are ordinary cancellations, never a lost receipt, because neither was ever attached. After a complete set, the job disposes of removed receipts that have no `disposed_at`. A never-attached one is disposed of at once: the job deletes the object if one exists and sets `disposed_at` either way. An ever-attached one (`attached_at` set) is disposed of only once a complete set holds its bytes. Failed disposal retries on the next run. Retain audit metadata and protected backups according to retention.

**CSV per project.** Export starts from a project or property. The database checks membership for that project and produces one consistent snapshot including archived work. A member receives an operational tasks CSV with IDs, project/property, kind, title, description, assigned name, dates, status, follow-up, predecessor IDs and archive flag. Updates export as a companion CSV keyed by task ID. Owners can choose the operational export or **Full project export**. The full archive has keyed CSVs for project details, tasks, updates, dependencies, budgets with vendor/category/payment, totals and variance with coverage counts (from `budget_summary` in the same snapshot), receipt manifest and complete money history. Include attached photo files under relative names listed in the manifest. Fetch them through owner-authenticated downloads and report missing files before marking the export complete. “All projects” repeats the full export for every project in workspaces the caller owns, including archived projects.

Use stable column order, UTF-8, ISO dates, two-decimal dollar strings and CSV escaping for delimiters, quotes and newlines. Neutralize spreadsheet formulas in user-entered text during export. An accessible empty project yields header-only detail CSVs. A non-owner requesting a full export receives a denial without a file.

## Backup and restore

Hank owns recovery. Proposed targets are at most 24 hours of lost changes and recovery within one business day.

**Who can read a backup.** Every set holds both workspaces, including budgets, complete money history and receipt photos. Only a current owner of **every** workspace in the set may hold its decryption key, read its plaintext, use the credentials the backup job uses, or open a restored copy. These people are the **eligible owners**. Today they are the four family owners. Hank holds the key and may give a copy to one other eligible owner (Open questions). Anyone else Hank asks to watch backups is a **status monitor**: they see job runs, alert state and the status record, and nothing that holds data. The rule covers every place that can read data outside Postgres RLS:

- the Supabase organization, whose members can open every project’s database from the dashboard;
- the backup Google Cloud project, its backup bucket and its Secret Manager;
- the decryption key;
- every restore project.

When someone stops owning either workspace, remove their access to all of these in the same sitting as the roster change, and rotate the key and secrets if they held them.

**Hosted daily set.** One setup runs with Hank’s computer off, in a Google Cloud project Hank owns for Eden HQ (the project that holds the OAuth client will do). Every grant below is on the named resource only; no service account holds a project-wide role.

| Part | Setting |
| --- | --- |
| Scheduler | Cloud Scheduler job `eden-backup-daily`, cron `0 9 * * *` in time zone `Etc/UTC` (03:00 Chicago standard time, 04:00 daylight time), so consecutive scheduled runs are always 24 hours apart. Cloud Scheduler job `eden-backup-watch-hourly`, cron `15 * * * *` in `Etc/UTC`. Both call the Cloud Run Admin API `jobs.run` endpoint with an OAuth token for the service account `eden-backup-scheduler`. That account holds only Cloud Run Invoker (`roles/run.invoker`) on the job `eden-backup` and on the job `eden-backup-watch`, granted on each job, not on the project. [Cloud Run scheduling](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule) |
| Worker | Cloud Run job `eden-backup`, built from this repository’s `backup/` directory, running as its own service account `eden-backup`. |
| Destination | Cloud Storage bucket `eden-hq-backups-<suffix>`. Private, uniform bucket-level access, public access prevention enforced, 30-day retention policy, lifecycle deletion at 31 days. `eden-backup` holds only Storage Object Creator (`roles/storage.objectCreator`) on this bucket: it can create objects and cannot read, list, overwrite or delete them. Every object name contains the set’s timestamp, so the worker never needs to replace one. |
| Encryption | The worker encrypts every file with an `age` public key before upload. Only eligible owners hold the matching private key, in their password managers. Cloud Storage encryption is a second layer. |
| Credentials | Secret Manager in the same project: `eden-db-url` (connection string of the serving project’s database, for the claim, the dump and disposal bookkeeping), `eden-storage-key` (that project’s Supabase secret key, for receipt download and disposal) and `eden-superseded-db-urls` (connection strings of former serving projects not yet deleted; empty until a first cutover). The job names an explicit version number of each secret, never `latest`, so changing the project it backs up is a deliberate job update. `eden-backup` holds Secret Manager Secret Accessor (`roles/secretmanager.secretAccessor`) on these three secrets only. |
| Status | Each run writes `status/<timestamp>.json`, then replaces `status/latest.json`, in a separate bucket, `eden-hq-backup-status-<suffix>` (private, uniform access, public access prevention, no retention policy): start and finish times, recovery point of the last complete set, this run’s completion state, file count and encrypted byte counts. It never holds rows, totals, names, object keys or project refs. Replacing an existing object needs delete as well as create permission, so `eden-backup` holds Storage Object User (`roles/storage.objectUser`) on this bucket only. [Cloud Storage object permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions#object_permissions) |
| Watch | Cloud Run job `eden-backup-watch`, from the same directory, running as service account `eden-backup-watch`, which holds only Storage Object Viewer (`roles/storage.objectViewer`) on the status bucket. Each hourly run reads `status/latest.json` and writes one structured log line: `eden_backup_watch_ok`, or `eden_backup_stale` when the last complete set is older than `STALE_AFTER_HOURS` (26 by default) or the file is missing or unreadable. The line carries the age in hours and nothing else. |
| Alerts | Three Cloud Monitoring alert policies email Hank’s notification channel: (1) a log-based metric counting `eden_backup_stale` and `eden_superseded_was_open` lines, above zero; (2) Cloud Run’s completed-execution count for `eden-backup` or `eden-backup-watch` with result `failed` above zero; (3) no `eden_backup_watch_ok` line for 3 hours, which catches a stopped schedule or a broken watch. Hank checks the last complete set in `status/latest.json` or the job’s execution history. |

Each run works in this order:

1. For each connection string in `eden-superseded-db-urls`, connect. If the database answers and its gate is open, close it, read it back closed and log `eden_superseded_was_open`, which alerts Hank; if the gate was already closed, log `eden_superseded_closed`. An unreachable one logs `eden_superseded_unreachable`. None of these lines names the project. A gate that will not close fails the run.
2. Claim stale receipt reservations older than 24 hours by marking them removed (system actor `eden-backup`).
3. In one repeatable-read snapshot, dump roles, schema and data: grants, policies, Auth identities and stable IDs, memberships, project data, receipt metadata and audit history, leaving out the access gate’s data. In the same snapshot, record the per-table row counts, `eden_private.budget_totals` for every project, the audit row count, and the receipt inventory: every receipt row with its state, `attached_at` and `disposed_at`, joined to the `storage.objects` row at its key if one exists (size, type, owner).
4. From Stage 2, sort the inventory into the manifest:
   - **Required:** every receipt with `attached_at` set and no `disposed_at` (attached, or removed after attachment and not yet disposed of). The worker downloads each one and records key, length and SHA-256. A missing object, or bytes that do not match the recorded size, **fails the set**.
   - **Not copied:** a pending receipt, and a removed receipt that was never attached, with or without bytes. The manifest records their count and states only. Their bytes are never readable and never recovered, and their absence is not an error.
   - **Unreferenced objects:** an object under the bucket with no receipt row is counted, logged by count only, and left for Hank to inspect.
5. Write the manifest, reconcile the downloaded files against the required list, and only then write `sets/<timestamp>/COMPLETE` as the set’s last object. A set without `COMPLETE` is incomplete and is never restored. Each set is self-contained, so the 30-day retention keeps every recovery point whole.
6. Only after `COMPLETE`, dispose of removed receipts as the receipt lifecycle allows and set `disposed_at`. A failed set skips this step, leaves `status/latest.json` pointing at the previous complete set, and fails the execution, which alerts Hank. Retry failed disposals on the next run.

The membership roster and the project register are never written to the backup bucket. Supabase’s managed database backups contain Storage metadata only, and they are not the recovery path of record. Never restore any backup in place over the live project. [Supabase database backups](https://supabase.com/docs/guides/platform/backups)

**One serving project.** At any time at most one Eden Supabase project serves app users: the one the production site’s `VITE_SUPABASE_URL` names. Hank keeps a private **project register** in his password manager, outside this repository and the backup bucket: every Eden Supabase project ever created, with its ref, publishable key, purpose (`production`, `replacement`, `drill`, `rehearsal`) and state (`serving`, `closed`, `keys removed`, `deleted`). Before setting the gate open, `access:open` reads the register and refuses unless the target is the only entry that will be `serving`, and every other entry not marked `deleted` either reads back with a closed gate over a connection string it prompts for, or is marked `keys removed` and refuses a request made with its recorded publishable key. A `drill` or `rehearsal` copy may be opened only when it holds synthetic data, and it is never the production site’s target.

**Restore and cutover.** Restore before live use, after any change to the backup job, and quarterly afterward. A drill of a set holding real data never opens its copy: it stops after step A4 and its access checks run against the closed copy. An eligible owner restores the newest complete set into a new, isolated Supabase project that no Netlify build points at, and adds it to the register as `replacement` or `drill`, state `closed`.

*A. Restore, gate closed.*

1. Decrypt on that owner’s machine. Restore roles, schema and data. The access gate arrives closed because its data was left out. Revoke every restored Auth session and refresh token.
2. Restore the required receipt bytes at their original keys through the Storage API, with the copy’s secret key.
3. Run `npm run restore:verify -- <decrypted-set-directory>`. It prompts for the restored database’s connection string and compares, over that direct connection, the manifest’s row counts, receipt checksums, audit count and `eden_private.budget_totals` for every project with the restored copy. It compares only tables the copy’s applied migrations create, so a Stage 1 set checks Stage 1 tables only. It prints pass/fail and the names of failing checks, never values, to the terminal. A missing or mismatched required file, count or total fails the restore. No API call is involved, so this runs while every app request is denied.
4. Confirm the gate holds: over the direct connection, with each restored owner’s ID set as the request’s `auth.uid()`, `eden_private.is_member` returns false for both workspaces, and an anonymous Data API request and an anonymous Storage download with the copy’s publishable key return nothing.

*B. Isolate the former serving project (real recovery and rehearsal only), before anything opens.*

1. If its database answers, run `access:close` against it and read the gate back closed. Then, in its Supabase dashboard, delete its publishable and secret keys and disable its legacy API keys.
2. If its database does not answer, deleting and disabling its keys in the dashboard is required. With no valid key, its Data API, Auth and Storage refuse every app request if it comes back, whatever its gate says. Hank runs `access:close` himself as soon as it answers.
3. If neither its gate nor its keys can be shut, stop: the replacement stays closed.
4. In both cases add its connection string to a new version of `eden-superseded-db-urls`, so every backup run closes its gate whenever it answers (run step 1 above), and mark the entry `closed` or `keys removed` in the register.

*C. Reconnect the replacement, gate still closed.* A dump does not carry project settings, so Hank sets them in this order. [Supabase settings requiring manual reconfiguration](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

1. **Supabase settings.** Data API exposed schemas exactly `eden_api`; GraphQL extension disabled; Auth Google provider enabled with the existing Google client ID and secret from Hank’s password manager, every other provider disabled; Site URL and the redirect allow-list set to the production site’s origin and `https://<site-host>/auth/callback`; the `receipts` bucket private, 10 MiB, JPEG and PNG only. Record the new project URL and publishable key in the register.
2. **Google.** In the OAuth client, add the replacement’s callback `https://<new-ref>.supabase.co/auth/v1/callback` under authorized redirect URIs and remove the former project’s callback. The JavaScript origin stays the production site.
3. **Netlify.** Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to the replacement and start a fresh production deploy from `main` in the Netlify UI with the build cache cleared. Open the published site and confirm its script references the new project ref and not the old one. Every user now reaches the closed replacement and sees no workspace.
4. **Backup worker.** Add new versions of `eden-db-url` and `eden-storage-key` holding the replacement’s connection string and secret key. Update `eden-backup` to those version numbers and to the new `eden-superseded-db-urls` version from B4. Disable the previous versions. Until the replacement’s first complete set, the newest recovery point is the restored set.

*D. Roster, gate still closed.*

1. Run `roster:apply --dry-run` from Hank’s **current** private roster, never from the restored rows. It lists any line whose UUID is missing from the restored Auth database, typically a person added after the snapshot.
2. For each such person: they sign in once through the rebuilt site and see the no-access screen. `roster:pending` shows their new UUID, Google subject and verified address. Hank confirms the subject equals the one in the roster line, which proves it is the same Google account, then replaces that line’s UUID in his private roster. A subject that does not match is not that person: leave them out and investigate.
3. Run `roster:apply` for real, then `roster:show`. Every role, addition, downgrade and removal made since the snapshot is now current, and the whole roster applied in one transaction.

*E. Open.* Hank checks the read-back and confirms. Only then does an eligible owner run `access:open` with the register, and Hank marks the replacement `serving`. He signs in through the production site, checks one workspace, and after the next scheduled run confirms `status/latest.json` shows a complete set of the replacement.

*Exits.* On every exit from a drill or rehearsal, pass, fail or abandoned, the owner runs `access:close` on the copy if it was opened, deletes its API keys, deletes the project and marks it `deleted` in the register. A former serving project stays `closed` or `keys removed` until Hank deletes it, then it leaves `eden-superseded-db-urls` in a new version.

Record the recovery point, elapsed time, register changes and pass/fail in Hank’s private recovery log. The drill cases are in the Stage 1 and Stage 2 acceptance tests.

## Build stages and acceptance

Ship the stages in order. Use local Supabase and synthetic fixtures for development and policy tests. The hosted setup below is Hank’s checklist for implementation. Keep Google addresses, property details, the rough build plan and all credential values outside this repository.

### Checks that apply to every stage

**Schema and grant inventory.** Each migration adds an automated test of the reviewed inventory, checked in with that migration. The test lists:

- every relation, view, function and sequence visible to `anon`, `authenticated` and `PUBLIC` in every schema;
- the RLS state of every Eden table;
- the Data API’s exposed schemas;
- the tables in the `supabase_realtime` publication;
- the policies on `storage.objects`, including the receipt verifier’s metadata policy;
- every `SECURITY DEFINER` function in every Eden schema (exactly the three named under Access at the database boundary), its owner and its `search_path` setting;
- every privilege and policy held by `eden_membership_reader`, `eden_receipt_verifier` and `eden_audit_writer`, column by column.

Any difference from the reviewed inventory fails. The same suite confirms that the GraphQL endpoint returns no Eden types and that requests naming `eden` or `eden_private` in the schema-profile headers are refused.

**Public repository.** This repository is public. Before every push to GitHub, and again in CI on each pull request, `npm run check:public` reviews every outgoing commit between the remote base and HEAD, not only the final tree. It fails on:

- environment files other than `.env.example`;
- roster, backup, dump, export or archive files;
- CSV, JSON or SQL data outside `fixtures/`, and images outside `fixtures/images/`;
- fixture files without a `SYNTHETIC` marker;
- key-shaped values: Supabase secret keys, JWTs with a `service_role` claim, Google OAuth client secrets and private-key blocks;
- any entry in Hank’s private deny-list (real addresses, names, property names and plan terms), read from a file outside the repository that a local environment variable names.

CI runs every rule except the deny-list. The deny-list runs locally before the push, because a pushed commit is already public. Reports name the file, commit and rule, never the matched text. Fixtures are synthetic: `example.com` and `example.test` addresses, generated UUIDs, invented names, properties, tasks and amounts, and generated images.

**Browser build.** `npm run build` runs a guard before Vite writes anything. It allows exactly two `VITE_` variables. `VITE_SUPABASE_URL` must be an `https://` Supabase project URL. `VITE_SUPABASE_PUBLISHABLE_KEY` must be a publishable key (`sb_publishable_…`, or a legacy JWT whose role is `anon`). Otherwise the guard exits non-zero and leaves no `dist/`. Production builds emit no source maps. `npm run check:dist` scans the built files and any source maps for test markers. [Vite environment variables](https://vite.dev/guide/env-and-mode#env-variables)

Stage 1 acceptance proves these checks, and they stay in the test chain for every later stage.

### Stage 1 · Google sign-in, workspaces, roles, tasks, list and board

Build a static, phone-first front end on Netlify. Use Vite to produce static assets, `supabase-js` for Google sessions and authorized requests, and Supabase Postgres for data and policies. Implement workspace selection, project creation, assignment, task detail, list, board, the operational CSV and the initial backup/restore procedure. In Stay Eden, a property can already hold an item. Stage 4 adds the manager’s workflow.

**Hank sets up the following during implementation.**

1. **Supabase.** Create the Eden HQ project in Hank’s organization, choose a region and store the database password in his password manager. Give Supabase organization seats to eligible owners only (Backup and restore). Record the project URL and browser publishable key privately for Netlify. Apply the schema from a clean checkout of `main` with `supabase link --project-ref <ref>` and then `supabase db push`. `supabase/migrations/` is the only migration entry point, applied in filename order. `supabase migration list` reads back what is applied. In the Data API settings set Exposed schemas to exactly `eden_api`, removing `public` and `graphql_public`. [Supabase custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas) Keep email/password, phone, anonymous sign-in and all other providers disabled. Allow first-time Google sign-ins to create an identity. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
2. **Google.** In Google Cloud, configure the OAuth consent screen with Eden HQ, a support address and an audience that includes the actual family and staff accounts. If using External in testing, add each pilot Google account as a test user. Use only identity scopes (openid, email and profile). Create a Web application OAuth client. Add the app’s exact HTTPS origin under authorized JavaScript origins. Set Google’s authorized redirect URI to the exact callback copied from Supabase’s Google provider panel, normally `https://<project-ref>.supabase.co/auth/v1/callback`. Enter the Google client ID and secret **in that Supabase provider panel** and enable Google. Keep a copy of both in his password manager; a replacement project needs them (Backup and restore). [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
3. **Netlify and return URLs.** When an implementation is ready to host, connect the repository to the intended Netlify site, select `main`, build command `npm run build`, and publish directory `dist`. Configure an SPA fallback for `/auth/callback` and project deep links. Under project environment variables set **`VITE_SUPABASE_URL`** to the project URL and **`VITE_SUPABASE_PUBLISHABLE_KEY`** to its browser key, scoped to the build and intended environment. These two values are embedded in the static assets. Keep service-role/secret keys, database passwords, backup credentials and the Google client secret out of Netlify’s client build. Use isolated nonproduction values for trusted test builds and keep arbitrary previews disconnected from production. Set the Supabase Auth Site URL to the final site origin and allow the exact app return URL `https://<site-host>/auth/callback`. The app supplies that return URL when starting Google sign-in. For development, register the corresponding local app origin and callback in the development configuration. [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls) · [Netlify build environment](https://docs.netlify.com/build/environment-variables/get-started/)
4. **Roster and first project.** The migrations seed the two workspaces with the time zone America/Chicago unless Hank specifies another, and create the access gate closed. Ask each person to sign in once; each sees the no-access screen. Run `npm run roster:pending` and copy each person’s UUID and Google subject into the private roster: the four family owners as owner in both workspaces, the manager as member in Stay Eden only. Run `roster:apply` with `--dry-run`, then for real, then `roster:show`. The read-back must show four owners in each workspace and the manager as the only other member, in Stay Eden only. Start the private project register with this project as `production`, then run `access:open` with it and mark the project `serving`. Every later addition, role change or revocation is a roster edit followed by `roster:apply`. A new internal user gets only the memberships Hank lists. Hank then creates the first build and types in his rough plan.
5. **Recovery.** In the Eden HQ Google Cloud project, as its owner:
   1. Enable Cloud Run, Cloud Scheduler, Secret Manager, Cloud Storage and Cloud Monitoring.
   2. Create the backup bucket and the status bucket with the settings in Backup and restore.
   3. Create three service accounts: `eden-backup` (the worker), `eden-backup-watch` (the watch) and `eden-backup-scheduler` (the identity both schedules use). Grant none of them a project-level role.
   4. Create the secrets `eden-db-url`, `eden-storage-key` and `eden-superseded-db-urls` (first version empty). Grant `eden-backup` Secret Accessor on each of the three, on the secret.
   5. On the backup bucket grant `eden-backup` Storage Object Creator. On the status bucket grant `eden-backup` Storage Object User and `eden-backup-watch` Storage Object Viewer.
   6. Generate the `age` key pair on his own machine, keep the private key in his password manager, and give only the public key to the job.
   7. Deploy the `eden-backup` job (running as `eden-backup`, secrets pinned to their version numbers) and the `eden-backup-watch` job (running as `eden-backup-watch`, `STALE_AFTER_HOURS=26`). On each job grant `eden-backup-scheduler` Cloud Run Invoker.
   8. Create the schedules `eden-backup-daily` and `eden-backup-watch-hourly` with the crons in Backup and restore, each an HTTP target on its job’s `:run` endpoint with an OAuth token for `eden-backup-scheduler`. As project owner, Hank may attach that service account.
   9. Create the email notification channel, the log-based metric for `eden_backup_stale` and `eden_superseded_was_open`, and the three alert policies.
   10. Grant a status monitor, if any, only Cloud Run Viewer, Monitoring Viewer and Storage Object Viewer on the status bucket.

   Run the Stage 1 restore drill before entering real work.

**Stage acceptance**

- A verified Google sign-in returns to the app. The four owners see both workspaces. The manager sees only Stay Eden. A new Google identity sees the no-access screen and an anonymous API request returns no app rows.
- From a manager session, request a known Home project and try to create a Home task. Both fail without disclosing the project. Changing the supplied workspace or role cannot grant access. Revoke membership, reuse the existing session, and confirm the next list and write are denied.
- Hank creates a project from a phone and adds tasks assigned to a member, an outside vendor and nobody. Cross-workspace assignees and an end date before start are rejected. A board move updates the list after refresh. Two concurrent edits preserve the winning version and explain the conflict to the other editor.
- At 375 px and desktop width, create, open, edit and move a task with touch or keyboard. Export an empty project and a project containing commas, quotes, multiple lines and formula-like text. Reopen the CSV and check row boundaries, literal text and project scope.
- **Empty-project rehearsal.** Start from an empty local Supabase project and apply every migration from `supabase/migrations/`; the inventory test passes. Apply a synthetic roster for six synthetic Google identities. The read-back shows four owners in both workspaces and the manager only in Stay Eden. A rerun reports no change. Removing a line revokes that membership. Changing a role to member downgrades it. A roster with no Home owner is refused.
- **Paged reads.** With synthetic projects of 50 and 300 tasks and many assignees, List and each Board column load in one request per page, and each row shows its assignee without further requests. The request count per page is the same for both projects.
- **Realtime.** As the manager, a same-workspace member and a signed-out client, subscribe to Postgres changes on every Eden table. A synthetic Home task change and a synthetic Stay Eden change reach none of them.
- **Public repository and build.** A synthetic build with a secret-key-shaped value in the publishable-key slot fails and leaves no `dist/`. A synthetic build with planted markers in a non-`VITE_` variable and in an ignored local environment file produces assets, source maps included, that contain neither marker. A synthetic commit carrying a deny-listed value, a roster-shaped file or an unmarked fixture is refused before it leaves the machine. No check report contains a matched value.
- **Scheduled backup.** With Hank’s computer off, two consecutive scheduled runs of `eden-backup-daily` each complete a set. After the second, `status/latest.json` has been replaced and shows the second set’s recovery point, 24 hours after the first. An attempt by `eden-backup` to read, list, overwrite or delete an object in the backup bucket is refused. Running `eden-backup-watch` once with `STALE_AFTER_HOURS=1` emails Hank the stale alert; set it back to 26 afterward. Pausing `eden-backup-watch-hourly` for 3 hours emails Hank the missing-heartbeat alert; resume it afterward.
- **Restore drill with the roster.** This drill runs before real work, so the set holds synthetic data only and the copy may be opened. After a backup, downgrade a synthetic owner to member in Stay Eden and remove another synthetic user’s Home membership, in the roster and in the live project. Restore the set into an isolated project registered as `drill`. `restore:verify` passes on the Stage 1 tables only, with the gate closed. Before `roster:apply`, every API and Storage request to the restored project is denied. After `roster:apply`, `roster:show` and `access:open`, the restored API and Storage give the downgraded user operational reads only and the removed user nothing in Home. The manager sees only Stay Eden. A status monitor can see the runs and the status record but cannot read the backup bucket or Secret Manager versions, or open the restored project. On exit the copy is closed, its keys deleted and the project deleted, and `access:open` on the production project still passes with the register showing it as the only open entry.

### Stage 2 · Owner budgets, receipts, audit and full export

Add manual budget entry, project/category rollups, private receipt handling, immutable audit history, full owner exports and the separate object backup. **Hank** chooses the starting category labels, then:

1. Applies the Stage 2 migrations with `supabase db push`. They create the private `receipts` bucket (10 MiB limit, JPEG and PNG only), its policies, the `eden_receipt_verifier` and `eden_audit_writer` roles with exactly the grants listed above, the audit triggers and the budget operations.
2. Redeploys the `eden-backup` job at the Stage 2 version, which adds the receipt inventory, receipt copy and stale-upload cleanup. The schedules, buckets, secrets, service accounts and alerts stay as set up in Stage 1.
3. Sets up the **rehearsal environment**, which holds synthetic data only and is torn down after the rehearsal: a nonproduction Netlify site (`main`, the same build settings) with its own two `VITE_` variables; a second Web OAuth client in the same Google Cloud project, whose origin is that site; two rehearsal Supabase projects in the same organization, configured like production and registered as `rehearsal`; and a second deployment of the backup job, `eden-backup-rehearsal`, with its own service account, backup and status buckets (no retention policy, since they hold synthetic data and are deleted afterward), `age` key pair, three secrets (`eden-rehearsal-db-url`, `eden-rehearsal-storage-key`, `eden-rehearsal-superseded-db-urls`) and daily schedule, granted exactly as in Stage 1.
4. Checks that `status/latest.json` shows a complete set after the next scheduled run, then runs the Stage 2 restore drill and the cutover rehearsal before entering real money. Afterward he deletes the rehearsal projects (marking them `deleted`), the rehearsal job, schedule, secrets, buckets and service account, disconnects the rehearsal site and deletes the second OAuth client.

No additional production front-end key or OAuth client is required.

**Stage acceptance**

- In one build enter Framing $100 estimated / $125 actual, Framing $50 / blank, and Site work $0 / $0. The project shows $150 estimated, $125 actual, one missing actual and +$25 over on two comparable tasks. Framing shows +$25 on one comparable task. Mark paid and attach two photos. Totals stay the same.
- In a synthetic build of 300 budgeted tasks across several pages, archived tasks included, open the Budget screen with only the first page of tasks loaded. Project and category totals, missing counts and variance equal an independent calculation over every task, and the totals CSV matches them. The Budget screen uses one summary request at 30 tasks and at 300.
- Finalize, on a local project built only from `supabase/migrations/`, so `eden_receipt_verifier` holds exactly the migration grants and no test role or superuser stands in: a valid pending upload finalizes once, and a retry returns the attached result with no new audit row. A missing object, an object at another key, one uploaded by another owner, one over 10 MiB, one of another type, a reservation created by another owner, one whose task budget was cleared, and one whose uploader was downgraded before finalizing each stay pending. Pending bytes stay unreadable, to the uploader included, through download, list and signing. Revoking any one of the verifier’s listed grants in a test copy makes the valid case fail, which proves each grant is needed.
- An active owner downloads an attached receipt but cannot create a signed URL or list the bucket. Downgrade that owner to member with `roster:apply`. On the same session, budget, totals, history, receipt and full-export requests are denied while List, Board and task detail still work.
- Subscribe to Postgres changes on every Eden table as a same-workspace member, the manager and a signed-out client. Synthetic budget, receipt and audit changes reach none of them. The inventory test covers the receipt object policies and the verifier’s grants.
- Use a synthetic non-owner **in the same build workspace**, the operations-only manager and an owner of a different workspace. Inspect actual HTTP responses for task detail, searches/filters, bulk reads, totals, CSV, receipt metadata/download/signing and audit. Operational responses contain zero financial field names or values. Owner operations deny access. Direct financial table access, writes, and attempts to change row scope or role fail.
- As an owner, create a budget, change vendor/category and payment, clear a value, attach, replace and remove a photo, then clear the budget. Check actor, time, before/after and scope for each persisted change. A client cannot alter history. A stale save, failed audit insert or repeated finalize makes no partial or duplicate change.
- Audit trigger, on the same migrations-only local project: one owner budget save creates exactly one `money_audit` row with the owner’s ID and label. As `authenticated`, a direct insert, update or delete on `money_audit`, and any `eden_api` call that tries to write it, is denied. With a test-only fault that makes the audit insert fail (in a test copy, revoke `eden_audit_writer`’s INSERT), an owner budget save and a receipt attach each fail and leave the budget and receipt unchanged.
- Cancel an upload and resume it. Verify a pending object is absent from exports, a public or guessed path cannot fetch bytes, and revoking the owner blocks a fresh download. Full project export includes attached images, archived tasks and prior money edits. Full exports across projects exclude workspaces where the user lacks ownership.
- **Receipt backup cases**, in the rehearsal environment with Hank’s computer off. Before a scheduled run, leave (a) a reservation older than 24 hours with no upload, (b) one older than 24 hours with uploaded but unfinalized bytes, and an attached receipt. The run completes a set: both stale reservations are claimed and disposed of, (b)’s object is deleted, both get `disposed_at`, neither is in the required list, and the attached receipt’s checksum is in the manifest. Then delete a second attached receipt’s object directly with the rehearsal secret key. The next run fails the set: no `COMPLETE`, no disposal, `status/latest.json` still names the previous set, and Hank receives the failure alert. That previous set still restores and passes `restore:verify`.
- **Restore drill.** Restore the newest complete set into an isolated project registered as `drill`. With the gate closed, `restore:verify` passes on row counts, audit count, receipt checksums and `eden_private.budget_totals` for every project, and a synthetic owner’s API and Storage requests to the copy are denied. An eligible owner recovers a synthetic receipt with a matching checksum. A status monitor cannot read it, the encrypted set or the restored database. Run same-workspace member and manager denial tests against the copy after `roster:apply` and `access:open`. A missing required file makes the drill fail. On exit the copy is closed and deleted.
- **Cutover rehearsal.** Rehearsal project R1 serves the rehearsal site. It holds a synthetic Home owner O with a known budget and an attached receipt, and synthetic members X and Y. After a complete scheduled set of R1: downgrade O to member, remove X, and add a new synthetic Google account N, in the rehearsal roster and in R1. Restore the set into R2 and follow Restore and cutover:
  - A: `restore:verify` reports R2’s totals equal the manifest while O’s and every other synthetic user’s requests to R2 are denied.
  - B: isolate R1 by `access:close` and key deletion. `access:open` on R2 was refused while R1 still had an open gate.
  - C: reconnect R2 (rehearsal OAuth client callback, provider, redirect allow-list and exposed schemas; rebuilt rehearsal site; new rehearsal secret versions).
  - D: `roster:apply --dry-run` names N as missing. N signs in through the rebuilt site, their subject is checked and their UUID replaced, and the full roster then applies in one transaction: N added, O downgraded, X removed.
  - E: open R2. O signs in with Google through the rebuilt site and gets List, Board and task detail but no budget, totals, history, receipt download or full export. Using R1’s URL and its old publishable key, O’s and X’s budget, full-export and receipt-download requests are refused. Then rehearse a former project that comes back after being unreachable: open R1’s gate directly over its connection string, as a project restored to its last state would be. Requests with its deleted keys are still refused, and the next rehearsal run logs `eden_superseded_was_open`, closes R1’s gate and alerts Hank.
  - After cutover, Y creates a synthetic task edit and an owner attaches a synthetic receipt in R2. The first scheduled set of R2 holds both. Restoring it into a drill copy recovers the edit and the receipt’s checksum.
  - On exit, every rehearsal and drill copy is closed and deleted, and the register shows none of them open.

### Stage 3 · Dependencies and timeline

Add the project dependency graph, Waiting indicator and Gantt view. Extend exports with predecessor data. **Hank** supplies a few real predecessor relationships and dates from his build plan and enters them after acceptance. Existing Supabase, Google and Netlify settings suffice.

**Stage acceptance**

- Make Rough plumbing wait on Frame walls. The successor shows Waiting and cannot start. Completing the predecessor unblocks it in the list, board and timeline. A second unfinished predecessor keeps it waiting.
- Reject self-links, duplicates, cross-project/workspace edges and an indirect cycle. Concurrent graph writes that would form a cycle cannot both commit. Reopening a predecessor of an already-started task produces a clear conflict.
- Show a two-date bar, a one-date point and an undated task on a phone and desktop. Tap each to edit. A date edit changes only that task. The operational CSV identifies predecessors and carries no financial columns.
- In a synthetic project of 300 tasks with many edges, List, Board and Timeline rows show Waiting and open predecessors from the page request alone. The request count per page stays the same at 50 tasks and at 300.

### Stage 4 · Stay Eden manager workspace polish

Add property navigation, item types, threads, follow-up dates and manager filters. “Due for follow-up” includes open items due today or earlier in the workspace’s calendar day, including overdue items. **Hank** supplies property display names, confirms the manager’s Google account and local time zone, and creates the initial property projects. The existing membership and infrastructure are sufficient.

**Stage acceptance**

- An owner creates a request, maintenance item, note and follow-up for one property. The manager finds the assigned maintenance item on a phone, posts an update, sets a follow-up and completes it. The owner sees the thread and outcome on desktop.
- Seed two properties. Verify the selected property filters correctly, overdue open work appears in Due for follow-up, completed work drops off that filter, and exported updates belong to the selected property.
- Repeat the manager’s Home deep-link, direct API, export and receipt denial tests. Opening and finishing an item requires only Eden HQ. Verify no cleaner checklist, Guesty calls or notification jobs are introduced.

Proposed operating defaults and the few inputs Hank still needs to supply are listed in [Open questions](OPEN_QUESTIONS.md).
