import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  admin, approveBorrow, checkedOutFixture, decideBorrow, itemReturn, listingImageBytes, loanEffects, localScores, password, recordReturn, requestItem,
  returnAction, returnCondition, returnReminders, withReturnWindows,
} from '../../scripts/verify/backend';

const base = 'ecbb87b9c8da936ba4ada0a2491838374982da61';
type Fixture = Awaited<ReturnType<typeof checkedOutFixture>>;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function open(page: Page, f: Fixture, email = f.bob.email) {
  await signIn(page, email); await page.goto(`/handoffs/${f.exchangeId}`); await expect(page.getByRole('heading', { name: 'Item Return', exact: true })).toBeVisible();
}
async function counterpart(browser: Browser, info: TestInfo) {
  const { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = info.project.use;
  const context = await browser.newContext({ baseURL: process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor });
  return { context, page: await context.newPage() };
}
async function record(page: Page, details = returnCondition) {
  await page.getByLabel('Condition at Return', { exact: true }).fill(details.condition); await page.getByLabel('Returned accessories').fill(details.accessories);
  await page.getByRole('button', { name: 'Record Return', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Item Return' }).getByRole('status').filter({ hasText: 'Return awaiting confirmation' })).toBeVisible();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Refresh Return', exact: true }).click();
  await page.getByLabel('The item is back and its condition', { exact: false }).check(); await page.getByRole('button', { name: 'Confirm Return', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Completed loan' })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }, null, 2), contentType: 'application/json' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function completed(f: Fixture) {
  const effects = await loanEffects(f.exchangeId);
  expect({ state: effects.state, interactions: effects.interactions, feed: effects.feed, events: effects.events }).toEqual({ state: 'completed', interactions: 2, feed: 1,
    events: [{ rule: 'item_borrower_return', points: 1, recipient_id: f.bob.id }, { rule: 'item_owner_share', points: 2, recipient_id: f.alice.id }] });
  expect(await localScores(f.community.id, f.alice, f.bob)).toEqual([52, 51]);
  return effects;
}
async function primary(page: Page, browser: Browser, info: TestInfo, f: Fixture) {
  await open(page, f); await record(page);
  const owner = await counterpart(browser, info);
  try {
    await open(owner.page, f, f.alice.email);
    await expect(owner.page.getByRole('region', { name: 'Handoff and Return comparison' })).toContainText(`Condition. ${returnCondition.condition}`);
    await confirm(owner.page);
    await expect(owner.page.getByRole('region', { name: 'Completed loan' })).toContainText('52 — Petty Bourgeoisie');
    await expect(owner.page.getByRole('region', { name: 'Completed loan' })).toContainText('You earned +2 for sharing this item.');
  } finally { await owner.context.close(); }
  await page.reload(); await expect(page.getByRole('region', { name: 'Completed loan' })).toContainText('51 — Petty Bourgeoisie');
  await expect(page.getByRole('region', { name: 'Completed loan' })).toContainText('1 completed Exchange');
  return completed(f);
}

test('lane 1 trunk has no Return controls for a checked-out loan; head records Return and completes the loan', async ({ page, browser }, info) => {
  test.setTimeout(150000); const f = await checkedOutFixture('return-trunk'); const root = `.pilot-evidence/issue-9-trunk-${info.project.name}`;
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(p => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(p));
  for (const p of files) { const target = `${root}/${p}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${p}`])); }
  copyFileSync('.env.local', `${root}/.env.local`); const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ ...info.project.use, baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(r => r.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.bob.email); await trunk.goto(`/handoffs/${f.exchangeId}`);
    await expect(trunk.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible();
    await expect(trunk.getByRole('button', { name: 'Record Return', exact: true })).toHaveCount(0);
    await expect(trunk.getByRole('heading', { name: 'Item Return', exact: true })).toHaveCount(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  const effects = await primary(page, browser, info, f); await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { trunk: 'Handoff recorded, no Return controls; checked-out custody retained', effects });
});

test('lane 2 borrower records Return, owner confirms, loan completes with Alice 52, Bob 51 and one interaction each', async ({ page, browser }, info) => {
  const f = await checkedOutFixture('return-primary'); const effects = await primary(page, browser, info, f);
  expect(effects.milestones).toEqual(['completion_settled', 'item_completed', 'item_returned']);
  expect(effects.reservation).toEqual({ blocking: false, custody_unresolved: false });
  await capture(page, info, 2, effects);
});

test('lane 3 optional photos are skipped or retried and Handoff and Return records are compared before completion', async ({ page, browser }, info) => {
  const f = await checkedOutFixture('return-photos'); await open(page, f);
  await page.getByRole('region', { name: 'Optional Return photos' }).getByRole('button', { name: 'Skip optional photos', exact: true }).click();
  await expect(page.getByText('Photos skipped. Continue with the Return condition.')).toBeVisible();
  await record(page);
  const owner = await counterpart(browser, info);
  try {
    await open(owner.page, f, f.alice.email);
    let interrupted = false;
    await owner.page.route('**/storage/v1/object/exchange-evidence/**', route => { if (!interrupted && route.request().method() === 'POST') { interrupted = true; return route.abort(); } return route.continue(); });
    const photos = owner.page.getByRole('region', { name: 'Optional Return photos' });
    await photos.getByLabel('Camera or photo').setInputFiles({ name: 'return.png', mimeType: 'image/png', buffer: listingImageBytes });
    await photos.getByRole('button', { name: 'Upload or retry photo', exact: true }).click();
    await expect(photos.getByRole('alert')).toContainText('Photo not confirmed');
    await photos.getByLabel('Camera or photo').setInputFiles({ name: 'return.png', mimeType: 'image/png', buffer: listingImageBytes });
    await photos.getByRole('button', { name: 'Upload or retry photo', exact: true }).click();
    const comparison = owner.page.getByRole('region', { name: 'Handoff and Return comparison' });
    await expect(comparison).toContainText('1 Return photos'); await expect(comparison).toContainText('0 Handoff photos');
    await expect(comparison).toContainText(`Accessories. ${returnCondition.accessories}`);
    await expect(comparison.getByRole('img', { name: 'Private Return condition' })).toBeVisible();
    await confirm(owner.page);
  } finally { await owner.context.close(); }
  const view = await itemReturn(f.bob, f.exchangeId);
  expect(view.evidence.map(photo => [photo.purpose, photo.state, photo.uploader_id])).toEqual([['return', 'ready', f.alice.id]]);
  await page.reload(); await expect(page.getByRole('region', { name: 'Handoff and Return comparison' })).toContainText('1 Return photos');
  await capture(page, info, 3, { effects: await completed(f), evidence: view.evidence.length, skipped: 'borrower', retried: 'owner' });
});

test('lane 4 conflicting Return condition opens the Dispute path and blocks ordinary completion', async ({ page }, info) => {
  const f = await checkedOutFixture('return-conflict'); await recordReturn(f);
  await open(page, f, f.alice.email);
  const form = page.getByRole('form', { name: 'Report a different condition' });
  await form.getByLabel('Issue type').selectOption('missing_item'); await form.getByLabel('Condition you see').fill('The charger is missing.');
  await form.getByRole('button', { name: 'Report condition disagreement', exact: true }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Ordinary completion is blocked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Return', exact: true })).toHaveCount(0);
  const effects = await loanEffects(f.exchangeId);
  expect({ state: effects.state, interactions: effects.interactions, events: effects.events, feed: effects.feed, reservation: effects.reservation }).toEqual({ state: 'return_pending', interactions: 0, events: [], feed: 0, reservation: { blocking: true, custody_unresolved: true } });
  const cases = await admin.from('disputes').select('issue_type,status,reporter_id').eq('exchange_id', f.exchangeId);
  expect(cases.data).toEqual([{ issue_type: 'missing_item', status: 'issue_reported', reporter_id: f.alice.id }]);
  await page.getByRole('link', { name: 'Open Exchange issues' }).click(); await expect(page.getByRole('status').filter({ hasText: 'Disputed' })).toBeVisible();
  await capture(page, info, 4, { effects, cases: cases.data });
});

test('lane 5 seven days of missing confirmation after reminders queues administrator review without completion or points', async ({ page, browser }, info) => {
  const f = await checkedOutFixture('return-silence');
  await withReturnWindows({ confirmation_reminder_after: '1 second', review_after: '4 seconds' }, async () => {
    await open(page, f); await record(page);
    await expect.poll(async () => (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).filter(row => row.current && row.state === 'delivered').length, { timeout: 20000 }).toBe(2);
    await wait(3500);
    expect((await admin.rpc('process_due_item_returns')).error).toBeNull();
  });
  expect((await admin.from('exchange_review_items').select('reason').eq('exchange_id', f.exchangeId)).data).toEqual([{ reason: 'missing_return_confirmation' }]);
  await page.reload(); await expect(page.getByRole('region', { name: 'Administrator review' })).toContainText('Return confirmation missing for seven days');
  const effects = await loanEffects(f.exchangeId);
  expect({ state: effects.state, interactions: effects.interactions, events: effects.events, feed: effects.feed }).toEqual({ state: 'return_pending', interactions: 0, events: [], feed: 0 });
  const reviewer = await counterpart(browser, info);
  try {
    await signIn(reviewer.page, f.owner.email); await reviewer.page.goto('/reviews');
    await expect(reviewer.page.getByRole('heading', { name: 'Exchange review queue' })).toBeVisible();
    await expect(reviewer.page.getByText('Return confirmation missing for seven days', { exact: true }).first()).toBeVisible();
    await expect(reviewer.page.getByText(returnCondition.condition)).toHaveCount(0);
  } finally { await reviewer.context.close(); }
  await capture(page, info, 5, { effects, review: 'missing_return_confirmation', reminders: await returnReminders(f.exchangeId, 'item_return_confirmation_due') });
});

test('lane 6 racing and replayed Return, confirmations and Finalize apply state, awards, interactions, feed and notices once', async ({ page }, info) => {
  const f = await checkedOutFixture('return-race');
  const records = await Promise.all([returnAction(f.bob, f.exchangeId, 0, 'record_return', returnCondition), returnAction(f.alice, f.exchangeId, 0, 'record_return', returnCondition)]);
  expect(records.map(result => result.error?.code ?? 'ok').sort()).toEqual(['55000', 'ok']);
  const pending = await itemReturn(f.bob, f.exchangeId); const confirmer = pending.record!.recorded_by === f.bob.id ? f.alice : f.bob;
  await open(page, f, confirmer.email);
  await page.getByLabel('The item is back and its condition', { exact: false }).check();
  const [, direct, sweep] = await Promise.all([page.getByRole('button', { name: 'Confirm Return', exact: true }).click(),
    returnAction(confirmer, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true }), admin.rpc('process_due_item_returns')]);
  expect(sweep.error).toBeNull();
  await page.reload(); await expect(page.getByRole('region', { name: 'Completed loan' })).toBeVisible();
  const replay = await returnAction(confirmer, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true });
  expect(replay.error?.code).toBe('55000');
  const effects = await completed(f);
  expect((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'item_completed')).data).toHaveLength(4);
  expect((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_return_confirmed')).data).toHaveLength(1);
  await capture(page, info, 6, { records: records.map(result => result.error?.code ?? 'ok'), direct: direct.error?.code ?? 'ok', effects });
});

test('lane 7 only confirmed physical recovery releases custody and allocation; missing and disputed Returns stay unavailable', async ({ page, browser }, info) => {
  const confirmed = await checkedOutFixture('return-custody-confirmed'); await primary(page, browser, info, confirmed);
  const later = await approveBorrow(confirmed.alice, await requestItem(confirmed.carol, confirmed.listing.id)); expect(later.status).toBe('approved');
  const missing = await checkedOutFixture('return-custody-missing'); await recordReturn(missing);
  expect((await decideBorrow(missing.alice, await requestItem(missing.carol, missing.listing.id, '2027-02-01', '2027-02-02'))).error?.code).toBe('23P01');
  const disputed = await checkedOutFixture('return-custody-disputed'); const pending = await recordReturn(disputed);
  expect((await returnAction(disputed.alice, disputed.exchangeId, pending.revision, 'contest_return', { condition: 'Cracked chuck', issue_type: 'damage' })).error).toBeNull();
  expect((await decideBorrow(disputed.alice, await requestItem(disputed.carol, disputed.listing.id, '2027-02-01', '2027-02-02'))).error?.code).toBe('23P01');
  const owner = await counterpart(browser, info);
  try { await open(owner.page, missing, missing.alice.email); await expect(owner.page.getByRole('article', { name: 'Item Return' }).getByRole('status')).toHaveText('Return awaiting confirmation'); }
  finally { await owner.context.close(); }
  const result = { confirmed: (await loanEffects(confirmed.exchangeId)).reservation, missing: (await loanEffects(missing.exchangeId)).reservation, disputed: (await loanEffects(disputed.exchangeId)).reservation, laterApproval: later.status };
  expect(result).toEqual({ confirmed: { blocking: false, custody_unresolved: false }, missing: { blocking: true, custody_unresolved: true }, disputed: { blocking: true, custody_unresolved: true }, laterApproval: 'approved' });
  await capture(page, info, 7, result);
});

test('lane 8 Community feed shows a safe completion entry and another Exchange stays private', async ({ page: first, browser }, info) => {
  const f = await checkedOutFixture('return-feed'); await primary(first, browser, info, f);
  const member = await counterpart(browser, info); const page = member.page;
  await signIn(page, f.carol.email); await page.goto(`/communities/${f.community.id}`);
  const feed = page.getByRole('region', { name: 'Community activity feed' });
  await expect(feed).toContainText(`${f.alice.email} lent Alice's Makita drill to ${f.bob.email}. The loan is complete.`);
  for (const secret of [returnCondition.condition, returnCondition.accessories, 'Front porch', 'exchange-evidence']) await expect(feed).not.toContainText(secret);
  await page.goto(`/handoffs/${f.exchangeId}`); await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Item Return', exact: true })).toHaveCount(0);
  expect((await f.carol.client.rpc('read_item_return', { p_exchange_id: f.exchangeId })).error?.code).toBe('42501');
  expect((await f.carol.client.from('item_returns').select('exchange_id').eq('exchange_id', f.exchangeId)).data).toEqual([]);
  expect((await f.carol.client.from('exchange_evidence').select('id').eq('exchange_id', f.exchangeId)).data).toEqual([]);
  await page.goto(`/communities/${f.community.id}`); await expect(feed).toBeVisible();
  await capture(page, info, 8, { feed: await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id }).then(r => r.data), otherExchange: '42501 and empty RLS reads' });
  await member.context.close();
});

