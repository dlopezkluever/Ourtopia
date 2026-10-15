import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { resolve } from 'node:path';

const binary = process.execPath;
const config = readFileSync('supabase/config.toml', 'utf8');
const port = section => new RegExp(`\\[${section}\\][\\s\\S]*?^port\\s*=\\s*(\\d+)`, 'm').exec(config)?.[1];
const appPort = Number(process.env.APP_PORT ?? 5173);
if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65535) throw new Error('APP_PORT must be a valid local port.');
if (process.argv[2] === '--dev') {
  if (!config.includes(`site_url = "http://127.0.0.1:${appPort}"`)) throw new Error('Set the uncommitted Auth site_url and redirects to APP_PORT before starting this lane backend.');
  const worker = existsSync('.env.test.local') ? spawn(binary, ['node_modules/tsx/dist/cli.mjs', resolve('supabase/functions/notifications/local.ts')], { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true }) : null;
  try {
    execFileSync(binary, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { stdio: 'inherit' });
  } finally { worker?.kill(); }
  process.exit(0);
}
if (process.argv[2] === '--reset') {
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  execFileSync(binary, ['scripts/verify/migrations.mjs', '--disposable-project', project ?? ''], { stdio: 'inherit' });
  process.exit(0);
}
const raw = execFileSync(binary, ['node_modules/supabase/dist/supabase.js', 'status', '-o', 'env'], { encoding: 'utf8' });
const values = Object.fromEntries(raw.split(/\r?\n/).flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line);
  return match ? [[match[1], match[2]]] : [];
}));
if (!values.API_URL || !['127.0.0.1', 'localhost'].includes(new URL(values.API_URL).hostname)) throw new Error('Expected disposable local Supabase status.');
if (new URL(values.API_URL).port !== port('api')) throw new Error('API port must match the lane config.');
for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET']) if (!values[key]) throw new Error(`Missing ${key}.`);
writeFileSync('.env.local', `VITE_SUPABASE_URL=${values.API_URL}\nVITE_SUPABASE_ANON_KEY=${values.ANON_KEY}\n`, { mode: 0o600 });
writeFileSync('.env.test.local', `SUPABASE_SERVICE_ROLE_KEY=${values.SERVICE_ROLE_KEY}\nTEST_JWT_SECRET=${values.JWT_SECRET}\nTEST_MAILBOX_URL=http://127.0.0.1:${port('local_smtp')}\n`, { mode: 0o600 });
process.stdout.write('Local app and private test environment files written. No credentials printed.\n');
