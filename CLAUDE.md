# Eden HQ agent instructions

Read [the v1 specification](docs/SPEC.md) before changing behavior. Hank’s product decisions are recorded there. Use [open questions](docs/OPEN_QUESTIONS.md) for outstanding inputs and proposed defaults.

- Keep secrets, real Google identities, property details, receipts and budget data out of git, issues, PRs, fixtures and logs. Use synthetic test data. Configure the browser’s Supabase URL and publishable key through Netlify build environment variables. Keep privileged Supabase keys and the Google client secret out of the browser bundle.
- Require active membership in the row’s workspace for every app read or write. Enable Postgres RLS on every application table in the migration that creates it. Cover Storage objects with matching private-bucket policies. Validate existing and proposed rows on writes, including parent scope.
- Only active owners of the specific workspace may receive or change money data. Keep amounts, financial vendor, category, payment state, totals, audit history and receipt metadata in owner-only relations and operations. Apply the same boundary to exports, images and derived results. Preserve a database-generated, append-only record of every financial edit.
- Keep vendors and subcontractors as recorded assignees in v1. Google sign-in grants an identity. Only provisioned memberships grant access.
- Make every change on a branch and submit a pull request. Hank merges. Run the relevant tests before merge and record the results in the PR. For permission changes, test actual database/API requests as an owner, a member in the same workspace, someone outside it and a signed-out caller. For money or receipt changes cover exports, file access, audit and restore as affected.
