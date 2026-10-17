import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';

export const subscriptionSchema = z.object({
  subscription_id: z.string(), status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']),
  cancel_at_period_end: z.boolean(), reconciled_at: z.string(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export const jobSchema = z.object({ id: z.uuid(), kind: z.enum(['checkout', 'cancel']),
  state: z.enum(['pending', 'processing', 'ready', 'failed']), last_error: z.string().nullable(),
  checkout_url: z.string().nullable(), created_at: z.string(),
});
export type BillingJob = z.infer<typeof jobSchema>;

export async function readBilling() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('Sign in to inspect your test billing.');
  const read = async (path: string): Promise<unknown> => {
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/${path}`, { headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${data.session.access_token}`,
    } });
    if (!response.ok) throw new Error('Your test billing status could not be loaded. Try again.');
    return response.json();
  };
  const [subscriptions, jobs] = await Promise.all([
    read('billing_subscriptions?select=subscription_id,status,cancel_at_period_end,reconciled_at&order=reconciled_at.desc'),
    read('billing_jobs?select=id,kind,state,last_error,checkout_url,created_at&order=created_at.desc&limit=1'),
  ]);
  return { subscriptions: z.array(subscriptionSchema).parse(subscriptions), jobs: z.array(jobSchema).parse(jobs) };
}

export async function requestBilling(communityId: string, kind: 'checkout' | 'cancel', accountId: string) {
  const key = `billing-intent-${accountId}-${communityId}-${kind}`;
  const intentId = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, intentId);
  const result = await supabase.functions.invoke('stripe-checkout', { body: { intent_id: intentId, community_id: communityId, kind } });
  if (result.error) throw new Error('Test billing could not finish. Retry the same action. Community access is unchanged.');
  const job = jobSchema.parse(result.data);
  if (job.state === 'ready') sessionStorage.removeItem(key);
  return job;
}

export function checkoutUrl(value: string | null) {
  if (!value) throw new Error('Stripe has not returned a test Checkout link yet. Retry shortly.');
  const url = new URL(value);
  if (url.origin !== 'https://checkout.stripe.com') throw new Error('The Checkout link is invalid.');
  return url.href;
}
