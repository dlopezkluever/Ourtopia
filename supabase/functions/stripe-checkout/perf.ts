import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cpus, freemem, totalmem } from 'node:os';
import { chromium, expect, type Page } from '@playwright/test';
import { actor, createCommunity, password } from '../../../scripts/verify/backend';
import { currentSubscriptionFixture, persistedStatus, realBillingConfig, stripeTestApi } from './verification';
import { TestStripe } from './provider';
import { processReceipt, type BillingBackend } from './worker';

export async function verifyBillingPerf(values: { base?: string; head?: string; pairs?: string }) {
  realBillingConfig();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(values.head, head, 'Measure the exact committed head.');
  assert.ok(values.base); const base = values.base;
  const pairs = Number(values.pairs); assert.ok(Number.isInteger(pairs) && pairs >= 10);
  assert.equal(execFileSync('git', ['diff', base, head, '--', 'package-lock.json'], { encoding: 'utf8' }), '', 'Trunk and head require identical dependencies.');
  const directory = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/perf`;
  mkdirSync(directory, { recursive: true });
  const trunk = resolve(directory, 'trunk');
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const file of files) { const target = `${trunk}/${file}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`])); }
  copyFileSync('.env.local', `${trunk}/.env.local`);
  writeFileSync(`${trunk}/perf.vite.config.ts`, "import { mergeConfig } from 'vite';\nimport config from './vite.config';\nexport default mergeConfig(config, { cacheDir: '.vite-perf-cache' });\n");
  const trunkPort = Number(process.env.APP_PORT ?? 56225) + 1;
  const headPort = trunkPort + 1;
  const servers: ReturnType<typeof spawn>[] = [];
  const startup: Record<string, number> = {};
  const samples: { pair: number; side: string; readinessMs: number; queryMs: number }[] = [];
  const actions: { pair: number; commandMs: number; localCommandsMs: number; providerMs: number; fullReconcileMs: number; visibleAfterProviderMs: number; status: string }[] = [];
  const persist = (extra: unknown) => writeFileSync(`${directory}/samples.json`, JSON.stringify({ head, base, pairs, startup, samples, actions,
    host: { cores: cpus().length, freeMemory: freemem(), totalMemory: totalmem() }, extra,
  }, null, 2));
  async function serve(side: string, root: string, port: number, config: string[] = []) {
    const started = performance.now();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, ...config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
    servers.push(server);
    await expect.poll(async () => { if (server.exitCode !== null) throw new Error('Perf server exited.'); try { return (await fetch(`http://127.0.0.1:${port}`)).ok; } catch { return false; } }, { timeout: 60000 }).toBe(true);
    startup[side] = performance.now() - started;
  }
  async function login(page: Page, email: string) {
    await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    await serve('trunk', trunk, trunkPort, ['--config', `${trunk}/perf.vite.config.ts`]); await serve('head', '.', headPort);
    for (let pair = 0; pair < pairs; pair++) {
      const owner = await actor({ label: 'billing-paired-perf' });
      const community = await createCommunity(owner.client, randomUUID(), `Billing performance ${pair}`); assert.equal(community.error, null);
      for (const [side, port] of [['trunk', trunkPort], ['head', headPort]] as const) {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
        try {
          const page = await context.newPage(); await login(page, owner.email);
          await expect(page.getByRole('heading', { name: `Welcome to ${community.data.name}.` })).toBeVisible();
          const started = performance.now(); await page.reload(); await expect(page.getByRole('heading', { name: `Welcome to ${community.data.name}.` })).toBeVisible();
          const readinessMs = performance.now() - started;
          const queryStart = performance.now(); const read: { error: unknown; data: unknown } = await owner.client.from('communities').select('*').eq('id', community.data.id); const queryMs = performance.now() - queryStart;
          assert.equal(read.error, null); assert.deepEqual(read.data, [community.data]); samples.push({ pair, side, readinessMs, queryMs }); persist({ phase: 'paired read', errors: 0 });
        } finally { await context.close(); }
      }
      const fixture = await currentSubscriptionFixture(`billing-perf-${pair}`);
      try {
        const context = await browser.newContext({ baseURL: `http://127.0.0.1:${headPort}` });
        try {
          const page = await context.newPage(); await login(page, fixture.member.email); await page.goto('/billing'); await expect(page.getByTestId('billing-status')).toContainText('active', { timeout: 60000 });
          const eventId = `evt_perf_${randomUUID().replaceAll('-', '')}`;
          await fixture.backend.rpc('receive_stripe_receipt', { p_event_id: eventId, p_event_type: 'customer.subscription.updated', p_subscription_id: fixture.subscriptionId, p_customer_id: fixture.customer, p_fingerprint: 'verified-perf-fixture' });
          const commandMs = fixture.requestCommandMs;
          await stripeTestApi(`subscriptions/${fixture.subscriptionId}`, 'DELETE');
          let localCommandsMs = 0; let providerMs = 0; let providerFinished = 0;
          const backend: BillingBackend = { rpc: async (name, args) => { const start = performance.now(); const result = await fixture.backend.rpc(name, args); localCommandsMs += performance.now() - start; return result; } };
          const stripe = new TestStripe(realBillingConfig().key, async (input, init) => { const start = performance.now(); const response = await fetch(input, init); const raw = await response.text(); providerMs += performance.now() - start; providerFinished = performance.now(); return new Response(raw, { status: response.status, headers: response.headers }); });
          const started = performance.now(); await processReceipt(backend, stripe, eventId); const fullReconcileMs = performance.now() - started;
          await expect(page.getByTestId('billing-status')).toContainText('canceled'); const visibleAfterProviderMs = performance.now() - providerFinished;
          const rows = await persistedStatus(fixture.member.id); assert.equal(rows[0].status, 'canceled');
          actions.push({ pair, commandMs, localCommandsMs, providerMs, fullReconcileMs, visibleAfterProviderMs, status: rows[0].status }); persist({ phase: 'persisted current status visible', errors: 0 });
        } finally { await context.close(); }
      } finally { const current = await fixture.stripe.subscription(fixture.subscriptionId); if (current.status !== 'canceled') await fixture.stripe.cancel(fixture.subscriptionId); }
    }
    const median = (rows: number[]) => { const ordered = [...rows].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; };
    const summary = (side: string) => ({ readinessMs: median(samples.filter(row => row.side === side).map(row => row.readinessMs)), queryMs: median(samples.filter(row => row.side === side).map(row => row.queryMs)) });
    const baseline = summary('trunk'); const current = summary('head');
    const added = { commandMs: median(actions.map(row => row.commandMs)), localCommandsMs: median(actions.map(row => row.localCommandsMs)), providerMs: median(actions.map(row => row.providerMs)), visibleAfterProviderMs: median(actions.map(row => row.visibleAfterProviderMs)) };
    const queries = samples.filter(row => row.side === 'head').map(row => row.queryMs).sort((a, b) => a - b); const queryP95Ms = queries[Math.ceil(queries.length * .95) - 1];
    const checks = { readiness: current.readinessMs <= Math.max(baseline.readinessMs * 1.2, baseline.readinessMs + 100), read: current.queryMs <= Math.max(baseline.queryMs * 1.2, baseline.queryMs + 100), command: added.commandMs <= 1000 && added.localCommandsMs <= 1000, visible: added.visibleAfterProviderMs <= 2000, query: queryP95Ms <= 3000, startup: Object.values(startup).every(value => value <= 60000) };
    persist({ baseline, head: current, added, queryP95Ms, checks, errors: 0, mode: 'Local Vite and serial Chrome. Ten interleaved trunk-first pairs with identical persisted authorized reads. Billing absent at trunk. Head uses actual Stripe test subscriptions; synthetic verified receipts isolate current-object reconciliation. Provider time is separate. No speedup claim.' });
    writeFileSync(`${directory}/report.md`, `P22 at ${head}. ${pairs} alternating pairs against ${base}.\n\nBaseline ${JSON.stringify(baseline)}. Head ${JSON.stringify(current)}. Added ${JSON.stringify(added)}. Query p95 ${queryP95Ms} ms.\n\nChecks ${JSON.stringify(checks)}. Zero failed samples. Every action persisted and displayed canceled status matching current Stripe. External provider wait is separate from local command work. Browser polling and HTTP rendering bound visible time. This local development probe makes no production throughput or speedup claim. Real hosted Checkout is covered separately by the journey suite.\n`);
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  } catch (error) { persist({ failed: true, errors: 1, message: error instanceof Error ? error.message : 'Perf failed.' }); throw error; }
  finally { await browser.close(); for (const server of servers) server.kill(); }
}
