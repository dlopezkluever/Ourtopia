import { deliverOne, httpEmailSender, type DeliveryBackend } from './worker.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (request.headers.get('Authorization') !== `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`) return new Response('Forbidden', { status: 403 });
  const backend: DeliveryBackend = { rpc: async (name, args) => {
    const response = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data: unknown = await response.json();
    return { data: response.ok ? data : null, error: response.ok ? null : { message: 'Notification command failed.' } };
  } };
  const sendEmail = httpEmailSender(env('EMAIL_API_URL'), env('EMAIL_API_KEY'), env('EMAIL_FROM'));
  let count = 0;
  try {
    for (; count < 25; count++) if (!await deliverOne(backend, sendEmail)) break;
    return Response.json({ processed: count });
  } catch {
    return Response.json({ error: 'Delivery worker failed. Durable attempts remain retryable.' }, { status: 503 });
  }
});
