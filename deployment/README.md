# P26 HTTPS pilot deployment runbook

Document map: this file is the code-referenced runbook and environment inventory. [docs/pilot/DEPLOYMENT.md](../docs/pilot/DEPLOYMENT.md) is the hosting choice, configuration summary and rollback table. [docs/pilot/OPERATOR-PREVIEW.md](../docs/pilot/OPERATOR-PREVIEW.md) is the ordered operator command list with authorization points. [migration-diff.md](migration-diff.md) is the migration inventory. [docs/pilot/ACCEPTANCE-MATRIX.md](../docs/pilot/ACCEPTANCE-MATRIX.md) maps scenarios to named local tests and [evidence-matrix.md](evidence-matrix.md) maps them to the live HTTPS receipts still owed by each P26 lane.

## Status and boundary

This packet prepares a future pilot deployment. No hosted project, domain, provider account, Stripe account, secret, or shared database has been created or changed. Every live action below is **POST-AUTHORIZATION**. Stop before creating or changing a shared environment until the operator approves [the operator preview](../docs/pilot/OPERATOR-PREVIEW.md) and provides the values named there through provider secret stores.

The app is a static Vite PWA. Supabase Edge Functions are `due-work`, `notifications`, `stripe-checkout`, and `stripe-webhook`. The current migrations already schedule the due database work and notification dispatcher. The dispatcher remains inert until its two Vault values are configured. Confirm hosted Supabase enables the required `pg_cron`, `vault`, `pg_net`, and `pgcrypto` extensions before migration replay.

## Ordered setup after authorization

1. **Create the hosted Supabase project.** Use a dedicated pilot project and region approved by the operator. Record its project ref and HTTPS API URL. Keep production billing disabled. Do not put database passwords or service-role credentials in source, build variables, tickets, or shell history.

2. **Apply Auth settings.** Set the site URL to the exact HTTPS pilot origin. Add the exact callback URL `https://pilot.example.invalid/auth/callback` and any explicit preview origins separately. Configure email confirmation, password recovery, and allowed redirect URLs. Do not add wildcard origins. `src/features/auth/AccountForm.tsx` and `src/features/auth/RecoveryForm.tsx` use Supabase Auth; `src/app/App.tsx` consumes the callback session.

3. **Apply migrations to a disposable hosted rehearsal project first.** Compare `supabase/migrations/` against that project's migration history, take a recoverable backup, then use `npx supabase link --project-ref <approved-project-ref>` followed by `npx supabase db push`. The ordered inventory and forward-only rollback policy are in [migration-diff.md](migration-diff.md). Never edit a migration after merge.

4. **Check Storage.** Migrations create private buckets `listing-images`, `item-need-images`, and `exchange-evidence` and their scoped policies. Confirm all remain non-public. Exercise allowed owner/member paths and denied anonymous, foreign, unrelated, removed, and expired-obligation paths before accepting the pilot. Call sites are `src/features/listings/ListingImages.tsx`, `src/features/item-needs/NeedImage.tsx`, `src/features/evidence/HandoffPhotos.tsx`, and `src/features/evidence/EvidenceRecovery.tsx`.

5. **Check Realtime.** The migrations add only the hint tables intended for publication, including membership access and notification hints. Do not publish private content tables. Verify subscriptions re-read through RLS and that membership change, channel error, focus, and visibility refreshes clear stale cached Community data. Relevant code is `src/features/communities/CommunityHome.tsx` and `src/features/pwa/useProtectedCacheInvalidation.ts`.

6. **Set Edge Function environment.** Use the names-only files under `deployment/functions/` as checklists. Set secrets in Supabase Function secrets, never in Vite variables. `due-work` calls guarded due RPCs and `notifications`; `notifications` calls guarded outbox RPCs and the email API; `stripe-checkout` creates TEST-mode sessions; `stripe-webhook` verifies the raw signed body and records/reconciles durable receipts. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are read by `supabase/functions/due-work/index.ts` and `supabase/functions/notifications/index.ts`. The checkout and webhook read all `stripe-checkout.env.example` names through `supabase/functions/stripe-checkout/config.ts`.

7. **Deploy the Functions.** After the project link and secrets are approved, run:

   ```sh
   npx supabase functions deploy due-work --project-ref <approved-project-ref>
   npx supabase functions deploy notifications --project-ref <approved-project-ref>
   npx supabase functions deploy stripe-checkout --project-ref <approved-project-ref>
   npx supabase functions deploy stripe-webhook --no-verify-jwt --project-ref <approved-project-ref>
   ```

   Keep JWT verification enabled for `due-work`, `notifications`, and `stripe-checkout`; those handlers require a service-role or authenticated bearer. Disable gateway JWT verification only for `stripe-webhook`, because Stripe sends its own `Stripe-Signature` header and the handler verifies the raw body. Set per-function secrets with the Supabase secret manager, not command arguments that may be logged.