test('lane 9 failed reminder is obsoleted by a corrected Return; business state is stable and only the current reminder delivers', async ({ page, browser }, info) => {
  test.setTimeout(120000);
  const f = await checkedOutFixture('return-reminders'); await open(page, f);
  let failedId = '';
  await withReturnWindows({ confirmation_reminder_after: '2 minutes' }, async () => {
    await record(page);
    for (let attempt = 0; attempt < 3 && !failedId; attempt++) {
      const email = (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).find(row => row.current && row.channel === 'email' && row.state === 'pending')!;
      expect((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).eq('id', email.id)).error).toBeNull();
      const claimed = await admin.rpc('claim_notification', { p_outbox_id: email.id });
      if (!claimed.data) { await page.getByRole('button', { name: 'Update Return record', exact: true }).click(); await wait(500); continue; }
      const token = (claimed.data as { claim_token: string }).claim_token;
      expect(((await admin.rpc('finish_notification', { p_outbox_id: email.id, p_claim_token: token, p_error: 'Provider unavailable' })).data as { state: string }).state).toBe('failed');
      failedId = email.id;
    }
  });
  expect(failedId).not.toBe('');
  expect((await itemReturn(f.alice, f.exchangeId)).state).toBe('return_pending');
  await withReturnWindows({ confirmation_reminder_after: '1 second' }, async () => {
    await page.getByLabel('Returned accessories').fill('Two batteries, charger and case'); await page.getByRole('button', { name: 'Update Return record', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Handoff and Return comparison' })).toContainText('Two batteries, charger and case');
  });
  expect((await f.owner.client.rpc('retry_notification', { p_intent_id: crypto.randomUUID(), p_outbox_id: failedId })).error?.code).toBe('55000');
  expect((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).eq('id', failedId)).error).toBeNull();
  await expect.poll(async () => (await admin.from('notification_outbox').select('state').eq('id', failedId).single()).data?.state, { timeout: 20000 }).toBe('suppressed');
  await expect.poll(async () => (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).filter(row => row.current && row.state === 'delivered').length, { timeout: 20000 }).toBe(2);
  const current = (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).find(row => row.current && row.channel === 'email')!;
  const mailbox = async (id: string) => ((await (await fetch(`${process.env.TEST_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`message-id:${id}@ourtopia.test`)}`)).json()) as { messages: unknown[] }).messages.length;
  await expect.poll(() => mailbox(current.id)).toBe(1); expect(await mailbox(failedId)).toBe(0);
  const owner = await counterpart(browser, info);
  try {
    await open(owner.page, f, f.alice.email);
    await expect(owner.page.getByRole('region', { name: 'Handoff notices' })).toContainText('A recorded Return is still waiting for your confirmation.');
  } finally { await owner.context.close(); }
  const view = await itemReturn(f.alice, f.exchangeId); expect(view.state).toBe('return_pending');
  await capture(page, info, 9, { failedId, current: current.id, view, reminders: await returnReminders(f.exchangeId, 'item_return_confirmation_due') });
});

test('lane 10 keyboard confirmation exposes completion, points and updated history on mobile and desktop', async ({ page }, info) => {
  const f = await checkedOutFixture('return-keyboard'); await recordReturn(f);
  await open(page, f, f.alice.email);
  await expect(page.getByText('Next step.', { exact: true })).toBeVisible();
  const check = page.getByLabel('The item is back and its condition', { exact: false }); await check.focus(); await page.keyboard.press('Space');
  await expect(check).toBeChecked(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Confirm Return', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  const done = page.getByRole('region', { name: 'Completed loan' }); await expect(done).toContainText('52 — Petty Bourgeoisie'); await expect(done).toContainText('One Qualifying Interaction was recorded for each participant.');
  await expect(page.getByRole('article', { name: 'Item Return' }).getByRole('status')).toHaveText('Loan completed');
  await done.getByRole('link', { name: 'See your history' }).focus(); await page.keyboard.press('Enter');
  const history = page.getByRole('region', { name: `Your history in ${f.community.name}` });
  await expect(history).toContainText('+2'); await expect(history).toContainText('Shared an item');
  await expect(page.getByText('52 — Petty Bourgeoisie').first()).toBeVisible();
  await capture(page, info, 10, await completed(f));
});
