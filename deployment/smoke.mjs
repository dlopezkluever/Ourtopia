import { parseArgs } from 'node:util';
import { URL } from 'node:url';

const { values } = parseArgs({
  options: { base: { type: 'string' }, 'anon-key': { type: 'string' } },
});
const base = values.base ?? process.env.PILOT_BASE_URL;
const anonKey = values['anon-key'] ?? process.env.VITE_SUPABASE_ANON_KEY;
if (!base || !anonKey) throw new Error('Provide --base and --anon-key, or PILOT_BASE_URL and VITE_SUPABASE_ANON_KEY.');

const baseUrl = new URL(base);
if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
  throw new Error('The pilot URL must use HTTPS.');
}

async function check(name, url, init) {
  const response = await globalThis.fetch(url, init);
  if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}.`);
  process.stdout.write(`${name}: HTTP ${response.status}\n`);
  return response;
}

await check('app', baseUrl);
const manifest = new URL('/manifest.webmanifest', baseUrl);
await check('pwa manifest', manifest);
const supabaseUrl = process.env.VITE_SUPABASE_URL;
if (!supabaseUrl) throw new Error('Set VITE_SUPABASE_URL for the Auth settings check.');
const authSettings = new URL('/auth/v1/settings', supabaseUrl);
await check('Supabase Auth settings', authSettings, { headers: { apikey: anonKey } });
process.stdout.write('receipt: all configured public endpoints responded successfully\n');
