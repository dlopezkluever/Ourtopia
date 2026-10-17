import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { chromium, expect, type Page } from '@playwright/test';
import { activeMember, actor, commitHelp, createCommunity, createHelpPost, helpFixture, helpListingFields, membershipFixture, password, configureVouch, vouchFixture, admin } from './backend';
import { borrowingFixture, requestItem, handoffFixture, advanceHandoff, itemHandoff, handoffCondition } from './backend';
import { handoffSchema } from '../../src/features/handoff/model';
import { borrowViewSchema } from '../../src/features/borrowing/model';
import { z } from 'zod';
import { vouchSchema } from '../../src/features/vouches/model';
import { standingSchema } from '../../src/features/reputation/model';
import { communitySchema } from '../../src/features/communities/model';
import { drillDetails } from './backend';
import { listingSchema } from '../../src/features/listings/model';
import { conversationSchema, messageSchema } from '../../src/features/messages/model';
import { helpExchangeSchema, helpPostSchema } from '../../src/features/help/model';

const { values } = parseArgs({ options: { issue: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, pairs: { type: 'string', default: '10' } } });
if (values.issue === '7') await verifyIssue7(values);
else if (values.issue === '6') await verifyIssue6(values);
else if (values.issue === '22') await (await import('../../supabase/functions/stripe-checkout/perf')).verifyBillingPerf(values);
else if (values.issue === '14') await verifyIssue14(values);
else if (values.issue === '12') await verifyIssue12(values);
else if (values.issue === '15') await verifyIssue15(values);
else if (values.issue === '3' || values.issue === '4' || values.issue === '5') await verifyIssue3(values);
else await verifyIssue2(values);

type PerfArguments = { issue?: string; base?: string; head?: string; pairs?: string };

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
