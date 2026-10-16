import { test, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  activeMember, admin, approveBorrow, borrowNotices, borrowRecords, borrowingFixture, checkOutFixture, decideBorrow, drillDetails, password,
  requestItem, seedReputationEvent, withAcknowledgmentWindow,
} from '../../scripts/verify/backend';

const base = '7aa1af9cf1dae27a32226bb0f52f408e29749aa2';
const appURL = process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`;
const weekend = 'Fri, Jan 15, 2027 through Sun, Jan 17, 2027';
type Fixture = Awaited<ReturnType<typeof borrowingFixture>>;

async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function openListing(page: Page, f: Fixture, email: string) {
  await signIn(page, email); await page.goto(`/communities/${f.community.id}/listings/${f.listing.id}`);
  await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Borrow Requests', exact: true }).getByRole('heading', { level: 2 })).toBeVisible();
}
function device(info: TestInfo, extra: BrowserContextOptions = {}): BrowserContextOptions {
  const { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = info.project.use;
  return { baseURL: appURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor, ...extra };
}
async function second(browser: Browser, info: TestInfo, extra: BrowserContextOptions = {}) {
  const context = await browser.newContext(device(info, extra));
  return { context, page: await context.newPage() };
}
async function requestDates(page: Page, startsOn: string, endsOn: string) {
  const form = page.getByRole('form', { name: 'Request this item' });
  await form.getByLabel('First day', { exact: true }).fill(startsOn); await form.getByLabel('Last day', { exact: true }).fill(endsOn);
  await form.getByRole('button', { name: 'Send Borrow Request', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Borrow Request sent');
}
const card = (page: Page, who: string, dates = weekend) => page.getByRole('article', { name: `Borrow Request from ${who} for ${dates}`, exact: true });
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), backend: process.env.VITE_SUPABASE_URL, data }, null, 2), contentType: 'application/json' });
}
async function noHorizontalScroll(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }

test('lane 1 trunk has no Borrow Request submission; head approves one 48-hour reservation', async ({ page, browser }, info) => {
  test.setTimeout(150000);
  const f = await borrowingFixture('borrow-trunk'); const root = `.pilot-evidence/issue-6-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) { const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`])); }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext(device(info, { baseURL: `http://127.0.0.1:${port}` }));
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(result => result.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.bob.email);
    await trunk.goto(`/communities/${f.community.id}/listings/${f.listing.id}`); await expect(trunk.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
    await trunk.getByRole('button', { name: 'Borrow Request', exact: true }).click();
    await expect(trunk.getByRole('region', { name: 'Borrow Request', exact: true })).toContainText('Borrow Request submission is coming in the next release.');
    await expect(trunk.getByRole('form', { name: 'Request this item' })).toHaveCount(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await openListing(page, f, f.bob.email); await requestDates(page, '2027-01-15', '2027-01-17');
  const alice = await second(browser, info);
  try {
    await openListing(alice.page, f, f.alice.email);
    await card(alice.page, f.bob.email).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }).click();
    await expect(card(alice.page, f.bob.email).getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    await alice.page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  } finally { await alice.context.close(); }
  const records = await borrowRecords(f.listing.id);
  expect(records.exchanges.map(row => row.state)).toEqual(['approved']); expect(records.reservations.map(row => row.dates)).toEqual(['[2027-01-15,2027-01-18)']);
  await page.reload(); await expect(card(page, 'you').getByText('Approved and reserved', { exact: true })).toBeVisible();
  await capture(page, info, 1, { trunk: 'Borrow Request submission absent; placeholder sends nothing', records });
});

