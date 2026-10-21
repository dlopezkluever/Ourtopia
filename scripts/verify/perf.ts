import { disputeView } from './backend';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { chromium, expect, type Page } from '@playwright/test';
import { handoffFixture, advanceHandoff, itemHandoff, handoffCondition } from './backend';
import { handoffSchema } from '../../src/features/handoff/model';
import { activeMember, actor, commitHelp, createCommunity, createHelpPost, helpFixture, helpListingFields, helpNeedFields, helpScheduleFields, membershipFixture, password, configureVouch, vouchFixture, admin, failedDelivery } from './backend';
import { localDelivery } from '../../supabase/functions/notifications/local';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { borrowingFixture, itemNeedFixture, requestItem, workflowEffects } from './backend';
import { borrowViewSchema } from '../../src/features/borrowing/model';
import { z } from 'zod';
import { vouchSchema } from '../../src/features/vouches/model';
import { standingSchema } from '../../src/features/reputation/model';
import { communitySchema } from '../../src/features/communities/model';
import { drillDetails } from './backend';
import { listingSchema } from '../../src/features/listings/model';
import { conversationSchema, messageSchema } from '../../src/features/messages/model';
import { helpCompletionSchema, helpExchangeSchema, helpPostSchema } from '../../src/features/help/model';

const { values } = parseArgs({ options: { issue: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, pairs: { type: 'string', default: '10' } } });
if (values.issue === '24') await verifyIssue24(values);
else if (values.issue === '25') await verifyIssue25(values);
else if (values.issue === '16') await verifyIssue16(values);
else if (values.issue === '17') await verifyIssue17(values);
else if (values.issue === '18') await verifyIssue18(values);
else if (values.issue === '19') await verifyIssue19(values);
else if (values.issue === '20') await verifyIssue20(values);
else if (values.issue === '21') await verifyIssue21(values);
else if (values.issue === '8') await verifyIssue8(values);
else if (values.issue === '9') await verifyIssue9(values);
else if (values.issue === '11') await verifyIssue11(values);
else if (values.issue === '7') await verifyIssue7(values);
else if (values.issue === '23') await verifyIssue23(values);
else if (values.issue === '6') await verifyIssue6(values);
else if (values.issue === '22') await (await import('../../supabase/functions/stripe-checkout/perf')).verifyBillingPerf(values);
else if (values.issue === '14') await verifyIssue14(values);
else if (values.issue === '12') await verifyIssue12(values);
else if (values.issue === '13') await verifyIssue13(values);
else if (values.issue === '15') await verifyIssue15(values);
else if (values.issue === '3' || values.issue === '4' || values.issue === '5') await verifyIssue3(values);
else await verifyIssue2(values);

type PerfArguments = { issue?: string; base?: string; head?: string; pairs?: string };

