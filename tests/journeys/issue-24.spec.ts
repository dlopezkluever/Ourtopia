import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { communitySchema } from '../../src/features/communities/model';
import { admin, membershipFixture, activeMember, createCommunity, password, handoffFixture, advanceHandoff, listingImageBytes, itemHandoff, handoffAction } from '../../scripts/verify/backend';

const base = '91cc7b00d9edd075c205464ef90235507e6a7b3b';
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function drafts(page: Page, email: string) { await signIn(page, email); await page.getByRole('link', { name: 'Draft contributions', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Item Listing draft' })).toBeVisible(); }
async function saved(page: Page) { await expect(page.getByRole('status').filter({ hasText: 'Draft saved privately.' })).toBeVisible(); }
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('persisted and privacy receipt', { body: JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), lane, project: info.project.name, viewport: page.viewportSize(), data }), contentType: 'application/json' });
}
async function shell(page: Page) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => Boolean(registration?.active)))).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}
async function artifacts(page: Page) {
  return page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) { const cache = await caches.open(name); for (const request of await cache.keys()) { const response = await cache.match(request); result.push({ cache: name, url: new URL(request.url).pathname, body: await response!.text() }); } }
    return result;
  });
}
const photo = { name: 'camera.png', mimeType: 'image/png', buffer: listingImageBytes };

