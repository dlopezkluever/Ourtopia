# Pilot deployment configuration

This is a static PWA connected to Supabase. The pilot deployment has not been created. The operator must supply the account, project, domain, and provider credentials listed in [the operator preview](OPERATOR-PREVIEW.md).

The ordered, code-referenced runbook and the full environment-variable inventory are in [deployment/README.md](../../deployment/README.md).

## Hosting choice

Use Cloudflare Pages for the static `dist/` output. The app has no server-side rendering or Pages Functions requirement. Pages supports Git-backed builds, preview deployments, deployment rollback, and Free plan limits suitable for a one-Community pilot. Its managed hostname provides HTTPS. A custom hostname needs DNS and certificate setup. This choice is reversible because the app is a static Vite build and its Supabase connection is configured at build time. [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/) [Cloudflare Pages overview](https://developers.cloudflare.com/pages/)

Build command: `npm run build`

Build output directory: `dist`

Node version: `22.16` or later.

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the Pages production build environment. These names are browser-exposed and are not secrets. Never set a service-role key or provider key in the Pages environment.

## Environment variables

Use [pilot.env.example](../../deployment/pilot.env.example) for names and placeholders. Set values only in the named host or secret store.

| Scope | Variables | Notes |
| --- | --- | --- |
| Browser build | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Public Supabase project URL and anon key. RLS is the data boundary. |
| Smoke runner | `PILOT_BASE_URL` | HTTPS app URL. Pass the anon key through `VITE_SUPABASE_ANON_KEY`. |
| Edge Function shared | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase URL and service-role secret. Set only in Supabase Function secrets. |
| Notifications Function | `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | Resend-compatible HTTP email endpoint, API key, and verified sender. The provider must honor `Idempotency-Key` for the retry period. |
| Stripe Checkout and webhook Functions | `STRIPE_WORKER_JWT`, `STRIPE_TEST_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_APP_ORIGIN` | Test-only Stripe key, verified webhook signing secret, worker JWT, and HTTPS app origin. Never configure a live Stripe key. |
| Supabase Auth | Dashboard site URL and redirect allow list | Configure as URLs, not environment variables. |

Do not add any hosted secret to a tracked file, build argument, browser variable, log, screenshot, or public evidence artifact.

## Supabase Auth URLs

Set the Auth **Site URL** to the final HTTPS origin, for example `https://pilot.example.org`.

Add this exact callback to the redirect allow list:

```text
https://pilot.example.org/auth/callback
```

Keep local and preview URLs out of the production allow list unless the operator needs them for a named test. Do not use a wildcard callback.

## Functions, email, and Stripe test webhooks

Deploy these existing Supabase Edge Functions:

- `due-work`
- `notifications`
- `stripe-checkout`
- `stripe-webhook`

Deploy `stripe-webhook` with `--no-verify-jwt` (Stripe authenticates by `Stripe-Signature`; the handler verifies the raw body) and keep gateway JWT verification on the other three. Configure the secrets from the Edge Function row above. `due-work` and `notifications` use the service-role secret for server-to-server calls. Set the notification dispatcher Vault values `notification_worker_url` and `notification_worker_token` to the deployed `due-work` HTTPS URL and its bearer credential. Keep both values in Supabase Vault.

Configure the email provider with a verified sender in `EMAIL_FROM`. Send through the existing `notifications` function. Preserve its durable outbox retry and idempotency behavior. A provider success means the provider accepted the message, not that the recipient read it.

Configure a Stripe **test-mode** webhook at:

```text
https://PROJECT_REF.supabase.co/functions/v1/stripe-webhook
```

Subscribe only to `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Store the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`. Checkout sends inline price data for a `$5 USD/month` TEST subscription; the code reads no Stripe Price ID. Do not enable live mode or configure live billing.

## Database services already defined by migrations

Apply the migrations in the order listed in [the operator preview](OPERATOR-PREVIEW.md). They create the private Storage buckets `listing-images`, `exchange-evidence`, and `item-need-images`, plus their object policies. Do not make these buckets public.

The migrations add `community_events`, `membership_access_hints`, and `notification_hints` to `supabase_realtime`. Realtime messages are IDs or access hints only. Clients must re-read content through RLS.

The database migrations schedule these functions every minute with `pg_cron`:

| Job | Function |
| --- | --- |
| `ourtopia-notification-delivery` | `private.dispatch_due_notifications()` |
| `ourtopia-item-approval-expiry` | `public.expire_due_item_approvals()` |
| `ourtopia-item-return-deadlines` | `public.process_due_item_returns()` |
| `ourtopia-help-completion-deadlines` | `public.process_due_help_completions()` |
| `ourtopia-disciplinary-vote-deadlines` | `public.process_due_disciplinary_votes()` |

The notification job needs its Vault URL and bearer token before it can call `due-work`. Confirm that each job exists after migration and that the worker endpoint responds only to authorized requests.

## One real Community

Do not seed Communities or people with SQL. After deployment, an operator-controlled verified account creates `Richmond Mutual Aid Collective` through the product UI. Invite Bob through the UI, have Bob verify his own account and request membership, then approve Bob through the UI. Run no bulk bootstrap and create no synthetic participation. The Alice and Bob acceptance run must use records created through the guarded product commands.

## Rollback

| Layer | Rollback |
| --- | --- |
| Static PWA | Roll back to the previous successful Pages deployment. If needed, remove the Pages project after preserving its build receipt. |
| Browser configuration | Restore the previous build variables and redeploy. A new build is required because Vite embeds these values. |
| Supabase Functions | Redeploy the prior function source version. Keep the database schema until code rollback is complete. |
| Auth URLs | Restore the previous Site URL and exact redirect allow list. |
| Email | Disable the notification email provider secret or restore the prior endpoint. Outbox entries remain available for retry. |
| Stripe test webhook | Disable the test endpoint in Stripe. Keep receipt rows for audit. |
| Database | Do not roll back by dropping schema or editing applied migrations. Roll forward with a reviewed corrective migration. A disposable local database may be reset to its predecessor. |
| Community data | Keep the real Community and its records. Do not delete shared data as a rollback method. Suspend access through existing product controls if the pilot must stop. |
