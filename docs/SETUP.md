# Eden HQ setup · what Hank does

Everything below is done by Hank, in his own accounts. Nothing here is automated, and no agent runs any of it. Keep every real value (project refs, keys, passwords, Google account addresses, the rosters, the project register) in the password manager, never in this repository, an issue or a PR. Placeholders look like `<this>`.

The order matters, because each step uses only what earlier steps created: Supabase project → Auth settings → migrations, then the Data API settings → Google OAuth → Netlify → hosted checks → CI and local guard → connection strings → synthetic test accounts and the gate → backups → restore drill on synthetic data → real users → first real project.

Until step 12, the production project holds **synthetic data only**: six test Google accounts and invented projects. That is what lets the Stage 1 restore drill open its copy (the spec allows opening only copies that hold synthetic data).

Spec of record: [SPEC.md](SPEC.md). Stage 1 notes and deviations: [STAGE1.md](STAGE1.md).

## 0. What you need

- A Supabase organization you own. Seats in it only for owners of **both** workspaces (Backup and restore in the spec).
- A Google Cloud project for Eden HQ (holds the OAuth client and the backup jobs), billing enabled, you as Owner.
- A Netlify account connected to GitHub.
- On your Mac: Node 22 or later, `git`, the Supabase CLI (`npx supabase@2` works), the `gcloud` CLI, and `age` (`brew install age`).
- The PostgreSQL client tools, **17 or later** (`psql`, `pg_dump`, `pg_restore`; the restore and the local tests drive them):

  ```sh
  brew install libpq
  echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zprofile && source ~/.zprofile
  psql --version          # must print 17 or later
  pg_restore --version    # must print 17 or later
  pg_dump --version       # must print 17 or later
  ```

  `npm run restore:apply` checks the versions itself and refuses older tools.
- Six Google accounts that hold nothing real, for the synthetic stage (step 9): for example new free accounts named `Eden Test 1` to `Eden Test 6`. Never a real person's account. Keep their sign-in details in the password manager.
- A clean clone of this repository on `main`, then `npm ci`, then `npm test` (it needs the client tools above).

## 1. Create the Supabase project

1. Supabase dashboard → New project, in your organization. Name `eden-hq`. Pick the region closest to Texas (for example `us-east-1` or `us-central`).
2. Generate the database password, save it in the password manager, and create the project.
3. Project Settings → API Keys: copy the **Project URL** (`https://<ref>.supabase.co`) and the **publishable key** (`sb_publishable_…`) into the password manager. Never copy the secret key anywhere except where step 10 says.
4. Start the private **project register** in the password manager, a CSV with this header and one line:

   ```text
   ref,publishable_key,purpose,state
   <ref>,<publishable key>,production,closed
   ```

## 2. Auth settings (dashboard)

1. Authentication → Sign In / Providers:
   - Turn **off** Email, Phone, Anonymous sign-ins and every other provider.
   - Leave **Allow new users to sign up** on: a first Google sign-in creates an identity, and only your roster grants access.
   - Google is configured in step 4.
2. Authentication → URL Configuration: leave until step 5 gives you the site host.
3. Realtime: nothing to turn on. Eden uses no Realtime channels.

The Data API settings come in step 3, after the migrations: the schema they expose does not exist until then.

## 3. Apply the migrations, then set the Data API

From a clean checkout of `main` on your Mac:

```sh
git switch main && git pull --ff-only
npx supabase@2 login
npx supabase@2 link --project-ref <ref>        # asks for the database password
npx supabase@2 db push                          # applies supabase/migrations/ in filename order
npx supabase@2 migration list                   # read-back: both Stage 1 migrations applied
```

`supabase/migrations/` is the only migration entry point. Then, in the dashboard:

1. Database → Extensions shows `pg_graphql` **off** (the first migration removes it), and Database → Publications → `supabase_realtime` lists **no** `eden` table.
2. Project Settings → Data API: **Exposed schemas** exactly `eden_api` (it exists now; remove `public` and `graphql_public`). **Extra search path** empty. Max rows 100. Save.

## 4. Google sign-in

In Google Cloud console, Eden HQ project:

