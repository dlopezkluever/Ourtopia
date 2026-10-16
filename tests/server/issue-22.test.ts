import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { TestStripe, verifyStripeBody } from '../../supabase/functions/stripe-checkout/provider';
import { acceptWebhook, processReceipt, type BillingBackend } from '../../supabase/functions/stripe-checkout/worker';
import { billingHandlers } from '../../supabase/functions/stripe-checkout/http';

const accountId = randomUUID();
const secret = 'whsec_local_signature_fixture';
const current = (status = 'active') => ({ id: 'sub_fixture', customer: 'cus_fixture', livemode: false, status,
  cancel_at_period_end: false, metadata: { account_id: accountId }, items: { data: [{ quantity: 1, price: {
    unit_amount: 500, currency: 'usd', recurring: { interval: 'month', interval_count: 1 },
  } }] },
});
const sign = (raw: string, time = Math.floor(Date.now() / 1000)) => `t=${time},v1=${createHmac('sha256', secret).update(`${time}.${raw}`).digest('hex')}`;
const rawEvent = JSON.stringify({ id: 'evt_fixture', type: 'customer.subscription.updated', livemode: false, created: 1,
  data: { object: { id: 'sub_fixture', customer: 'cus_fixture', status: 'active' } },
});

test('raw body signature rejects mutations, stale timestamps and malformed headers', async () => {
  await verifyStripeBody(rawEvent, sign(rawEvent), secret);
  await assert.rejects(verifyStripeBody(`${rawEvent} `, sign(rawEvent), secret), /signature/);
  await assert.rejects(verifyStripeBody(rawEvent, sign(rawEvent, 1), secret), /signature/);
  await assert.rejects(verifyStripeBody(rawEvent, `${sign(rawEvent)},t=1`, secret), /signature/);
  await assert.rejects(verifyStripeBody(rawEvent, 't=NaN,v1=abc', secret), /signature/);
});

test('unverified events never reach durable receipt commands', async () => {
  let calls = 0;
  const backend: BillingBackend = { rpc: async () => { calls++; return null; } };
  const stripe = new TestStripe('sk_test_fixture', async () => Response.json(current()));
  await assert.rejects(acceptWebhook({ raw: `${rawEvent} `, signature: sign(rawEvent), secret, backend, stripe }));
  assert.equal(calls, 0);
  assert.throws(() => new TestStripe('a_live_key_is_not_accepted'), /test secret/);
});

test('out of order event data is replaced by the current Stripe object after writer acquisition', async () => {
  const sequence: string[] = [];
  const backend: BillingBackend = { rpc: async (name, args) => {
    sequence.push(name);
    if (name === 'receive_stripe_receipt') return {};
    if (name === 'claim_stripe_receipt') return { event_id: 'evt_fixture', subscription_id: 'sub_fixture', customer_id: 'cus_fixture', state: 'processing', result: null, claim_token: randomUUID() };
    assert.equal(args.p_status, 'canceled');
    return { status: args.p_status };
  } };
  const stripe = new TestStripe('sk_test_fixture', async () => { sequence.push('stripe-current'); return Response.json(current('canceled')); });
  assert.deepEqual(await acceptWebhook({ raw: rawEvent, signature: sign(rawEvent), secret, backend, stripe }), { status: 'canceled' });
  assert.deepEqual(sequence, ['receive_stripe_receipt', 'claim_stripe_receipt', 'stripe-current', 'finish_stripe_receipt']);
});

test('processed duplicate returns its durable result without another Stripe retrieval', async () => {
  const prior = { event_id: 'evt_fixture', status: 'canceled' };
  const backend: BillingBackend = { rpc: async () => ({ event_id: 'evt_fixture', subscription_id: 'sub_fixture', customer_id: 'cus_fixture', state: 'processed', result: prior }) };
  const stripe = new TestStripe('sk_test_fixture', async () => { throw new Error('Processed duplicates must not call Stripe.'); });
  assert.deepEqual(await processReceipt(backend, stripe, 'evt_fixture'), prior);
});