8. **Configure Cron and Vault.** Existing migrations schedule `expire_due_item_approvals`, `process_due_item_returns`, `process_due_help_completions`, and `process_due_disciplinary_votes` every minute. The `ourtopia-notification-delivery` schedule calls `private.dispatch_due_notifications()` every minute. Store Vault name `notification_worker_url` as `https://<approved-project-ref>.supabase.co/functions/v1/due-work` and `notification_worker_token` as the service-role credential. These are Vault names, not environment variable names. Confirm job success and retry rows after a controlled test. See `supabase/functions/notifications/README.md` and migrations `20261015190200_issue_3_due_work.sql`, `20261016170000_issue_6_reservations.sql`, `20261017180000_issue_9_returns.sql`, `20261017190100_issue_13_help_completion.sql`, and `20261020120000_issue_21_disciplinary_votes.sql`.

9. **Configure email.** Create or authorize an email provider separately, verify the sender identity and callback domain, then place `EMAIL_API_URL`, `EMAIL_API_KEY`, and `EMAIL_FROM` in the `notifications` Function secret store. `supabase/functions/notifications/index.ts` reads these names. The provider must honor the outbox idempotency key, or reconcile accepted sends before retry. Confirm delivery and failure recovery without including private message or evidence content.

10. **Configure Stripe TEST mode only.** Checkout currently sends Stripe inline price data for a `$5 USD/month` subscription named `Ourtopia test subscription`; no dashboard Product or Price ID is read by the code (`supabase/functions/stripe-checkout/provider.ts`). Confirm the resulting TEST Checkout Session has that amount and cadence. If operations require a pre-created Price ID, that needs a code change and migration before this runbook can use it. Create a TEST webhook endpoint at `https://<approved-project-ref>.supabase.co/functions/v1/stripe-webhook` for `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Store the `sk_test_…` as `STRIPE_TEST_SECRET_KEY` and the endpoint's `whsec_…` as `STRIPE_WEBHOOK_SECRET` in the Stripe Functions' secret store. Set `STRIPE_APP_ORIGIN=https://pilot.example.invalid`. The code returns to `https://pilot.example.invalid/billing?checkout=returned` on success and `https://pilot.example.invalid/billing?checkout=canceled` on cancel. Do not put secrets into `stripe listen` arguments or logs. A future local-only drill uses `stripe listen --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted --forward-to http://127.0.0.1:56261/functions/v1/stripe-webhook`. It prints a temporary signing secret. Enter that value only into the ignored local `.env.stripe.local` configuration; never copy it into this committed example. The live deployed checkout and webhook drill remains post-authorization.

11. **Build and host the static PWA over HTTPS.** Build with `VITE_SUPABASE_URL=https://<approved-project-ref>.supabase.co` and `VITE_SUPABASE_ANON_KEY=<publishable-anon-key>` set only in the hosting build environment. `src/lib/supabase/client.ts` reads these two browser-visible values. Publish the `dist/` directory to an approved static host with HTTPS, SPA fallback to `/index.html`, and immutable hashed asset caching. Never expose `SUPABASE_SERVICE_ROLE_KEY`, Stripe keys, or email credentials in the app build.

12. **Check the PWA.** On the HTTPS origin, inspect `/manifest.webmanifest`, icon paths, service-worker registration at `/manifest-service-worker.js`, scope `/`, offline shell, install prompt, and update behavior. Code lives in `public/manifest.webmanifest`, `public/manifest-service-worker.js`, `public/manifest-offline.html`, `src/service-worker.ts`, and `src/features/pwa/PwaStatus.tsx`. Verify the installed app and recovery behaviors on a real mobile browser after the live gate is approved.

13. **Run authenticated evidence lanes.** Use [`.env.example`](.env.example) as a names-only checklist, then provide the needed values directly to the test process or its CI secret store. The names are `PILOT_BASE_URL`, `PILOT_SUPABASE_URL`, `PILOT_ANON_KEY`, `PILOT_SERVICE_ROLE_KEY`, and where unverified test actors or Stripe worker JWT signing are needed `PILOT_JWT_SECRET`. The P26 journey reads `PILOT_BASE_URL`; the backend helper reads the other `PILOT_*` values. Existing journeys use `TEST_APP_URL` for their HTTPS base URL through `playwright.config.ts`. These tests create records and accounts, so use only the authorized, dedicated pilot and test-only identities. Run the ten P26 lanes on desktop and mobile and preserve evidence privately.

14. **Complete live checks.** Authenticated mobile and desktop HTTPS journeys, live Stripe TEST checkout/failure/cancel/retry, real email delivery and retry, actor-boundary probes, screen-reader review, and persisted-record reconciliation require a separate explicit operator authorization. Track each receipt in [evidence-matrix.md](evidence-matrix.md). A checklist or local CI pass is not a live receipt.

## Environment variable inventory

