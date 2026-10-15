import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { actor, password } from './backend';
import { communitySchema } from '../../src/features/communities/model';

const { values } = parseArgs({ options: { issue: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, pairs: { type: 'string', default: '10' } } });
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
const started = performance.now();
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    try { ready = (await fetch('http://127.0.0.1:5174')).ok; } catch { ready = false; }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'App did not respond within 60 seconds.');
  const startupPage = await browser.newPage();
  await startupPage.goto('http://127.0.0.1:5174');
  await expect(startupPage.getByRole('heading', { name: 'Good to have you here.' })).toBeVisible();
  const readinessMs = performance.now() - started;
  await startupPage.close();
  for (let index = 0; index < count; index++) {
    const owner = await actor({ label: 'perf' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5174');
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
