# Ourtopia

Register, verify your email, and create a private Community as its first administrator.

## Run the app locally

Use Node.js 22.16 or later, Docker Desktop with Linux containers, and Chrome. Run commands from this checkout.

1. Run `npm ci`.
2. Run `npm run db:start`. The disposable project is `ourtopia-issue-2`. Its API uses port 55321 and its database uses 55322.
3. Run `node scripts/verify/local-env.mjs`. The command writes ignored app and test environment files without printing credentials.
4. Run `npm run dev`. Open `http://127.0.0.1:5173`.
5. Create an account. Open its verification email in the local inbox at `http://127.0.0.1:55324`.

The local Studio uses port 55323. Auth callbacks return to `/auth/callback`. Password recovery uses the same local inbox. Environment variable names and placeholders are in [.env.example](.env.example). Only the Supabase URL and anonymous key enter the browser bundle.

## Verify this slice

Run these commands against the disposable local backend.

```sh
npm run lint
npm run typecheck
npm run build
npm run verify:secrets
node scripts/verify/migrations.mjs --disposable-project ourtopia-issue-2
npm run test:server -- tests/server/issue-2.test.ts
npm run test:rls -- tests/rls/issue-2.test.ts
npm run test:journey -- tests/journeys/issue-2.spec.ts
npm run verify:perf -- --issue 2 --base 2af28e7a06db971e8e5fbbf01b0b8bda07f81c76 --head HEAD_SHA --pairs 10
```

Replace `HEAD_SHA` with `git rev-parse HEAD`. On Linux, first run `npx playwright install --with-deps chromium`. On Windows the journeys use installed Chrome. Set `CHROME_PATH` to override the executable. Use `--project desktop` or `--project mobile` to select a viewport, and `--grep "lane 3 "` to replay one scenario. The complete suite runs ten scenarios on both viewports. It follows real verification and recovery emails.

Migration verification resets only the named disposable project after checking its container port. It proves clean replay and upgrade from the source-only predecessor with a persisted sentinel. Run it before browser tests because it removes local test accounts and Communities. Use `npx supabase migration up --local` to apply additive migrations without resetting a working local backend.

Private receipts, screenshots, and traces stay under ignored `.pilot-evidence/`. Traces can contain test sessions. Do not commit them. `EVIDENCE_DIR` can choose another private directory for receipts and browser artifacts. CI runs the same gates without publishing sessions or environment files.

Run `node scripts/verify/database-types.mjs` after schema changes to regenerate the client types. On Windows, use `npm.cmd` when passing script arguments through PowerShell.

## Extend the Community boundary

The browser calls `create_community(p_intent_id, p_name, p_description)`. One Postgres transaction verifies the current Auth user, creates the Community and active administrator, appends `community_created`, and saves the result by actor and intent. Identical retries return that result. Different payloads conflict. A retry after membership revocation fails. Names and descriptions use literal request semantics, and the UI trims before sending them.

Clients have read access through active-membership RLS and no writes to command-owned tables. `is_active_member(community_id)` is the guard for later Community activity. Community identity is immutable to clients. Realtime exposes authorized event hints; clients read content through RLS. No file upload or Storage bucket is needed by this slice. Creation has no time-sensitive recipient notice or reputation effect, so it creates neither an email outbox entry nor a reputation record. Supabase Auth owns verification and recovery delivery.

The UI uses shadcn preset `b4iB4lDuK`, generated with `shadcn init --template vite --preset b4iB4lDuK --yes`, and a branded responsive shell. [components.json](components.json) records its resolved component settings.

## Stop or roll back local work

Stop Vite with Ctrl+C. Run `npx supabase stop --project-id ourtopia-issue-2` to stop this backend. Keep its volumes to preserve local state. Reverting the application commit rolls back the app. For a disposable database, switch to the predecessor checkout and reset its local schema. Shared environments require a reviewed forward migration; never delete or rewrite an applied migration.
