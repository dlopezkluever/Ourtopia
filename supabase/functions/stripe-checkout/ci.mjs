import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This runner is restricted to an isolated GitHub Actions worker.');
if (!process.env.STRIPE_TEST_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Required CI capability is missing: STRIPE_TEST_SECRET_KEY in the billing test environment.');
mkdirSync('.pilot-evidence/ci', { recursive: true });
const original = readFileSync('supabase/config.toml', 'utf8');
if (!original.includes('project_id = "ourtopia-issue-2"')) throw new Error('Unexpected committed backend configuration.');
writeFileSync('supabase/config.toml', original.replace('project_id = "ourtopia-issue-2"', 'project_id = "ourtopia-issue-22"'));
process.env.APP_PORT = '5173';
const handles = [];
const daemons = [];
function run(label, binary, args, extra = {}) {
  const descriptor = openSync(`.pilot-evidence/ci/${label}.log`, 'w', 0o600); handles.push(descriptor);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', descriptor, descriptor], env: { ...process.env, ...extra }, windowsHide: true });
    child.once('error', () => reject(new Error(`${label} could not start.`)));
    child.once('exit', code => { process.stdout.write(`${label}: exit ${code}\n`); if (code === 0) resolve(); else reject(new Error(`${label} failed. Private log retained on the runner.`)); });
  });
}
function daemon(label, binary, args, extra = {}) {
  const descriptor = openSync(`.pilot-evidence/ci/${label}.log`, 'w', 0o600); handles.push(descriptor);
  const child = spawn(binary, args, { stdio: ['ignore', descriptor, descriptor], env: { ...process.env, ...extra }, windowsHide: true }); daemons.push(child); return child;
}
try {
  await run('backend', process.execPath, ['node_modules/supabase/dist/supabase.js', 'start']);
  await run('environment', process.execPath, ['scripts/verify/local-env.mjs']);
  await run('migrations', process.execPath, ['scripts/verify/migrations.mjs', '--disposable-project', 'ourtopia-issue-22']);
  await run('types', process.execPath, ['scripts/verify/database-types.mjs']);
  const generatedTypesDiff = execFileSync('git', ['diff', '--unified=0', '--', 'src/lib/supabase/database.types.ts'], { encoding: 'utf8' });
  if (generatedTypesDiff) { process.stderr.write(generatedTypesDiff); throw new Error('Generated database types differ from the checked-in output.'); }
  process.stdout.write('types-diff: exit 0\n');
  await run('stripe-image', 'docker', ['pull', 'stripe/stripe-cli:v1.53.1']);
  const listener = spawn('docker', ['run', '--rm', '--name', 'ourtopia-stripe-ci', '--network', 'host', '-e', 'STRIPE_API_KEY', 'stripe/stripe-cli:v1.53.1', 'listen', '--events', 'customer.subscription.created,customer.subscription.updated,customer.subscription.deleted', '--forward-to', 'http://127.0.0.1:55321/functions/v1/stripe-webhook'], {
    env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_TEST_SECRET_KEY }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }); daemons.push(listener);
  await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Stripe listener did not become ready.')), 60000);
    const inspect = chunk => {
      buffer = `${buffer}${String(chunk)}`.slice(-8192);
      const secret = /whsec_[A-Za-z0-9]+/.exec(buffer)?.[0];
      if (secret) { process.env.STRIPE_WEBHOOK_SECRET = secret; clearTimeout(timer); resolve(); }
    };
    listener.stdout.on('data', inspect); listener.stderr.on('data', inspect);
    listener.once('error', () => { clearTimeout(timer); reject(new Error('Stripe listener could not start.')); });
    listener.once('exit', () => { clearTimeout(timer); reject(new Error('Stripe listener exited before readiness.')); });
  });
  await run('billing-environment', process.execPath, ['supabase/functions/stripe-checkout/local-env.mjs', '--prepare']);
  daemon('functions', process.execPath, ['node_modules/supabase/dist/supabase.js', 'functions', 'serve', '--env-file', '.env.stripe-functions.local', '--no-verify-jwt']);
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    try { const result = await globalThis.fetch('http://127.0.0.1:55321/functions/v1/stripe-webhook'); if (result.status === 405) { ready = true; break; } } catch { ready = false; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Billing functions did not become ready.');
  await run('server', 'npm', ['run', 'test:server', '--', 'tests/server/issue-22.test.ts']);
  await run('rls', 'npm', ['run', 'test:rls', '--', 'tests/rls/issue-22.test.ts']);
  for (let suite = 1; suite <= 3; suite++) await run(`journeys-${suite}`, 'npm', ['run', 'test:journey', '--', 'tests/journeys/issue-22.spec.ts'], { EVIDENCE_DIR: `.pilot-evidence/ci/suite-${suite}` });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await run('perf', 'npm', ['run', 'verify:perf', '--', '--issue', '22', '--base', '7aa1af9cf1dae27a32226bb0f52f408e29749aa2', '--head', head, '--pairs', '10']);
} finally {
  for (const child of daemons) child.kill();
  try { execFileSync('docker', ['stop', 'ourtopia-stripe-ci'], { stdio: 'ignore' }); } catch { process.stdout.write('Stripe listener cleanup was not confirmed.\n'); }
  try { execFileSync(process.execPath, ['node_modules/supabase/dist/supabase.js', 'stop', '--project-id', 'ourtopia-issue-22'], { stdio: 'ignore' }); } finally { writeFileSync('supabase/config.toml', original); for (const descriptor of handles) closeSync(descriptor); }
}