| Name | Set in | Secret? | Read by |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | static host build environment; ignored local `.env.local` | No | `src/lib/supabase/client.ts`, `src/features/billing/model.ts`, `supabase/functions/stripe-checkout/local-env.mjs`, `supabase/functions/notifications/local.ts`, `scripts/verify/backend.ts` |
| `VITE_SUPABASE_ANON_KEY` | static host build environment; ignored local `.env.local` | No, publishable | `src/lib/supabase/client.ts`, `src/features/billing/model.ts`, `scripts/verify/backend.ts` |
| `SUPABASE_URL` | `due-work`, `notifications`, and billing Function environment | No | `supabase/functions/due-work/index.ts`, `supabase/functions/notifications/index.ts`, `supabase/functions/stripe-checkout/config.ts` |
| `SUPABASE_ANON_KEY` | billing Function environment | No, publishable | `supabase/functions/stripe-checkout/config.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | `due-work` and `notifications` Function secrets; ignored local CI `.env.test.local` | Yes | `supabase/functions/due-work/index.ts`, `supabase/functions/notifications/index.ts`, `supabase/functions/notifications/local.ts`, `scripts/verify/backend.ts` |
| `EMAIL_API_URL` | `notifications` Function environment | No | `supabase/functions/notifications/index.ts` |
| `EMAIL_API_KEY` | `notifications` Function secrets | Yes | `supabase/functions/notifications/index.ts` |
| `EMAIL_FROM` | `notifications` Function environment | No | `supabase/functions/notifications/index.ts` |
| `STRIPE_WORKER_JWT` | billing Function secret environment | Yes | `supabase/functions/stripe-checkout/config.ts` |
| `STRIPE_TEST_SECRET_KEY` | billing Function secret environment; isolated billing CI secret store; ignored local Stripe config | Yes, TEST mode only | `supabase/functions/stripe-checkout/config.ts`, `supabase/functions/stripe-checkout/ci.mjs`, `supabase/functions/stripe-checkout/verification.ts`, `supabase/functions/stripe-checkout/local-env.mjs` |
| `STRIPE_WEBHOOK_SECRET` | billing Function secret environment; ignored local Stripe config | Yes | `supabase/functions/stripe-checkout/config.ts`, `supabase/functions/stripe-checkout/ci.mjs`, `supabase/functions/stripe-checkout/verification.ts`, `supabase/functions/stripe-checkout/local-env.mjs` |
| `STRIPE_APP_ORIGIN` | billing Function environment | No | `supabase/functions/stripe-checkout/config.ts` |
| `PILOT_BASE_URL` | local/CI test process environment | No | `tests/journeys/issue-26.spec.ts` |
| `PILOT_SUPABASE_URL` | local/CI test process environment | No | `scripts/verify/backend.ts` |
| `PILOT_ANON_KEY` | local/CI test process environment | No, publishable | `scripts/verify/backend.ts` |
| `PILOT_SERVICE_ROLE_KEY` | isolated test process secret store | Yes | `scripts/verify/backend.ts` |
| `PILOT_JWT_SECRET` | isolated test process secret store, only where signing is needed | Yes | `scripts/verify/backend.ts` |
| `TEST_APP_URL` | local/CI test process for existing suites using the hosted app URL | No | `playwright.config.ts` |
| `APP_PORT` | local dev process | No | `playwright.config.ts`, `scripts/verify/local-env.mjs`, `supabase/functions/stripe-checkout/ci.mjs`, `supabase/functions/stripe-checkout/perf.ts` |
| `TEST_MAILBOX_URL` | local verification process | No | `scripts/verify/backend.ts`, `supabase/functions/notifications/local.ts` |
| `TEST_JWT_SECRET` | ignored `.env.test.local` in local CI | Yes | `scripts/verify/backend.ts` |
| `EVIDENCE_DIR` | local/CI test process | No | `playwright.config.ts`, `scripts/verify/backend.ts`, `scripts/verify/perf.ts`, `supabase/functions/stripe-checkout/perf.ts` |
| `CHROME_PATH` | local browser process, when system Chrome is not at its default path | No | `playwright.config.ts`, `scripts/verify/perf.ts`, `supabase/functions/stripe-checkout/perf.ts` |
| `CI` | GitHub Actions environment | No | `playwright.config.ts` |
| `GITHUB_ACTIONS` | GitHub Actions environment | No | `supabase/functions/stripe-checkout/ci.mjs` |
| `STRIPE_API_KEY` | not set directly; CI maps `STRIPE_TEST_SECRET_KEY` into the Stripe CLI child process | Yes, TEST mode only | `supabase/functions/stripe-checkout/ci.mjs` |
| `BILLING_LIGHTWEIGHT` | isolated billing test process only | No | `tests/server/issue-22.test.ts` |
| `OURTOPIA_MANUAL_NOTIFICATION_DELIVERY` | controlled issue 23 local/CI drill only | No | `supabase/functions/notifications/local.ts` |

The repository `.gitignore` contains `.env*` with an explicit `.env.example` exception. It therefore excludes real root and nested environment files; confirm with `git check-ignore` before using any new path.

## Operator sequence and held gates

See [the operator preview](../docs/pilot/OPERATOR-PREVIEW.md) for the exact shared-environment commands, delta and authorization points. No deployment, hosted migration, live Stripe call, provider delivery, or hosted account work is authorized in this preparation round.
