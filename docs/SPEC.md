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

Supabase Auth owns Google identities in `auth.users`. Eden references the stable user UUID. Below, IDs and foreign keys are UUIDs unless specified, dates are calendar dates, timestamps are `timestamptz`, labels are text, and versions increase on each change. Each entity has an `id` primary key unless another key is given. A question mark marks a nullable column. Keep app tables in an unexposed schema.

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
| `receipts` | `id, workspace_id, project_id, task_id, object_key, mime_type, byte_count?, state, created_by, created_at, attached_at?, removed_at?` | Unique immutable object key in the private bucket. States are `pending`, `attached` and `removed`. Reserve only for a budgeted task. Retain metadata for removed receipts. |
| `money_audit` | `id, workspace_id, project_id, task_id, actor_user_id, actor_label, occurred_at, entity, entity_key, action, before?, after?` | One immutable event per changed financial row. Before/after are JSONB snapshots of budget fields or receipt metadata. Keep the actor ID and label as they were at edit time. |

Use unique parent keys and composite foreign keys carrying workspace, project and task IDs wherever applicable. Both dependency ends must match the project. Member and contact references must match the workspace. Derive creator, author, timestamps and audit actor on the server. Freeze parent IDs after insert. Index membership by user/workspace and children by workspace/project, task, due date and dependency endpoint. Archive tasks, contacts and projects in place. Restrict destructive cascades.

Start must be on or before due when both are set. Either can be unknown. Status is Ready, In progress or Done. Waiting is derived from open dependencies. Reject self-links, duplicates and cycles of any length. Serialize graph and status writes on the project before validation. Reject starting or finishing a waiting successor. Reject reopening a predecessor or adding an unfinished prerequisite if that would invalidate a started or completed successor. Resolve or remove edges before archiving a linked task. Date edits never reschedule another task. Draw a bar for two dates, a labeled point for one, and an Unscheduled list for neither.

## Access at the database boundary

