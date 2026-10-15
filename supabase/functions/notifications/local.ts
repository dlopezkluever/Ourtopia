import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { deliverOne, type EmailSender } from './worker';

export function localDelivery() {
  const values = Object.fromEntries(['.env.local', '.env.test.local'].flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  })));
  const config = readFileSync('supabase/config.toml', 'utf8');
  if (!/^project_id\s*=\s*"ourtopia-issue-\d+"/m.test(config)) throw new Error('Local delivery requires a disposable issue lane.');
  const apiPort = /\[api\][\s\S]*?^port\s*=\s*(\d+)/m.exec(config)?.[1];
  const inboxPort = /\[local_smtp\][\s\S]*?^port\s*=\s*(\d+)/m.exec(config)?.[1];
  const url = new URL(values.VITE_SUPABASE_URL);
  const mailbox = new URL(values.TEST_MAILBOX_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== apiPort || mailbox.hostname !== '127.0.0.1' || mailbox.port !== inboxPort) throw new Error('Local delivery requires this lane API and inbox.');
  const client = createClient(url.href, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const send: EmailSender = async message => {
    const messageId = `${message.idempotencyKey}@ourtopia.test`;
    const existing = await fetch(`${mailbox.origin}/api/v1/search?query=${encodeURIComponent(`message-id:${messageId}`)}`);
    if (!existing.ok) throw new Error('Local inbox search failed.');
    if (((await existing.json()) as { messages: unknown[] }).messages.length > 0) return;
    const response = await fetch(`${mailbox.origin}/api/v1/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ From: { Email: 'notices@ourtopia.test', Name: 'Ourtopia' }, To: [{ Email: message.to }], Subject: message.subject, Text: message.text, Headers: { 'Message-ID': `<${messageId}>`, 'X-Ourtopia-Notice': message.idempotencyKey } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Local inbox rejected delivery.');
  };
  return { client, send };
}

async function run() {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
  const { client, send } = localDelivery();
  for (;;) {
    try {
      for (let index = 0; index < 25; index++) if (!await deliverOne(client, send)) break;
    } catch { process.stderr.write('Local notice worker will retry durable work.\n'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void run();
