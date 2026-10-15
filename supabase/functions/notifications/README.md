# Membership notice delivery

`npm run dev` starts the local worker when `.env.test.local` exists. It uses only the API and Mailpit ports in this worktree's config. Stopping the parent closes the worker's input and stops delivery. `local.ts` can also run through `tsx` with an open input stream.

Hosted delivery uses `notifications/index.ts`. It accepts a POST authenticated with the service role key. Configure `EMAIL_API_URL`, `EMAIL_API_KEY`, and `EMAIL_FROM` in the function environment. The email endpoint must honor `Idempotency-Key` for the full retry period or reconcile previously accepted messages before resending. An HTTP success means the provider accepted the message, not that a recipient opened it.

The migration schedules `private.dispatch_due_notifications()` once per minute. The dispatcher does nothing until Vault contains `notification_worker_url` and `notification_worker_token`. Set the URL to the deployed `due-work` function and the token to its service role credential. Configuring these secrets and deploying functions are operator actions. No hosted configuration is included in this PR.

Commands enqueue notices with unique `(event_id, recipient_id, channel, kind)` identity. Workers claim one due row with `FOR UPDATE SKIP LOCKED`, receive a new attempt token and a two-minute lease, then deliver outside the business transaction. A failure records a safe error and exponential retry starting at 30 seconds, capped at one hour. An expired lease is reclaimable. Its prior token cannot finish the new attempt. In-app delivery inserts one notice per outbox ID. Email adapters use that ID as their stable provider identity. The local Mailpit adapter searches its stable Message-ID before resending.

An administrator can inspect delivery rows and attempts through RLS and request an immediate retry with `retry_notification`. Delivery does not change application or membership state. Only `notification_hints`, containing IDs, is published to realtime. Clients fetch notice and application content through RLS.

Later features reuse the same outbox and commands. `application_id` is optional for non-membership events. Add presentation text for each new kind in the worker and in the authorized feature UI. Do not put messages, evidence, signed URLs, or other private bodies in realtime hints or email text.
