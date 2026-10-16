import { z } from 'zod';

export const stripeId = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/);
export const subscriptionSchema = z.object({
  id: stripeId, customer: stripeId, livemode: z.literal(false),
  status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']),
  cancel_at_period_end: z.boolean(), metadata: z.object({ account_id: z.uuid(), billing_job_id: z.uuid().optional() }),
  items: z.object({ data: z.array(z.object({ quantity: z.literal(1), price: z.object({
    unit_amount: z.literal(500), currency: z.literal('usd'), recurring: z.object({ interval: z.literal('month'), interval_count: z.literal(1) }),
  }) })).length(1) }),
});
export type CurrentSubscription = z.infer<typeof subscriptionSchema>;

export class TestStripe {
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {
    if (!key.startsWith('sk_test_')) throw new Error('Only a Stripe test secret key is permitted.');
  }

  private async call(path: string, method = 'GET', body?: URLSearchParams, identity?: string): Promise<unknown> {
    const response = await this.request(`https://api.stripe.com/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${this.key}`, 'Stripe-Version': '2025-02-24.acacia',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(identity ? { 'Idempotency-Key': identity } : {}),
      }, body, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Stripe test operation failed. Retry the same action.');
    return response.json();
  }

  async customer(accountId: string) {
    const result = z.object({ id: z.string().startsWith('cus_'), livemode: z.literal(false), metadata: z.object({ account_id: z.literal(accountId) }) }).parse(
      await this.call('customers', 'POST', new URLSearchParams({ 'metadata[account_id]': accountId }), `ourtopia-test-customer-${accountId}`));
    return result.id;
  }

  async checkout(job: { id: string; account_id: string }, customer: string, origin: string) {
    const subscriptions = z.object({ data: z.array(z.object({ status: z.string() })), has_more: z.boolean() }).parse(
      await this.call(`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`));
    if (subscriptions.has_more || subscriptions.data.some(item => !['canceled', 'incomplete_expired'].includes(item.status))) {
      throw new Error('This customer already has a current test subscription. Wait for verified status.');
    }
    const params = new URLSearchParams({
      mode: 'subscription', customer, client_reference_id: job.account_id,
      success_url: `${origin}/billing?checkout=returned`, cancel_url: `${origin}/billing?checkout=canceled`,
      'metadata[account_id]': job.account_id, 'subscription_data[metadata][account_id]': job.account_id,
      'subscription_data[metadata][billing_job_id]': job.id,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '500', 'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': 'Ourtopia test subscription',
    });
    return z.object({ id: z.string().startsWith('cs_test_'), livemode: z.literal(false), customer: z.literal(customer),
      url: z.url().refine(value => new URL(value).origin === 'https://checkout.stripe.com'), expires_at: z.number().int().positive(),
    }).parse(await this.call('checkout/sessions', 'POST', params, `ourtopia-test-checkout-${job.id}`));
  }

  async subscription(id: string): Promise<CurrentSubscription> {
    return subscriptionSchema.parse(await this.call(`subscriptions/${encodeURIComponent(id)}`));
  }

  async cancel(id: string) {
    const current = await this.subscription(id);
    if (current.status !== 'canceled') subscriptionSchema.parse(await this.call(`subscriptions/${encodeURIComponent(id)}`, 'DELETE'));
  }
}

export async function verifyStripeBody(raw: string, signature: string, secret: string, now = Date.now()) {
  if (!secret.startsWith('whsec_')) throw new Error('A webhook signing secret is required.');
  const fields = signature.split(',').map(value => value.split('='));
  const timestamps = fields.filter(([key]) => key === 't');
  const timestamp = timestamps[0]?.[1];
  if (timestamps.length !== 1 || !timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('Invalid webhook signature.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const payload = new TextEncoder().encode(`${timestamp}.${raw}`);
  for (const [name, value] of fields) {
    if (name !== 'v1' || !value || !/^[a-f0-9]{64}$/i.test(value)) continue;
    const bytes = Uint8Array.from(value.match(/../g) ?? [], item => Number.parseInt(item, 16));
    if (await crypto.subtle.verify('HMAC', key, bytes, payload)) return;
  }
  throw new Error('Invalid webhook signature.');
}

export async function fingerprint(raw: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), byte => byte.toString(16).padStart(2, '0')).join('');
}
