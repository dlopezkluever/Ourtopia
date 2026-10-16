import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor, admin, applyInvite, backendUrl, createCommunity, decideApplication, issueInvite, stripeWorker } from '../../../scripts/verify/backend';
import { TestStripe } from './provider';
import type { BillingBackend } from './worker';

function billingEnvironment() {
  const values = { ...process.env };
  for (const file of ['.env.stripe.local', '.env.stripe-functions.local']) {
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^([A-Z_]+)=["']?(.*?)["']?$/.exec(line);
        if (match) values[match[1]] ??= match[2];
      }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  return values;
}

export function realBillingConfigured() {
  const values = billingEnvironment();
  return Boolean(values.STRIPE_TEST_SECRET_KEY && values.STRIPE_WEBHOOK_SECRET);
}

export function realBillingConfig() {
  const values = billingEnvironment();
  if (!values.STRIPE_TEST_SECRET_KEY || !values.STRIPE_WEBHOOK_SECRET) throw new Error('Real Stripe test acceptance requires ignored STRIPE_TEST_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
  if (!values.STRIPE_TEST_SECRET_KEY.startsWith('sk_test_') || !values.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) throw new Error('Only Stripe test configuration is permitted.');
  return { key: values.STRIPE_TEST_SECRET_KEY, webhook: values.STRIPE_WEBHOOK_SECRET };
}

export const billingBackend = (): BillingBackend => {
  const worker = stripeWorker();
  return { rpc: async (name, args) => { const result = await worker.rpc(name, args); if (result.error) throw new Error(`Billing fixture command ${name} failed (${result.error.code}).`); return result.data; } };
};

export async function stripeTestApi(path: string, method = 'GET', params?: URLSearchParams) {
  const { key } = realBillingConfig();
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { method,
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2025-02-24.acacia', ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: params, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Stripe test fixture ${method} failed with HTTP ${response.status}.`);
  return response.json();
}

export async function billingFixture(label: string) {
  const owner = await actor({ label: `${label}-admin` });
  const member = await actor({ label: `${label}-member` });
  const community = z.object({ id: z.uuid(), name: z.string() }).parse((await createCommunity(owner.client, randomUUID(), `${label} circle`)).data);
  const invite = await issueInvite(owner, community.id, member.email);
  const application = await applyInvite(member, invite.id);
  const approved = await decideApplication(owner, application.id);
  if (approved.error) throw approved.error;
  return { owner, member, community };
}

export async function currentSubscriptionFixture(label: string) {
  const fixture = await billingFixture(label);
  const commandStart = performance.now();
  const requested = await fixture.member.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: fixture.community.id, p_kind: 'checkout' });
  const requestCommandMs = performance.now() - commandStart;
  if (requested.error) throw requested.error;
  const backend = billingBackend();
  const claim = z.object({ claim_token: z.uuid() }).parse(await backend.rpc('claim_test_billing', { p_job_id: requested.data.job_id }));
  const stripe = new TestStripe(realBillingConfig().key);
  const customer = await stripe.customer(fixture.member.id);
  await backend.rpc('link_test_customer', { p_job_id: requested.data.job_id, p_claim_token: claim.claim_token, p_customer_id: customer });
  const payment = z.object({ id: z.string() }).parse(await stripeTestApi('payment_methods', 'POST', new URLSearchParams({ type: 'card', 'card[token]': 'tok_visa' })));
  await stripeTestApi(`payment_methods/${payment.id}/attach`, 'POST', new URLSearchParams({ customer }));
  const product = z.object({ id: z.string() }).parse(await stripeTestApi('products', 'POST', new URLSearchParams({ name: 'Ourtopia verification test subscription' })));
  const subscription = z.object({ id: z.string(), livemode: z.literal(false) }).parse(await stripeTestApi('subscriptions', 'POST', new URLSearchParams({
    customer, default_payment_method: payment.id, 'metadata[account_id]': fixture.member.id,
    'items[0][price_data][currency]': 'usd', 'items[0][price_data][product]': product.id,
    'items[0][price_data][unit_amount]': '500', 'items[0][price_data][recurring][interval]': 'month',
  })));
  await backend.rpc('finish_test_billing', { p_job_id: requested.data.job_id, p_claim_token: claim.claim_token, p_failed: true });
  return { ...fixture, customer, subscriptionId: subscription.id, backend, stripe, requestCommandMs };
}

export async function deliverTestReceipt(subscriptionId: string, customer: string, options: { eventId?: string; mutateBody?: boolean; invalid?: boolean; created?: number } = {}) {
  const eventId = options.eventId ?? `evt_fixture_${randomUUID().replaceAll('-', '')}`;
  const raw = JSON.stringify({ id: eventId, type: 'customer.subscription.updated', livemode: false, created: options.created ?? 1,
    data: { object: { id: subscriptionId, customer, status: 'stale_fixture_status' } },
  });
  const time = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', realBillingConfig().webhook).update(`${time}.${raw}`).digest('hex');
  const response = await fetch(`${backendUrl}/functions/v1/stripe-webhook`, { method: 'POST', headers: {
    'Stripe-Signature': `t=${time},v1=${options.invalid ? '0'.repeat(64) : signature}`, 'Content-Type': 'application/json',
  }, body: options.mutateBody ? `${raw} ` : raw });
  return { response, eventId };
}

export async function persistedStatus(accountId: string) {
  const result = await admin.from('billing_subscriptions').select('subscription_id,status,customer_id').eq('account_id', accountId).order('reconciled_at', { ascending: false });
  if (result.error) throw result.error;
  return result.data;
}