test('lane 2 Bob requests Friday through Sunday and Alice approves after seeing 50 Unproven', async ({ page, browser }, info) => {
  const f = await borrowingFixture('borrow-primary');
  await openListing(page, f, f.bob.email); await requestDates(page, '2027-01-15', '2027-01-17');
  await expect(card(page, 'you').getByText('Waiting for the owner', { exact: true })).toBeVisible();
  expect((await borrowRecords(f.listing.id)).exchanges).toEqual([]);
  const alice = await second(browser, info);
  try {
    await openListing(alice.page, f, f.alice.email);
    const review = card(alice.page, f.bob.email).getByRole('region', { name: `Current standing of ${f.bob.email}`, exact: true });
    await expect(review.getByRole('region', { name: 'Community Solidarity Score', exact: true })).toContainText('50 — Unproven');
    await expect(review.getByRole('region', { name: 'Global Solidarity Score', exact: true })).toContainText('50 — Unproven');
    await expect(review.getByRole('region', { name: 'Community Solidarity Score', exact: true })).toContainText('0 completed Exchanges');
    await expect(review.getByRole('region', { name: 'Trust indicators', exact: true })).toContainText('No unresolved Disputes or serious violations');
    await expect(review).toContainText("Meets this Listing's minimum of 45.");
    const started = Date.now();
    await card(alice.page, f.bob.email).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }).click();
    const reservation = card(alice.page, f.bob.email).getByRole('region', { name: 'Reservation', exact: true });
    await expect(reservation.getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    await expect(reservation).toContainText(`Next: ${f.bob.email} acknowledges the terms by`);
    const records = await borrowRecords(f.listing.id);
    expect(records.exchanges).toEqual([{ id: records.reservations[0].exchange_id, kind: 'item', state: 'approved', provider_id: f.alice.id, receiver_id: f.bob.id }]);
    expect(records.reservations.map(row => [row.dates, row.blocking])).toEqual([['[2027-01-15,2027-01-18)', true]]);
    const window = Date.parse(records.reservations[0].acknowledgment_due_at) - started;
    expect(window).toBeGreaterThan(48 * 3600000 - 60000); expect(window).toBeLessThan(48 * 3600000 + 60000);
    expect(await borrowNotices(f.community.id, 'borrow_approved')).toHaveLength(2);
    await capture(alice.page, info, 2, { records, trust: { local: '50 — Unproven', global: '50 — Unproven', disputes: 0 } });
  } finally { await alice.context.close(); }
  await page.reload(); await expect(card(page, 'you').getByRole('region', { name: 'Reservation', exact: true })).toContainText('Next: acknowledge the return date');
});

test('lane 3 overlapping applications stay pending and a decline records its notice', async ({ page, browser }, info) => {
  const f = await borrowingFixture('borrow-decline');
  await requestItem(f.bob, f.listing.id); await requestItem(f.carol, f.listing.id);
  await openListing(page, f, f.alice.email);
  await expect(page.getByRole('region', { name: 'Borrow Requests', exact: true })).toContainText('2 requests are waiting.');
  expect((await borrowRecords(f.listing.id)).exchanges).toEqual([]);
  await card(page, f.carol.email).getByRole('button', { name: `Decline ${f.carol.email}`, exact: true }).click();
  await expect(card(page, f.carol.email).getByText('You declined this request. Nothing was reserved.')).toBeVisible();
  await expect(card(page, f.bob.email).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true })).toBeVisible();
  const records = await borrowRecords(f.listing.id);
  expect(records.requests.map(row => [row.borrower_id === f.bob.id ? 'bob' : 'carol', row.status, row.exchange_id])).toEqual([['bob', 'requested', null], ['carol', 'rejected', null]]);
  expect(records.exchanges).toEqual([]);
  expect(await borrowNotices(f.community.id, 'borrow_rejected')).toEqual([{ recipient_id: f.carol.id, channel: 'email', kind: 'borrow_rejected' }, { recipient_id: f.carol.id, channel: 'in_app', kind: 'borrow_rejected' }]);
  const carol = await second(browser, info);
  try {
    await signIn(carol.page, f.carol.email); await carol.page.goto('/borrowing');
    await expect(card(carol.page, 'you').getByText('The owner declined this request. Nothing was reserved.')).toBeVisible();
  } finally { await carol.context.close(); }
  await capture(page, info, 3, records);
});