1. APIs & Services → OAuth consent screen: app name `Eden HQ`, your support address, scopes `openid`, `email`, `profile` only. Audience: if External and in Testing, add the six test accounts (and later every real person) as test users.
2. Credentials → Create credentials → OAuth client ID → **Web application**, name `Eden HQ`.
   - Authorized JavaScript origins: the site origin from step 5 (`https://<site-host>`). Add it after step 5 if you don't know it yet.
   - Authorized redirect URIs: copy the callback shown in Supabase → Authentication → Providers → Google, normally `https://<ref>.supabase.co/auth/v1/callback`.
3. Save the **client ID and client secret** in the password manager (a replacement or drill project needs them).
4. Supabase → Authentication → Providers → Google: paste the client ID and secret, enable, save.

## 5. Netlify site

1. Netlify → Add new site → Import from Git → this repository. Branch `main`. Build command `npm run build`. Publish directory `dist`. (`netlify.toml` sets the same, the SPA fallback for `/auth/callback` and deep links, and security headers.)
2. Site configuration → Environment variables → add, scoped to **Builds** and the **Production** context only:
   - `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`

   Nothing else. No secret key, database password, backup credential or Google client secret goes into Netlify. The build refuses any other `VITE_` variable and any key that is not publishable, and leaves no `dist/`.
3. Build & deploy → Deploy Previews: **None** (or leave previews without the two variables, so a preview can never reach production data).
4. Deploy, then note the site host (`<site-host>`, or your custom domain).
5. Back in Supabase → Authentication → URL Configuration: **Site URL** `https://<site-host>`, **Redirect URLs** exactly `https://<site-host>/auth/callback`.
6. Back in Google → the OAuth client → Authorized JavaScript origins: `https://<site-host>`.
7. Open the site's built script (view source → the `/assets/…js` file) and confirm it names your project ref.

For local development: copy `.env.example` to `.env.local`, fill the two values with a **separate development project**, and add `http://127.0.0.1:5173` and `http://127.0.0.1:5173/auth/callback` to that project's URL settings and a development OAuth client. `npm run dev` serves the app.

## 6. Hosted access checks (once, after step 5)

With the publishable key (it is public by design) and no user token:

```sh
K='<publishable key>'; U='https://<ref>.supabase.co'
curl -s "$U/rest/v1/rpc/my_workspaces" -X POST -H "apikey: $K" -H "Content-Profile: eden_api" -H 'Content-Type: application/json' -d '{}'
#   → a permission error, no rows
curl -s "$U/rest/v1/workspaces" -H "apikey: $K" -H "Accept-Profile: eden"
#   → refused: schema eden is not exposed
curl -s "$U/graphql/v1" -X POST -H "apikey: $K" -H 'Content-Type: application/json' -d '{"query":"{__schema{types{name}}}"}'
#   → an error or no eden types (pg_graphql is removed)
```

Record pass/fail in your setup notes (private).

## 7. CI and the local public-repository guard

1. Move `docs/ci/github-actions-ci.yml` to `.github/workflows/ci.yml` in a PR from your own account (the agent's token has no workflow scope). CI runs every `check:public` rule except the deny-list over exactly the commits of the pull request or push (the event's base and head), all tests (it installs the PostgreSQL 17 client tools for the restore test) and a synthetic build with `check:dist`.
2. Create your private deny-list outside the repository, one term per line (real addresses, family and staff names, property names, plan terms). Then in your shell profile:

   ```sh
   export EDEN_DENYLIST_FILE="$HOME/<private folder>/eden-denylist.txt"
   ```

3. Once per clone: `git config core.hooksPath .githooks`. Every `git push` then runs `check:public` with the deny-list over exactly the commits that push sends, whichever branch is checked out. Reports name the file, commit and rule, never the matched text; a file whose name holds a deny-listed term is shown as `<file name withheld: deny-listed term>`.
4. Optional: GitHub → Settings → Branches → protect `main` (require the `ci` check and a PR).

## 8. Connection strings for the operator scripts

`roster:*`, `access:*`, `restore:apply` and `restore:verify` prompt for a database connection string at a hidden prompt; they never echo, store or log it.