test('provider failure marks a claimed receipt failed and the next attempt retrieves current state', async () => {
  const completions: Record<string, unknown>[] = [];
  const backend: BillingBackend = { rpc: async (name, args) => {
    if (name === 'claim_stripe_receipt') return { event_id: 'evt_fixture', subscription_id: 'sub_fixture', customer_id: 'cus_fixture', state: 'processing', result: null, claim_token: randomUUID() };
    completions.push(args); return { status: args.p_status };
  } };
  await assert.rejects(processReceipt(backend, new TestStripe('sk_test_fixture', async () => new Response(null, { status: 503 })), 'evt_fixture'), /retryable/);
  assert.equal(completions[0]?.p_failed, true);
  assert.deepEqual(await processReceipt(backend, new TestStripe('sk_test_fixture', async () => Response.json(current('past_due'))), 'evt_fixture'), { status: 'past_due' });
  assert.equal(completions[1]?.p_status, 'past_due');
});

test('forged client status is rejected before any server command', async () => {
  let calls = 0;
  const handlers = billingHandlers({ supabaseUrl: 'http://127.0.0.1:56221', anonKey: 'fixture', workerJwt: 'fixture',
    stripeKey: 'sk_test_fixture', webhookSecret: secret, appOrigin: 'http://127.0.0.1:56225',
  }, async () => { calls++; throw new Error('No external request expected.'); });
  const response = await handlers.checkout(new Request('http://127.0.0.1/stripe-checkout', { method: 'POST',
    headers: { Authorization: 'Bearer ordinary-fixture' }, body: JSON.stringify({ intent_id: randomUUID(), community_id: randomUUID(), kind: 'checkout', status: 'active' }),
  }));
  assert.equal(response.status, 503); assert.equal(calls, 0);
});

test('server fixes Checkout price and identities and reuses the durable provider idempotency key', async () => {
  const calls: { path: string; headers: Headers; body: URLSearchParams }[] = [];
  const stripe = new TestStripe('sk_test_fixture', async (input, init) => {
    const path = String(input); const headers = new Headers(init?.headers); const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ path, headers, body });
    if (path.includes('subscriptions?')) return Response.json({ data: [], has_more: false });
    return Response.json({ id: 'cs_test_fixture', customer: 'cus_fixture', livemode: false, url: 'https://checkout.stripe.com/c/pay/cs_test_fixture', expires_at: 1900000000 });
  });
  const job = { id: randomUUID(), account_id: accountId };
  const first = await stripe.checkout(job, 'cus_fixture', 'http://127.0.0.1:56225');
  const second = await stripe.checkout(job, 'cus_fixture', 'http://127.0.0.1:56225');
  assert.deepEqual(first, second);
  assert.equal(calls[1].headers.get('Idempotency-Key'), `ourtopia-test-checkout-${job.id}`);
  assert.equal(calls[3].headers.get('Idempotency-Key'), calls[1].headers.get('Idempotency-Key'));
  assert.equal(calls[1].body.get('line_items[0][price_data][unit_amount]'), '500');
  assert.equal(calls[1].body.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(calls[1].body.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(calls[1].body.get('subscription_data[metadata][account_id]'), accountId);
  assert.equal(calls[1].body.get('subscription_data[metadata][billing_job_id]'), job.id);
  assert.equal(calls[1].body.get('customer'), 'cus_fixture');
});

test('a delayed webhook cannot permit Checkout for an already subscribed Stripe customer', async () => {
  let calls = 0;
  const stripe = new TestStripe('sk_test_fixture', async () => { calls++; return Response.json({ data: [{ status: 'active' }], has_more: false }); });
  await assert.rejects(stripe.checkout({ id: randomUUID(), account_id: accountId }, 'cus_fixture', 'http://127.0.0.1:56225'), /already has/);
  assert.equal(calls, 1);
});

test('current-object validation rejects live objects and unexpected monthly amounts', async () => {
  const live = new TestStripe('sk_test_fixture', async () => Response.json({ ...current(), livemode: true }));
  await assert.rejects(live.subscription('sub_fixture'));
  const wrongAmount = current(); wrongAmount.items.data[0].price.unit_amount = 501;
  await assert.rejects(new TestStripe('sk_test_fixture', async () => Response.json(wrongAmount)).subscription('sub_fixture'));
});

