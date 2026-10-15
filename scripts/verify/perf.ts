import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { chromium, expect, type Page } from '@playwright/test';
import { actor, createCommunity, password } from './backend';
import { communitySchema } from '../../src/features/communities/model';

const { values } = parseArgs({ options: { issue: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, pairs: { type: 'string', default: '10' } } });
if (values.issue === '3') await verifyIssue3(values);
else await verifyIssue2(values);

type PerfArguments = { issue?: string; base?: string; head?: string; pairs?: string };

async function verifyIssue2(values: PerfArguments) {
assert.equal(values.issue, '2');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(values.head, head, 'Perf must measure the exact committed head.');
assert.ok(values.base);
const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', values.base], { encoding: 'utf8' });
assert.equal(tree.split('\n').includes('package.json'), false, 'The P02 baseline exception requires an absent runtime.');
const count = Number(values.pairs);
assert.ok(Number.isInteger(count) && count >= 10);
const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/baseline.json`, JSON.stringify({ base: values.base, tree: tree.split('\n'), runtime: 'absent', comparison: 'not applicable; no speedup claimed' }, null, 2));
const appUrl = `http://127.0.0.1:${Number(process.env.APP_PORT ?? 5173) + 1}`;
const started = performance.now();
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(appUrl).port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
server.stdout.on('data', chunk => { output += String(chunk); });
server.stderr.on('data', chunk => { output += String(chunk); });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const samples = [];
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Perf app exited ${server.exitCode}. ${output}`);
    try { ready = (await fetch(appUrl)).ok; } catch { ready = false; }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'App did not respond within 60 seconds.');
  const startupPage = await browser.newPage();
  await startupPage.goto(appUrl);
  await expect(startupPage.getByRole('heading', { name: 'Good to have you here.' })).toBeVisible();
  const readinessMs = performance.now() - started;
  await startupPage.close();
  for (let index = 0; index < count; index++) {
    const owner = await actor({ label: 'perf' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(appUrl);
    await page.getByLabel('Email address').fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByLabel('Community name')).toBeVisible();
    const name = `Performance circle ${index}`;
    await page.getByLabel('Community name').fill(name);
    let commandStart = 0;
    let commandMs = 0;
    page.on('request', request => { if (request.url().includes('/rpc/create_community')) commandStart = performance.now(); });
    const response = page.waitForResponse(value => value.url().includes('/rpc/create_community')).then(async value => {
      await value.finished();
      commandMs = performance.now() - commandStart;
      assert.equal(value.status(), 200);
      return communitySchema.parse(await value.json());
    });
    const actionStart = performance.now();
    await page.getByRole('button', { name: 'Create Community', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Welcome to ${name}.` })).toBeVisible();
    const visibleMs = performance.now() - actionStart;
    const result = await response;
    const queryStart = performance.now();
    const queried = await owner.client.from('communities').select('*').eq('id', result.id);
    const queryMs = performance.now() - queryStart;
    assert.equal(queried.error, null);
    assert.deepEqual(queried.data, [result]);
    assert.deepEqual((await owner.client.from('memberships').select('role,status').eq('community_id', result.id)).data, [{ role: 'administrator', status: 'active' }]);
    await page.reload();
    await expect(page.getByRole('heading', { name: `Welcome to ${name}.` })).toBeVisible();
    samples.push({ index, commandMs, visibleMs, queryMs, persisted: true, uniqueCommunityId: result.id });
    await context.close();
  }
  const percentile = (numbers: number[], fraction: number) => [...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * fraction) - 1];
  const median = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const summary = { commandMedianMs: median(samples.map(row => row.commandMs)), visibleMedianMs: median(samples.map(row => row.visibleMs)), queryP95Ms: percentile(samples.map(row => row.queryMs), .95), readinessMs };
  const report = { utc: new Date().toISOString(), head, base: values.base, mode: 'local Vite development; no comparative claim', claim: 'Ten successful new Community commands and durable visible states meet P02 absolute budgets on this machine.', samples, errors: 0, summary, host: { logicalCores: cpus().length, loadAverage: loadavg(), totalMemory: totalmem(), freeMemory: freemem() }, limiter: 'No speedup or throughput claim. Samples include local HTTP, PostgreSQL transaction and browser render work. Fixed one-browser serial load, warm modules after one measured startup; no profiler in timed samples.', emailWait: 'Measured separately by browser mailbox tests with a 30s deadline.' };
  writeFileSync(`${directory}/samples.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${directory}/report.md`, `P02 absolute-budget probe at ${head}.\n\nTrunk ${values.base} has no runtime. No speedup is claimed. Ten real successful commands each created a distinct Community and exactly one active administrator. Reload verified durability.\n\nCommand median ${summary.commandMedianMs.toFixed(1)} ms. Action-to-visible median ${summary.visibleMedianMs.toFixed(1)} ms. Query p95 ${summary.queryP95Ms.toFixed(1)} ms. Dev readiness ${readinessMs.toFixed(1)} ms.\n\n${report.limiter}\n\nRaw samples, ranges, host observations and persisted identities are in samples.json.\n`);
  assert.ok(summary.commandMedianMs <= 1000, 'Command median exceeds 1s.');
  assert.ok(summary.visibleMedianMs <= 2000, 'Action to visible median exceeds 2s.');
  assert.ok(summary.queryP95Ms <= 3000, 'Authorized query p95 exceeds 3s.');
  assert.ok(readinessMs <= 60000, 'App readiness exceeds 60s.');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await browser.close();
  server.kill();
  writeFileSync(`${directory}/app-start.txt`, output);
}

}