1. Supabase → Connect → **Session pooler** (IPv4, port 5432): `postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres`.
2. Database Settings → SSL Configuration → download the CA certificate. Keep it outside the repository.
3. Append `?sslmode=verify-full&sslrootcert=<path to the certificate>` to the string. The scripts refuse a remote string without it.
4. Keep the full string in the password manager and paste it at the prompt.

## 9. Synthetic test accounts and opening the gate

The migrations seed the two workspaces (time zone `America/Chicago`) and create the access gate **closed**: until step 9.5 everyone, you included, sees no workspace. In this step only the six test accounts are enrolled; no real person signs in to Eden HQ until step 12.

1. In a private browser window per account, open the site and **Sign in with Google** once as each of the six test accounts. Each sees "Ask Hank for workspace access".
2. `npm run roster:pending` lists each Auth account without access: UUID, Google subject and verified address. Check each address is one of the six test accounts.
3. Keep a **synthetic roster** CSV in the password manager, separate from the real roster you write in step 12. Header and shape (display names are invented):

   ```text
   workspace_kind,user_id,google_subject,role,display_name
   home_building,<test 1 uuid>,<subject>,owner,SYNTHETIC Owner A
   stay_eden_ops,<test 1 uuid>,<subject>,owner,SYNTHETIC Owner A
   … the same two lines for tests 2, 3 and 4 (Owners B, C, D) …
   stay_eden_ops,<test 5 uuid>,<subject>,member,SYNTHETIC Manager
   home_building,<test 6 uuid>,<subject>,member,SYNTHETIC Helper
   ```

4. Save it to a temporary file outside the repository and run:

   ```sh
   npm run roster:apply -- <roster file> --dry-run   # prints the changes, makes none
   npm run roster:apply -- <roster file>              # one transaction, or a refusal that changes nothing
   npm run roster:show                                # read-back
   ```

   The read-back must show Owners A to D plus the Helper as a member in Home building, Owners A to D plus the Manager as a member in Stay Eden operations, and nothing else. Delete the temporary file. Every later access change is: edit the roster, then `roster:apply`. Never edit membership rows by hand. A rerun with the same file reports "No change".
5. Open the gate with the register:

   ```sh
   npm run access:open -- <register file>
   ```

   It asks for this project's connection string, and for every other register entry that is not `deleted` it asks for that project's connection string and refuses unless its gate **reads back closed**. An unreachable project, or deleted keys alone, are not enough (spec review P0-2). Then mark the project `serving` in the register.
6. As Owner A on your phone, create a synthetic project and property (`SYNTHETIC Test build`, `SYNTHETIC Test cottage`) with a few tasks: one assigned to a member, one to an outside name, one to nobody. As the Manager, add an item to the property. These are what the drill restores.
7. Check: Owner A sees both workspaces, the Manager only Stay Eden, the Helper only Home building. To close everything at once: `npm run access:close`.

## 10. Recovery: the hosted daily backup

All in the Eden HQ Google Cloud project, as its Owner. Every grant is on the named resource only; no service account gets a project-level role. `<r>` is your region (for example `us-central1`), `<p>` the project ID, `<suffix>` a random string.

1. Enable services:

   ```sh
   gcloud services enable run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
     storage.googleapis.com monitoring.googleapis.com logging.googleapis.com \
     cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```

2. Buckets:

   ```sh
   gcloud storage buckets create gs://eden-hq-backups-<suffix> --location=<r> \
     --uniform-bucket-level-access --public-access-prevention --retention-period=30d
   gcloud storage buckets update gs://eden-hq-backups-<suffix> --lifecycle-file=<lifecycle file>
   gcloud storage buckets create gs://eden-hq-backup-status-<suffix> --location=<r> \
     --uniform-bucket-level-access --public-access-prevention
   ```

   The lifecycle file (kept outside the repository) deletes objects at 31 days: `{"rule":[{"action":{"type":"Delete"},"condition":{"age":31}}]}`.
3. Service accounts (no project roles):

   ```sh
   gcloud iam service-accounts create eden-backup
   gcloud iam service-accounts create eden-backup-watch
   gcloud iam service-accounts create eden-backup-scheduler
   ```