test('durable receipts, writer fencing, atomic rollback and semantic checkout intents', { skip: process.env.BILLING_LIGHTWEIGHT === '1' }, async () => {
  const { actor, admin, createCommunity, stripeWorker, receipt } = await import('../../scripts/verify/backend');
  const owner = await actor({ label: 'billing-owner' });
  const community = await createCommunity(owner.client);
  assert.equal(community.error, null);
  const intent = randomUUID();
  const args = { p_intent_id: intent, p_community_id: community.data.id, p_kind: 'checkout' };
  const requested = await owner.client.rpc('request_test_billing', args);
  assert.equal(requested.error, null);
  assert.deepEqual((await owner.client.rpc('request_test_billing', args)).data, requested.data);
  assert.equal((await owner.client.rpc('request_test_billing', { ...args, p_kind: 'cancel' })).error?.code, '23505');
  const worker = stripeWorker();
  const claimed = await worker.rpc('claim_test_billing', { p_job_id: requested.data.job_id });
  assert.equal(claimed.error, null);
  assert.equal((await worker.rpc('claim_test_billing', { p_job_id: requested.data.job_id })).data, null);
  const customer = `cus_${randomUUID().replaceAll('-', '')}`;
  assert.equal((await worker.rpc('link_test_customer', { p_job_id: requested.data.job_id, p_claim_token: claimed.data.claim_token, p_customer_id: customer })).error, null);
  const sub = `sub_${randomUUID().replaceAll('-', '')}`;
  const event = `evt_${randomUUID().replaceAll('-', '')}`;
  const receivedArgs = { p_event_id: event, p_event_type: 'customer.subscription.updated', p_subscription_id: sub, p_customer_id: customer, p_fingerprint: 'signed-fixture' };
  assert.equal((await worker.rpc('receive_stripe_receipt', receivedArgs)).error, null);
  assert.equal((await worker.rpc('receive_stripe_receipt', { ...receivedArgs, p_fingerprint: 'changed' })).error?.code, '23505');
  const first = await worker.rpc('claim_stripe_receipt', { p_event_id: event });
  assert.equal(first.error, null);
  const concurrent = await worker.rpc('claim_stripe_receipt', { p_event_id: event });
  assert.equal(concurrent.data, null);
  await admin.from('stripe_writers').update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq('subscription_id', sub);
  const second = await worker.rpc('claim_stripe_receipt', { p_event_id: event });
  assert.notEqual(first.data.claim_token, second.data.claim_token);
  const finish = { p_event_id: event, p_account_id: owner.id, p_status: 'canceled', p_cancel_at_period_end: false };
  assert.equal((await worker.rpc('finish_stripe_receipt', { ...finish, p_claim_token: first.data.claim_token })).error?.code, '55000');
  assert.equal((await worker.rpc('finish_stripe_receipt', { ...finish, p_claim_token: second.data.claim_token, p_status: 'forged' })).error?.code, '23514');
  assert.equal((await admin.from('stripe_receipts').select('state').eq('event_id', event).single()).data?.state, 'processing');
  assert.deepEqual((await owner.client.from('billing_subscriptions').select('*')).data, []);
  const done = await worker.rpc('finish_stripe_receipt', { ...finish, p_claim_token: second.data.claim_token });
  assert.equal(done.error, null);
  assert.deepEqual((await worker.rpc('finish_stripe_receipt', { ...finish, p_claim_token: first.data.claim_token })).data, done.data);
  const nextEvent = `${event}next`;
  assert.equal((await worker.rpc('receive_stripe_receipt', { ...receivedArgs, p_event_id: nextEvent })).error, null);
  const nextClaim = await worker.rpc('claim_stripe_receipt', { p_event_id: nextEvent });
  const failed = await worker.rpc('finish_stripe_receipt', { p_event_id: nextEvent, p_claim_token: nextClaim.data.claim_token, p_failed: true });
  assert.equal(failed.data.state, 'failed');
  assert.equal((await worker.rpc('claim_stripe_receipt', { p_event_id: nextEvent })).data.state, 'processing');
  const concurrentSub = `${sub}concurrent`;
  const eventIds = [`${event}a`, `${event}b`];
  for (const id of eventIds) assert.equal((await worker.rpc('receive_stripe_receipt', { ...receivedArgs, p_event_id: id, p_subscription_id: concurrentSub })).error, null);
  const writers = await Promise.all(eventIds.map(id => worker.rpc('claim_stripe_receipt', { p_event_id: id })));
  assert.equal(writers.filter(result => result.data).length, 1);
  assert.equal(writers.filter(result => result.data === null).length, 1);
  const winner = writers.find(result => result.data)?.data;
  assert.ok(winner);
  assert.equal((await worker.rpc('finish_stripe_receipt', { ...finish, p_event_id: winner.event_id, p_claim_token: winner.claim_token })).error, null);
  const remaining = eventIds.find(id => id !== winner.event_id);
  assert.ok(remaining);
  assert.ok((await worker.rpc('claim_stripe_receipt', { p_event_id: remaining })).data);
  receipt('issue-22-server', { semanticRetry: true, staleTokenDenied: true, invalidStatusRolledBack: true, pendingCrashReclaimed: true, failedRetry: true });
});