test('lane 4 below-minimum and no-longer-eligible approvals are refused without partial effects', async ({ page }, info) => {
  const f = await borrowingFixture('borrow-ineligible');
  await seedReputationEvent(f.community.id, f.bob.id, -10);
  await requestItem(f.bob, f.listing.id); await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02');
  await openListing(page, f, f.alice.email);
  const bob = card(page, f.bob.email);
  await expect(bob.getByRole('region', { name: 'Community Solidarity Score', exact: true })).toContainText('40 — Unproven');
  await expect(bob).toContainText("Below this Listing's minimum of 45. Approval will be refused.");
  await bob.getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }).click();
  await expect(bob.getByRole('alert')).toContainText('Not eligible');
  await expect(bob.getByRole('alert')).toContainText("below this Listing's minimum Community Solidarity Score");
  const carolDates = 'Mon, Feb 1, 2027 through Tue, Feb 2, 2027';
  await expect(card(page, f.carol.email, carolDates).getByRole('button', { name: `Approve ${f.carol.email}`, exact: true })).toBeVisible();
  expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error).toBeNull();
  await card(page, f.carol.email, carolDates).getByRole('button', { name: `Approve ${f.carol.email}`, exact: true }).click();
  await expect(card(page, f.carol.email, carolDates).getByRole('alert')).toContainText('no longer an active member');
  const records = await borrowRecords(f.listing.id);
  expect(records.exchanges).toEqual([]); expect(records.reservations).toEqual([]);
  expect(records.requests.map(row => [row.status, row.version, row.exchange_id])).toEqual([['requested', 1, null], ['requested', 1, null]]);
  expect(await borrowNotices(f.community.id, 'borrow_approved')).toEqual([]);
  await capture(page, info, 4, { records, belowMinimum: '23514', removedBorrower: '55000' });
});

test('lane 5 adjacent and nonoverlapping inclusive dates match across display timezones', async ({ browser }, info) => {
  const f = await borrowingFixture('borrow-timezones');
  const bob = await second(browser, info, { timezoneId: 'Pacific/Kiritimati' });
  const adjacent = 'Mon, Jan 18, 2027 through Wed, Jan 20, 2027'; const later = 'Mon, Feb 1, 2027 through Tue, Feb 2, 2027';
  try {
    await openListing(bob.page, f, f.bob.email);
    const form = bob.page.getByRole('form', { name: 'Request this item' });
    await form.getByLabel('First day', { exact: true }).fill('2027-01-15'); await form.getByLabel('Last day', { exact: true }).fill('2027-01-17');
    await expect(form).toContainText(`You are asking for ${weekend} (3 days, both included).`);
    await form.getByRole('button', { name: 'Send Borrow Request', exact: true }).click(); await expect(form.getByRole('status')).toContainText('Borrow Request sent');
    await requestDates(bob.page, '2027-01-18', '2027-01-20'); await requestDates(bob.page, '2027-02-01', '2027-02-02');
  } finally { await bob.context.close(); }
  const alice = await second(browser, info, { timezoneId: 'America/Los_Angeles' });
  try {
    await openListing(alice.page, f, f.alice.email);
    for (const dates of [weekend, adjacent, later]) {
      await card(alice.page, f.bob.email, dates).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }).click();
      await expect(card(alice.page, f.bob.email, dates).getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    }
    const ranges = (await borrowRecords(f.listing.id)).reservations.map(row => row.dates);
    expect(ranges).toEqual(['[2027-01-15,2027-01-18)', '[2027-01-18,2027-01-21)', '[2027-02-01,2027-02-03)']);
    await expect(card(alice.page, f.bob.email, weekend).getByRole('region', { name: 'Reservation', exact: true })).toContainText(`${weekend}. Both days are included.`);
    const deadline = await card(alice.page, f.bob.email, weekend).locator('time').first().textContent();
    await capture(alice.page, info, 5, { ranges, ownerTimezone: 'America/Los_Angeles', borrowerTimezone: 'Pacific/Kiritimati', ownerDeadlineText: deadline });
  } finally { await alice.context.close(); }
});