4. Secrets, created in the Console (Security → Secret Manager) so values never touch shell history:
   - `eden-db-url`: the **session pooler** string from step 8.1 **without** the `sslmode`/`sslrootcert` part (the worker adds verify-full itself).
   - `eden-storage-key`: the project's secret key (used from Stage 2; create it now).
   - `eden-superseded-db-urls`: first version is the single line `# none`.

   Then grant the worker access on each secret:

   ```sh
   for s in eden-db-url eden-storage-key eden-superseded-db-urls; do
     gcloud secrets add-iam-policy-binding "$s" \
       --member=serviceAccount:eden-backup@<p>.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
   done
   ```

5. Bucket grants:

   ```sh
   gcloud storage buckets add-iam-policy-binding gs://eden-hq-backups-<suffix> \
     --member=serviceAccount:eden-backup@<p>.iam.gserviceaccount.com --role=roles/storage.objectCreator
   gcloud storage buckets add-iam-policy-binding gs://eden-hq-backup-status-<suffix> \
     --member=serviceAccount:eden-backup@<p>.iam.gserviceaccount.com --role=roles/storage.objectUser
   gcloud storage buckets add-iam-policy-binding gs://eden-hq-backup-status-<suffix> \
     --member=serviceAccount:eden-backup-watch@<p>.iam.gserviceaccount.com --role=roles/storage.objectViewer
   ```

6. The `age` key pair, on your Mac: `age-keygen -o <temporary file>`. Put the whole file (the private key) in the password manager, note the printed `age1…` public key, then delete the temporary file.
7. Build the image (Cloud Build; its own build identity, separate from the runtime accounts that read secrets):

   ```sh
   gcloud artifacts repositories create eden --repository-format=docker --location=<r>
   git switch main && git pull --ff-only
   gcloud builds submit --config backup/cloudbuild.yaml \
     --substitutions _IMAGE=<r>-docker.pkg.dev/<p>/eden/eden-backup:$(git rev-parse --short HEAD)
   ```

   If the build cannot push, grant the Cloud Build service account `roles/artifactregistry.writer` on the `eden` repository only.
8. Deploy the two jobs. Write an env-vars file outside the repository (YAML) holding `EDEN_BACKUP_BUCKET`, `EDEN_STATUS_BUCKET`, `EDEN_AGE_RECIPIENT` (the `age1…` key) and `EDEN_DB_CA_PEM` (the full text of the Supabase CA certificate from step 8.2; it is public). Then, with the secret **version numbers** pinned (never `latest`):

   ```sh
   IMG=<r>-docker.pkg.dev/<p>/eden/eden-backup:<tag>
   gcloud run jobs deploy eden-backup --image "$IMG" --region <r> \
     --service-account eden-backup@<p>.iam.gserviceaccount.com \
     --set-secrets EDEN_DB_URL=eden-db-url:1,EDEN_SUPERSEDED_DB_URLS=eden-superseded-db-urls:1 \
     --env-vars-file <env vars file> --max-retries 0 --task-timeout 30m
   gcloud run jobs deploy eden-backup-watch --image "$IMG" --region <r> \
     --service-account eden-backup-watch@<p>.iam.gserviceaccount.com \
     --command node --args backup/watch.mjs \
     --set-env-vars EDEN_STATUS_BUCKET=eden-hq-backup-status-<suffix>,STALE_AFTER_HOURS=26 --max-retries 0
   for j in eden-backup eden-backup-watch; do
     gcloud run jobs add-iam-policy-binding "$j" --region <r> \
       --member=serviceAccount:eden-backup-scheduler@<p>.iam.gserviceaccount.com --role=roles/run.invoker
   done
   ```

9. Schedules (UTC, so runs are always 24 hours apart):

   ```sh
   for pair in "eden-backup-daily|0 9 * * *|eden-backup" "eden-backup-watch-hourly|15 * * * *|eden-backup-watch"; do
     IFS='|' read -r name cron job <<< "$pair"
     gcloud scheduler jobs create http "$name" --location <r> --schedule "$cron" --time-zone Etc/UTC \
       --uri "https://run.googleapis.com/v2/projects/<p>/locations/<r>/jobs/$job:run" --http-method POST \
       --oauth-service-account-email eden-backup-scheduler@<p>.iam.gserviceaccount.com \
       --oauth-token-scope https://www.googleapis.com/auth/cloud-platform
   done
   ```