test('worker rechecks current membership before claims, customer links and completion', { skip: process.env.BILLING_LIGHTWEIGHT === '1' }, async () => {
  const { actor, admin, createCommunity, stripeWorker, receipt } = await import('../../scripts/verify/backend');
  const owner = await actor({ label: 'billing-revoked-worker' });
  const community = await createCommunity(owner.client);
  assert.equal(community.error, null);
  const args = { p_intent_id: randomUUID(), p_community_id: community.data.id, p_kind: 'checkout' };
  const requested = await owner.client.rpc('request_test_billing', args);
  assert.equal(requested.error, null);
  const worker = stripeWorker();
  const claimed = await worker.rpc('claim_test_billing', { p_job_id: requested.data.job_id });
  assert.equal(claimed.error, null);
  const removed = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', community.data.id).eq('user_id', owner.id);
  assert.equal(removed.error, null);
  assert.equal((await owner.client.rpc('request_test_billing', args)).error?.code, '42501');
  const commands = [
    { name: 'claim_test_billing', args: { p_job_id: requested.data.job_id } },
    { name: 'link_test_customer', args: { p_job_id: requested.data.job_id, p_claim_token: claimed.data.claim_token, p_customer_id: 'cus_revoked_fixture' } },
    { name: 'finish_test_billing', args: { p_job_id: requested.data.job_id, p_claim_token: claimed.data.claim_token, p_failed: true } },
  ];
  for (const command of commands) assert.equal((await worker.rpc(command.name, command.args)).error?.code, '42501', command.name);
  assert.equal((await owner.client.from('billing_accounts').select('customer_id').single()).data?.customer_id, null);
  assert.equal((await owner.client.from('billing_jobs').select('state').single()).data?.state, 'processing');
  receipt('issue-22-worker-current-membership', { revokedClaimDenied: true, revokedLinkDenied: true, revokedFinishDenied: true, priorIntentDenied: true });
});

test('generated signatures traverse durable reconciliation without claiming real provider acceptance', { skip: process.env.BILLING_LIGHTWEIGHT === '1' }, async () => {
  const { actor, admin, createCommunity, stripeWorker, receipt } = await import('../../scripts/verify/backend');
  const owner = await actor({ label: 'billing-signed-integration' });
  const community = await createCommunity(owner.client);
  assert.equal(community.error, null);
  const requested = await owner.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: community.data.id, p_kind: 'checkout' });
  assert.equal(requested.error, null);
  const worker = stripeWorker();
  const claim = await worker.rpc('claim_test_billing', { p_job_id: requested.data.job_id });
  assert.equal(claim.error, null);
  const suffix = randomUUID().replaceAll('-', '');
  const customer = `cus_${suffix}`;
  const subscription = `sub_${suffix}`;
  assert.equal((await worker.rpc('link_test_customer', { p_job_id: requested.data.job_id, p_claim_token: claim.data.claim_token, p_customer_id: customer })).error, null);
  const backend: BillingBackend = { rpc: async (name, args) => {
    const result = await worker.rpc(name, args);
    if (result.error) throw result.error;
    return result.data;
  } };
  let currentStatus = 'active';
  let providerReads = 0;
  let fail = false;
  const stripe = new TestStripe('sk_test_fixture', async () => {
    providerReads++;
    if (fail) return new Response(null, { status: 503 });
    return Response.json({ ...current(currentStatus), id: subscription, customer, metadata: { account_id: owner.id } });
  });
  const event = (id: string, created: number) => JSON.stringify({ id, type: 'customer.subscription.updated', livemode: false, created,
    data: { object: { id: subscription, customer, status: 'stale_payload' } } });
  const deliver = (raw: string, signature = sign(raw)) => acceptWebhook({ raw, signature, secret, backend, stripe });
  const newer = event(`evt_${suffix}new`, 9999999999);
  await assert.rejects(deliver(`${newer} `, sign(newer)), /signature/);
  assert.deepEqual((await admin.from('stripe_receipts').select('event_id').eq('event_id', `evt_${suffix}new`)).data, []);
  assert.equal(providerReads, 0);
  const first = await deliver(newer);
  assert.equal(providerReads, 1);
  assert.deepEqual(await deliver(newer), first);
  assert.equal(providerReads, 1);
  currentStatus = 'canceled';
  const older = event(`evt_${suffix}old`, 1);
  fail = true;
  await assert.rejects(deliver(older), /retryable/);
  assert.equal((await admin.from('stripe_receipts').select('state').eq('event_id', `evt_${suffix}old`).single()).data?.state, 'failed');
  assert.equal((await owner.client.from('billing_subscriptions').select('status').single()).data?.status, 'active');
  fail = false;
  await deliver(older);
  assert.equal((await owner.client.from('billing_subscriptions').select('status').single()).data?.status, 'canceled');
  assert.deepEqual((await admin.from('stripe_receipts').select('state,attempts').eq('event_id', `evt_${suffix}old`).single()).data, { state: 'processed', attempts: 2 });
  assert.deepEqual((await owner.client.from('memberships').select('role,status').eq('user_id', owner.id)).data, [{ role: 'administrator', status: 'active' }]);
  receipt('issue-22-signed-integration', { signature: 'generated HMAC over exact raw body', persistence: 'real Postgres', provider: 'controlled current-object fixture, not real Stripe acceptance', outOfOrderConverged: true, failedRetried: true, membershipUnchanged: true });
});

