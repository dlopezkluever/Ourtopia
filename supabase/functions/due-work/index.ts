declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

Deno.serve(async request => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key || request.method !== 'POST' || request.headers.get('Authorization') !== `Bearer ${key}`) return new Response('Forbidden', { status: 403 });
  const rpc = (name: string) => fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: '{}',
  }).then(response => response.ok, () => false);
  const [expiry, returns, help] = await Promise.all([rpc('expire_due_item_approvals'), rpc('process_due_item_returns'), rpc('process_due_help_completions')]);
  const result = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notifications`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}` },
  });
  const delivery = await result.text();
  return Response.json({ expiry, returns, help, delivery }, { status: expiry && returns && help && result.ok ? 200 : 503 });
});