10. Alerts. Create an email notification channel to yourself (Monitoring → Alerting → Edit notification channels), then two log-based metrics:

    ```sh
    gcloud logging metrics create eden_backup_alerts \
      --log-filter='resource.type="cloud_run_job" AND (jsonPayload.message="eden_backup_stale" OR jsonPayload.message="eden_superseded_was_open")'
    gcloud logging metrics create eden_backup_watch_ok \
      --log-filter='resource.type="cloud_run_job" AND jsonPayload.message="eden_backup_watch_ok"'
    ```

    Run `eden-backup-watch` once by hand (`gcloud run jobs execute eden-backup-watch --region <r>`) so the heartbeat metric exists, then create three alert policies in Monitoring → Alerting, each to your channel:
    1. `logging/user/eden_backup_alerts` above 0 (stale backup or a superseded project found open).
    2. Cloud Run Job → Completed execution count (`run.googleapis.com/job/completed_execution_count`), filter `result = failed`, jobs `eden-backup` and `eden-backup-watch` (and the Stage 2 rehearsal job when it exists), above 0.
    3. Metric absence: `logging/user/eden_backup_watch_ok` absent for 3 hours.
11. A status monitor, if you want one: only Cloud Run Viewer, Monitoring Viewer, and Storage Object Viewer on the **status** bucket.

**Acceptance (Stage 1 scheduled backup).** With your Mac off, two consecutive `eden-backup-daily` runs each write a set ending in `sets/<timestamp>/COMPLETE`; `status/latest.json` then shows the second set's recovery point. `eden-backup` cannot read, list, overwrite or delete objects in the backup bucket (try `gcloud storage ls` impersonating it: refused). Running the watch with `STALE_AFTER_HOURS=1` emails the stale alert (set it back to 26); pausing `eden-backup-watch-hourly` for 3 hours emails the heartbeat alert (resume it).

## 11. Restore drill (synthetic data, before any real person)

The Stage 1 drill restores a set taken while production held only the step 9 test accounts and synthetic projects, so its copy may be opened. A drill of a set with real data stops after step 11.7 and is never opened. At most one Eden project serves app users at any time, so production is closed while the drill copy is open, and reopened afterwards.

*Before the drill: the snapshot, then the changes it must not contain.*

1. Wait for a set that ends in `sets/<timestamp>/COMPLETE` (step 10), taken after step 9.6. Run `npm run roster:show` on production and confirm only the six test accounts are listed: the set then holds no real person.
2. Then, in the synthetic roster, downgrade Owner C to `member` in `stay_eden_ops` and delete the Helper's `home_building` line. Apply it to production (`roster:apply`, `roster:show`). These changes are newer than the set: the drill must bring them back from the roster, not from the restored rows.

*Restore, gate closed.*

3. Create a new, isolated Supabase project `eden-hq-drill` in your organization (no Netlify site points at it). Add it to the register: `<drill ref>,<drill publishable key>,drill,closed`.
4. Download the set (`gcloud storage cp -r gs://eden-hq-backups-<suffix>/sets/<timestamp> <private folder>`) and decrypt each file on your Mac into one folder outside the repository: `age -d -i <private key file> eden.dump.age > eden.dump`, and the same for `auth.dump`, `migrations.dump`, `roles.sql` and `manifest.json`.
5. Restore into the drill with its session-pooler string (step 8 form):

   ```sh
   npm run restore:apply -- <decrypted set folder>
   ```

   It checks every file against the manifest (present, recorded size and hash) and the client tools (17 or later), refuses a database that already holds Eden, then runs each step (remove GraphQL, Eden roles, Auth rows, Eden schemas and rows, the membership helper's owner, the migration ledger) and **stops at the first error**. On a failure it names the step: delete the drill project and start again (rerun with `--show-errors` to see the tool's message on your terminal only). The access gate arrives **closed**: its data is never in a set.