test('an old subscription receipt cannot expire a newer open Checkout job', { skip: process.env.BILLING_LIGHTWEIGHT === '1' }, async () => {
  const { actor, createCommunity, stripeWorker, receipt } = await import('../../scripts/verify/backend');
  const owner = await actor({ label: 'billing-old-receipt' });
  const community = await createCommunity(owner.client);
  assert.equal(community.error, null);
  const worker = stripeWorker();
  const suffix = randomUUID().replaceAll('-', '');
  const customer = `cus_${suffix}`;
  const subscription = `sub_${suffix}`;
  const requestJob = async () => {
    const result = await owner.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: community.data.id, p_kind: 'checkout' });
    assert.equal(result.error, null);
    return result.data.job_id as string;
  };
  const reconcile = async (jobId: string, status: string) => {
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    assert.equal((await worker.rpc('receive_stripe_receipt', { p_event_id: eventId, p_event_type: 'customer.subscription.updated', p_subscription_id: subscription, p_customer_id: customer, p_fingerprint: eventId })).error, null);
    const claim = await worker.rpc('claim_stripe_receipt', { p_event_id: eventId });
    assert.equal(claim.error, null);
    assert.equal((await worker.rpc('finish_stripe_receipt', { p_event_id: eventId, p_claim_token: claim.data.claim_token, p_account_id: owner.id, p_status: status, p_checkout_job_id: jobId })).error, null);
  };
  const finish = async (jobId: string, token: string) => {
    const result = await worker.rpc('finish_test_billing', { p_job_id: jobId, p_claim_token: token, p_session_id: `cs_test_${jobId}`, p_checkout_url: `https://checkout.stripe.com/c/pay/cs_test_${jobId}`, p_expires_at: new Date(Date.now() + 3600000).toISOString() });
    assert.equal(result.error, null);
    return result.data;
  };
  const firstJob = await requestJob();
  const firstClaim = await worker.rpc('claim_test_billing', { p_job_id: firstJob });
  assert.equal(firstClaim.error, null);
  assert.equal((await worker.rpc('link_test_customer', { p_job_id: firstJob, p_claim_token: firstClaim.data.claim_token, p_customer_id: customer })).error, null);
  await reconcile(firstJob, 'active');
  const completed = await finish(firstJob, firstClaim.data.claim_token);
  assert.equal(completed.subscription_id, subscription);
  assert.ok(Date.parse(completed.expires_at) <= Date.now());
  await reconcile(firstJob, 'canceled');
  const nextJob = await requestJob();
  assert.notEqual(nextJob, firstJob);
  const nextClaim = await worker.rpc('claim_test_billing', { p_job_id: nextJob });
  assert.equal(nextClaim.error, null);
  const open = await finish(nextJob, nextClaim.data.claim_token);
  await reconcile(firstJob, 'canceled');
  assert.equal(await requestJob(), nextJob);
  const retained = await owner.client.from('billing_jobs').select('expires_at,subscription_id').eq('id', nextJob).single();
  assert.equal(retained.error, null);
  assert.equal(retained.data?.expires_at, open.expires_at);
  assert.equal(retained.data?.subscription_id, null);
  receipt('issue-22-old-receipt-checkout', { earlyReceiptPreserved: true, newerOpenCheckoutRetained: true, provider: 'command fixtures only, no real Checkout acceptance' });
});
