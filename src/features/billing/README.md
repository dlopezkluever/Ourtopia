# Test billing

Billing belongs to the signed-in account. An approved active membership authorizes a new checkout or cancellation command. A person can always inspect their own retained billing records. The billing tables and commands never grant, remove, or change Community membership.

`request_test_billing(intent_id, community_id, kind)` reuses `command_intents`. The same account, intent and exact payload return the original job identity. Reusing the intent for changed details raises `23505`. Current verified-account and membership authorization runs before returning a prior result.

Checkout jobs persist before Stripe calls. Customer creation uses the account UUID as the Stripe idempotency identity. Checkout creation uses the durable job UUID. The server fixes the price at USD 500 cents per month and quantity one. Clients supply neither prices nor customer identities. Failed jobs retain the same provider identity. Jobs older than 22 hours fail closed for manual recovery before Stripe's idempotency retention window can expire. Recover the original provider operation before permitting a replacement. No automatic retry may create a second chargeable subscription.

Stripe subscription metadata retains `billing_job_id`. Reconciliation consumes only that originating Checkout job. An old subscription event cannot expire a newer open session. A receipt that arrives before the Checkout response also records the consumed job, so the later response cannot make that job reusable.

The webhook verifies the exact raw body with HMAC SHA-256 and a five minute timestamp tolerance before recording an event. Configure its destination for `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Other verified test events receive a durable ignored result and cannot change subscription state. Signed test events have unique durable receipt identities and payload fingerprints. The receipt commits before processing. A pending or failed receipt can be claimed again. A processed duplicate returns its prior result.

Each subscription has one durable writer lease. The worker acquires a fresh claim token before retrieving Stripe's current subscription object. The guarded finish command checks the token and lease again, validates customer ownership, then updates the subscription and marks the receipt processed in one transaction. Event creation timestamps never choose the resulting state. Expired workers cannot finish after another claim. A crash after receipt insertion leaves pending work. A crash after a claim requires lease expiry, then a new Stripe retrieval. A failed transaction leaves the receipt retryable and preserves the old subscription state.

The `stripe_worker` database role can execute only billing worker commands. It cannot read billing tables directly, mutate membership, or invoke membership and notice commands. Its private signed JWT is separate from the service-role credential. Neither credential enters the browser. The browser receives its own RLS-filtered projection, a test Checkout URL, and safe failure messages. Stripe events and writer leases have no client read grants and are absent from realtime publications. This slice introduces no Storage objects or billing notices.

Before claiming a job, linking its customer, or finishing it, the worker rechecks the persisted requesting account's verified identity and current membership in the job's immutable Community. The private guard calls the upstream current-membership guard with that persisted account and keeps its membership lock through the transaction. Receipt reconciliation continues for retained account records after membership removal, so Stripe status remains inspectable without restoring Community access.

## Run the disposable test lane

Use the coordinator's runtime lease before starting a backend or browser workload. Keep the issue-22 port override uncommitted. Follow the existing guarded migration recipe and regenerate database types after applying the final migration.

Provide `STRIPE_TEST_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` through the ignored `.env.stripe.local` file. Use a Stripe test secret key. The signing secret must match the local Stripe CLI listener. Do not place either value in a Vite variable or a command argument.

No price ID environment variable is required. The server creates the fixed USD 500 monthly price through Checkout's inline price data. Clients cannot choose the price or interval.

The issue-22 performance command always collects the ten paired shared readiness and authorized-read samples. Without provider configuration, it saves those samples and a blocked report, then exits with code 2. Billing command and provider-visible outcome checks remain null. A partial performance report never passes the full performance gate.

1. Run `node supabase/functions/stripe-checkout/local-env.mjs --check` to print availability booleans only.
2. Start the lane backend and run `node scripts/verify/local-env.mjs`.
3. Start an authenticated Stripe CLI listener for the three subscription event types. Forward to `http://127.0.0.1:56221/functions/v1/stripe-webhook`. Keep its signing secret in ignored configuration and its output private.
4. Run `node supabase/functions/stripe-checkout/local-env.mjs --prepare` with `APP_PORT=56225`.
5. Run `npx supabase functions serve --env-file .env.stripe-functions.local --no-verify-jwt`. The public webhook performs its own signature authentication. Checkout performs user authentication through its guarded command.
6. Run the app and the issue-22 browser suite. The real-provider lanes require actual Stripe test Checkout completion. A fake provider cannot pass this gate.

Keep screenshots, trace archives, customer IDs, and subscription receipts under ignored `.pilot-evidence`. A test browser can use Stripe's published test card numbers. Never use real card details. Shut down the listener, function server and backend after the assigned workload.

Without the two provider secrets, journey lanes 1, 2, 3, and 6 through 10 report `BLOCKED P22-STRIPE-TEST-CONFIG` as skipped. These skips do not pass the affected acceptance boxes. Lanes 4 and 5 still exercise unpaid Community access and forged redirects on both viewports. Lane 5 calls the production signature handler with generated invalid or body-changed signatures and proves that no backend command runs. Server tests additionally exercise signed receipt persistence and reconciliation against real Postgres with controlled provider responses. Those fixtures do not replace real test Checkout, hosted cancellation, or current-object provider acceptance.

## Production activation is the first post-MVP release

Production billing activation is a separate first release after MVP acceptance. It is not an unfinished MVP ticket. This MVP rejects live keys and live objects and has no payment membership gate.

That separate release requires an explicit operator approval for live Stripe setup and deployment. Prepare live product and price configuration, a production webhook signing secret, narrow worker credentials, monitoring and alerting for failed receipts, provider retry recovery, payment failure behavior, and an explicit migration plan for pilot members. Review customer consent and any access policy change before collecting money. Reconcile existing test identities separately from live identities. Test credentials and test subscriptions must never be promoted into live billing records.

Rollback the app with a revert. Shared database changes require a forward migration. Only the guarded disposable-lane migration runner may reset the issue-22 database.

Stripe protocol references are [Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create) and [webhook signature verification](https://docs.stripe.com/webhooks/signature).
