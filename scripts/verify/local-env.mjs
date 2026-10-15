import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const binary = process.execPath;
const raw = execFileSync(binary, ['node_modules/supabase/dist/supabase.js', 'status', '-o', 'env'], { encoding: 'utf8' });
const values = Object.fromEntries(raw.split(/\r?\n/).flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line);
  return match ? [[match[1], match[2]]] : [];
}));
if (!values.API_URL || !['127.0.0.1', 'localhost'].includes(new URL(values.API_URL).hostname)) throw new Error('Expected disposable local Supabase status.');
for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET']) if (!values[key]) throw new Error(`Missing ${key}.`);
writeFileSync('.env.local', `VITE_SUPABASE_URL=${values.API_URL}\nVITE_SUPABASE_ANON_KEY=${values.ANON_KEY}\n`, { mode: 0o600 });
writeFileSync('.env.test.local', `SUPABASE_SERVICE_ROLE_KEY=${values.SERVICE_ROLE_KEY}\nTEST_JWT_SECRET=${values.JWT_SECRET}\nTEST_MAILBOX_URL=http://127.0.0.1:55324\n`, { mode: 0o600 });
process.stdout.write('Local app and private test environment files written. No credentials printed.\n');
