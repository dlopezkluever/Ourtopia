# Migration inventory and change report

## Current migration set

The repository has no P26 migration. A fresh hosted pilot project needs every migration below in timestamp order. A project with earlier migrations already applied needs only later unapplied versions, as determined by Supabase migration history. Do not infer applied state from a dashboard snapshot.

1. `supabase/migrations/20261015010000_issue_2_community.sql`
2. `supabase/migrations/20261015020000_issue_2_membership_access_hints.sql`
3. `supabase/migrations/20261015190000_issue_3_membership.sql`
4. `supabase/migrations/20261015190100_issue_3_delivery.sql`
5. `supabase/migrations/20261015190200_issue_3_due_work.sql`
6. `supabase/migrations/20261015201500_issue_4_reputation.sql`
7. `supabase/migrations/20261015210000_issue_15_messages.sql`
8. `supabase/migrations/20261016070000_issue_5_listings.sql`
9. `supabase/migrations/20261016090000_issue_12_help.sql`
10. `supabase/migrations/20261016150000_issue_14_vouches.sql`
11. `supabase/migrations/20261016160000_issue_22_billing.sql`
12. `supabase/migrations/20261016170000_issue_6_reservations.sql`
13. `supabase/migrations/20261016231500_issue_23_delivery_console.sql`
14. `supabase/migrations/20261017021000_issue_7_handoff.sql`
15. `supabase/migrations/20261017030000_issue_7_logistics_notice_privacy.sql`
16. `supabase/migrations/20261017120000_issue_11_item_needs.sql`
17. `supabase/migrations/20261017140000_issue_8_disputes.sql`
18. `supabase/migrations/20261017180000_issue_9_returns.sql`
19. `supabase/migrations/20261017190000_issue_10_thank_yous.sql`
20. `supabase/migrations/20261017190100_issue_13_help_completion.sql`
21. `supabase/migrations/20261017210000_issue_17_message_evidence.sql`
22. `supabase/migrations/20261017220000_issue_16_dispute_decisions.sql`
23. `supabase/migrations/20261017230000_issue_13_help_notice_privacy.sql`
24. `supabase/migrations/20261017240000_issue_24_contribution_drafts.sql`
25. `supabase/migrations/20261018190000_issue_18_verified_misconduct.sql`
26. `supabase/migrations/20261018200000_issue_20_moderation.sql`
27. `supabase/migrations/20261018210000_issue_20_membership_guards.sql`
28. `supabase/migrations/20261018250000_issue_19_stalled_review.sql`
29. `supabase/migrations/20261020120000_issue_21_disciplinary_votes.sql`
30. `supabase/migrations/20261021140000_issue_25_pilot_metrics.sql`

## Prepared apply command

After operator authorization and a successful disposable-project rehearsal:

```sh
npx supabase link --project-ref <approved-project-ref>
npx supabase db push
```

The command applies pending migrations to the linked project. Verify the selected project ref immediately before running it. This preparation round does not run `db push` or link a hosted project.

## Pre-flight checklist

- [ ] Rehearse a clean replay and an upgrade on a disposable hosted project with the same Supabase features enabled.
- [ ] Capture the project ref, current migration history, schema diff, and extension availability for `pg_cron`, `vault`, `pg_net`, and `pgcrypto`.
- [ ] Take and verify a recoverable database backup or provider-supported restore point before the shared migration.
- [ ] Confirm Auth URL settings, Storage bucket policies, Realtime publication, function settings, and Vault prerequisites.
- [ ] Review each pending migration in timestamp order, including grants, RLS, triggers, extension creation, and scheduled jobs.
- [ ] Ensure service-role and provider credentials are present only in the approved secret store.
- [ ] Confirm the target project is the dedicated pilot and the live authorization record covers migration.
- [ ] Record migration versions and smoke-check all required RPCs, constraints, RLS policies, Storage boundaries, and Cron jobs after apply.

## Rollback and forward fix

Do not edit or delete a merged migration. Database rollback is forward-only in a shared environment. If a migration fails before commit, inspect the exact failed statement and database transaction state, then correct the new migration only if it has not merged or been applied anywhere; otherwise add a later corrective migration. If an applied change causes a defect, stop affected pilot actions, preserve evidence, and ship a new migration that restores the invariant. Revert application code only when the prior application remains schema-compatible. Keep the backup until the forward fix is verified. Never use `db reset` against a hosted or shared project. A disposable project may be recreated only under its explicit disposable policy.
