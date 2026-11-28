# Eden HQ

Internal projects and tasks for two separate workspaces: **Home building** and **Stay Eden operations**. Phone-first, Google sign-in only, about ten users. Money is visible to workspace owners only, enforced in Postgres.

- Spec: [docs/SPEC.md](docs/SPEC.md) · Open questions: [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)
- Stage 1 (this build): [docs/STAGE1.md](docs/STAGE1.md) · Hank's setup: [docs/SETUP.md](docs/SETUP.md)
- Agent rules: [CLAUDE.md](CLAUDE.md)

## Stack

Supabase Postgres (row-level security on every table; the Data API exposes only `eden_api`), Supabase Auth with Google, a static Vite front end on Netlify. Hosted backups run as Cloud Run jobs (`backup/`). The browser build reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Commands

```sh
npm ci
npm test                      # database, screen and script tests (local Postgres 17 via PGlite; no Docker)
npm run dev                   # local app; needs .env.local (see .env.example)
npm run build                 # build guard, then Vite
npm run check:dist            # scan the build
npm run check:public          # before every push (needs EDEN_DENYLIST_FILE)
npm run --silent inventory:print > tests/db/inventory.expected.mjs   # after a migration; review the diff
```

Operator scripts (Hank only; they prompt for a connection string and never store it): `roster:pending`, `roster:apply`, `roster:show`, `access:open`, `access:close`, `restore:verify`.

This repository is public. Use synthetic data only.