test('lane 6 racing owner approvals produce exactly one reservation and a typed conflict', async ({ page, browser }, info) => {
  const f = await borrowingFixture('borrow-race');
  await requestItem(f.bob, f.listing.id); await requestItem(f.carol, f.listing.id, '2027-01-16', '2027-01-18');
  const carolDates = 'Sat, Jan 16, 2027 through Mon, Jan 18, 2027';
  await openListing(page, f, f.alice.email);
  const other = await second(browser, info);
  try {
    await openListing(other.page, f, f.alice.email);
    const bobApprove = card(page, f.bob.email).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true });
    const carolApprove = card(other.page, f.carol.email, carolDates).getByRole('button', { name: `Approve ${f.carol.email}`, exact: true });
    await expect(bobApprove).toBeEnabled(); await expect(carolApprove).toBeEnabled();
    await Promise.all([bobApprove.click(), carolApprove.click()]);
    await expect.poll(async () => (await borrowRecords(f.listing.id)).exchanges.length).toBe(1);
    const records = await borrowRecords(f.listing.id);
    const winner = records.exchanges[0].receiver_id === f.bob.id ? 'bob' : 'carol';
    const loserCard = winner === 'bob' ? card(other.page, f.carol.email, carolDates) : card(page, f.bob.email);
    await expect(loserCard.getByRole('alert')).toContainText('Reservation conflict');
    await expect(loserCard.getByRole('alert')).toContainText('Nothing was reserved, and the borrower was not notified.');
    const loserId = winner === 'bob' ? f.carol.id : f.bob.id;
    expect(records.requests.find(row => row.borrower_id === loserId)).toMatchObject({ status: 'requested', exchange_id: null, version: 1 });
    expect((await borrowNotices(f.community.id, 'borrow_approved')).map(row => row.recipient_id)).toEqual([records.exchanges[0].receiver_id, records.exchanges[0].receiver_id]);
    await capture(winner === 'bob' ? other.page : page, info, 6, { winner, records });
  } finally { await other.context.close(); }
});

test('lane 7 an unacknowledged approval expires once under delayed and repeated workers while the client is offline', async ({ page, browser }, info) => {
  test.setTimeout(120000);
  const f = await borrowingFixture('borrow-expiry');
  await requestItem(f.bob, f.listing.id);
  await openListing(page, f, f.bob.email);
  const alice = await second(browser, info);
  try {
    await openListing(alice.page, f, f.alice.email);
    await withAcknowledgmentWindow('12 seconds', async () => {
      await card(alice.page, f.bob.email).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }).click();
      await expect(card(alice.page, f.bob.email).getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    });
    const approved = await borrowRecords(f.listing.id); const exchangeId = approved.reservations[0].exchange_id;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(card(page, 'you').getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await page.waitForTimeout(Math.max(0, Date.parse(approved.reservations[0].acknowledgment_due_at) - Date.now()) + 1000);
    await expect(card(alice.page, f.bob.email).getByRole('heading', { name: /^(Acknowledgment deadline passed|Approval expired)$/ })).toBeVisible();
    expect((await admin.from('item_reservations').update({ acknowledged_at: new Date().toISOString() }).eq('exchange_id', exchangeId)).error?.code).toBe('55000');
    const workers = await Promise.all([admin.rpc('expire_due_item_approvals'), admin.rpc('expire_item_approval', { p_exchange_id: exchangeId }), admin.rpc('expire_due_item_approvals')]);
    for (const worker of workers) expect(worker.error).toBeNull();
    expect((await admin.rpc('expire_item_approval', { p_exchange_id: exchangeId })).error).toBeNull();
    await page.context().setOffline(false); await page.reload();
    await expect(card(page, 'you').getByRole('heading', { name: 'Approval expired', exact: true })).toBeVisible();
    await expect(card(page, 'you')).toContainText('you can send a new Borrow Request.');
    await expect(card(alice.page, f.bob.email).getByRole('heading', { name: 'Approval expired', exact: true })).toBeVisible();
    const records = await borrowRecords(f.listing.id);
    expect(records.exchanges.map(row => row.state)).toEqual(['expired']); expect(records.requests.map(row => row.status)).toEqual(['expired']);
    expect(records.reservations.map(row => row.blocking)).toEqual([false]);
    expect((await admin.from('community_events').select('id').eq('community_id', f.community.id).eq('kind', 'borrow_expired')).data).toHaveLength(1);
    expect((await borrowNotices(f.community.id, 'borrow_expired')).map(row => row.recipient_id).sort()).toEqual([f.alice.id, f.alice.id, f.bob.id, f.bob.id].sort());
    await capture(page, info, 7, { records, workers: workers.map(worker => worker.data) });
  } finally { await alice.context.close(); }
});

