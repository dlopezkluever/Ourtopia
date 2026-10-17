import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const names = ['STRIPE_TEST_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const values = { ...process.env };
for (const file of ['.env.local', '.env.test.local', '.env.stripe.local']) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z_]+)=["']?(.*?)["']?$/.exec(line);
      if (match) values[match[1]] ??= match[2];
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (process.argv.includes('--check')) {
  process.stdout.write(`${JSON.stringify(Object.fromEntries(names.map(name => [name, Boolean(values[name])])))}\n`);
} else if (process.argv.includes('--prepare')) {
  const config = readFileSync('supabase/config.toml', 'utf8');
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  const apiPort = /\[api\][\s\S]*?^port\s*=\s*(\d+)/m.exec(config)?.[1];
  const appPort = Number(process.env.APP_PORT ?? 56225);
  if (project !== 'ourtopia-issue-22' || new URL(values.VITE_SUPABASE_URL).hostname !== '127.0.0.1' || new URL(values.VITE_SUPABASE_URL).port !== apiPort) throw new Error('Billing setup requires this disposable issue-22 backend.');
  for (const name of names) if (!values[name]) throw new Error(`Missing ignored test configuration ${name}.`);
  if (!values.STRIPE_TEST_SECRET_KEY.startsWith('sk_test_') || !values.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) throw new Error('Test-only Stripe configuration is required.');
  if (!values.TEST_JWT_SECRET) throw new Error('Missing private local JWT signing configuration.');
  if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65535) throw new Error('Invalid local app port.');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'stripe_worker', exp: Math.floor(Date.now() / 1000) + 14400 })}`;
  const token = `${payload}.${createHmac('sha256', values.TEST_JWT_SECRET).update(payload).digest('base64url')}`;
  writeFileSync('.env.stripe-functions.local', names.map(name => `${name}=${values[name]}\n`).join('') + `STRIPE_WORKER_JWT=${token}\nSTRIPE_APP_ORIGIN=http://127.0.0.1:${appPort}\n`, { mode: 0o600 });
  process.stdout.write('Ignored test-only function configuration prepared. No credentials printed.\n');
} else {
  throw new Error('Choose --check for availability only, or --prepare for the disposable lane.');
}