async function verifyIssue25(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(!tree.some(path => path.startsWith('src/features/pilot-metrics/')));
  const evidence = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(evidence, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-25'); assert.ok(!existsSync(trunkRoot));
  const samples: { pair: number; side: string; readinessMs: number; communityReadMs: number; metricsReadMs?: number; visibleMs?: number }[] = [];
  const servers: ReturnType<typeof spawn>[] = [];
  const port = Number(process.env.APP_PORT ?? 5173) + 12;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${evidence}/samples.json`, JSON.stringify({ head, base, pairs, samples, result, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() } }, null, 2));
  async function serve(root: string, at: number) {
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server); const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null);
      if (await fetch(`http://127.0.0.1:${at}`).then(result => result.ok, () => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('P25 probe exceeded 60-second startup budget.');
  }
  try {
    for (const path of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
      const target = join(trunkRoot, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve(trunkRoot, port); await serve('.', port + 1);
    for (let pair = 0; pair < pairs; pair++) {
      const fixture = await membershipFixture(`perf25-${pair}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(fixture.owner.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const welcome = page.getByRole('heading', { name: `Welcome to ${fixture.community.name}.` }); await expect(welcome).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(welcome).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const community = await fixture.owner.client.from('communities').select('id,name').eq('id', fixture.community.id);
          const communityReadMs = performance.now() - readAt; assert.equal(community.error, null); assert.equal(community.data?.[0]?.id, fixture.community.id);
          if (side === 'trunk') samples.push({ pair, side, readinessMs, communityReadMs });
          else {
            const metricsAt = performance.now(); const metrics = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
            const metricsReadMs = performance.now() - metricsAt; assert.equal(metrics.error, null);
            const actionAt = performance.now(); await page.getByRole('link', { name: 'Pilot health and activity export' }).click();
            await expect(page.getByRole('heading', { name: 'Pilot health' })).toBeVisible(); const visibleMs = performance.now() - actionAt;
            samples.push({ pair, side, readinessMs, communityReadMs, metricsReadMs, visibleMs });
          }
          persist({ failures: 0 });
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
    const baseline = { readinessMs: median(samples.filter(row => row.side === 'trunk').map(row => row.readinessMs)), communityReadMs: median(samples.filter(row => row.side === 'trunk').map(row => row.communityReadMs)) };
    const current = { readinessMs: median(samples.filter(row => row.side === 'head').map(row => row.readinessMs)), communityReadMs: median(samples.filter(row => row.side === 'head').map(row => row.communityReadMs)) };
    const metricsReadMs = median(samples.filter(row => row.metricsReadMs !== undefined).map(row => row.metricsReadMs!));
    const visibleMs = median(samples.filter(row => row.visibleMs !== undefined).map(row => row.visibleMs!));
    const readinessBudget = Math.max(1.2 * baseline.readinessMs, baseline.readinessMs + 100);
    const querySamples = samples.filter(row => row.metricsReadMs !== undefined).map(row => row.metricsReadMs!);
    const sortedQueries = [...querySamples].sort((a, b) => a - b); const p95 = sortedQueries[Math.ceil(sortedQueries.length * .95) - 1];
    const result = { baseline, head: current, readinessBudget, metricsReadMedianMs: metricsReadMs, metricsReadP95Ms: p95, visibleMedianMs: visibleMs, pass: current.readinessMs <= readinessBudget && metricsReadMs <= 3000 && p95 <= 3000 && visibleMs <= 2000 };
    writeFileSync(`${evidence}/report.md`, `# Issue 25 performance\n\n- Head: ${head}\n- Base: ${base}\n- Paired runs: ${pairs}\n- Trunk metric route: absent at base; readiness and authorized Community read are compared on both sides.\n- Baseline: ${JSON.stringify(baseline)}\n- Head shared path: ${JSON.stringify(current)}\n- Head authorized metrics read median: ${metricsReadMs.toFixed(1)} ms\n- Head authorized metrics read p95: ${p95.toFixed(1)} ms\n- Metrics action to visible page median: ${visibleMs.toFixed(1)} ms\n- Limits: readiness ${readinessBudget.toFixed(1)} ms; metrics query 3000 ms; visible page 2000 ms.\n- Result: ${result.pass ? 'PASS' : 'FAIL'}\n`);
    persist(result); assert.ok(result.pass, JSON.stringify(result));
  } finally {
    await browser.close();
    for (const server of servers) if (server.exitCode === null) server.kill();
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-25'));
    if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue24(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(path => path.startsWith('src/features/drafts/')));
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-24'); assert.ok(!existsSync(trunkRoot));
  const samples: { pair: number; side: string; readinessMs: number; queryMs: number; communityId: string }[] = [];
  const actions: { pair: number; commandMs: number; visibleMs: number; queryMs: number; revision: number }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: number[] = [];
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null);
      if (await fetch(`http://127.0.0.1:${at}`).then(result => result.ok, () => false)) { startup.push(performance.now() - started); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('P24 probe exceeded 60-second startup budget.');
  }
  try {
    for (const path of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
      const target = join(trunkRoot, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve(trunkRoot, port); await serve('.', port + 1);
    for (let pair = 0; pair < pairs; pair++) {
      const f = await membershipFixture(`perf24-${pair}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.owner.email); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.owner.client.from('communities').select('id,name').eq('id', f.community.id); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.deepEqual(read.data, [{ id: f.community.id, name: f.community.name }]);
          samples.push({ pair, side, readinessMs, queryMs, communityId: f.community.id }); persist({ failures: 0 });
          if (side === 'head') {
            await page.getByRole('link', { name: 'Draft contributions', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Item Listing draft' })).toBeVisible();
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/command_contribution_draft')) commandAt = performance.now(); });
            const response = page.waitForResponse(response => response.url().includes('/rpc/command_contribution_draft')).then(async response => { await response.finished(); assert.equal(response.status(), 200); return performance.now() - commandAt; });
            const title = `Durable P24 draft ${pair}`; const actionAt = performance.now(); await page.getByLabel('Title', { exact: true }).fill(title); await expect(page.getByRole('status').filter({ hasText: 'Draft saved privately.' })).toBeVisible(); const visibleMs = performance.now() - actionAt;
            const commandMs = await response; const queryAt = performance.now(); const draft = await f.owner.client.from('contribution_drafts').select('fields,revision,status').eq('community_id', f.community.id).eq('kind', 'item').single(); const endQueryMs = performance.now() - queryAt;
            assert.equal(draft.error, null); assert.equal(draft.data!.status, 'editing'); assert.equal((draft.data!.fields as Record<string, unknown>).title, title);
            await page.reload(); await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
            actions.push({ pair, commandMs, visibleMs, queryMs: endQueryMs, revision: draft.data!.revision }); persist({ failures: 0 });
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
    const summary = (side: string) => ({ readinessMs: median(samples.filter(sample => sample.side === side).map(sample => sample.readinessMs)), queryMs: median(samples.filter(sample => sample.side === side).map(sample => sample.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMs: median(actions.map(action => action.commandMs)), visibleMs: median(actions.map(action => action.visibleMs)) };
    const queries = [...samples.filter(sample => sample.side === 'head').map(sample => sample.queryMs), ...actions.map(action => action.queryMs)].sort((a, b) => a - b); const p95 = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMs <= Math.max(1.2 * baseline.readinessMs, baseline.readinessMs + 100), read: current.queryMs <= Math.max(1.2 * baseline.queryMs, baseline.queryMs + 100), command: added.commandMs <= 1000, visible: added.visibleMs <= 2000, queryP95: p95 <= 3000, startup: startup.every(value => value <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(action => action.commandMs)), Math.max(...actions.map(action => action.commandMs))], visibleMs: [Math.min(...actions.map(action => action.visibleMs)), Math.max(...actions.map(action => action.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, p95, ranges, checks });
    writeFileSync(`${directory}/report.md`, `P24 at ${head}.\n\n${pairs} interleaved pairs against ${base}. Both reload the authorized Community home and read the same persisted Community as its owner. Trunk lacks durable contribution drafts. Head adds an autosaved draft, fresh RLS read and restored form after reload. All outputs asserted. No external provider is timed.\n\nBaseline ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)} ms. Query p95 ${p95} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nThis is a local serial Chrome/Vite gate, including HTTP, Postgres and rendering. The visible path includes the deliberate 600 ms autosave debounce. Host observations are in samples.json. No production throughput or speedup claim; production performance and a saturation limiter are inconclusive.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, p95, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); for (const server of servers) if (server.exitCode === null) server.kill();
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-24')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue7(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/handoff/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-7'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; exchangeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; exchangeId: string; state: string }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await handoffFixture(`perf7-${index}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.bob.client.from('exchanges').select('id,state').eq('id', f.exchangeId); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.deepEqual(read.data, [{ id: f.exchangeId, state: 'approved' }]);
          samples.push({ index, side, readinessMs, queryMs, exchangeId: f.exchangeId }); persist({ failures: 0, phase: 'paired readiness and authorized Exchange read' });
          if (side === 'head') {
            await advanceHandoff(f, 'condition'); await page.goto(`/handoffs/${f.exchangeId}`);
            await page.getByLabel('I acknowledge the item is received', { exact: false }).check();
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/command_item_handoff')) commandAt = performance.now(); });
            const response = page.waitForResponse(r => r.url().includes('/rpc/command_item_handoff')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return { commandMs: performance.now() - commandAt, h: handoffSchema.parse(await r.json()) }; });
            const actionAt = performance.now(); await page.getByRole('button', { name: 'Confirm Handoff', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible(); const visibleMs = performance.now() - actionAt;
            const result = await response; assert.equal(result.h.state, 'checked_out');
            const queryAt = performance.now(); const durable = await itemHandoff(f.alice, f.exchangeId); const endQueryMs = performance.now() - queryAt;
            assert.equal(durable.state, 'checked_out'); assert.equal(durable.condition, handoffCondition.condition); assert.equal(durable.accessories, handoffCondition.accessories); assert.equal(durable.reservation.custody_unresolved, true);
            await page.reload(); await expect(page.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible();
            actions.push({ index, commandMs: result.commandMs, visibleMs, queryMs: endQueryMs, exchangeId: f.exchangeId, state: durable.state }); persist({ failures: 0, phase: 'durable Handoff after reload and counterparty read' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P07 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both reload the authenticated home and read the identical approved Exchange as Bob. Trunk lacks Handoff controls. Added head samples measure the final guarded Handoff command, the visible checked-out state, a fresh owner read of condition/accessories/custody, and a borrower reload.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. Notices are enqueued after the same business transition and delivered separately. No external provider wait is timed. Production performance is inconclusive, no saturation limiter established and no speedup or throughput claim. Raw samples and host memory observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-7')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue23(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(path => path.startsWith('src/features/notification-delivery/')), 'Record the absent console before measuring added actions.');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  const root = resolve('.pilot-evidence', 'p23-perf-trunk');
  mkdirSync(directory, { recursive: true });
  for (const path of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
    const target = join(root, path); mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
  }
  copyFileSync('.env.local', join(root, '.env.local'));
  writeFileSync(join(root, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: number[] = [];
  const samples: { index: number; side: string; readinessMs: number; queryMs: number }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; providerMs: number; noticeId: string }[] = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(root: string, port: number, extra: string[] = []) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...extra, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null, 'Probe server remains alive.');
      if (await fetch(`http://127.0.0.1:${port}`).then(response => response.ok, () => false)) { startup.push(performance.now() - started); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Probe startup exceeded 60 seconds.');
  }
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  try {
    await serve(root, trunkPort, ['--config', join(root, 'perf.vite.config.ts')]); await serve('.', trunkPort + 1);
    const { client, send } = localDelivery();
    for (let index = 0; index < pairs; index++) {
      const f = await failedDelivery(`p23-perf-${index}`);
      for (const [side, port] of [['trunk', trunkPort], ['head', trunkPort + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.owner.email); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const start = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - start;
          const readStart = performance.now(); const query = await f.owner.client.from('notification_outbox').select('id,state,attempts').eq('id', f.email.id); const queryMs = performance.now() - readStart;
          assert.equal(query.error, null); assert.deepEqual(query.data, [{ id: f.email.id, state: 'failed', attempts: 1 }]); samples.push({ index, side, readinessMs, queryMs }); persist({ errors: 0 });
          if (side === 'trunk') { await expect(page.getByRole('link', { name: 'Notice deliveries', exact: true })).toHaveCount(0); continue; }
          await page.goto(`/deliveries?community=${f.community.id}`);
          const card = page.getByRole('article', { name: `Membership approved email ${f.email.id}`, exact: true });
          await expect(card.getByText('Retryable failure', { exact: true })).toBeVisible();
          let commandStart = 0;
          page.on('request', request => { if (request.url().includes('/rpc/retry_notification')) commandStart = performance.now(); });
          const response = page.waitForResponse(response => response.url().includes('/rpc/retry_notification')).then(async response => { await response.finished(); assert.equal(response.status(), 200); return performance.now() - commandStart; });
          const actionStart = performance.now(); await card.getByRole('button', { name: 'Retry delivery' }).click();
          await expect(page.getByText('Retry requested. Delivery runs after the original workflow commits.', { exact: true })).toBeVisible(); const commandMs = await response;
          let providerMs = 0; const delivered = await deliverOne(client, async message => { const started = performance.now(); try { await send(message); } finally { providerMs += performance.now() - started; } }, f.email.id) as { state: string }; assert.equal(delivered.state, 'delivered');
          await page.getByRole('button', { name: 'Refresh deliveries' }).click(); await expect(card.getByText('Delivered', { exact: true })).toBeVisible();
          const visibleMs = performance.now() - actionStart - providerMs;
          const inspectStart = performance.now(); const inspected = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id }); const inspectMs = performance.now() - inspectStart;
          assert.equal(inspected.error, null); assert.equal(inspected.data.find((row: { id: string }) => row.id === f.email.id).attempts, 2);
          const membership = await f.applicant.client.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.applicant.id); assert.deepEqual(membership.data, [{ status: 'active' }]);
          await page.reload(); await expect(card.getByText('Delivered', { exact: true })).toBeVisible();
          actions.push({ index, commandMs, visibleMs, queryMs: inspectMs, providerMs, noticeId: f.email.id }); persist({ errors: 0 });
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { commandMs: median(actions.map(row => row.commandMs)), visibleMs: median(actions.map(row => row.visibleMs)), providerMs: median(actions.map(row => row.providerMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMs <= Math.max(1.2 * baseline.readinessMs, baseline.readinessMs + 100), read: current.queryMs <= Math.max(1.2 * baseline.queryMs, baseline.queryMs + 100), command: added.commandMs <= 1000, visible: added.visibleMs <= 2000, query: queryP95Ms <= 3000, startup: startup.every(value => value <= 60000) };
    const ranges = { readiness: [Math.min(...samples.map(row => row.readinessMs)), Math.max(...samples.map(row => row.readinessMs))], visible: [Math.min(...actions.map(row => row.visibleMs)), Math.max(...actions.map(row => row.visibleMs))] };
    persist({ errors: 0, baseline, current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P23 at ${head}, base ${base}.\n\n${pairs} alternating trunk-first pairs. Both sides reload the same authorized Community and read the same failed outbox entry under its administrator. Trunk already has membership-specific retry, whose persisted success is exercised by journey lane 1. It lacks the new console inspection and attempt-history flow. The added console journey uses absolute budgets. Provider HTTP waits are measured separately and subtracted from local visible time. Local claim and finish work remains inside the visible measurement. Every action verifies two attempts, active membership and delivered state after reload.\n\nBaseline ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}.\n\nLocal serial Chrome and Vite development probe, bounded by authenticated HTTP round trips and rendering. No production throughput or speedup claim. Raw timings, provider waits, zero-error assertions and host observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { await browser.close(); await Promise.all(servers.map(server => new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', () => resolve()); server.kill(); } }))); }
}

async function verifyIssue15(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the committed candidate head.');
  assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs);
  assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(tree.includes('package.json'));
  assert.ok(!tree.some(path => path.startsWith('src/features/messages/')), 'The added-action exception requires messaging to be absent at the base.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('..', 'perf-trunk-15');
  assert.ok(!existsSync(trunkRoot), 'An existing probe checkout must be inspected before reuse.');
  const trunkModules = join(trunkRoot, 'node_modules');
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; communityId: string }[] = [];
  const actions: { index: number; startMs: number; commandMs: number; visibleMs: number; messageQueryMs: number; messageId: string; conversationId: string; persistedReaders: number }[] = [];
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  const headPort = trunkPort + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base, pairs, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(label: string, root: string, port: number, config: string[] = []) {
    const start = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${label} server exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) { startup[label] = performance.now() - start; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${label} startup exceeded 60 seconds`);
  }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', trunkRoot, base], { stdio: 'inherit' });
    symlinkSync(resolve('node_modules'), trunkModules, 'junction');
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
    await serve('head', '.', headPort);
    for (let index = 0; index < pairs; index++) {
      const { owner, community } = await membershipFixture(`perf-${index}`);
      const f = { first: await activeMember(owner, community.id, 'perf-first'), second: await activeMember(owner, community.id, 'perf-second'), community };
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(f.first.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyStart = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyStart;
          const queryStart = performance.now(); const query = await f.first.client.from('communities').select('id,name').eq('id', f.community.id); const queryMs = performance.now() - queryStart;
          assert.equal(query.error, null); assert.deepEqual(query.data, [f.community]);
          samples.push({ index, side, readinessMs, queryMs, communityId: f.community.id }); persist({ errors: 0, phase: 'paired reads' });
          if (side === 'head') {
            const startAt = performance.now();
            const started = await f.first.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_participant_id: f.second.id });
            const startMs = performance.now() - startAt; assert.equal(started.error, null);
            const conversation = conversationSchema.parse(started.data);
            await page.goto(`/messages/${conversation.id}`); await expect(page.getByRole('heading', { name: `Conversation with ${f.second.email}` })).toBeVisible();
            const body = `Performance handoff ${index}`; await page.getByLabel(`Message to ${f.second.email}`, { exact: true }).fill(body);
            let requestStart = 0;
            page.on('request', request => { if (request.url().includes('/rpc/send_message')) requestStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/send_message')).then(async value => {
              await value.finished(); assert.equal(value.status(), 200);
              return { commandMs: performance.now() - requestStart, message: messageSchema.parse(await value.json()) };
            });
            const actionStart = performance.now(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
            await expect(page.getByText(body, { exact: true })).toBeVisible(); const visibleMs = performance.now() - actionStart;
            const result = await response;
            const readStart = performance.now(); const messages = await f.second.client.from('messages').select('id,body').eq('conversation_id', conversation.id); const messageQueryMs = performance.now() - readStart;
            assert.equal(messages.error, null); assert.deepEqual(messages.data, [{ id: result.message.id, body }]);
            await page.reload(); await expect(page.getByText(body, { exact: true })).toBeVisible();
            actions.push({ index, startMs, commandMs: result.commandMs, visibleMs, messageQueryMs, messageId: result.message.id, conversationId: conversation.id, persistedReaders: 2 }); persist({ errors: 0, phase: 'head action persisted' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { startMedianMs: median(actions.map(row => row.startMs)), commandMedianMs: median(actions.map(row => row.commandMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.messageQueryMs)].sort((a, b) => a - b);
    const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: Math.max(added.startMedianMs, added.commandMedianMs) <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    const ranges = { readinessMs: [Math.min(...samples.map(row => row.readinessMs)), Math.max(...samples.map(row => row.readinessMs))], commandMs: [Math.min(...actions.map(row => row.commandMs)), Math.max(...actions.map(row => row.commandMs))], visibleMs: [Math.min(...actions.map(row => row.visibleMs)), Math.max(...actions.map(row => row.visibleMs))] };
    persist({ errors: 0, baseline, head: current, added, queryP95Ms, checks, ranges, claim: 'Local serial development probe meets regression and absolute budgets. No production throughput or speedup claim.', baselineAction: 'Messages absent; shared authorized Community readiness/read compared instead.', providerWait: 'None in this path; only local persisted command and render work.' });
    writeFileSync(`${directory}/report.md`, `P15 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both sides reload and read the identical authorized Community. Trunk lacks messaging, so added message commands and durable visible states use absolute budgets.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}.\n\nEvery sample includes a successful HTTP command, a unique persisted message, a fresh counterparty RLS read and an author reload. Zero failed samples. Local serial Chrome and Vite development timings include HTTP, PostgreSQL and render work. Provider waits are absent. No production throughput or speedup claim. Host observations and raw samples are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkModules)) unlinkSync(trunkModules);
    if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
    assert.ok(existsSync('node_modules/vite/package.json'));
  }
}

async function verifyIssue12(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the committed candidate head.');
  assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs);
  assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(tree.includes('package.json'));
  assert.ok(!tree.some(path => path.startsWith('src/features/help/')), 'The added-action exception requires help to be absent at the base.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('..', 'perf-trunk-12');
  assert.ok(!existsSync(trunkRoot), 'An existing probe checkout must be inspected before reuse.');
  const trunkModules = join(trunkRoot, 'node_modules');
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; communityId: string }[] = [];
  const actions: { index: number; boardQueryMs: number; commandMs: number; visibleMs: number; exchangeId: string; listingId: string }[] = [];
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  const headPort = trunkPort + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base, pairs, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(label: string, root: string, port: number, config: string[] = []) {
    const start = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${label} server exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) { startup[label] = performance.now() - start; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${label} startup exceeded 60 seconds`);
  }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', trunkRoot, base], { stdio: 'inherit' });
    symlinkSync(resolve('node_modules'), trunkModules, 'junction');
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
    await serve('head', '.', headPort);
    for (let index = 0; index < pairs; index++) {
      const f = await helpFixture(`perf12-${index}`, 1);
      const [requester] = f.members;
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(f.author.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyStart = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyStart;
          const queryStart = performance.now(); const query = await f.author.client.from('communities').select('id,name').eq('id', f.community.id); const queryMs = performance.now() - queryStart;
          assert.equal(query.error, null); assert.deepEqual(query.data, [f.community]);
          samples.push({ index, side, readinessMs, queryMs, communityId: f.community.id }); persist({ errors: 0, phase: 'paired reads' });
          if (side === 'head') {
            const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields({ title: `Perf help ${index}` }));
            await commitHelp(requester, 'listing', listing.id);
            const boardStart = performance.now();
            const board = await requester.client.rpc('help_board', { p_community_id: f.community.id, p_search: '', p_post_kind: '', p_category: '' });
            const boardQueryMs = performance.now() - boardStart;
            assert.equal(board.error, null); assert.deepEqual(helpPostSchema.array().parse(board.data).map(post => post.id), [listing.id]);
            await page.goto(`/help/${f.community.id}/listing/${listing.id}`); await expect(page.getByRole('heading', { name: `Perf help ${index}`, exact: true })).toBeVisible();
            let requestStart = 0;
            page.on('request', request => { if (request.url().includes('/rpc/accept_help_commitment')) requestStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/accept_help_commitment')).then(async value => {
              await value.finished(); assert.equal(value.status(), 200);
              return { commandMs: performance.now() - requestStart, exchange: helpExchangeSchema.parse(await value.json()) };
            });
            const actionStart = performance.now(); await page.getByRole('button', { name: `Accept ${requester.email}`, exact: true }).click();
            const region = page.getByRole('region', { name: `Help Exchange with ${requester.email}` });
            await expect(region.getByText('Committed', { exact: true })).toBeVisible(); const visibleMs = performance.now() - actionStart;
            const result = await response;
            const persisted = await requester.client.from('exchanges').select('id,kind,provider_id,receiver_id,state').eq('source_id', listing.id);
            assert.deepEqual(persisted.data, [{ id: result.exchange.id, kind: 'help', provider_id: f.author.id, receiver_id: requester.id, state: 'committed' }]);
            await page.reload(); await expect(region.getByText('Committed', { exact: true })).toBeVisible();
            actions.push({ index, boardQueryMs, commandMs: result.commandMs, visibleMs, exchangeId: result.exchange.id, listingId: listing.id }); persist({ errors: 0, phase: 'head action persisted' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { boardQueryMedianMs: median(actions.map(row => row.boardQueryMs)), commandMedianMs: median(actions.map(row => row.commandMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.boardQueryMs)].sort((a, b) => a - b);
    const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    const ranges = { readinessMs: [Math.min(...samples.map(row => row.readinessMs)), Math.max(...samples.map(row => row.readinessMs))], commandMs: [Math.min(...actions.map(row => row.commandMs)), Math.max(...actions.map(row => row.commandMs))], visibleMs: [Math.min(...actions.map(row => row.visibleMs)), Math.max(...actions.map(row => row.visibleMs))] };
    persist({ errors: 0, baseline, head: current, added, queryP95Ms, checks, ranges, claim: 'Local serial development probe meets regression and absolute budgets. No production throughput or speedup claim.', baselineAction: 'Help absent at trunk; shared authorized Community readiness/read compared instead.', providerWait: 'None in this path; notices are enqueued in the transaction and delivered after commit.' });
    writeFileSync(`${directory}/report.md`, `P12 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both sides reload and read the identical authorized Community. Trunk lacks help, so the added help board read, owner acceptance command, and visible committed Exchange use absolute budgets.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}.\n\nEvery head sample publishes a Help Listing, records a requester commitment, reads the board, accepts through the browser, asserts HTTP 200, one persisted committed help Exchange with the owner as helper and the committer as requester, and a reload. Zero failed samples. Local serial Chrome and Vite development timings include HTTP, PostgreSQL and render work. Notice delivery happens after commit and is excluded. No production throughput or speedup claim. Host observations and raw samples are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkModules)) unlinkSync(trunkModules);
    if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
    assert.ok(existsSync('node_modules/vite/package.json'));
  }
}

async function verifyIssue13(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the exact candidate head.');
  assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs);
  assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(tree.includes('src/features/help/HelpPage.tsx'), 'The baseline includes issue 12 Help Exchanges.');
  assert.ok(!tree.some(path => /help-completion|issue-13/.test(path)), 'The baseline excludes issue 13 completion.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('..', 'perf-trunk-13');
  assert.ok(!existsSync(trunkRoot), 'Inspect an existing perf worktree before reusing it.');
  const trunkModules = join(trunkRoot, 'node_modules');
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; exchangeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; exchangeId: string; state: string }[] = [];
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  const headPort = trunkPort + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base, pairs, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(label: string, root: string, port: number, config: string[] = []) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${label} server exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${port}`).then(response => response.ok, () => false)) { startup[label] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${label} startup exceeded 60 seconds`);
  }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', trunkRoot, base], { stdio: 'inherit' });
    symlinkSync(resolve('node_modules'), trunkModules, 'junction');
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
    await serve('head', '.', headPort);
    for (let index = 0; index < pairs; index++) {
      const f = await helpFixture(`perf13-${index}`, 1);
      const [helper] = f.members;
      const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1));
      const commitment = await commitHelp(helper, 'need_post', need.id);
      const accepted = await f.author.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: commitment });
      assert.equal(accepted.error, null);
      const exchangeId = helpExchangeSchema.parse(accepted.data).id;
      const scheduled = await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchangeId, p_fields: helpScheduleFields() });
      assert.equal(scheduled.error, null);
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(helper.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const queryAt = performance.now();
          const read = await helper.client.from('exchanges').select('id,state').eq('id', exchangeId);
          const queryMs = performance.now() - queryAt;
          assert.deepEqual(read.data, [{ id: exchangeId, state: 'scheduled' }]);
          samples.push({ index, side, readinessMs, queryMs, exchangeId }); persist({ failures: 0, phase: 'paired authorized scheduled Exchange read' });
          if (side === 'head') {
            const path = `/help/${f.community.id}/need/${need.id}`;
            await page.goto(path);
            const helperCard = page.getByRole('region', { name: `Help Exchange with ${f.author.email}` });
            let firstCommand = 0;
            page.on('request', request => { if (request.url().includes('/rpc/command_help_completion')) firstCommand = performance.now(); });
            const firstResponse = page.waitForResponse(response => response.url().includes('/rpc/command_help_completion')).then(async response => { await response.finished(); assert.equal(response.status(), 200); return performance.now() - firstCommand; });
            await helperCard.getByRole('button', { name: 'Confirm completed help' }).click();
            await expect(helperCard).toContainText('Waiting for the other participant to confirm');
            await firstResponse;
            await page.getByRole('button', { name: 'Sign out' }).click();
            await page.goto('/'); await page.getByLabel('Email address').fill(f.author.email); await page.getByLabel('Password', { exact: true }).fill(password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
            await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(); await page.goto(path);
            const requesterCard = page.getByRole('region', { name: `Help Exchange with ${helper.email}` });
            let commandStart = 0;
            page.on('request', request => { if (request.url().includes('/rpc/command_help_completion')) commandStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/command_help_completion')).then(async value => { await value.finished(); assert.equal(value.status(), 200); return performance.now() - commandStart; });
            const actionAt = performance.now(); await requesterCard.getByRole('button', { name: 'Confirm completed help' }).click();
            await expect(requesterCard).toContainText('Help completed.'); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const readAt = performance.now(); const durableResult = await helper.client.rpc('read_help_completion', { p_exchange_id: exchangeId }); const finalQueryMs = performance.now() - readAt;
            const durable = helpCompletionSchema.parse(durableResult.data);
            assert.equal(durableResult.error, null); assert.equal(durable.state, 'completed');
            assert.deepEqual(durable.awards, [{ recipientId: helper.id, rule: 'help_helper_completed', points: 3 }]);
            actions.push({ index, commandMs, visibleMs, queryMs: finalQueryMs, exchangeId, state: durable.state });
            persist({ failures: 0, phase: 'both confirmations completed and fresh read showed helper-only award' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { commandMedianMs: median(actions.map(row => row.commandMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.queryMs)].sort((a, b) => a - b);
    const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, claim: 'Local serial development probe with regression and absolute budgets. No production throughput or speedup claim.' });
    writeFileSync(`${directory}/report.md`, `P13 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both sides reload and read the same scheduled Help Exchange. Head samples measure the second participant confirmation through the command, visible completion, and a fresh participant read showing completion and the +3 helper award.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Checks ${JSON.stringify(checks)}.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres, and rendering. Notice delivery is excluded. No production throughput or speedup claim. Raw samples and host observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkModules)) unlinkSync(trunkModules);
    if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
  }
}

async function verifyIssue6(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the committed candidate head.');
  assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs);
  assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(tree.includes('package.json'));
  assert.ok(!tree.some(path => path.startsWith('src/features/borrowing/')), 'The added-action exception requires Borrow Requests to be absent at the base.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('..', 'perf-trunk-6');
  assert.ok(!existsSync(trunkRoot), 'An existing probe checkout must be inspected before reuse.');
  const trunkModules = join(trunkRoot, 'node_modules');
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; communityId: string }[] = [];
  const actions: { index: number; requestQueryMs: number; commandMs: number; visibleMs: number; exchangeId: string; listingId: string }[] = [];
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  const headPort = trunkPort + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base, pairs, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(label: string, root: string, port: number, config: string[] = []) {
    const start = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${label} server exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) { startup[label] = performance.now() - start; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${label} startup exceeded 60 seconds`);
  }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', trunkRoot, base], { stdio: 'inherit' });
    symlinkSync(resolve('node_modules'), trunkModules, 'junction');
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
    await serve('head', '.', headPort);
    for (let index = 0; index < pairs; index++) {
      const f = await borrowingFixture(`perf6-${index}`);
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(f.alice.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyStart = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyStart;
          const queryStart = performance.now(); const query = await f.alice.client.from('communities').select('id,name').eq('id', f.community.id); const queryMs = performance.now() - queryStart;
          assert.equal(query.error, null); assert.deepEqual(query.data, [f.community]);
          samples.push({ index, side, readinessMs, queryMs, communityId: f.community.id }); persist({ errors: 0, phase: 'paired reads' });
          if (side === 'head') {
            const request = await requestItem(f.bob, f.listing.id);
            const requestStart = performance.now();
            const pending = await f.alice.client.from('borrow_requests').select('id,status,exchange_id').eq('listing_id', f.listing.id);
            const requestQueryMs = performance.now() - requestStart;
            assert.equal(pending.error, null); assert.deepEqual(pending.data, [{ id: request.id, status: 'requested', exchange_id: null }]);
            await page.goto(`/communities/${f.community.id}/listings/${f.listing.id}`);
            const card = page.getByRole('article', { name: `Borrow Request from ${f.bob.email} for Fri, Jan 15, 2027 through Sun, Jan 17, 2027`, exact: true });
            const approve = card.getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }); await expect(approve).toBeVisible();
            let commandStart = 0;
            page.on('request', value => { if (value.url().includes('/rpc/decide_borrow_request')) commandStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/decide_borrow_request')).then(async value => {
              await value.finished(); assert.equal(value.status(), 200);
              return { commandMs: performance.now() - commandStart, view: borrowViewSchema.parse(await value.json()) };
            });
            const actionStart = performance.now(); await approve.click();
            const reserved = card.getByRole('heading', { name: 'Dates reserved', exact: true });
            await expect(reserved).toBeVisible(); const visibleMs = performance.now() - actionStart;
            const result = await response;
            const persisted = await f.bob.client.from('item_reservations').select('exchange_id,dates,blocking').eq('listing_id', f.listing.id);
            assert.deepEqual(persisted.data, [{ exchange_id: result.view.exchange_id, dates: '[2027-01-15,2027-01-18)', blocking: true }]);
            await page.reload(); await expect(reserved).toBeVisible();
            actions.push({ index, requestQueryMs, commandMs: result.commandMs, visibleMs, exchangeId: result.view.exchange_id ?? '', listingId: f.listing.id }); persist({ errors: 0, phase: 'head action persisted' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { requestQueryMedianMs: median(actions.map(row => row.requestQueryMs)), commandMedianMs: median(actions.map(row => row.commandMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.requestQueryMs)].sort((a, b) => a - b);
    const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    const ranges = { readinessMs: [Math.min(...samples.map(row => row.readinessMs)), Math.max(...samples.map(row => row.readinessMs))], commandMs: [Math.min(...actions.map(row => row.commandMs)), Math.max(...actions.map(row => row.commandMs))], visibleMs: [Math.min(...actions.map(row => row.visibleMs)), Math.max(...actions.map(row => row.visibleMs))] };
    persist({ errors: 0, baseline, head: current, added, queryP95Ms, checks, ranges, claim: 'Local serial development probe meets regression and absolute budgets. No production throughput or speedup claim.', baselineAction: 'Borrow Requests absent at trunk; shared authorized Community readiness/read compared instead.', providerWait: 'None in this path; notices are enqueued in the transaction and delivered after commit.' });
    writeFileSync(`${directory}/report.md`, `P06 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both sides reload Alice's home and read the identical authorized Community. Trunk cannot submit or approve Borrow Requests, so the added owner request read, approval command, and visible reserved dates use absolute budgets.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}.\n\nEvery head sample submits Bob's Friday through Sunday Borrow Request, reads it as Alice through RLS, approves it in the browser, asserts HTTP 200, one persisted blocking reservation [2027-01-15,2027-01-18) read by Bob, and a reload. Zero failed samples. Local serial Chrome and Vite development timings include HTTP, PostgreSQL and render work. Notices are enqueued in the approval transaction and delivered after commit, so no provider wait is included. No production throughput or speedup claim. Host observations and raw samples are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkModules)) unlinkSync(trunkModules);
    if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
    assert.ok(existsSync('node_modules/vite/package.json'));
  }
}

async function verifyIssue11(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the committed candidate head.');
  assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs);
  assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(tree.includes('package.json'));
  assert.ok(!tree.some(path => path.startsWith('src/features/item-needs/')), 'The added-action exception requires item Need Posts to be absent at the base.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-11');
  assert.ok(!existsSync(trunkRoot), 'An existing probe checkout must be inspected before reuse.');
  const trunkModules = join(trunkRoot, 'node_modules');
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; communityId: string }[] = [];
  const actions: { index: number; requestQueryMs: number; commandMs: number; visibleMs: number; borrowCommandMs: number; borrowVisibleMs: number; requestId: string; responseId: string; needId: string }[] = [];
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  const headPort = trunkPort + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base, pairs, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(label: string, root: string, port: number, config: string[] = []) {
    const start = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${label} server exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) { startup[label] = performance.now() - start; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${label} startup exceeded 60 seconds`);
  }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', trunkRoot, base], { stdio: 'inherit' });
    symlinkSync(resolve('node_modules'), trunkModules, 'junction');
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
    await serve('head', '.', headPort);
    for (let index = 0; index < pairs; index++) {
      const f = await itemNeedFixture(`perf11-${index}`);
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(f.alice.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyStart = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyStart;
          const queryStart = performance.now(); const query = await f.alice.client.from('communities').select('id,name').eq('id', f.community.id); const queryMs = performance.now() - queryStart;
          assert.equal(query.error, null); assert.deepEqual(query.data, [f.community]);
          samples.push({ index, side, readinessMs, queryMs, communityId: f.community.id }); persist({ errors: 0, phase: 'paired reads' });
          if (side === 'head') {
            await page.goto(`/communities/${f.community.id}/needs/${f.need.id}`);
            const offer = page.getByRole('form', { name: 'Answer with a Listing' }).getByRole('button', { name: 'Offer this Listing', exact: true }); await expect(offer).toBeVisible();
            let commandStart = 0;
            page.on('request', value => { if (value.url().includes('/rpc/respond_to_item_need')) commandStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/respond_to_item_need')).then(async value => {
              await value.finished(); assert.equal(value.status(), 200);
              return { commandMs: performance.now() - commandStart, row: z.object({ id: z.uuid(), listing_id: z.uuid(), status: z.literal('offered') }).parse(await value.json()) };
            });
            const actionStart = performance.now(); await offer.click();
            const offered = page.getByRole('article', { name: `Response: ${drillDetails.title}`, exact: true });
            await expect(offered).toContainText('You offered your Listing'); const visibleMs = performance.now() - actionStart;
            const result = await response;
            const requestStart = performance.now();
            const persisted = await f.bob.client.from('item_need_responses').select('id,listing_id,status').eq('need_id', f.need.id);
            const requestQueryMs = performance.now() - requestStart;
            assert.equal(persisted.error, null); assert.deepEqual(persisted.data, [{ id: result.row.id, listing_id: f.listing.id, status: 'offered' }]);
            assert.deepEqual(await workflowEffects(f.community.id), { exchanges: 0, reservations: 0, reputationEvents: 0, qualifyingInteractions: 0, borrowRequests: 0 });
            await page.reload(); await expect(offered).toBeVisible();
            const borrowerContext = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
            try {
              const borrower = await borrowerContext.newPage(); await borrower.goto('/');
              await borrower.getByLabel('Email address').fill(f.bob.email); await borrower.getByLabel('Password', { exact: true }).fill(password);
              await borrower.getByRole('button', { name: 'Sign in', exact: true }).last().click();
              await expect(borrower.getByRole('button', { name: 'Sign out' })).toBeVisible();
              await borrower.goto(`/communities/${f.community.id}/needs/${f.need.id}`);
              const requestForm = borrower.getByRole('form', { name: `Borrow Request for ${drillDetails.title}` });
              await expect(requestForm.getByLabel('First day', { exact: true })).toHaveValue('2027-01-15');
              let borrowStart = 0;
              borrower.on('request', value => { if (value.url().includes('/rpc/submit_borrow_request')) borrowStart = performance.now(); });
              const requested = borrower.waitForResponse(value => value.url().includes('/rpc/submit_borrow_request')).then(async value => {
                await value.finished(); assert.equal(value.status(), 200);
                return { commandMs: performance.now() - borrowStart, row: z.object({ id: z.uuid(), status: z.literal('requested'), exchange_id: z.null() }).parse(await value.json()) };
              });
              const visibleStart = performance.now(); await requestForm.getByRole('button', { name: 'Send Borrow Request', exact: true }).click();
              await expect(requestForm.getByRole('status')).toContainText('Borrow Request sent');
              const borrowVisibleMs = performance.now() - visibleStart;
              const requestResult = await requested;
              const savedRequest = await f.bob.client.from('borrow_requests').select('id,status,exchange_id').eq('id', requestResult.row.id);
              assert.equal(savedRequest.error, null); assert.deepEqual(savedRequest.data, [requestResult.row]);
              assert.deepEqual(await workflowEffects(f.community.id), { exchanges: 0, reservations: 0, reputationEvents: 0, qualifyingInteractions: 0, borrowRequests: 1 });
              await borrower.reload(); await expect(borrower.getByText('Your Borrow Request for', { exact: false })).toBeVisible();
              actions.push({ index, requestQueryMs, commandMs: result.commandMs, visibleMs, borrowCommandMs: requestResult.commandMs, borrowVisibleMs, requestId: requestResult.row.id, responseId: result.row.id, needId: f.need.id });
              persist({ errors: 0, phase: 'separate Borrow Request persisted' });
            } finally { await borrowerContext.close(); }
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { requestQueryMedianMs: median(actions.map(row => row.requestQueryMs)), commandMedianMs: median(actions.map(row => row.commandMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)), borrowCommandMedianMs: median(actions.map(row => row.borrowCommandMs)), borrowVisibleMedianMs: median(actions.map(row => row.borrowVisibleMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.requestQueryMs)].sort((a, b) => a - b);
    const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, borrowCommand: added.borrowCommandMedianMs <= 1000, borrowVisible: added.borrowVisibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    const ranges = { readinessMs: [Math.min(...samples.map(row => row.readinessMs)), Math.max(...samples.map(row => row.readinessMs))], commandMs: [Math.min(...actions.map(row => row.commandMs)), Math.max(...actions.map(row => row.commandMs))], visibleMs: [Math.min(...actions.map(row => row.visibleMs)), Math.max(...actions.map(row => row.visibleMs))] };
    persist({ errors: 0, baseline, head: current, added, queryP95Ms, checks, ranges, claim: 'Local serial development probe meets regression and absolute budgets. No production throughput or speedup claim.', baselineAction: 'Item Need Posts absent at trunk; shared authorized Community readiness/read compared instead.', providerWait: 'None in this path; the response notice is enqueued in the transaction and delivered after commit.' });
    writeFileSync(`${directory}/report.md`, `P11 at ${head}.

${pairs} interleaved trunk/head pairs against ${base}. Both sides reload Alice's home and read the identical authorized Community. Trunk has no item Need Posts, so the added response command, Bob's RLS read of the persisted response, and the visible offered response use absolute budgets.

Trunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}.

Every head sample opens Bob's posted drill need as Alice, offers her drill Listing in the browser, asserts HTTP 200, reads the one offered response as Bob through RLS, asserts zero Exchanges, reservations, Reputation Events, Qualifying Interactions, and Borrow Requests, and reloads. Bob then sends a separate Borrow Request in the browser. Its command and visible result have separate absolute budgets. An authorized read and reload prove that one requested Borrow Request persists and no Exchange exists. Zero failed samples. Local serial Chrome and Vite development timings include HTTP, PostgreSQL and render work. The response notice is enqueued in the transaction and delivered after commit, so no provider wait is included. No production throughput or speedup claim. Host observations and raw samples are in samples.json.
`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkModules)) unlinkSync(trunkModules);
    if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
    assert.ok(existsSync('node_modules/vite/package.json'));
  }
}

async function verifyIssue14(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the committed candidate head.');
  assert.ok(values.base);
  const base = values.base;
  const pairs = Number(values.pairs);
  assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(tree.includes('package.json'));
  assert.ok(!tree.some(path => path.startsWith('src/features/vouches/')), 'The added-action exception requires vouches to be absent at the base.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-14');
  assert.ok(!existsSync(trunkRoot), 'An existing probe checkout must be inspected before reuse.');
  const trunkModules = join(trunkRoot, 'node_modules');
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const warmup: Record<string, number> = {};
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; communityId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; vouchQueryMs: number; vouchId: string; applicationId: string; membershipStatus: string }[] = [];
  const trunkPort = Number(process.env.APP_PORT ?? 5173) + 1;
  const headPort = trunkPort + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base, pairs, startup, samples, actions, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
  async function serve(label: string, root: string, port: number, config: string[] = []) {
    const start = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
    servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${label} server exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) { startup[label] = performance.now() - start; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${label} startup exceeded 60 seconds`);
  }
  try {
    mkdirSync(trunkRoot, { recursive: true });
    for (const file of tree.filter(file => /^(src\/|vite.config.ts$|index.html$|package.json$|tsconfig.json$)/.test(file))) {
      const target = join(trunkRoot, file);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    symlinkSync(resolve('node_modules'), trunkModules, 'junction');
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    await serve('trunk', trunkRoot, trunkPort, ['--config', join(trunkRoot, 'perf.vite.config.ts')]);
    await serve('head', '.', headPort);
    for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
      const warmStart = performance.now();
      const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
      try {
        const page = await context.newPage(); await page.goto('/', { timeout: 120000 });
        await expect(page.getByLabel('Email address')).toBeVisible({ timeout: 120000 });
      } finally { await context.close(); }
      warmup[side] = performance.now() - warmStart;
    }
    for (let index = 0; index < pairs; index++) {
      const f = await vouchFixture(`perf-vouch-${index}`);
      assert.equal((await configureVouch(f.owner, f.community.id, f.sponsor.id)).error, null);
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/');
          await page.getByLabel('Email address').fill(f.sponsor.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyStart = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyStart;
          const queryStart = performance.now(); const query = await f.sponsor.client.from('communities').select('id,name').eq('id', f.community.id); const queryMs = performance.now() - queryStart;
          assert.equal(query.error, null); assert.deepEqual(query.data, [f.community]);
          samples.push({ index, side, readinessMs, queryMs, communityId: f.community.id }); persist({ errors: 0, phase: 'paired reads' });
          if (side === 'head') {
            await page.goto(`/vouches?community=${f.community.id}`);
            const body = `Persisted performance Vouch ${index}`;
            await page.getByLabel(`Trust statement for ${f.applicant.email}`, { exact: true }).fill(body);
            let requestStart = 0;
            page.on('request', request => { if (request.url().includes('/rpc/submit_vouch')) requestStart = performance.now(); });
            const response = page.waitForResponse(value => value.url().includes('/rpc/submit_vouch')).then(async value => {
              await value.finished(); assert.equal(value.status(), 200);
              return { commandMs: performance.now() - requestStart, vouch: vouchSchema.parse(await value.json()) };
            });
            const actionStart = performance.now(); await page.getByRole('button', { name: `Vouch for ${f.applicant.email}`, exact: true }).click();
            await expect(page.getByRole('region', { name: 'Sponsor history', exact: true }).getByText(body, { exact: true })).toBeVisible();
            const visibleMs = performance.now() - actionStart;
            const result = await response;
            const readStart = performance.now();
            const statement = await f.applicant.client.from('vouches').select('id,statement').eq('application_id', f.application.id);
            const vouchQueryMs = performance.now() - readStart;
            assert.equal(statement.error, null); assert.deepEqual(statement.data, [{ id: result.vouch.id, statement: body }]);
            const membership = await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.applicant.id);
            assert.deepEqual(membership.data, [{ status: 'pending' }]);
            assert.deepEqual((await f.applicant.client.from('communities').select('*')).data, []);
            assert.deepEqual(z.object({ global: standingSchema }).parse((await f.sponsor.client.rpc('my_reputation')).data).global, { score: 50, title: 'Unproven', completedInteractions: 0 });
            await page.reload(); await expect(page.getByText(body, { exact: true })).toBeVisible();
            actions.push({ index, commandMs: result.commandMs, visibleMs, vouchQueryMs, vouchId: result.vouch.id, applicationId: f.application.id, membershipStatus: 'pending' });
            persist({ errors: 0, phase: 'head statement persisted and applicant remains pending' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMedianMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { commandMedianMs: median(actions.map(row => row.commandMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
    const queries = [...samples.filter(row => row.side === 'head').map(row => row.queryMs), ...actions.map(row => row.vouchQueryMs)].sort((a, b) => a - b);
    const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    const ranges = { readinessMs: [Math.min(...samples.map(row => row.readinessMs)), Math.max(...samples.map(row => row.readinessMs))], commandMs: [Math.min(...actions.map(row => row.commandMs)), Math.max(...actions.map(row => row.commandMs))], visibleMs: [Math.min(...actions.map(row => row.visibleMs)), Math.max(...actions.map(row => row.visibleMs))] };
    persist({ errors: 0, warmup, baseline, head: current, added, queryP95Ms, checks, ranges, claim: 'Local serial development probe meets regression and absolute budgets. No production throughput or speedup claim.', baselineAction: 'Vouches absent; shared authorized Community readiness/read compared instead.', providerWait: 'None in this path; only local persisted command and render work.' });
    writeFileSync(`${directory}/report.md`, `P14 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both sides reload and read the identical authorized Community. Trunk lacks Vouches, so added statement commands and durable visible states use absolute budgets.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}.\n\nEvery sample includes a successful HTTP command, a unique persisted statement, a fresh applicant RLS read, a sponsor reload, pending membership and literal 50 Unproven with zero completions. Zero failed samples. Local serial Chrome and Vite development timings include HTTP, PostgreSQL and render work. Provider waits are absent. No production throughput or speedup claim. Host observations and raw samples are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkModules)) unlinkSync(trunkModules);
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-14'));
    if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
    assert.ok(existsSync('node_modules/vite/package.json'));
  }
}

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
assert.ok(values.issue === '3' || values.issue === '4' || values.issue === '5');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(values.head, head);
assert.ok(values.base);
const count = Number(values.pairs);
assert.ok(Number.isInteger(count) && count >= 10);
const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
mkdirSync(directory, { recursive: true });
const base = values.base;
assert.equal(execFileSync('git', ['cat-file', '-t', `${base}:package.json`], { encoding: 'utf8' }).trim(), 'blob', 'P03 needs the real P02 runtime baseline.');
const trunkRoot = values.issue === '5' ? resolve('.pilot-evidence', 'perf-trunk-5') : resolve('..', `perf-trunk-${values.issue}`);
const trunkModules = join(trunkRoot, 'node_modules');
function removeTrunk() {
  if (values.issue === '5') return;
  if (existsSync(trunkModules)) unlinkSync(trunkModules);
  if (existsSync(trunkRoot)) execFileSync('git', ['worktree', 'remove', '--force', trunkRoot], { stdio: 'inherit' });
  execFileSync('git', ['worktree', 'prune']);
  assert.ok(existsSync('node_modules/vite/package.json'), 'Trunk cleanup must not touch head dependencies.');
}
function addTrunk() {
  if (values.issue === '5') {
    assert.equal(execFileSync('git', ['diff', base, 'HEAD', '--', 'package-lock.json'], { encoding: 'utf8' }), '', 'Trunk requires identical dependencies.');
    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
    for (const path of paths) {
      const target = join(trunkRoot, path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    writeFileSync(join(trunkRoot, 'perf.vite.config.ts'), "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
    return;
  }
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
const profiles: { index: number; queryMs: number; visibleMs: number; subjectId: string }[] = [];
const listings: { index: number; commandMs: number; queryMs: number; visibleMs: number; listingId: string }[] = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
function persist(extra: unknown = {}) {
  writeFileSync(`${directory}/samples.json`, JSON.stringify({ utc: new Date().toISOString(), head, base: values.base, startup, samples, actions, profiles, ...(values.issue === '5' ? { listings } : {}), host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, extra }, null, 2));
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
        if (side === 'head' && values.issue === '5') {
          await page.goto(`/communities/${community.id}/listings`);
          await page.getByRole('button', { name: 'Share an item', exact: true }).click();
          for (const [label, value] of [['Title', drillDetails.title], ['Description', drillDetails.description], ['Condition', drillDetails.condition], ['Estimated replacement value ($)', '180'], ['Minimum Community Solidarity Score', '45'], ['Available from 1', '2027-01-10'], ['Available through 1', '2027-01-20']] as const) await page.getByLabel(label, { exact: true }).fill(value);
          let started = 0;
          page.on('request', request => { if (request.url().includes('/rpc/save_listing')) started = performance.now(); });
          const response = page.waitForResponse(response => response.url().includes('/rpc/save_listing')).then(response => { assert.equal(response.status(), 200); return { commandMs: performance.now() - started }; });
          const actionStart = performance.now();
          await page.getByRole('button', { name: 'Save Listing', exact: true }).click();
          await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
          const visibleMs = performance.now() - actionStart;
          const saved = await response;
          const readStart = performance.now();
          const result = await owner.client.from('listings').select('*,listing_availability(starts_on,ends_on)').eq('community_id', String(community.id)).single();
          const queryMs = performance.now() - readStart;
          assert.equal(result.error, null);
          const persisted = listingSchema.parse(result.data);
          assert.equal(persisted.title, "Alice's Makita drill"); assert.equal(persisted.replacement_value, 180); assert.equal(persisted.minimum_score, 45); assert.equal(persisted.owner_id, owner.id);
          await page.reload(); await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
          listings.push({ index, commandMs: saved.commandMs, queryMs, visibleMs, listingId: persisted.id });
          persist({ phase: 'Listing persisted and visible', errors: 0 });
        }
        if (side === 'head' && values.issue === '4') {
          const subject = await activeMember(owner, String(community.id), 'perf-profile-subject');
          const queryStart = performance.now();
          const profile = await owner.client.rpc('member_profile', { p_community_id: String(community.id), p_subject: subject.id });
          const queryMs = performance.now() - queryStart;
          assert.equal(profile.error, null);
          assert.deepEqual(z.object({ local: standingSchema }).parse(profile.data).local, { score: 50, title: 'Unproven', completedInteractions: 0 });
          await page.goto(`/communities/${community.id}/members`);
          const member = page.getByRole('link', { name: subject.email, exact: true });
          await expect(member).toBeVisible();
          const start = performance.now();
          await member.click();
          await expect(page.getByRole('heading', { name: subject.email, exact: true })).toBeVisible();
          await expect(page.getByRole('region', { name: 'Global Solidarity Score', exact: true })).toContainText('0 completed Exchanges');
          profiles.push({ index, queryMs, visibleMs: performance.now() - start, subjectId: subject.id });
          persist({ phase: 'profile read and visible persisted standing', errors: 0 });
        }
        if (side === 'head' && values.issue === '3') {
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
  if (values.issue === '5') {
    assert.equal(listings.length, count);
    const added = { commandMedianMs: median(listings.map(row => row.commandMs)), queryMedianMs: median(listings.map(row => row.queryMs)), visibleMedianMs: median(listings.map(row => row.visibleMs)) };
    const ordered = listings.map(row => row.queryMs).sort((a,b) => a-b);
    const queryP95Ms = ordered[Math.ceil(ordered.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    persist({ errors: 0, pairs: count, baseline, head: current, added, queryP95Ms, checks, mode: 'Local Vite development, serial Chrome. Equivalent persisted Community reads and authenticated reloads. Listing publication is absent on trunk and uses absolute budgets. No provider wait. No throughput or speedup claim.' });
    writeFileSync(`${directory}/report.md`, `P05 budget probe at ${head}.\n\n${count} interleaved trunk/head pairs. Trunk ${values.base} lacks Listing publication. Shared persisted Community reads and reloads use equivalent fixtures. Added publication measures the command response and visible durable detail, followed by direct RLS and reload assertions for the $180 drill and minimum score 45.\n\nBaseline ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Checks ${JSON.stringify(checks)}.\n\nZero failed samples. Raw samples retain host memory and every duration. Local HTTP, database command and browser rendering are timed. No saturation limiter was established. Optimization conclusions are inconclusive. No speedup or production-throughput claim.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    console.log(JSON.stringify({ baseline, head: current, added, queryP95Ms, checks }));
    return;
  }
  if (values.issue === '4') {
    assert.equal(profiles.length, count);
    const added = { queryMedianMs: median(profiles.map(row => row.queryMs)), visibleMedianMs: median(profiles.map(row => row.visibleMs)) };
    const ordered = profiles.map(row => row.queryMs).sort((a, b) => a - b);
    const queryP95Ms = ordered[Math.ceil(ordered.length * .95) - 1];
    const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    persist({ errors: 0, pairs: count, baseline, head: current, added, queryP95Ms, checks, mode: 'Local Vite development, serial Chrome, equivalent persisted authorized Community reload and read. Profile UI absent on trunk. Added profile read and visible state use absolute budgets. No mutating P04 command or provider wait.' });
    writeFileSync(`${directory}/report.md`, `P04 budget probe at ${head}.\n\n${count} alternating trunk/head pairs against ${values.base}. No speedup claim. Shared authorized home reload and Community read use equivalent persisted fixtures. Profile is absent on trunk.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added profile ${JSON.stringify(added)}. Profile query p95 ${queryP95Ms} ms. Checks ${JSON.stringify(checks)}.\n\nEvery timed profile read returned literal 50 Unproven and zero completions, and every timed navigation rendered that persisted standing. Zero failed samples. Samples include all runs and host memory. Local browser reload, HTTP and rendering bound these development measurements. Production throughput is not measured. No provider wait or mutating P04 command exists.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    console.log(JSON.stringify({ baseline, head: current, added, queryP95Ms, checks }));
    return;
  }
  const added = { inviteMedianMs: median(actions.map(row => row.inviteMs)), applyMedianMs: median(actions.map(row => row.applyMs)), approveMedianMs: median(actions.map(row => row.approveMs)), visibleMedianMs: median(actions.map(row => row.visibleMs)) };
  const queries = samples.filter(row => row.side === 'head').map(row => row.queryMs).sort((a, b) => a - b);
  const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
  // Trunk is the P02 commit, so the head carries every later feature in Vite dev mode; the readiness margin is wide enough for shared-runner noise.
  const checks = { comparableReadiness: current.readinessMedianMs <= Math.max(1.5 * baseline.readinessMedianMs, baseline.readinessMedianMs + 300), comparableRead: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), commands: Math.max(added.inviteMedianMs, added.applyMedianMs, added.approveMedianMs) <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
  persist({ errors: 0, pairs: count, baseline, head: current, added, queryP95Ms, checks, mode: 'local Vite development; serial Chrome; trunk served from a temporary detached worktree of the base; same database and identical persisted Community per pair', comparison: 'Trunk first then head for ten interleaved pairs. Invite actions absent on trunk use absolute budgets. No speedup claim.', providerWait: 'Excluded; real email is verified separately in server and journey tests.' });
  writeFileSync(`${directory}/report.md`, `P03 paired probe at ${head}.\n\n${count} alternating trunk/head pairs against ${values.base}. Same persisted authorized Community read and authenticated reload on each side. No speedup claim.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added actions ${JSON.stringify(added)}. Query p95 ${queryP95Ms.toFixed(1)} ms.\n\nChecks ${JSON.stringify(checks)}. Every approval produced an active membership and visible Community. Zero rejected or failed command samples. Email provider waits are excluded and tested separately. Local development timing is bounded by browser reload, HTTP, realtime delivery, and rendering. It does not establish production throughput.\n`);
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify({ checks, baseline, current, added, queryP95Ms }));
  console.log(JSON.stringify({ baseline, head: current, added, queryP95Ms, checks }));
} catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
finally {
  await browser.close();
  await Promise.all(servers.map(server => new Promise(done => { if (server.exitCode !== null) done(null); else { server.once('exit', done); server.kill(); } })));
  removeTrunk();
}

}

async function verifyIssue8(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/disputes/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-8'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; exchangeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; exchangeId: string; state: string }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await handoffFixture(`perf8-${index}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.bob.client.from('exchanges').select('id,state').eq('id', f.exchangeId); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.deepEqual(read.data, [{ id: f.exchangeId, state: 'approved' }]);
          samples.push({ index, side, readinessMs, queryMs, exchangeId: f.exchangeId }); persist({ failures: 0, phase: 'paired readiness and authorized Exchange read' });
          if (side === 'head') {
            await advanceHandoff(f); await page.goto(`/disputes/${f.exchangeId}`);
            await page.getByLabel('What happened?').fill('The case was damaged.');
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/report_exchange_issue')) commandAt = performance.now(); });
            const response = page.waitForResponse(r => r.url().includes('/rpc/report_exchange_issue')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return performance.now() - commandAt; });
            const actionAt = performance.now(); await page.getByRole('button', { name: 'Report issue', exact: true }).click(); await expect(page.getByRole('article', { name: 'Structured case' })).toContainText('The case was damaged.'); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const queryAt = performance.now(); const durable = await disputeView(f.alice, f.exchangeId); const endQueryMs = performance.now() - queryAt;
            assert.equal(durable.state, 'checked_out'); assert.equal(durable.cases.length, 1); assert.equal(durable.cases[0].responses[0].body, 'The case was damaged.');
            await page.reload(); await expect(page.getByRole('note')).toContainText('Ordinary completion is blocked');
            actions.push({ index, commandMs, visibleMs, queryMs: endQueryMs, exchangeId: f.exchangeId, state: durable.cases[0].status }); persist({ failures: 0, phase: 'case persisted after reload and fresh counterparty read' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P08 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both reload the authenticated home and read the identical approved Exchange as Bob. Trunk lacks Dispute controls. Added head samples measure the guarded report command, the visible structured case, a fresh counterparty read of its response history and unchanged fulfillment, and a borrower reload with completion blocked.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. Notices are enqueued after the same business transition and delivered separately. No external provider wait is timed. Production performance is inconclusive, no saturation limiter established and no speedup or throughput claim. Raw samples and host memory observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-8')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue16(values: PerfArguments) {
  const { agreedRemedyWithBothSidesAgreed, caseAction, decisionView, disputeFixture } = await import('./backend');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/dispute-decisions/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-16'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; exchangeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; exchangeId: string; status: string }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await disputeFixture(`perf16-${index}`);
      const remedyId = await agreedRemedyWithBothSidesAgreed(f); assert.equal((await caseAction(f.alice, f.disputeId, 'confirm_settlement', { remedy_id: remedyId })).error, null);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await disputeView(f.bob, f.exchangeId); const queryMs = performance.now() - readAt;
          assert.equal(read.cases.length, 1); assert.equal(read.cases[0].status, 'repairing');
          samples.push({ index, side, readinessMs, queryMs, exchangeId: f.exchangeId }); persist({ failures: 0, phase: 'paired readiness and authorized case read' });
          if (side === 'head') {
            await page.goto(`/disputes/${f.exchangeId}`); const card = page.getByRole('article', { name: 'Case decision' });
            await expect(card.getByRole('button', { name: 'Confirm settlement' })).toBeVisible();
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/act_on_dispute')) commandAt = performance.now(); });
            const response = page.waitForResponse(r => r.url().includes('/rpc/act_on_dispute')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return performance.now() - commandAt; });
            const actionAt = performance.now(); await card.getByRole('button', { name: 'Confirm settlement' }).click(); await expect(card).toContainText('Status Resolved'); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const queryAt = performance.now(); const durable = await decisionView(f.alice, f.exchangeId); const endQueryMs = performance.now() - queryAt;
            assert.equal(durable.cases[0].status, 'resolved'); assert.equal(durable.cases[0].remedy?.confirmed_by.length, 2); assert.equal(durable.state, 'checked_out');
            await page.reload(); await expect(card).toContainText('Settlement confirmations 2 of 2');
            actions.push({ index, commandMs, visibleMs, queryMs: endQueryMs, exchangeId: f.exchangeId, status: durable.cases[0].status }); persist({ failures: 0, phase: 'settled case persisted after reload and fresh counterparty read' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P16 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both reload the authenticated home and read the identical open case as Bob through read_exchange_disputes. Trunk lacks remedy and decision controls. Added head samples measure the guarded final settlement confirmation, the visible resolved case, a fresh counterparty read of remedy and both confirmations with unchanged fulfillment, and a reload.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. Notices are enqueued in the same transition and delivered separately. No external provider wait is timed. Production performance is inconclusive. Raw samples and host memory observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-16')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue9(values: PerfArguments) {
  const { checkedOutFixture, itemReturn, recordReturn } = await import('./backend');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/returns/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-9'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; exchangeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; exchangeId: string; state: string }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await checkedOutFixture(`perf9-${index}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.bob.client.from('exchanges').select('id,state').eq('id', f.exchangeId); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.deepEqual(read.data, [{ id: f.exchangeId, state: 'checked_out' }]);
          samples.push({ index, side, readinessMs, queryMs, exchangeId: f.exchangeId }); persist({ failures: 0, phase: 'paired readiness and authorized Exchange read' });
          if (side === 'head') {
            await recordReturn(f); await page.context().clearCookies(); await page.evaluate(() => localStorage.clear());
            await page.goto('/'); await page.getByLabel('Email address').fill(f.alice.email); await page.getByLabel('Password', { exact: true }).fill(password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
            await page.goto(`/handoffs/${f.exchangeId}`); await page.getByLabel('The item is back and its condition', { exact: false }).check();
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/command_item_return')) commandAt = performance.now(); });
            const response = page.waitForResponse(r => r.url().includes('/rpc/command_item_return')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return performance.now() - commandAt; });
            const actionAt = performance.now(); await page.getByRole('button', { name: 'Confirm Return', exact: true }).click(); await expect(page.getByRole('region', { name: 'Completed loan' })).toContainText('52'); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const queryAt = performance.now(); const durable = await itemReturn(f.bob, f.exchangeId); const endQueryMs = performance.now() - queryAt;
            assert.equal(durable.state, 'completed'); assert.deepEqual(durable.standing, { score: 51, title: 'Petty Bourgeoisie', completedInteractions: 1 });
            await page.reload(); await expect(page.getByRole('region', { name: 'Completed loan' })).toBeVisible();
            actions.push({ index, commandMs, visibleMs, queryMs: endQueryMs, exchangeId: f.exchangeId, state: durable.state }); persist({ failures: 0, phase: 'completion persisted after reload and fresh borrower read' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P09 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both reload the authenticated home and read the identical checked-out Exchange as Bob. Trunk lacks Return controls. Added head samples record Bob's Return through the command, then measure Alice's guarded confirm-and-finalize command, the visible completed loan with her 52 score, a fresh borrower read showing completion and 51, and an owner reload.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. Notices are enqueued after the same business transition and delivered separately. No external provider wait is timed. Production performance is inconclusive, no saturation limiter established and no speedup or throughput claim. Raw samples and host memory observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-9')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue18(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/misconduct/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const { admin, caseAction, reviewedDispute } = await import('./backend');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-18'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; disputeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; disputeId: string; penalties: number }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await reviewedDispute(`perf18-${index}`);
      const decided = await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved', reason: 'The submitted evidence supports the reported damage.' });
      assert.equal(decided.error, null);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.owner.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.owner.client.rpc('read_exchange_disputes', { p_exchange_id: f.exchangeId }); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.equal((read.data as { cases: { id: string }[] }).cases[0].id, f.disputeId);
          samples.push({ index, side, readinessMs, queryMs, disputeId: f.disputeId }); persist({ failures: 0, phase: 'paired readiness and authorized case read' });
          if (side === 'head') {
            await page.goto(`/disputes/${f.exchangeId}`);
            const misconduct = page.getByRole('region', { name: 'Verified misconduct' });
            await misconduct.getByLabel('Rule').selectOption('unresolved_damage');
            await misconduct.getByLabel('Responsible member').selectOption({ label: 'Borrower' });
            await misconduct.getByLabel('Reason for verified decision').fill('The dated return photographs show new damage.');
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/record_verified_misconduct')) commandAt = performance.now(); });
            const response = page.waitForResponse(r => r.url().includes('/rpc/record_verified_misconduct')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return performance.now() - commandAt; });
            const actionAt = performance.now(); await misconduct.getByRole('button', { name: 'Record verified penalty' }).click();
            await expect(misconduct.getByRole('status')).toContainText('Recorded -10 for Unresolved damage.'); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const queryAt = performance.now(); const durable = await admin.from('reputation_events').select('points,rule').eq('source_id', f.disputeId); const endQueryMs = performance.now() - queryAt;
            assert.deepEqual(durable.data, [{ points: -10, rule: 'unresolved_damage' }]);
            actions.push({ index, commandMs, visibleMs, queryMs: endQueryMs, disputeId: f.disputeId, penalties: durable.data?.length ?? 0 }); persist({ failures: 0, phase: 'penalty persisted and read back' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P18 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both reload the authenticated home and read the identical closed case as the administrator. Trunk lacks verified misconduct. Added head samples measure the guarded record_verified_misconduct command, the visible -10 event, and a fresh read of the persisted penalty.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. No external provider wait is timed. Raw samples and host memory observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-18')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue17(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/message-evidence/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const { messageEvidenceFixture, messageEvidenceView, evidenceMessages } = await import('./backend');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-17'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; disputeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; disputeId: string; snapshots: number }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await messageEvidenceFixture(`perf17-${index}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.bob.client.rpc('read_exchange_disputes', { p_exchange_id: f.exchangeId }); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.equal((read.data as { cases: { id: string }[] }).cases[0].id, f.disputeId);
          samples.push({ index, side, readinessMs, queryMs, disputeId: f.disputeId }); persist({ failures: 0, phase: 'paired readiness and authorized case read' });
          if (side === 'head') {
            await page.goto(`/disputes/${f.exchangeId}`);
            const region = page.getByRole('region', { name: 'Submitted messages' });
            await region.getByRole('checkbox', { name: evidenceMessages[2] }).check();
            let commandAt = 0; page.on('request', request => { if (request.url().includes('/rpc/submit_dispute_messages')) commandAt = performance.now(); });
            const response = page.waitForResponse(r => r.url().includes('/rpc/submit_dispute_messages')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return performance.now() - commandAt; });
            const actionAt = performance.now(); await region.getByRole('button', { name: 'Submit selected messages', exact: true }).click();
            await expect(region.getByRole('listitem', { name: 'Message snapshot' })).toContainText(evidenceMessages[2]); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const queryAt = performance.now(); const durable = await messageEvidenceView(f.owner, f.disputeId); const endQueryMs = performance.now() - queryAt;
            assert.deepEqual(durable.snapshots.map(row => row.body), [evidenceMessages[2]]); assert.deepEqual(durable.sources, []);
            actions.push({ index, commandMs, visibleMs, queryMs: endQueryMs, disputeId: f.disputeId, snapshots: durable.snapshots.length }); persist({ failures: 0, phase: 'snapshot persisted and read by the administrator' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P17 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both reload the authenticated home and read the identical open case as Bob. Trunk lacks message selection. Added head samples measure the guarded submit_dispute_messages command, the visible snapshot, and a fresh administrator read that returns the snapshot and no source text.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. Notices are enqueued in the same transaction and delivered separately. No external provider wait is timed. Production performance is inconclusive, no saturation limiter established and no speedup or throughput claim. Raw samples and host memory observations are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-17')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

// P19: trunk lacks the stalled review route, so both sides time the shared authorized Return read and the shared app
// readiness. Head additionally times the guarded verified decision from the administrator's page and its durable end state.
async function verifyIssue19(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/stalled-review/')), 'Trunk must lack the stalled review route.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const { checkedOutFixture, recordReturn, admin: service, password: testPassword } = await import('./backend');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-19'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number; exchangeId: string }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; exchangeId: string; awards: number }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  async function signIn(page: Page, email: string) {
    await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await checkedOutFixture(`perf19-${index}`);
      await recordReturn(f);
      const aged = await service.from('item_returns').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', f.exchangeId);
      assert.equal(aged.error, null);
      assert.equal((await service.rpc('process_due_item_returns')).error, null);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await signIn(page, f.alice.email);
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.alice.client.rpc('read_item_return', { p_exchange_id: f.exchangeId }); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); assert.equal((read.data as { exchange_id: string }).exchange_id, f.exchangeId);
          samples.push({ index, side, readinessMs, queryMs, exchangeId: f.exchangeId }); persist({ failures: 0, phase: 'paired readiness and authorized Return read' });
        } finally { await context.close(); }
        if (side === 'head') {
          const adminContext = await browser.newContext({ baseURL: `http://127.0.0.1:${port + 1}`, viewport: { width: 1440, height: 1000 } });
          try {
            const adminPage = await adminContext.newPage(); await signIn(adminPage, f.owner.email);
            await expect(adminPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
            await adminPage.goto(`/stalled/case/${f.exchangeId}`);
            await expect(adminPage.getByRole('heading', { name: 'Stalled confirmation', exact: true })).toBeVisible();
            await adminPage.getByRole('radio', { name: 'Verified completion' }).check();
            await adminPage.getByRole('checkbox', { name: 'I checked the recorded Return' }).check();
            await adminPage.getByRole('checkbox', { name: 'I checked the recorded condition and it is resolved' }).check();
            await adminPage.getByLabel('Reason for this decision').fill('The borrower recorded the Return and the condition matches the Handoff.');
            let commandAt = 0; adminPage.on('request', request => { if (request.url().includes('/rpc/decide_stalled_review')) commandAt = performance.now(); });
            const response = adminPage.waitForResponse(r => r.url().includes('/rpc/decide_stalled_review')).then(async r => { await r.finished(); assert.equal(r.status(), 200); return performance.now() - commandAt; });
            const actionAt = performance.now(); await adminPage.getByRole('button', { name: 'Record decision', exact: true }).click();
            await expect(adminPage.getByRole('heading', { name: 'Recorded decision' })).toBeVisible(); const visibleMs = performance.now() - actionAt;
            const commandMs = await response;
            const queryAt = performance.now(); const durable = await service.from('stalled_review_decisions').select('outcome').eq('exchange_id', f.exchangeId); const queryMs = performance.now() - queryAt;
            assert.deepEqual(durable.data, [{ outcome: 'verified_completion' }]);
            const awards = await service.from('reputation_events').select('points').eq('exchange_id', f.exchangeId);
            const total = (awards.data ?? []).reduce((sum, row) => sum + row.points, 0);
            assert.equal(total, 3);
            actions.push({ index, commandMs, visibleMs, queryMs, exchangeId: f.exchangeId, awards: total }); persist({ failures: 0, phase: 'verified decision persisted and read back' });
          } finally { await adminContext.close(); }
        }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    const ranges = { commandMs: [Math.min(...actions.map(a => a.commandMs)), Math.max(...actions.map(a => a.commandMs))], visibleMs: [Math.min(...actions.map(a => a.visibleMs)), Math.max(...actions.map(a => a.visibleMs))] };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks, ranges });
    writeFileSync(`${directory}/report.md`, `P19 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Both sides reload the authenticated home and read the identical Return as a participant. Trunk lacks the stalled review route, so its action is recorded as absent. Head samples measure the guarded decide_stalled_review command, the visible Recorded decision state, and a fresh read of the persisted verified outcome and its three points.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Ranges ${JSON.stringify(ranges)}. Checks ${JSON.stringify(checks)}. Zero failures.\n\nLocal serial Chrome and Vite development timing includes HTTP, Postgres and rendering. No external provider wait is timed. Raw samples are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    assert.equal(trunkRoot, resolve('.pilot-evidence', 'perf-trunk-19')); if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue20(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.ok(values.base);
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(p => p.startsWith('src/features/moderation/')), 'Trunk must lack the added action.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-20'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(r => r.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await handoffFixture(`perf20-${index}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.bob.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId }); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null);
          samples.push({ index, side, readinessMs, queryMs }); persist({ failures: 0, phase: 'paired readiness and authorized obligation read' });
          if (side === 'head') {
            const commandAt = performance.now();
            const moderated = await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.bob.id, p_action: 'suspend', p_reason: 'Perf fixture.' });
            const commandMs = performance.now() - commandAt; assert.equal(moderated.error, null);
            const visibleAt = performance.now(); await page.goto('/'); await expect(page.getByRole('region', { name: 'Membership restrictions' })).toBeVisible(); const visibleMs = performance.now() - visibleAt;
            const durableAt = performance.now(); const durable = await f.owner.client.rpc('moderation_roster', { p_community_id: f.community.id }); const durableQueryMs = performance.now() - durableAt;
            assert.equal(durable.error, null);
            actions.push({ index, commandMs, visibleMs, queryMs: durableQueryMs }); persist({ failures: 0, phase: 'suspension persisted, shown to the affected member, and read by the administrator' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (a: number[]) => { const sorted = [...a].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(s => s.side === side).map(s => s.readinessMs)), queryMedianMs: median(samples.filter(s => s.side === side).map(s => s.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(a => a.commandMs)), visibleMedianMs: median(actions.map(a => a.visibleMs)) };
    const queries = [...samples.filter(s => s.side === 'head').map(s => s.queryMs), ...actions.map(a => a.queryMs)].sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(v => v <= 60000) };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks });
    writeFileSync(`${directory}/report.md`, `P20 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Trunk has no moderation action, so both sides use the shared readiness and authorized obligation read as Bob. Head additionally measures the guarded moderate_membership command, the affected member's restriction notice, and a fresh administrator roster read.\n\nTrunk readiness median ${baseline.readinessMedianMs.toFixed(0)} ms; head ${current.readinessMedianMs.toFixed(0)} ms. Command median ${added.commandMedianMs.toFixed(0)} ms; visible median ${added.visibleMedianMs.toFixed(0)} ms; query p95 ${queryP95Ms.toFixed(0)} ms.\n\nChecks: ${JSON.stringify(checks)}\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}

async function verifyIssue21(values: PerfArguments) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head); assert.equal(values.base, 'ee1b3e1140aa0985b9405de57bfc806f5940ceb4');
  const base = values.base; const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  assert.ok(!tree.some(path => path.startsWith('src/features/disciplinary-votes/')), 'The source baseline must lack disciplinary votes.');
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`; mkdirSync(directory, { recursive: true });
  const trunkRoot = resolve('.pilot-evidence', 'perf-trunk-21'); assert.ok(!existsSync(trunkRoot));
  const samples: { index: number; side: string; readinessMs: number; queryMs: number }[] = [];
  const actions: { index: number; commandMs: number; visibleMs: number; queryMs: number; voteId: string }[] = [];
  const servers: ReturnType<typeof spawn>[] = []; const startup: Record<string, number> = {};
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const persist = (result: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, samples, actions, startup, host: { cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg() }, result }, null, 2));
  async function serve(side: string, root: string, at: number) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(at), '--strictPort'], { stdio: 'ignore', windowsHide: true }); servers.push(server);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${side} exited ${server.exitCode}`);
      if (await fetch(`http://127.0.0.1:${at}`).then(response => response.ok, () => false)) { startup[side] = performance.now() - started; return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${side} exceeded 60-second startup budget`);
  }
  try {
    for (const file of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
      const target = join(trunkRoot, file); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
    }
    copyFileSync('.env.local', join(trunkRoot, '.env.local'));
    await serve('trunk', trunkRoot, port); await serve('head', '.', port + 1);
    for (let index = 0; index < pairs; index++) {
      const f = await handoffFixture(`perf21-${index}`);
      for (const [side, at] of [['trunk', port], ['head', port + 1]] satisfies [string, number][]) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${at}`, viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Email address').fill(f.bob.email); await page.getByLabel('Password', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
          const home = page.getByRole('heading', { name: `Welcome to ${f.community.name}.` }); await expect(home).toBeVisible();
          const readyAt = performance.now(); await page.reload(); await expect(home).toBeVisible(); const readinessMs = performance.now() - readyAt;
          const readAt = performance.now(); const read = await f.bob.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId }); const queryMs = performance.now() - readAt;
          assert.equal(read.error, null); samples.push({ index, side, readinessMs, queryMs }); persist({ failures: 0, phase: 'paired readiness and authorized persisted read' });
          if (side === 'head') {
            await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByLabel('Email address').fill(f.owner.email); await page.getByLabel('Password', { exact: true }).fill(password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await page.getByRole('button', { name: 'Sign out' }).waitFor(); await page.goto('/votes');
            await page.getByLabel('Administrator Community').selectOption(f.community.id); await page.getByLabel('Accused member').selectOption(f.bob.id);
            await page.getByLabel('Reason', { exact: true }).fill('Performance comparison vote.'); await page.getByLabel('Submitted evidence').fill('Performance sample evidence.');
            const visibleAt = performance.now();
            const response = page.waitForResponse(item => item.url().includes('/rest/v1/rpc/open_disciplinary_vote') && item.request().method() === 'POST');
            const commandAt = performance.now(); await page.getByRole('button', { name: 'Open removal vote' }).click();
            await expect(page.getByRole('status').filter({ hasText: 'The seven-day vote is open.' })).toBeVisible(); const visibleMs = performance.now() - visibleAt;
            const commandResponse = await response; assert.equal(commandResponse.ok(), true); const commandMs = performance.now() - commandAt;
            const durableAt = performance.now(); const durable = await admin.from('disciplinary_votes').select('id,state,eligible_count,closes_at').eq('community_id', f.community.id).single(); const durableQueryMs = performance.now() - durableAt;
            assert.equal(durable.error, null); assert.equal(durable.data.state, 'open');
            actions.push({ index, commandMs, visibleMs, queryMs: durableQueryMs, voteId: durable.data.id }); persist({ failures: 0, phase: 'vote opened and durably re-read' });
          }
        } finally { await context.close(); }
      }
    }
    const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
    const summary = (side: string) => ({ readinessMedianMs: median(samples.filter(sample => sample.side === side).map(sample => sample.readinessMs)), queryMedianMs: median(samples.filter(sample => sample.side === side).map(sample => sample.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head'); const added = { commandMedianMs: median(actions.map(action => action.commandMs)), visibleMedianMs: median(actions.map(action => action.visibleMs)) };
    const querySamples = [...samples.filter(sample => sample.side === 'head').map(sample => sample.queryMs), ...actions.map(action => action.queryMs)].sort((a, b) => a - b); const queryP95Ms = querySamples[Math.ceil(querySamples.length * 0.95) - 1];
    const checks = { readiness: current.readinessMedianMs <= Math.max(1.2 * baseline.readinessMedianMs, baseline.readinessMedianMs + 100), read: current.queryMedianMs <= Math.max(1.2 * baseline.queryMedianMs, baseline.queryMedianMs + 100), command: added.commandMedianMs <= 1000, visible: added.visibleMedianMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    persist({ failures: 0, baseline, head: current, added, queryP95Ms, checks });
    writeFileSync(`${directory}/report.md`, `P21 at ${head}.\n\n${pairs} interleaved trunk/head pairs against ${base}. Trunk predates disciplinary votes, so both sides use the same authenticated Community readiness and persisted Handoff read. Head additionally measures the vote opening command, visible confirmation and a fresh persisted vote read.\n\nTrunk ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms. Checks ${JSON.stringify(checks)}.\n\nNo email provider wait is timed. The vote notice is enqueued in the opening transaction and delivered after commit. Raw samples are in samples.json.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks)); process.stdout.write(`${JSON.stringify({ baseline, head: current, added, queryP95Ms, checks })}\n`);
  } catch (error) { persist({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    await browser.close(); await Promise.all(servers.map(server => new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } })));
    if (existsSync(trunkRoot)) rmSync(trunkRoot, { recursive: true });
  }
}