test('lane 8 unresolved custody blocks a later request until physical recovery', async ({ page, browser }, info) => {
  const f = await borrowingFixture('borrow-custody');
  const loan = await approveBorrow(f.alice, await requestItem(f.bob, f.listing.id)); await checkOutFixture(loan.exchange_id!);
  const carol = await second(browser, info);
  try { await openListing(carol.page, f, f.carol.email); await requestDates(carol.page, '2027-02-01', '2027-02-02'); } finally { await carol.context.close(); }
  const carolDates = 'Mon, Feb 1, 2027 through Tue, Feb 2, 2027';
  await openListing(page, f, f.alice.email);
  await expect(card(page, f.bob.email).getByRole('region', { name: 'Reservation', exact: true })).toContainText('Checked out to the borrower');
  const approve = card(page, f.carol.email, carolDates).getByRole('button', { name: `Approve ${f.carol.email}`, exact: true });
  const decide = async () => (await Promise.all([page.waitForResponse(response => response.url().includes('/rpc/decide_borrow_request')), approve.click()]))[0];
  expect((await (await decide()).json()).code).toBe('23P01'); await expect(card(page, f.carol.email, carolDates).getByRole('alert')).toContainText('Item custody is unresolved');
  expect((await admin.from('exchanges').update({ state: 'closed_without_completion' }).eq('id', loan.exchange_id!)).error).toBeNull();
  expect((await (await decide()).json()).code).toBe('23P01'); await expect(card(page, f.carol.email, carolDates).getByRole('alert')).toContainText('Item custody is unresolved');
  const blocked = await borrowRecords(f.listing.id);
  expect(blocked.exchanges).toHaveLength(1); expect(blocked.reservations.map(row => [row.blocking, row.custody_unresolved])).toEqual([[true, true]]);
  await page.screenshot({ path: info.outputPath('lane-8/blocked.png'), fullPage: true });
  expect((await admin.from('item_reservations').update({ custody_unresolved: false }).eq('exchange_id', loan.exchange_id!)).error).toBeNull();
  await approve.click(); await expect(card(page, f.carol.email, carolDates).getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
  await capture(page, info, 8, { blocked, recovered: await borrowRecords(f.listing.id) });
});

test('lane 9 forged approvals, reservation edits, and foreign history reads are denied', async ({ page }, info) => {
  const f = await borrowingFixture('borrow-forgery');
  const request = await requestItem(f.bob, f.listing.id);
  const dave = await activeMember(f.owner, f.community.id, 'borrow-forgery-dave');
  await openListing(page, f, dave.email);
  await expect(page.getByRole('form', { name: 'Request this item' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Borrow Requests', exact: true });
  await expect(panel.getByRole('article')).toHaveCount(0); await expect(panel.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await page.goto('/borrowing'); await expect(page.getByText('No one has asked to borrow your items yet.')).toBeVisible(); await expect(page.getByText('You have not requested any items yet.')).toBeVisible();
  const denied = {
    borrowerApproves: (await decideBorrow(f.bob, request)).error?.code,
    administratorApproves: (await decideBorrow(f.owner, request)).error?.code,
    memberApproves: (await decideBorrow(dave, request)).error?.code,
    borrowerForgesStatus: (await f.bob.client.from('borrow_requests').update({ status: 'approved' }).eq('id', request.id)).error?.code,
    borrowerInsertsReservation: (await f.bob.client.from('item_reservations').insert({ exchange_id: randomUUID(), request_id: request.id, listing_id: f.listing.id, starts_on: '2027-01-15', ends_on: '2027-01-17', acknowledgment_due_at: new Date().toISOString(), condition: 'x', replacement_value: 1, lending_conditions: 'x' })).error?.code,
    ownerEditsDates: (await f.alice.client.from('borrow_requests').update({ ends_on: '2027-01-20' }).eq('id', request.id)).error?.code,
  };
  expect(denied).toEqual({ borrowerApproves: '42501', administratorApproves: '42501', memberApproves: '42501', borrowerForgesStatus: '42501', borrowerInsertsReservation: '42501', ownerEditsDates: '42501' });
  const reads = { member: (await dave.client.from('borrow_requests').select('id').eq('listing_id', f.listing.id)).data, administrator: (await f.owner.client.from('borrow_requests').select('id').eq('listing_id', f.listing.id)).data };
  expect(reads).toEqual({ member: [], administrator: [] });
  expect((await borrowRecords(f.listing.id)).requests.map(row => row.status)).toEqual(['requested']);
  await capture(page, info, 9, { denied, reads });
});

test('lane 10 request, trust review, conflict, and expiry screens work by keyboard on every viewport', async ({ page, browser }, info) => {
  test.setTimeout(120000);
  const f = await borrowingFixture('borrow-keyboard');
  await openListing(page, f, f.bob.email);
  const form = page.getByRole('form', { name: 'Request this item' });
  await form.getByLabel('First day', { exact: true }).focus(); await page.keyboard.type('01152027');
  await page.keyboard.press('Tab'); await expect(form.getByLabel('Last day', { exact: true })).toBeFocused(); await page.keyboard.type('01172027');
  await expect(form).toContainText(`You are asking for ${weekend} (3 days, both included).`);
  await page.keyboard.press('Tab'); await expect(form.getByRole('button', { name: 'Send Borrow Request', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(form.getByRole('status')).toContainText('The owner has been notified.'); await noHorizontalScroll(page);
  await requestItem(f.carol, f.listing.id, '2027-01-17', '2027-01-18');
  const expiring = await withAcknowledgmentWindow('2 seconds', async () => approveBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02')));
  await page.waitForTimeout(Math.max(0, Date.parse(expiring.reservation!.acknowledgment_due_at) - Date.now()) + 500);
  expect((await admin.rpc('expire_item_approval', { p_exchange_id: expiring.exchange_id! })).error).toBeNull();
  const alice = await second(browser, info);
  try {
    await openListing(alice.page, f, f.alice.email);
    await expect(card(alice.page, f.bob.email).getByRole('region', { name: `Current standing of ${f.bob.email}`, exact: true })).toBeVisible();
    const approve = card(alice.page, f.bob.email).getByRole('button', { name: `Approve ${f.bob.email}`, exact: true });
    await approve.focus(); await alice.page.keyboard.press('Enter');
    await expect(card(alice.page, f.bob.email).getByRole('region', { name: 'Reservation', exact: true })).toContainText(`Next: ${f.bob.email} acknowledges the terms by`);
    const conflict = card(alice.page, f.carol.email, 'Sun, Jan 17, 2027 through Mon, Jan 18, 2027');
    await conflict.getByRole('button', { name: `Approve ${f.carol.email}`, exact: true }).focus(); await alice.page.keyboard.press('Enter');
    await expect(conflict.getByRole('alert')).toContainText('Reservation conflict'); await expect(conflict.getByRole('alert')).toContainText('These dates overlap a reservation that is already approved.');
    await expect(card(alice.page, f.carol.email, 'Mon, Feb 1, 2027 through Tue, Feb 2, 2027').getByRole('heading', { name: 'Approval expired', exact: true })).toBeVisible();
    await noHorizontalScroll(alice.page);
    await capture(alice.page, info, 10, { records: await borrowRecords(f.listing.id), viewport: info.project.name });
  } finally { await alice.context.close(); }
  await page.reload(); await expect(card(page, 'you').getByRole('region', { name: 'Reservation', exact: true })).toContainText('Next: acknowledge the return date'); await noHorizontalScroll(page);
});
