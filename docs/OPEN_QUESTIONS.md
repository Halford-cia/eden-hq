# Open questions for Hank

The workspace split, four owners, Google-only sign-in, financial privacy and v1 scope are settled in [the specification](SPEC.md). These inputs can arrive as their stage approaches. Keep account addresses, the build plan and real property names in private setup records.

| When | Input needed from Hank | Working default in the spec |
| --- | --- | --- |
| Stage 1 setup | Which verified Google accounts correspond to the four owners and the cleaning manager? Which accounts, if any, should be added next? | Provision only identities Hank confirms. Give the four owners both workspaces and the manager membership in Stay Eden only. |
| Stage 1 setup | Which Supabase organization/region, Netlify site hostname and Google Cloud project will Hank use? | Use Hank-controlled infrastructure. Copy the actual URLs into the OAuth settings during setup. |
| First project | What project name, tasks, trades and dates from the rough plan should Hank enter first? | Start empty, allow unassigned/undated work and enter the plan by hand. |
| Before live data | Which protected destination and operator will hold the database and receipt backups? Do the proposed recovery targets meet the family’s needs? | Daily matched sets, 30 days’ retention, at most 24 hours of data loss, recovery within one business day, quarterly restore drill. |
| Stage 2 | Which category labels does Hank want in the first build? | Start with manually entered categories and put blank categories under Uncategorized. Use USD cents. Show variance on tasks with both amounts and display coverage counts. |
| Stage 4 | What property display names and calendar time zone should the manager see? | One project per property. Use America/Chicago for the pilot until Hank supplies the workspace time zone. |
