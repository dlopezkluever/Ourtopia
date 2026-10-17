declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

Deno.serve(async request => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key || request.method !== 'POST' || request.headers.get('Authorization') !== `Bearer ${key}`) return new Response('Forbidden', { status: 403 });
  const expiry = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/expire_due_item_approvals`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!expiry.ok) return new Response('Expiry worker failed. Durable work remains retryable.', { status: 503 });
  const result = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notifications`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}` },
  });
  return new Response(await result.text(), { status: result.status, headers: { 'Content-Type': 'application/json' } });
});