Enable Postgres row-level security (RLS) on **every Eden table**, including all private financial tables. Expose only a dedicated API schema of explicit operations through the Supabase Data API. Use caller-privilege (`SECURITY INVOKER`) operations with named return fields. Grant the minimum underlying table and column privileges. Revoke default function execution from `PUBLIC` and grant published operations only to `authenticated`. Keep base tables, relationship expansion and generic row-to-JSON endpoints off the exposed API. Return role-checked financial responses only after authorization, and avoid account-wide role claims in tokens. Exclude Eden tables from Realtime publications and alternate query surfaces. [Supabase custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas) · [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

The predicates below look up the current `auth.uid()` in active `workspace_members` for the row’s workspace. **M** means active member or owner. **O** means active owner. A private, fixed-search-path helper uses a dedicated non-login role with a nonrecursive read policy on membership rows. It returns only the caller’s membership decision. It accepts the workspace and reads the caller ID itself. The browser never holds table-owner or RLS-bypass privileges. Submitted roles and editable Google profile metadata cannot establish membership.

| Relation | SELECT policy | Create / change policy |
| --- | --- | --- |
| Workspaces | M for the row | Seed and maintain through trusted administration. |
| Workspace members | M for that workspace, exposing names needed for assignments and history | Hank provisions, revokes or changes roles through trusted administration. App users cannot promote themselves. |
| Projects | M | O creates, edits and archives projects. |
| Outside contacts | M | O creates, edits and archives names. M can assign an existing contact. Linking a login requires a future migration. |
| Tasks | M | M creates and edits operational fields in active projects. O may archive or restore a task. |
| Task updates | M | M appends in an active project for an active task. The server sets the author. |
| Dependencies | M | M adds or removes same-project edges through the validated graph operation. |
| Task budgets | O | O creates, revises or clears a budget on an active build task. |
| Receipts | O | O reserves, attaches or removes through the receipt workflow. |
| Money audit | O | Only the database audit trigger appends. App roles have no insert, update, truncate or delete privilege. |
| Storage objects in the receipts bucket | O for the matching attached receipt and authenticated download | O uploads once to a matching pending reservation. Storage maintenance handles disposal. |

Reads and deletes check the existing row (`USING`). Inserts check the proposed row (`WITH CHECK`), and updates check both. Deny operations absent from the matrix. Use column privileges, constraints and triggers to enforce state transitions and immutable parentage. An unenrolled or signed-out caller receives no workspace data. Revocation takes effect on the next server request even with the same unexpired token.

List, board, timeline, task detail and notes return only operational fields, even to an owner. The separately entered budget vendor is private. Owner operations check O **before** building any financial result or CSV header. A failed check returns a generic unavailable/permission error without cost fields, receipt metadata, totals, audit values or payment information. Omit these values from logs, error text, client analytics, URLs, static assets and persistent browser caches. Clear loaded project data and receipt previews on workspace/account change or sign-out.

## Budgets, receipts and export

**Budget math.** Enter costs by hand to the cent. Blank means unknown. An entered zero counts as known. Suggest existing trimmed category labels case-insensitively and group blanks under Uncategorized. Sum known estimate and actual amounts independently, once per task, including archived tasks. Show missing-value counts including tasks with no budget. Task variance is actual minus estimate when both exist. For project and category variance, sum differences for tasks that have both amounts and label the number of comparable tasks. Show a dash when none are comparable. Positive means over estimate. Payment and receipt count do not change totals. Clearing a budget removes its amounts from totals and preserves its history. Resolve pending and remove attached receipts before clearing.

**Money edits.** Every create, edit, clear, attachment, removal and replacement uses an owner-authorized operation. Database triggers capture inserts, updates and deletes on both financial tables, including receipt state changes. In the same transaction record the actor, database time, scoped IDs and old/new values. Fail the write if the audit insert fails. Controlled maintenance uses an attributable operator or dedicated system actor ID. The audit trigger alone may append through a private, narrowly privileged function with a fixed search path. There is no FK from audit to a deletable budget. An unchanged retry produces no duplicate event. Compare the expected budget or task version on update and reject stale writes. Allocate a fresh budget version on recreation so a stale save cannot match a replacement row. Replace a photo by uploading a new immutable object, then attaching it and removing the previous attachment in one database transaction.

**Private receipt lifecycle.** An owner saves a budget, taps Add receipt, and chooses or takes a photo. Normalize camera images to JPEG when needed. Accept JPEG or PNG up to 10 MiB after conversion. Enforce size/type limits in a private Supabase Storage bucket named `receipts`. Use the generated path `<workspace-id>/<project-id>/<task-id>/<receipt-id>`. [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)

1. Reserve a pending receipt for the task. An upload policy on `storage.objects` matches the bucket, complete reserved path, current active owner and reservation creator. Permit a new upload only, with overwrite and client deletion disabled.
2. Finalize after verifying that Storage has the matching object, size and type. Mark it attached and audit the change. A retry with the same receipt ID resumes or returns the attached result. Pending photos stay off the task and its export.
3. Fetch bytes using the current owner’s JWT. Limit object SELECT to the authenticated download operation and an attached matching row. The app lists receipts from Postgres. Exclude public URLs, bearer share links and signing operations. Discard in-memory image URLs when the screen closes. [Supabase Storage operation policies](https://supabase.com/docs/guides/storage/schema/helper-functions)
4. Removal first marks the receipt removed and records the audit event, cutting off subsequent reads. A restricted maintenance job claims stale reservations older than 24 hours by atomically marking them removed, then uses the Storage API to dispose of removed objects. Retry failed disposal. Retain audit metadata and protected backups according to retention.

**CSV per project.** Export starts from a project or property. The database checks membership for that project and produces one consistent snapshot including archived work. A member receives an operational tasks CSV with IDs, project/property, kind, title, description, assigned name, dates, status, follow-up, predecessor IDs and archive flag. Updates export as a companion CSV keyed by task ID. Owners can choose the operational export or **Full project export**. The full archive has keyed CSVs for project details, tasks, updates, dependencies, budgets with vendor/category/payment, totals and variance with coverage counts, receipt manifest and complete money history. Include attached photo files under relative names listed in the manifest. Fetch them through owner-authenticated downloads and report missing files before marking the export complete. “All projects” repeats the full export for every project in workspaces the caller owns, including archived projects.

Use stable column order, UTF-8, ISO dates, two-decimal dollar strings and CSV escaping for delimiters, quotes and newlines. Neutralize spreadsheet formulas in user-entered text during export. An accessible empty project yields header-only detail CSVs. A non-owner requesting a full export receives a denial without a file.

## Backup and restore

Hank owns recovery. Proposed targets are at most 24 hours of lost changes and recovery within one business day. Capture a daily encrypted database backup with schema, grants, policies, Auth identities and stable IDs, memberships, project data, receipt metadata and audit history. Separately copy private receipt **bytes** with lengths and checksums to versioned encrypted storage. Keep daily sets for 30 days. Supabase database backups contain Storage metadata only. Select managed backups appropriate to the project plan or schedule a validated logical backup on Hank’s trusted backup runner. [Supabase database backups](https://supabase.com/docs/guides/platform/backups)

Each set has a timestamp, database recovery point, receipt manifest and completion status. Reconcile files against the snapshot before marking it complete, retaining object versions needed by each set. Before purging an immutable object, verify that all recovery points referencing it have a protected copy. Restrict the destination and decryption keys to designated recovery operators. Check backup status daily and flag stale or incomplete sets to Hank through the backup system.

Before live use and quarterly afterward, restore into an isolated environment. Restore identities, policies and rows, then restore bytes at the original keys via the Storage API. Reconcile checksums, row counts, project totals and audit entries. Verify an owner can read a sample photo, the manager cannot, and the manager sees only assigned workspaces. Record recovery point, elapsed time and pass/fail. Reapply current revocations before reopening a restored system.

## Build stages and acceptance

Ship the stages in order. Use local Supabase and synthetic fixtures for development and policy tests. The hosted setup below is Hank’s checklist for implementation. Keep Google addresses, property details, the rough build plan and all credential values outside this repository.

### Stage 1 · Google sign-in, workspaces, roles, tasks, list and board

Build a static, phone-first front end on Netlify. Use Vite to produce static assets, `supabase-js` for Google sessions and authorized requests, and Supabase Postgres for data and policies. Implement workspace selection, project creation, assignment, task detail, list, board, the operational CSV and the initial backup/restore procedure. In Stay Eden, a property can already hold an item. Stage 4 adds the manager’s workflow.

**Hank sets up the following during implementation.**

1. **Supabase.** Create the Eden HQ project in Hank’s organization, choose a region and store the database password in his password manager. Record the project URL and browser publishable key privately for Netlify. Configure the Data API to expose only the reviewed API schema once migrations create it. Keep email/password, phone, anonymous sign-in and all other providers disabled. Allow first-time Google sign-ins to create an identity. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
2. **Google.** In Google Cloud, configure the OAuth consent screen with Eden HQ, a support address and an audience that includes the actual family and staff accounts. If using External in testing, add each pilot Google account as a test user. Use only identity scopes (openid, email and profile). Create a Web application OAuth client. Add the app’s exact HTTPS origin under authorized JavaScript origins. Set Google’s authorized redirect URI to the exact callback copied from Supabase’s Google provider panel, normally `https://<project-ref>.supabase.co/auth/v1/callback`. Enter the Google client ID and secret **in that Supabase provider panel** and enable Google. [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
3. **Netlify and return URLs.** When an implementation is ready to host, connect the repository to the intended Netlify site, select `main`, build command `npm run build`, and publish directory `dist`. Configure an SPA fallback for `/auth/callback` and project deep links. Under project environment variables set **`VITE_SUPABASE_URL`** to the project URL and **`VITE_SUPABASE_PUBLISHABLE_KEY`** to its browser key, scoped to the build and intended environment. These two values are embedded in the static assets. Keep service-role/secret keys, database passwords, backup credentials and the Google client secret out of Netlify’s client build. Use isolated nonproduction values for trusted test builds and keep arbitrary previews disconnected from production. Set the Supabase Auth Site URL to the final site origin and allow the exact app return URL `https://<site-host>/auth/callback`. The app supplies that return URL when starting Google sign-in. For development, register the corresponding local app origin and callback in the development configuration. [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls) · [Netlify build environment](https://docs.netlify.com/build/environment-variables/get-started/)
4. **Roster and first project.** Apply the reviewed Stage 1 schema and seed the two workspaces. Ask each person to sign in once. Match their verified Google account in Supabase Auth against Hank’s private roster and use its UUID to create the specified membership rows. The four family owners get both workspaces. The manager gets one member row for Stay Eden. Set the initial workspace time zone to America/Chicago unless Hank specifies another. A new internal user starts with only the memberships Hank explicitly assigns. Revoke access by timestamping that membership. Hank then creates the first build and types in his rough plan.
5. **Recovery.** Choose the backup destination, trusted runner and recovery operator. Configure daily database backups and perform a test restore of memberships, policies and tasks before entering real work.

**Stage acceptance**

- A verified Google sign-in returns to the app. The four owners see both workspaces. The manager sees only Stay Eden. A new Google identity sees the no-access screen and an anonymous API request returns no app rows.
- From a manager session, request a known Home project and try to create a Home task. Both fail without disclosing the project. Changing the supplied workspace or role cannot grant access. Revoke membership, reuse the existing session, and confirm the next list and write are denied.
- Hank creates a project from a phone and adds tasks assigned to a member, an outside vendor and nobody. Cross-workspace assignees and an end date before start are rejected. A board move updates the list after refresh. Two concurrent edits preserve the winning version and explain the conflict to the other editor.
- At 375 px and desktop width, create, open, edit and move a task with touch or keyboard. Export an empty project and a project containing commas, quotes, multiple lines and formula-like text. Reopen the CSV and check row boundaries, literal text and project scope.

### Stage 2 · Owner budgets, receipts, audit and full export

Add manual budget entry, project/category rollups, private receipt handling, immutable audit history, full owner exports and the separate object backup. **Hank** chooses the starting category labels and recovery destination. Apply the reviewed financial migrations and storage policies, create the private `receipts` bucket with the specified limits, enable cleanup and configure the protected daily file copy. Verify a complete restore with a synthetic receipt before using real money. No additional front-end key or OAuth client is required.

**Stage acceptance**

- In one build enter Framing $100 estimated / $125 actual, Framing $50 / blank, and Site work $0 / $0. The project shows $150 estimated, $125 actual, one missing actual and +$25 over on two comparable tasks. Framing shows +$25 on one comparable task. Mark paid and attach two photos. Totals stay the same.
- Use a synthetic non-owner **in the same build workspace**, the operations-only manager and an owner of a different workspace. Inspect actual HTTP responses for task detail, searches/filters, bulk reads, totals, CSV, receipt metadata/download/signing and audit. Operational responses contain zero financial field names or values. Owner operations deny access. Direct financial table access, writes, and attempts to change row scope or role fail.
- As an owner, create a budget, change vendor/category and payment, clear a value, attach, replace and remove a photo, then clear the budget. Check actor, time, before/after and scope for each persisted change. A client cannot alter history. A stale save, failed audit insert or repeated finalize makes no partial or duplicate change.
- Cancel an upload and resume it. Verify a pending object is absent from exports, a public or guessed path cannot fetch bytes, and revoking the owner blocks a fresh download. Full project export includes attached images, archived tasks and prior money edits. Full exports across projects exclude workspaces where the user lacks ownership.
- Restore a matched database and receipt backup. Compare totals, audit count, manifest and photo checksums. Run same-workspace member and manager denial tests against the restored copy. A missing file makes the rehearsal fail.

### Stage 3 · Dependencies and timeline

Add the project dependency graph, Waiting indicator and Gantt view. Extend exports with predecessor data. **Hank** supplies a few real predecessor relationships and dates from his build plan and enters them after acceptance. Existing Supabase, Google and Netlify settings suffice.

**Stage acceptance**

- Make Rough plumbing wait on Frame walls. The successor shows Waiting and cannot start. Completing the predecessor unblocks it in the list, board and timeline. A second unfinished predecessor keeps it waiting.
- Reject self-links, duplicates, cross-project/workspace edges and an indirect cycle. Concurrent graph writes that would form a cycle cannot both commit. Reopening a predecessor of an already-started task produces a clear conflict.
- Show a two-date bar, a one-date point and an undated task on a phone and desktop. Tap each to edit. A date edit changes only that task. The operational CSV identifies predecessors and carries no financial columns.

### Stage 4 · Stay Eden manager workspace polish

Add property navigation, item types, threads, follow-up dates and manager filters. “Due for follow-up” includes open items due today or earlier in the workspace’s calendar day, including overdue items. **Hank** supplies property display names, confirms the manager’s Google account and local time zone, and creates the initial property projects. The existing membership and infrastructure are sufficient.

**Stage acceptance**

- An owner creates a request, maintenance item, note and follow-up for one property. The manager finds the assigned maintenance item on a phone, posts an update, sets a follow-up and completes it. The owner sees the thread and outcome on desktop.
- Seed two properties. Verify the selected property filters correctly, overdue open work appears in Due for follow-up, completed work drops off that filter, and exported updates belong to the selected property.
- Repeat the manager’s Home deep-link, direct API, export and receipt denial tests. Opening and finishing an item requires only Eden HQ. Verify no cleaner checklist, Guesty calls or notification jobs are introduced.

Proposed operating defaults and the few inputs Hank still needs to supply are listed in [Open questions](OPEN_QUESTIONS.md).
