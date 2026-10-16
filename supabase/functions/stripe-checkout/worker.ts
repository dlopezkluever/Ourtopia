import { z } from 'zod';
import { TestStripe, fingerprint, verifyStripeBody } from './provider.ts';

export type BillingBackend = { rpc(name: string, args: Record<string, unknown>): Promise<unknown> };
const receiptSchema = z.object({ event_id: z.string(), state: z.enum(['pending', 'processing', 'failed', 'processed']),
  subscription_id: z.string(), customer_id: z.string(), result: z.unknown(),
});
const claimedReceiptSchema = receiptSchema.extend({ claim_token: z.uuid() });
const jobSchema = z.object({ id: z.uuid(), account_id: z.uuid(), kind: z.enum(['checkout', 'cancel']),
  state: z.enum(['pending', 'processing', 'failed', 'ready']), claim_token: z.uuid().nullable(),
  customer_id: z.string().nullable().optional(), subscription_id: z.string().nullable(),
});

export async function processReceipt(backend: BillingBackend, stripe: TestStripe, eventId: string) {
  const claim = await backend.rpc('claim_stripe_receipt', { p_event_id: eventId });
  if (!claim) throw new Error('The subscription writer is busy. Retry this event.');
  const prior = receiptSchema.parse(claim);
  if (prior.state === 'processed') return prior.result;
  const receipt = claimedReceiptSchema.parse(claim);
  try {
    const current = await stripe.subscription(receipt.subscription_id);
    if (current.id !== receipt.subscription_id || current.customer !== receipt.customer_id) throw new Error('Stripe subscription identity mismatch.');
    return await backend.rpc('finish_stripe_receipt', {
      p_event_id: eventId, p_claim_token: receipt.claim_token, p_account_id: current.metadata.account_id,
      p_status: current.status, p_cancel_at_period_end: current.cancel_at_period_end,
      p_checkout_job_id: current.metadata.billing_job_id ?? null,
    });
  } catch {
    await backend.rpc('finish_stripe_receipt', { p_event_id: eventId, p_claim_token: receipt.claim_token, p_failed: true });
    throw new Error('Current Stripe status could not be reconciled. The verified receipt remains retryable.');
  }
}

export async function acceptWebhook(options: { raw: string; signature: string; secret: string; backend: BillingBackend; stripe: TestStripe }) {
  await verifyStripeBody(options.raw, options.signature, options.secret);
  const event = z.object({ id: z.string().startsWith('evt_'), type: z.string(), livemode: z.literal(false),
    data: z.object({ object: z.unknown() }),
  }).parse(JSON.parse(options.raw));
  if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    const receipt = z.object({ result: z.unknown() }).parse(await options.backend.rpc('receive_stripe_receipt', {
      p_event_id: event.id, p_event_type: event.type, p_subscription_id: null, p_customer_id: null, p_fingerprint: await fingerprint(options.raw),
    }));
    return receipt.result;
  }
  const object = z.object({ id: z.string().startsWith('sub_'), customer: z.string().startsWith('cus_') }).parse(event.data.object);
  await options.backend.rpc('receive_stripe_receipt', { p_event_id: event.id, p_event_type: event.type,
    p_subscription_id: object.id, p_customer_id: object.customer, p_fingerprint: await fingerprint(options.raw),
  });
  return processReceipt(options.backend, options.stripe, event.id);
}

export async function executeBilling(backend: BillingBackend, stripe: TestStripe, jobId: string, origin: string) {
  const value = await backend.rpc('claim_test_billing', { p_job_id: jobId });
  if (!value) throw new Error('This test billing action is processing. Retry shortly.');
  const job = jobSchema.parse(value);
  if (job.state === 'ready') return value;
  const token = z.uuid().parse(job.claim_token);
  try {
    if (job.kind === 'checkout') {
      const customer = job.customer_id ?? await stripe.customer(job.account_id);
      await backend.rpc('link_test_customer', { p_job_id: job.id, p_claim_token: token, p_customer_id: customer });
      const session = await stripe.checkout(job, customer, origin);
      return await backend.rpc('finish_test_billing', { p_job_id: job.id, p_claim_token: token,
        p_session_id: session.id, p_checkout_url: session.url, p_expires_at: new Date(session.expires_at * 1000).toISOString(),
      });
    }
    const id = z.string().startsWith('sub_').parse(job.subscription_id);
    const current = await stripe.subscription(id);
    if (current.metadata.account_id !== job.account_id || current.customer !== job.customer_id) throw new Error('Subscription ownership mismatch.');
    await stripe.cancel(id);
    return await backend.rpc('finish_test_billing', { p_job_id: job.id, p_claim_token: token });
  } catch {
    await backend.rpc('finish_test_billing', { p_job_id: job.id, p_claim_token: token, p_failed: true });
    throw new Error('Test billing failed. Retry the same action.');
  }
}
