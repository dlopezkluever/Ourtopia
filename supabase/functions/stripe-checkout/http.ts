import { z } from 'zod';
import { TestStripe } from './provider.ts';
import { acceptWebhook, executeBilling, type BillingBackend } from './worker.ts';

export type BillingConfig = {
  supabaseUrl: string; anonKey: string; workerJwt: string; stripeKey: string; webhookSecret: string; appOrigin: string;
};

export function billingHandlers(config: BillingConfig, request: typeof fetch = fetch) {
  const origin = new URL(config.appOrigin).origin;
  if (new URL(config.appOrigin).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(config.appOrigin).hostname)) throw new Error('Billing requires HTTPS or a local test lane.');
  const stripe = new TestStripe(config.stripeKey, request);
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
  const backend = (jwt: string): BillingBackend => ({ rpc: async (name, args) => {
    const result = await request(`${config.supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: {
      Authorization: `Bearer ${jwt}`, apikey: config.anonKey, 'Content-Type': 'application/json',
    }, body: JSON.stringify(args), signal: AbortSignal.timeout(20000) });
    if (!result.ok) throw new Error('Billing command was denied or failed.');
    return result.status === 204 ? null : result.json();
  } });
  const worker = backend(config.workerJwt);
  return {
    checkout: async (incoming: Request) => {
      if (incoming.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (incoming.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
      try {
        const jwt = incoming.headers.get('Authorization')?.replace(/^Bearer /, '');
        if (!jwt) return Response.json({ error: 'Sign in to use test billing.' }, { status: 401, headers: cors });
        const command = z.object({ intent_id: z.uuid(), community_id: z.uuid(), kind: z.enum(['checkout', 'cancel']) }).strict().parse(await incoming.json());
        const result = z.object({ job_id: z.uuid() }).parse(await backend(jwt).rpc('request_test_billing', {
          p_intent_id: command.intent_id, p_community_id: command.community_id, p_kind: command.kind,
        }));
        const outcome = await executeBilling(worker, stripe, result.job_id, origin);
        return Response.json(outcome, { headers: cors });
      } catch {
        return Response.json({ error: 'Test billing could not finish. Retry the same action. Community access is unchanged.' }, { status: 503, headers: cors });
      }
    },
    webhook: async (incoming: Request) => {
      if (incoming.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (Number(incoming.headers.get('Content-Length') ?? 0) > 262144) return new Response('Body too large', { status: 413 });
      const raw = await incoming.text();
      if (new TextEncoder().encode(raw).length > 262144) return new Response('Body too large', { status: 413 });
      try {
        const result = await acceptWebhook({ raw, signature: incoming.headers.get('Stripe-Signature') ?? '', secret: config.webhookSecret, backend: worker, stripe });
        return Response.json(result);
      } catch {
        return Response.json({ error: 'Webhook rejected or retry required.' }, { status: 503 });
      }
    },
  };
}