6. Authentication → Users on the drill: sign out every user (sets hold no sessions, so there should be none).
7. `npm run restore:verify -- <decrypted set folder>` with the drill's string. Every line must read PASS: the set files, migrations, the table list, every row count, Auth counts, the closed gate, row-level security on every Eden table, the membership helper owned by its own role, and the restored grants and policies. It prints names only, never values.
8. Confirm the gate holds (the positive closed-gate check): set the drill's Data API **Exposed schemas** to exactly `eden_api`, then run the step 6 `curl` checks with the drill's URL and publishable key (no rows, `eden` refused), and over the direct connection:

   ```sh
   psql "<drill string>" -c "begin; set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"<Owner A uuid>\",\"role\":\"authenticated\"}', true); select count(*) from eden_api.my_workspaces(); rollback;"
   #   → 0: the restored owner gets no workspace while the gate is closed
   ```

   A drill of real data stops here: `access:close`, delete keys and project as in step 11.14.

*Close production, reach the drill, apply the current roster, open.*

9. Close production for the drill: `npm run access:close` with production's string; it reads the gate back closed. Then mark production `closed` in the register. The test accounts now see no workspace on the production site.
10. Point a local app at the drill only:
    - Drill → Authentication → Providers → Google: the same client ID and secret (step 4.3); every other provider off. URL Configuration: Site URL `http://127.0.0.1:5173`, Redirect URLs `http://127.0.0.1:5173/auth/callback`.
    - Google → the OAuth client: add the redirect URI `https://<drill ref>.supabase.co/auth/v1/callback` and the JavaScript origin `http://127.0.0.1:5173`.
    - In your checkout: `.env.local` with `VITE_SUPABASE_URL=https://<drill ref>.supabase.co` and the drill's publishable key, then `npm run dev`.
11. Roster, from the **current** synthetic roster (never the restored rows): `npm run roster:apply -- <roster file> --dry-run`, then for real, then `npm run roster:show`. It must show Owner C as a member in Stay Eden and no Helper in Home building.
12. `npm run access:open -- <register file> --synthetic-data` with the drill's string. It refuses unless production (and every other entry not `deleted`) reads back closed. Mark the drill `serving` while it is open.
13. Check at `http://127.0.0.1:5173`, one private window per account: Owner C sees Stay Eden as a member (no New property, no Archive) and Home building as an owner; the Helper sees "Ask Hank for workspace access"; the Manager sees only Stay Eden; Owner A sees the restored synthetic project and property. Record pass or fail for each.

*Exit (pass, fail or abandoned), then reopen production.*

14. `npm run access:close` with the drill's string (it reads back closed); Drill → Project Settings → API Keys: delete its publishable and secret keys; delete the drill project; mark it `deleted` in the register. In Google, remove the drill callback and the `127.0.0.1` origin from the OAuth client, and clear the drill values from `.env.local`.
15. Reopen production: `npm run access:open -- <register file>` with production's string. It skips the `deleted` drill and refuses if any other entry does not read back closed. Mark production `serving`. Sign in through the production site as Owner A and check one workspace.

Record the recovery point, elapsed time, register changes and pass/fail in your private recovery log.

## 12. Real users

Only after the drill passes. From here on production holds real data, so a later drill never opens its copy (step 11 stops at 11.8).

1. Ask each real person (the four owners and the cleaning manager) to open the site and **Sign in with Google** once. Each sees "Ask Hank for workspace access".
2. `npm run roster:pending` lists them: check each address is who you expect.
3. Write the **real roster** in the password manager (the shape in step 9.3, real names): an `owner` line in **both** workspaces for each of the four owners, and one `member` line in `stay_eden_ops` for the manager. Leave out every test account: `roster:apply` then revokes them.
4. `roster:apply -- <roster file> --dry-run`, then for real, then `roster:show`. The read-back must show four owners in Home building, the same four owners plus the manager as the only member in Stay Eden operations, the test accounts only as revoked rows, and nothing else.
5. As an owner, archive the synthetic project and property (**Archive project** on each). Keep the synthetic roster in the password manager for future drills on a synthetic copy.

## 13. First real project

Sign in, open Home building, **New project**, and type in the first tasks from your build plan by hand. Leave dates and assignees empty where unknown. A typo in a project's name is fixed with **Edit project** (owners only).
