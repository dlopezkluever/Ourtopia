# Operator preview

This preview lists the shared-environment commands and settings in order. The host has no hosted-service credentials, so no command below has been run. The operator must approve and execute the shared writes. No Community, member, listing, or Exchange data is seeded by these steps.

## 1. Prepare the operator shell

Use a clean clone at the exact reviewed PR head. The example assumes PowerShell and a project reference stored only in the current shell.

```powershell
git checkout mvp/issue-26
npm ci
$env:SUPABASE_PROJECT_REF = 'replace-with-project-ref'
```

Expected output: dependencies install successfully and the project reference remains only in shell state.

## 2. Create or select the Supabase project

Create the project in the Supabase dashboard, choose the pilot region, save its database password in the operator secret manager, and record the project reference. Do not paste a database password into this repository or a command line.

```powershell
npx supabase login
npx supabase link --project-ref $env:SUPABASE_PROJECT_REF
```

Expected output: the CLI reports that it linked the selected project. Stop if the project reference is not the intended pilot project.

## 3. Review and dry-run every migration

The repository has no new issue-26 migration. Apply the current source migrations in timestamp order. The exact list at this source head is:

1. `20261015010000_issue_2_community.sql`
2. `20261015020000_issue_2_membership_access_hints.sql`
3. `20261015190000_issue_3_membership.sql`
4. `20261015190100_issue_3_delivery.sql`
5. `20261015190200_issue_3_due_work.sql`
6. `20261015201500_issue_4_reputation.sql`
7. `20261015210000_issue_15_messages.sql`
8. `20261016070000_issue_5_listings.sql`
9. `20261016090000_issue_12_help.sql`
10. `20261016150000_issue_14_vouches.sql`
11. `20261016160000_issue_22_billing.sql`
12. `20261016170000_issue_6_reservations.sql`
13. `20261016231500_issue_23_delivery_console.sql`
14. `20261017021000_issue_7_handoff.sql`
15. `20261017030000_issue_7_logistics_notice_privacy.sql`
16. `20261017120000_issue_11_item_needs.sql`
17. `20261017140000_issue_8_disputes.sql`
18. `20261017180000_issue_9_returns.sql`
19. `20261017190000_issue_10_thank_yous.sql`
20. `20261017190100_issue_13_help_completion.sql`
21. `20261017210000_issue_17_message_evidence.sql`
22. `20261017220000_issue_16_dispute_decisions.sql`
23. `20261017230000_issue_13_help_notice_privacy.sql`
24. `20261017240000_issue_24_contribution_drafts.sql`
25. `20261018190000_issue_18_verified_misconduct.sql`
26. `20261018200000_issue_20_moderation.sql`
27. `20261018210000_issue_20_membership_guards.sql`
28. `20261018250000_issue_19_stalled_review.sql`
29. `20261020120000_issue_21_disciplinary_votes.sql`
30. `20261021140000_issue_25_pilot_metrics.sql`

Inspect the diff and ask the CLI for a dry run:

```powershell
git diff -- supabase/migrations
npx supabase db push --dry-run --project-ref $env:SUPABASE_PROJECT_REF
```

Expected output: no migration file changes, followed by a list containing only unapplied migration versions from the list above. If the dry run shows an unexpected migration or no clear plan, stop and reconcile the project migration history before applying anything.

## 4. Apply migrations

This is the first schema write to the hosted project. Reconfirm the project reference and dry-run output before approving it.

```powershell
npx supabase db push --project-ref $env:SUPABASE_PROJECT_REF
npx supabase migration list --project-ref $env:SUPABASE_PROJECT_REF
```

Expected output: each source migration is recorded as applied and the remote migration list matches the 30 source files. Migrations are forward-only. Use a reviewed corrective migration for any later fix.

## 5. Configure secrets and deploy functions

Set the variables from [the deployment configuration](DEPLOYMENT.md) in Supabase Function secrets. Use test-mode Stripe values and a verified email sender. The service-role key and provider keys must not enter GitHub workflow inputs or the static host.

```powershell
npx supabase secrets set --project-ref $env:SUPABASE_PROJECT_REF --env-file deployment/pilot.secrets.env
npx supabase functions deploy due-work --project-ref $env:SUPABASE_PROJECT_REF
npx supabase functions deploy notifications --project-ref $env:SUPABASE_PROJECT_REF
npx supabase functions deploy stripe-checkout --project-ref $env:SUPABASE_PROJECT_REF
npx supabase functions deploy stripe-webhook --project-ref $env:SUPABASE_PROJECT_REF
```

Expected output: four successful deployments. `deployment/pilot.secrets.env` is a local ignored file created by the operator. Never commit it. Configure the notification URL and token in Supabase Vault and confirm the scheduled notification dispatcher can reach `due-work`.

## 6. Configure Auth, Storage, Realtime, and Cron

In the Supabase dashboard, set Auth Site URL to the final HTTPS Pages URL and add only its `/auth/callback` URL. Confirm the three private buckets exist with non-public access. Confirm the three hint and event tables appear in `supabase_realtime`. Confirm all five one-minute Cron jobs listed in [the deployment configuration](DEPLOYMENT.md) exist and have successful recent runs after function deployment.

Expected output: exact URL values, three private buckets, three published tables, and five scheduled jobs are visible in the project settings. Do not create duplicate buckets or publication entries when migrations created them.

## 7. Deploy the static PWA

Create a Cloudflare Pages project connected to the reviewed GitHub branch. Set build command `npm run build`, output directory `dist`, and Node `22.16` or later. Configure only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as production build variables.

For a prebuilt deploy, use:

```powershell
npm run build
npx wrangler pages deploy dist --project-name ourtopia-pilot
```

Expected output: a Pages deployment URL using HTTPS. Configure the production hostname and wait for its certificate before changing Supabase Auth URLs.

## 8. Configure Stripe test mode and run smoke checks

Create the Stripe test endpoint at `https://PROJECT_REF.supabase.co/functions/v1/stripe-webhook` for `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Save the signing secret in Supabase Function secrets.

Run the public endpoint smoke check. It prints only endpoint names and HTTP status codes.

```powershell
$env:PILOT_BASE_URL = 'https://pilot.example.org'
$env:VITE_SUPABASE_URL = 'https://PROJECT_REF.supabase.co'
$env:VITE_SUPABASE_ANON_KEY = 'replace-with-project-anon-key'
node deployment/smoke.mjs
```

Expected output: `app`, `pwa manifest`, and `Supabase Auth settings` all report successful HTTP status codes, followed by the public-endpoint receipt. This check does not prove login, RLS, private Storage, Realtime authorization, workers, email delivery, Stripe event recovery, or journey completion.

## 9. Create the one real Community and collect live evidence

Use the product UI with the operator's verified Alice account to create `Richmond Mutual Aid Collective`. Invite Bob. Bob verifies his own account and requests membership. Alice approves him. Create no fake members or Exchanges. Run the configured mobile and desktop acceptance workflow against the final HTTPS URL and save access-controlled traces and sanitized persisted-state receipts.

Expected output: real records identify the Community and both memberships, and the end-to-end journey receipt agrees with the records. The issue remains open until this live evidence exists and receives independent review.

## Recovery

Roll back the static site through Pages deployment rollback. Redeploy a previous Edge Function version if a worker regresses. Restore prior Auth URLs and provider settings if needed. Keep the database and Community records. Do not reset or drop a hosted database. Correct schema defects with a new reviewed migration.
