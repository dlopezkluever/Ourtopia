import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { admin, advanceHandoff, handoffReminders, approveBorrow, borrowingFixture, handoffAction, handoffCondition, handoffFixture, handoffSchedule, handoffTerms, itemHandoff, listingImageBytes, password, requestItem, withAcknowledgmentWindow } from '../../scripts/verify/backend';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

const base = '8be7fe60908341f41beea49bc0f7ccb718ae3c7e';
type Fixture = Awaited<ReturnType<typeof handoffFixture>>;
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function open(page: Page, f: Fixture, email = f.bob.email) {
  await signIn(page, email); await page.goto(`/handoffs/${f.exchangeId}`); await expect(page.getByRole('heading', { name: 'Item Handoff', exact: true })).toBeVisible();
}
async function counterpart(browser: Browser, info: TestInfo) {
  const { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = info.project.use;
  const context = await browser.newContext({ baseURL: process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor });
  return { context, page: await context.newPage() };
}
async function terms(page: Page) {
  await page.getByLabel('I acknowledge the return date', { exact: false }).check(); await page.getByRole('button', { name: 'Acknowledge terms', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Arranging Handoff' })).toBeVisible();
}
async function schedule(page: Page, location = handoffSchedule().location) {
  await page.getByLabel('Handoff time', { exact: true }).fill('2027-01-15T10:00'); await page.getByLabel('Meeting location').fill(location);
  await page.getByRole('button', { name: 'Propose schedule', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Current Handoff schedule' })).toContainText(location);
}
async function record(page: Page) {
  await page.getByLabel('Item condition', { exact: true }).fill(handoffCondition.condition); await page.getByLabel('Included accessories').fill(handoffCondition.accessories);
  await page.getByRole('button', { name: 'Record condition', exact: true }).click(); await expect(page.getByText(`Recorded condition. ${handoffCondition.condition}`, { exact: true })).toBeVisible();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Refresh Handoff', exact: true }).click();
  await page.getByLabel('I acknowledge the item is received', { exact: false }).check(); await page.getByRole('button', { name: 'Confirm Handoff', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }, null, 2), contentType: 'application/json' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function primary(page: Page, browser: Browser, info: TestInfo, f: Fixture, skip = false) {
  await open(page, f); await terms(page);
  const owner = await counterpart(browser, info);
  try {
    await open(owner.page, f, f.alice.email); await schedule(owner.page);
    await page.getByRole('button', { name: 'Refresh Handoff', exact: true }).click(); await page.getByRole('button', { name: 'Confirm schedule', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Current Handoff schedule' })).toContainText('Schedule confirmed');
    if (skip) { await page.getByRole('button', { name: 'Skip optional photos', exact: true }).click(); await expect(page.getByText('Photos skipped. Continue with condition acknowledgment.')).toBeVisible(); }
    await owner.page.getByRole('button', { name: 'Refresh Handoff', exact: true }).click(); await record(owner.page); await confirm(page);
  } finally { await owner.context.close(); }
  const h = await itemHandoff(f.bob, f.exchangeId); expect(h.state).toBe('checked_out'); expect(h.condition).toBe(handoffCondition.condition); expect(h.accessories).toBe(handoffCondition.accessories); expect(h.evidence).toEqual([]);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible(); return h;
}

test('lane 1 trunk shows reserved approval without Handoff controls; head records durable checkout', async ({ page, browser }, info) => {
  test.setTimeout(150000); const f = await handoffFixture('handoff-trunk'); const root = `.pilot-evidence/issue-7-trunk-${info.project.name}`;
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p));
  for (const p of files) { const target = `${root}/${p}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${p}`])); }
  copyFileSync('.env.local', `${root}/.env.local`); const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ ...info.project.use, baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(r => r.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.bob.email); await trunk.goto('/borrowing');
    await expect(trunk.getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    await expect(trunk.getByRole('button', { name: 'Acknowledge terms', exact: true })).toHaveCount(0);
    await expect(trunk.getByRole('link', { name: 'Handoffs', exact: true })).toHaveCount(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  const h = await primary(page, browser, info, f); await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true }); await capture(page, info, 1, { trunk: 'Terms and Handoff controls absent; existing reserved dates visible', h });
});

test('lane 2 borrower acknowledges, pair confirms schedule and condition, one Handoff persists', async ({ page, browser }, info) => {
  const f = await handoffFixture('handoff-primary'); const h = await primary(page, browser, info, f);
  expect((await admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId).eq('kind', 'item_handed_off')).data).toEqual([{ kind: 'item_handed_off' }]); await capture(page, info, 2, h);
});

test('lane 3 optional photos are skipped and photo-free Handoff completes', async ({ page, browser }, info) => {
  const f = await handoffFixture('handoff-skip'); const h = await primary(page, browser, info, f, true);
  await expect(page.getByRole('region', { name: 'Recorded Handoff' })).toContainText('0 optional photos'); await capture(page, info, 3, h);
});

test('lane 4 reschedule updates both participants and suppresses obsolete reminder work', async ({ page, browser }, info) => {
  const f = await handoffFixture('handoff-reschedule'); await advanceHandoff(f, 'terms');
  expect((await handoffAction(f.alice, f.exchangeId, 1, 'propose_schedule', { starts_at: '2027-01-15T10:00:00Z', location: 'Original porch' })).error).toBeNull();
  expect((await handoffAction(f.bob, f.exchangeId, 2, 'confirm_schedule')).error).toBeNull(); await open(page, f);
  const owner = await counterpart(browser, info);
  try {
    await open(owner.page, f, f.alice.email); await schedule(page, 'Library side entrance');
    await owner.page.getByRole('button', { name: 'Refresh Handoff', exact: true }).click();
    await expect(owner.page.getByRole('region', { name: 'Current Handoff schedule' })).toContainText('Library side entrance');
    await owner.page.getByRole('button', { name: 'Confirm schedule', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh Handoff', exact: true }).click(); await expect(page.getByRole('region', { name: 'Current Handoff schedule' })).toContainText('Schedule confirmed');
    const outbox = await handoffReminders(f.exchangeId);
    expect(outbox.filter(r => !r.current)).toHaveLength(2); expect(outbox.filter(r => r.current)).toHaveLength(2);
    expect((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).in('id', outbox.filter(r => !r.current).map(r => r.id))).error).toBeNull();
    for (const row of outbox.filter(r => !r.current)) expect((await admin.rpc('claim_notification', { p_outbox_id: row.id })).data).toBeNull();
    expect((await handoffReminders(f.exchangeId)).filter(r => !r.current).map(r => r.state)).toEqual(['suppressed', 'suppressed']);
    const currentIds = outbox.filter(r => r.current).map(r => r.id);
    expect((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).in('id', currentIds)).error).toBeNull();
    const { send } = localDelivery(); for (const id of currentIds) await deliverOne(admin, send, id);
    await owner.page.reload(); await expect(owner.page.getByRole('region', { name: 'Handoff notices' })).toContainText('Your upcoming Handoff needs your attention.');
    const email = (await admin.from('notification_outbox').select('id').in('id', currentIds).eq('channel', 'email').single()).data!;
    await expect.poll(async () => { const mailbox = await fetch(`${process.env.TEST_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`message-id:${email.id}@ourtopia.test`)}`); return ((await mailbox.json()) as { messages: unknown[] }).messages.length; }).toBe(1);
    await capture(page, info, 4, { h: await itemHandoff(f.bob, f.exchangeId), outbox });
  } finally { await owner.context.close(); }
});

test('lane 5 deadline race has one valid result and late acknowledgment fails before worker', async ({ page }, info) => {
  const f = await handoffFixture('handoff-race'); await open(page, f);
  await page.getByLabel('I acknowledge the return date', { exact: false }).check();
  const [, expiry] = await Promise.all([page.getByRole('button', { name: 'Acknowledge terms', exact: true }).click(), admin.rpc('expire_item_approval', { p_exchange_id: f.exchangeId })]);
  expect(expiry.error).toBeNull(); await expect(page.getByRole('status').filter({ hasText: 'Arranging Handoff' })).toBeVisible();
  const late = await borrowingFixture('handoff-late'); const loan = await withAcknowledgmentWindow('1 millisecond', async () => approveBorrow(late.alice, await requestItem(late.bob, late.listing.id)));
  expect((await handoffAction(late.bob, loan.exchange_id!, 0, 'acknowledge_terms', handoffTerms)).error?.code).toBe('55000');
  expect((await admin.rpc('expire_item_approval', { p_exchange_id: loan.exchange_id! })).error).toBeNull();
  expect((await itemHandoff(late.bob, loan.exchange_id!)).state).toBe('expired'); await capture(page, info, 5, { valid: await itemHandoff(f.bob, f.exchangeId), late: '55000 and expired' });
});

test('lane 6 interrupted Handoff response replays once and changed payload conflicts', async ({ page }, info) => {
  const f = await handoffFixture('handoff-replay'); await advanceHandoff(f, 'condition'); await open(page, f);
  let payload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/command_item_handoff', async route => { payload = route.request().postDataJSON(); await route.fetch(); await route.abort('failed'); });
  await page.getByLabel('I acknowledge the item is received', { exact: false }).check(); await page.getByRole('button', { name: 'Confirm Handoff', exact: true }).click();
  await expect.poll(async () => (await itemHandoff(f.bob, f.exchangeId)).state).toBe('checked_out'); await page.unroute('**/rest/v1/rpc/command_item_handoff');
  expect(payload).not.toBeNull(); const args = payload! as { p_intent_id: string; p_exchange_id: string; p_expected_revision: number; p_action: string; p_details: Record<string, boolean> };
  const replay = await f.bob.client.rpc('command_item_handoff', args); expect(replay.error).toBeNull();
  expect((await f.bob.client.rpc('command_item_handoff', { ...args, p_details: { condition_acknowledged: false } })).error?.code).toBe('23505');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible();
  expect((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_handed_off')).data).toHaveLength(1); await capture(page, info, 6, { replay: replay.data, changed: '23505' });
});

test('lane 7 pre-Handoff cancellation releases dates without penalty and post-Handoff cancellation is denied', async ({ page }, info) => {
  const f = await handoffFixture('handoff-cancel'); await advanceHandoff(f, 'terms'); await open(page, f);
  await page.getByLabel('Cancellation reason').fill('Travel plans changed'); await page.getByRole('button', { name: 'Cancel before Handoff', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cancelled' })).toBeVisible();
  const later = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id)); expect(later.status).toBe('approved');
  expect((await admin.from('reputation_events').select('id').eq('community_id', f.community.id)).data).toEqual([]);
  const checked = await handoffFixture('handoff-too-late'); await advanceHandoff(checked);
  expect((await handoffAction(checked.bob, checked.exchangeId, 5, 'cancel', { reason: 'Too late' })).error?.code).toBe('55000');
  await capture(page, info, 7, { cancelled: await itemHandoff(f.bob, f.exchangeId), later, postCheckout: '55000' });
});

test('lane 8 interrupted camera upload resumes after reload with one evidence identity and no extra transition', async ({ page }, info) => {
  const f = await handoffFixture('handoff-upload'); await advanceHandoff(f, 'terms'); await open(page, f);
  await expect(page.getByLabel('Camera or photo')).toHaveAttribute('capture', 'environment');
  let interrupted = false;
  await page.route('**/storage/v1/object/exchange-evidence/**', async route => { if (route.request().method() === 'POST' && !interrupted) { interrupted = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  const photo = { name: 'camera.png', mimeType: 'image/png', buffer: listingImageBytes };
  await page.getByLabel('Camera or photo').setInputFiles(photo);
  await page.route('**/rest/v1/rpc/complete_exchange_evidence', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Upload or retry photo', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Photo not confirmed');
  await page.unroute('**/storage/v1/object/exchange-evidence/**'); await page.unroute('**/rest/v1/rpc/complete_exchange_evidence'); await page.reload();
  await page.getByLabel('Camera or photo').setInputFiles(photo); await page.getByRole('button', { name: 'Upload or retry photo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Private Handoff condition' })).toBeVisible();
  const h = await itemHandoff(f.bob, f.exchangeId); expect(h.evidence).toHaveLength(1); expect(h.evidence[0].state).toBe('ready'); expect(h.state).toBe('handoff_pending'); expect(h.handed_off_at).toBeNull();
  await capture(page, info, 8, { h, interrupted });
});

test('lane 9 outsiders cannot open logistics; removed participant keeps only obligation actions and caches refresh', async ({ page, browser }, info) => {
  const f = await handoffFixture('handoff-access'); await open(page, f);
  await page.evaluate(({ userId, exchangeId }) => sessionStorage.setItem(`handoff-command-${userId}-${exchangeId}-pending`, 'private draft'), { userId: f.bob.id, exchangeId: f.exchangeId });
  const peer = await counterpart(browser, info);
  try {
    await signIn(peer.page, f.carol.email); await peer.page.goto(`/handoffs/${f.exchangeId}`); await expect(peer.page.getByRole('heading', { name: 'Handoff unavailable' })).toBeVisible();
    expect((await f.carol.client.from('item_handoffs').select('exchange_id').eq('exchange_id', f.exchangeId)).data).toEqual([]);
    expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error).toBeNull();
    await page.reload(); await terms(page); await schedule(page, 'Obligation-only meeting');
    expect((await f.bob.client.from('listings').select('id').eq('id', f.listing.id)).data).toEqual([]);
    await page.getByLabel('Cancellation reason').fill('Resolve the open obligation'); await page.getByRole('button', { name: 'Cancel before Handoff', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toBeVisible(); await expect(page.getByText('Obligation-only meeting', { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('handoff-command-')).length)).toBe(0);
    await capture(page, info, 9, { outsider: 'denied UI and RLS', removed: 'terms and schedule permitted, closure clears access' });
  } finally { await peer.context.close(); }
});

test('lane 10 keyboard and mobile expose status next actor deadline schedule and camera controls', async ({ page }, info) => {
  const f = await handoffFixture('handoff-keyboard'); await open(page, f);
  await expect(page.getByText('Next actor.', { exact: true })).toBeVisible(); await expect(page.getByText('Acknowledgment deadline', { exact: false })).toBeVisible();
  const check = page.getByLabel('I acknowledge the return date', { exact: false }); await check.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Arranging Handoff' })).toBeVisible();
  await schedule(page, 'Keyboard meeting'); await expect(page.getByRole('region', { name: 'Current Handoff schedule' })).toContainText('Keyboard meeting');
  await page.getByLabel('Camera or photo').setInputFiles({ name: 'keyboard.png', mimeType: 'image/png', buffer: listingImageBytes });
  const upload = page.getByRole('button', { name: 'Upload or retry photo', exact: true }); await upload.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('img', { name: 'Private Handoff condition' })).toBeVisible();
  await capture(page, info, 10, await itemHandoff(f.bob, f.exchangeId));
});
