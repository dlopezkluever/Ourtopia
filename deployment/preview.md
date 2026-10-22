# P26 shared-environment preview

## Prepared change

The future pilot would use one dedicated hosted Supabase project, one HTTPS static PWA origin, server-side Edge Functions, configured Auth redirects, private Storage buckets, narrow Realtime hint publication, scheduled database and notification work, an email provider connection, and Stripe TEST-mode checkout and webhooks. The currently checked-in schema requires the 30 ordered migrations in [migration-diff.md](migration-diff.md). This branch adds no migration and does not change any hosted resource.

The app build would contain only the hosted Supabase URL and publishable anonymous key. The service-role credential, email API key, Stripe TEST secret, webhook signing secret, and worker credential remain in Supabase secret storage or Vault. Billing status remains informational and never grants Community access. Production charging is excluded.

## Expected shared-environment changes after authorization

1. A dedicated Supabase project receives all pending repository migrations and their RLS, Storage, Realtime, extension, and Cron definitions.
2. Auth site URL and exact callback allowlist are set to the chosen HTTPS app origin and `/auth/callback`.
3. Four Edge Functions are deployed: `due-work`, `notifications`, `stripe-checkout`, and `stripe-webhook`.
4. Supabase Function secrets and Vault dispatcher values are configured from the names in [README.md](README.md).
5. A provider sender is verified and connected for transactional notices.
6. A static host serves the PWA over HTTPS with the hosted public Supabase values and SPA fallback.
7. Stripe receives TEST-mode product/price configuration and one webhook endpoint for subscription lifecycle events.
8. Pilot test fixtures and real user-created Community records are added only during authorized verification. No fabricated milestone population is part of the deployment.

## Authorization points

Before any shared write, the operator must explicitly approve the target project, migration, function deployment, email-provider connection, static hosting/domain configuration, and Stripe TEST-mode account actions. The operator must provide or authorize access to the project ref, domain/host, Auth origin, provider sender and API credentials, Stripe TEST product/price and endpoint, and the secret store. Values are entered directly into provider interfaces, never sent in chat or committed.

Separate authorization is required before running live HTTPS browser lanes that create accounts or records, delivering real email, performing a Stripe TEST checkout/webhook drill, or conducting the screen-reader pass. No request in this round authorizes those actions. Approval must be recorded in the program's `gates.md` before deployment or shared migration.

## Rollback preview

Application rollback is a static-host release rollback to the previously approved build. Database changes use a forward corrective migration; merged migrations are immutable. Disable or roll back Function versions if the issue is isolated to a worker and retain durable outbox or webhook receipts for retry. Do not delete project data or attempt a shared database reset. Keep the pre-migration restore point until the forward fix and pilot smoke checks pass.