test('lane 1 trunk lacks install and recovery; head provides the public shell and durable private draft', async ({ page, browser }, info) => {
  test.setTimeout(150000);
  const f = await membershipFixture('pwa-trunk');
  const root = `.pilot-evidence/issue-24-trunk-${info.project.name}`;
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  expect(files.some(path => path.startsWith('src/features/drafts/'))).toBe(false);
  for (const path of files) { const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`])); }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ ...info.project.use, baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(result => result.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.owner.email);
    await expect(trunk.getByRole('link', { name: 'Draft contributions' })).toHaveCount(0);
    expect(await trunk.locator('link[rel=manifest]').count()).toBe(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await drafts(page, f.owner.email); await page.getByLabel('Title', { exact: true }).fill('Recoverable trunk comparison'); await saved(page); await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Recoverable trunk comparison');
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { trunk: 'No manifest or durable contribution drafts', head: (await f.owner.client.from('contribution_drafts').select('*')).data });
});

test('lane 2 install metadata, active service worker and offline shell reload have clear retry states', async ({ page, context }, info) => {
  await shell(page);
  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  expect(manifest.display).toBe('standalone'); expect(manifest.start_url).toBe('/');
  expect((await page.request.get('/manifest-icon.png')).status()).toBe(200);
  await page.getByText('Use Ourtopia as an app', { exact: true }).click(); await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
  await context.setOffline(true); await page.goto('/communities/private-route');
  await expect(page.getByRole('heading', { name: "You're offline." })).toBeVisible(); await expect(page.getByRole('link', { name: 'Retry connection' })).toBeVisible();
  await capture(page, info, 2, { manifest, offline: 'Public shell only; no account or Community content' });
  await context.setOffline(false); await page.getByRole('link', { name: 'Retry connection' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
});

test('lane 3 practical item and Help drafts survive interruption and reload only within their account and Community', async ({ page }, info) => {
  const f = await membershipFixture('pwa-drafts'); await drafts(page, f.owner.email);
  await page.getByLabel('Title', { exact: true }).fill('Drill with two batteries'); await page.getByLabel('Condition', { exact: true }).fill('Light marks on the case'); await saved(page); await page.reload();
  await expect(page.getByLabel('Condition', { exact: true })).toHaveValue('Light marks on the case');
  await page.getByLabel('Contribution type').selectOption('help_offer'); await page.getByLabel('Title', { exact: true }).fill('Bike repair on weekends'); await page.getByLabel('Skill', { exact: true }).fill('Brake adjustment'); await saved(page); await page.reload();
  await page.getByLabel('Contribution type').selectOption('help_offer'); await expect(page.getByLabel('Skill', { exact: true })).toHaveValue('Brake adjustment');
  await page.getByLabel('Contribution type').selectOption('help_need'); await page.getByLabel('Title', { exact: true }).fill('Help moving a couch'); await saved(page); await page.reload();
  await page.getByLabel('Contribution type').selectOption('help_need'); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Help moving a couch');
  const records = await f.owner.client.from('contribution_drafts').select('*'); expect(records.data).toHaveLength(3); await capture(page, info, 3, records.data);
});

test('lane 4 account and Community switches, sign-out and suspension cannot restore protected drafts', async ({ page }, info) => {
  const f = await membershipFixture('pwa-identities'); const member = await activeMember(f.owner, f.community.id);
  const created = await createCommunity(member.client, randomUUID(), 'Second private Community'); expect(created.error).toBeNull(); const other = communitySchema.parse(created.data);
  await drafts(page, member.email); await page.getByLabel('Community', { exact: true }).selectOption(f.community.id);
  await page.getByLabel('Title', { exact: true }).fill('My private unfinished item'); await saved(page);
  await page.getByLabel('Community', { exact: true }).selectOption(other.id); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
  await page.getByLabel('Community', { exact: true }).selectOption(f.community.id); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('My private unfinished item');
  await page.evaluate(() => sessionStorage.setItem('listing-draft-private-test', 'private-data'));
  await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('listing-draft-')))).toEqual([]);
  await drafts(page, f.owner.email); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Sign out' }).click(); await drafts(page, member.email); await page.getByLabel('Community', { exact: true }).selectOption(f.community.id);
  expect((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', member.id)).error).toBeNull();
  await page.reload(); await page.getByLabel('Community', { exact: true }).selectOption(other.id);
  expect((await member.client.from('contribution_drafts').select('*').eq('community_id', f.community.id)).data).toEqual([]);
  await expect(page.getByText('My private unfinished item', { exact: true })).toHaveCount(0); await capture(page, info, 4, { switched: true, signedOutStorage: 'cleared', suspendedRead: [] });
});

test('lane 5 interrupted Handoff camera upload reloads and retries once with the same record and object', async ({ page }, info) => {
  const f = await handoffFixture('pwa-camera'); await advanceHandoff(f, 'schedule'); await signIn(page, f.bob.email); await page.goto(`/handoffs/${f.exchangeId}`);
  await expect(page.getByLabel('Camera or photo')).toHaveAttribute('capture', 'environment');
  await page.route('**/storage/v1/object/exchange-evidence/**', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.getByLabel('Camera or photo').setInputFiles(photo); await page.getByRole('button', { name: 'Upload or retry photo', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Photo not confirmed' })).toBeVisible();
  const pending = (await f.bob.client.from('exchange_evidence').select('id,state').eq('exchange_id', f.exchangeId)).data!; expect(pending).toHaveLength(1); expect(pending[0].state).toBe('pending');
  await page.unroute('**/storage/v1/object/exchange-evidence/**'); await page.reload(); await page.getByRole('link', { name: 'Recover optional photo', exact: true }).click();
  await page.getByLabel('Camera or photo').setInputFiles(photo); await page.getByRole('button', { name: 'Retry optional photo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Photo confirmed.' })).toBeVisible();
  const rows = (await f.bob.client.from('exchange_evidence').select('id,state').eq('exchange_id', f.exchangeId)).data;
  expect(rows).toEqual([{ id: pending[0].id, state: 'ready' }]); expect((await admin.storage.from('exchange-evidence').list(f.exchangeId)).data).toHaveLength(1); expect((await itemHandoff(f.bob, f.exchangeId)).state).toBe('handoff_pending'); await capture(page, info, 5, rows);
});

test('lane 6 cached artifacts contain only fixed public shell files and no protected content or credentials', async ({ page }, info) => {
  const f = await membershipFixture('pwa-cache'); await drafts(page, f.owner.email); await page.getByLabel('Title', { exact: true }).fill('PRIVATE-DRAFT-CONTENT-24'); await saved(page); await shell(page);
  const cached = await artifacts(page); expect(cached.map(row => row.url).sort()).toEqual(['/manifest-icon-512.png', '/manifest-icon.png', '/manifest-offline.html', '/manifest.webmanifest']);
  const text = JSON.stringify(cached); for (const secret of ['PRIVATE-DRAFT-CONTENT-24', f.owner.email, f.community.id, 'access_token', 'refresh_token', 'signedUrl', 'eyJ']) expect(text).not.toContain(secret);
  const stores = await page.evaluate(() => ({ session: Object.entries(sessionStorage), local: Object.entries(localStorage).filter(([key]) => !key.startsWith('sb-')) })); expect(JSON.stringify(stores)).not.toContain('PRIVATE-DRAFT-CONTENT-24');
  await capture(page, info, 6, { cached: cached.map(({ cache, url }) => ({ cache, url })), privateDraft: 'server only', auth: 'Supabase auth storage excluded from service worker caching' });
});

test('lane 7 offline privileged action is not queued and reconnect after cancellation rejects stale work', async ({ page, context }, info) => {
  const f = await handoffFixture('pwa-offline-state'); await advanceHandoff(f, 'schedule'); await signIn(page, f.bob.email); await page.goto(`/handoffs/${f.exchangeId}`);
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: "You're offline." })).toBeVisible();
  expect((await handoffAction(f.alice, f.exchangeId, 3, 'cancel', { reason: 'Item no longer available' })).error).toBeNull();
  await page.getByLabel('Item condition', { exact: true }).fill('Attempted offline'); await page.getByLabel('Included accessories', { exact: true }).fill('Battery'); await page.getByRole('button', { name: 'Record condition', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await context.setOffline(false); await page.getByRole('button', { name: 'Record condition', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  expect((await itemHandoff(f.alice, f.exchangeId)).state).toBe('cancelled');
  expect((await admin.from('item_handoffs').select('condition').eq('exchange_id', f.exchangeId)).data).toEqual([{ condition: null }]); await capture(page, info, 7, { state: 'cancelled', offlineQueue: 'none', condition: null });
});

test('lane 8 shared Return recovery adapter contract survives a lost completion response with one evidence identity', async ({ page }, info) => {
  const f = await handoffFixture('pwa-shared-recovery'); await advanceHandoff(f, 'schedule'); await signIn(page, f.bob.email); await page.goto(`/pwa/evidence/${f.exchangeId}`);
  let interrupted = false;
  await page.route('**/rest/v1/rpc/complete_exchange_evidence', async route => { if (!interrupted) { interrupted = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await page.getByLabel('Camera or photo').setInputFiles(photo); await page.getByRole('button', { name: 'Retry optional photo', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Photo not confirmed.' })).toBeVisible();
  const prior = (await f.bob.client.from('exchange_evidence').select('id,state').eq('exchange_id', f.exchangeId)).data!; expect(prior).toHaveLength(1); expect(prior[0].state).toBe('ready');
  await page.reload(); await page.getByLabel('Camera or photo').setInputFiles(photo); await page.getByRole('button', { name: 'Retry optional photo', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Photo confirmed.' })).toBeVisible();
  expect((await f.bob.client.from('exchange_evidence').select('id,state').eq('exchange_id', f.exchangeId)).data).toEqual(prior); expect((await admin.storage.from('exchange-evidence').list(f.exchangeId)).data).toHaveLength(1); expect((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_evidence_completed')).data).toHaveLength(1);
  await capture(page, info, 8, { records: prior, contract: 'Kind-independent recovery adapter; real shared evidence commands; no early Return state machine', completionEvents: 1 });
});

test('lane 9 registration, draft errors, scheduling and confirmation expose names and keyboard focus', async ({ page }, info) => {
  const f = await handoffFixture('pwa-a11y'); await page.goto('/');
  await page.getByLabel('Email address').focus(); await expect(page.getByLabel('Email address')).toBeFocused(); await page.keyboard.type(f.bob.email); await page.keyboard.press('Tab'); await expect(page.getByLabel('Password', { exact: true })).toBeFocused(); await page.keyboard.type(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto('/drafts'); await page.getByRole('button', { name: 'Publish contribution' }).focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('alert')).toBeFocused();
  await advanceHandoff(f, 'terms'); await page.goto(`/handoffs/${f.exchangeId}`);
  await page.getByLabel('Handoff time', { exact: true }).focus(); await expect(page.getByLabel('Handoff time', { exact: true })).toBeFocused();
  await advanceHandoffFromTerms(f); await page.reload();
  const acknowledgment = page.getByLabel('I acknowledge the item is received', { exact: false }); await acknowledgment.focus(); await page.keyboard.press('Space'); await expect(acknowledgment).toBeChecked(); await page.getByRole('button', { name: 'Confirm Handoff', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible();
  await capture(page, info, 9, { accessibility: await page.locator('main').ariaSnapshot(), state: (await itemHandoff(f.bob, f.exchangeId)).state });
});
async function advanceHandoffFromTerms(f: Awaited<ReturnType<typeof handoffFixture>>) {
  for (const [actor, revision, action, details] of [[f.alice, 1, 'propose_schedule', { starts_at: new Date(Date.now() + 3600000).toISOString(), location: 'Front porch' }], [f.bob, 2, 'confirm_schedule', {}], [f.alice, 3, 'record_condition', { condition: 'Good', accessories: 'Battery' }]] as const) expect((await handoffAction(actor, f.exchangeId, revision, action, details)).error).toBeNull();
}

test('lane 10 touch and desktop publish a saved contribution with responsive controls and optional photos', async ({ page }, info) => {
  const f = await membershipFixture('pwa-responsive'); await drafts(page, f.owner.email); await page.getByLabel('Contribution type').selectOption('help_offer');
  for (const [label, value] of [['Title', 'Weekend bike repair'], ['Skill', 'Bike repair'], ['Availability', 'Weekend mornings'], ['Area you can help in', 'Maple Street']]) await page.getByLabel(label, { exact: true }).fill(value);
  await saved(page); const publish = page.getByRole('button', { name: 'Publish contribution' });
  if (info.project.name === 'mobile') await publish.tap(); else await publish.click();
  await expect(page.getByRole('heading', { name: 'Weekend bike repair', exact: true })).toBeVisible();
  const posts = await f.owner.client.from('help_listings').select('id,title').eq('community_id', f.community.id); expect(posts.data).toHaveLength(1);
  expect((await f.owner.client.from('contribution_drafts').select('status,fields').eq('kind', 'help_offer')).data).toEqual([{ status: 'published', fields: {} }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await capture(page, info, 10, { posts: posts.data, photos: 'not required', viewport: page.viewportSize() });
});