async function verifyIssue3(values: PerfArguments) {
assert.equal(values.issue, '3');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(values.head, head);
assert.ok(values.base);
const count = Number(values.pairs);
assert.ok(Number.isInteger(count) && count >= 10);
const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
mkdirSync(directory, { recursive: true });
const base = values.base;
assert.equal(execFileSync('git', ['cat-file', '-t', `${base}:package.json`], { encoding: 'utf8' }).trim(), 'blob', 'P03 needs the real P02 runtime baseline.');
const trunkRoot = resolve('..', `perf-trunk-${values.issue}`);
const trunkModules = join(trunkRoot, 'node_modules');
function removeTrunk() {
  if (existsSync(trunkModules)) unlinkSync(trunkModules);
  if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
  execFileSync('git', ['worktree', 'prune']);
  assert.ok(existsSync('node_modules/vite/package.json'), 'Trunk cleanup must not touch head dependencies.');
}
function addTrunk() {
  removeTrunk();
  execFileSync('git', ['worktree', 'add', '--detach', trunkRoot, base], { stdio: 'inherit' });
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: trunkRoot, encoding: 'utf8' }).trim(), execFileSync('git', ['rev-parse', `${base}^{commit}`], { encoding: 'utf8' }).trim());
  assert.equal(execFileSync('git', ['diff', `${base}`, 'HEAD', '--', 'package-lock.json'], { encoding: 'utf8' }), '', 'Trunk reuses head dependencies only when the lockfile is unchanged.');
  symlinkSync(resolve('node_modules'), trunkModules, 'junction');
  copyFileSync('.env.local', join(trunkRoot, '.env.local'));
  writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
}
const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
const headPort = trunkPort + 1;
const servers: ReturnType<typeof spawn>[] = [];
const startup: Record<string, number> = {};
async function serve(label: string, root: string, port: number, config: string[] = []) {
  const start = performance.now();
  const processHandle = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  servers.push(processHandle);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`${label} server exited ${processHandle.exitCode}.`);
    const ready = await fetch(`http://127.0.0.1:${port}`).then(response => response.ok, () => false);
    if (ready) { startup[label] = performance.now() - start; return; }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`${label} readiness exceeded 60 seconds.`);
}
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
type Sample = { index: number; side: string; readinessMs: number; queryMs: number; communityId: string };
const samples: Sample[] = [];
const actions: { index: number; inviteMs: number; applyMs: number; approveMs: number; visibleMs: number; applicationId: string; membershipStatus: string }[] = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
function persist(extra: unknown = {}) {
  writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base: values.base, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
}
try {
  addTrunk();
  await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
  await serve('head', '.', headPort);
  for (let index = 0; index < count; index++) {
    const owner = await actor({ label: 'paired-perf-admin' });
    const applicant = await actor({ label: 'paired-perf-applicant' });
    const communityResult = await createCommunity(owner.client, randomUUID(), `Paired performance circle ${index}`);
    assert.equal(communityResult.error, null);
    const community = communityResult.data;
    for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] as const) {
      const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await login(page, owner.email);
        await expect(page.getByRole('heading', { name: `Welcome to ${community.name}.` })).toBeVisible();
        const readyStart = performance.now();
        await page.reload();
        await expect(page.getByRole('heading', { name: `Welcome to ${community.name}.` })).toBeVisible();
        const readinessMs = performance.now() - readyStart;
        const queryStart = performance.now();
        const query = await owner.client.from('communities').select('*').eq('id', community.id);
        const queryMs = performance.now() - queryStart;
        assert.equal(query.error, null);
        assert.deepEqual(query.data, [community]);
        samples.push({ index, side, readinessMs, queryMs, communityId: community.id });
        persist({ phase: 'paired reads', errors: 0 });
        if (side === 'head') {
          let start = performance.now();
          const invite = await owner.client.rpc('issue_invite', { p_intent_id: randomUUID(), p_community_id: community.id, p_email: applicant.email });
          const inviteMs = performance.now() - start;
          assert.equal(invite.error, null);
          start = performance.now();
          const application = await applicant.client.rpc('redeem_invite', { p_intent_id: randomUUID(), p_invite_id: invite.data.id });
          const applyMs = performance.now() - start;
          assert.equal(application.error, null);
          assert.equal(application.data.status, 'pending');
          assert.deepEqual((await applicant.client.from('communities').select('*').eq('id', community.id)).data, []);
          const applicantContext = await browser.newContext({ baseURL: `http://127.0.0.1:${headPort}` });
          try {
            const pendingPage = await applicantContext.newPage();
            await login(pendingPage, applicant.email);
            let subscribed = false;
            pendingPage.on('websocket', socket => socket.on('framereceived', frame => {
              const payload = frame.payload.toString();
              if (payload.includes('application-status-') && payload.includes('phx_reply') && payload.includes('"status":"ok"')) subscribed = true;
            }));
            await pendingPage.goto('/membership');
            await expect(pendingPage.getByText('Pending administrator approval', { exact: true })).toBeVisible();
            await expect.poll(() => subscribed).toBe(true);
            await page.reload();
            const confirm = page.getByRole('button', { name: `Confirm decision for ${applicant.email}`, exact: true });
            await expect(confirm).toBeVisible();
            let requestStart = 0;
            page.on('request', request => { if (request.url().includes('/rpc/decide_membership')) requestStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/decide_membership')).then(async result => {
              await result.finished();
              assert.equal(result.status(), 200);
              return { approveMs: performance.now() - requestStart, result: await result.json() };
            });
            start = performance.now();
            await confirm.click();
            await expect(pendingPage.getByText('Approved', { exact: true })).toBeVisible();
            await pendingPage.getByRole('link', { name: 'Open Community', exact: true }).click();
            await expect(pendingPage.getByRole('heading', { name: `Welcome to ${community.name}.` })).toBeVisible();
            const visibleMs = performance.now() - start;
            const approval = await response;
            assert.equal(approval.result.status, 'approved');
            const membership = await applicant.client.from('memberships').select('role,status').eq('community_id', community.id).eq('user_id', applicant.id);
            assert.deepEqual(membership.data, [{ role: 'member', status: 'active' }]);
            actions.push({ index, inviteMs, applyMs, approveMs: approval.approveMs, visibleMs, applicationId: application.data.id, membershipStatus: 'active' });
            persist({ phase: 'head action persisted', errors: 0 });
          } finally { await applicantContext.close(); }
        }
      } finally { await context.close(); }
    }
  }
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
  const baseline = summary('trunk');
  const current = summary('head');
  const added = { inviteMedianMs: median(actions.map(row => row.inviteMs)), applyMedianMs: median(actions.map(row => row.applyMs)), approveMedianMs: median(actions.map(row => row.approveMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
  const queries = samples.filter(row => row.side === 'head').map(row => row.queryMs).sort((a, b) => a - b);
  const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
  const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), commands: Math.max(added.inviteMedianMs, added.applyMedianMs, added.approveMedianMs) <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
  persist({ errors: 0, pairs: count, baseline, head: current, added, queryP95Ms, checks, mode: 'local Vite development; serial Chrome; trunk served from a temporary detached worktree of the base; same database and identical persisted Community per pair', comparison: 'Trunk first then head for ten interleaved pairs. Invite actions absent on trunk use absolute budgets. No speedup claim.', providerWait: 'Excluded; real email is verified separately in server and journey tests.' });
  writeFileSync(`${directory}/report.md`, `P03 paired probe at ${head}.\n\n${count} alternating trunk/head pairs against ${values.base}. Same persisted authorized Community read and authenticated reload on each side. No speedup claim.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added actions ${JSON.stringify(added)}. Query p95 ${queryP95Ms.toFixed(1)} ms.\n\nChecks ${JSON.stringify(checks)}. Every approval produced an active membership and visible Community. Zero rejected or failed command samples. Email provider waits are excluded and tested separately. Local development timing is bounded by browser reload, HTTP, realtime delivery, and rendering. It does not establish production throughput.\n`);
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  console.log(JSON.stringify({ baseline, head: current, added, queryP95Ms, checks }));
} catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
finally {
  await browser.close();
  await Promise.all(servers.map(server => new Promise(done => { if (server.exitCode !== null) done(null); else { server.once('exit', done); server.kill(); } })));
  removeTrunk();
}

}
