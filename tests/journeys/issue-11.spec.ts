import { test, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  actor, admin, borrowRecords, borrowingFixture, drillDetails, itemNeedFixture, listingImageBytes, needDetails, password, publishDrill, requestItem, respondToNeed, workflowEffects,
} from '../../scripts/verify/backend';

const base = '8be7fe60908341f41beea49bc0f7ccb718ae3c7e';
const appURL = process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`;
const none = { exchanges: 0, reservations: 0, reputationEvents: 0, qualifyingInteractions: 0, borrowRequests: 0 };
type Fixture = Awaited<ReturnType<typeof borrowingFixture>>;

async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
function device(info: TestInfo, extra: BrowserContextOptions = {}): BrowserContextOptions {
  const { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = info.project.use;
  return { baseURL: appURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor, ...extra };
}
async function second(browser: Browser, info: TestInfo, email: string) {
  const context = await browser.newContext(device(info));
  const page = await context.newPage(); await signIn(page, email);
  return { context, page };
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), backend: process.env.VITE_SUPABASE_URL, data }, null, 2), contentType: 'application/json' });
}
async function noHorizontalScroll(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }

const needsPage = (f: Fixture) => `/communities/${f.community.id}/needs`;
async function postNeedInBrowser(page: Page, f: Fixture, title = needDetails().title) {
  await page.goto(needsPage(f)); await expect(page.getByRole('heading', { name: 'Community requests', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ask for an item', exact: true }).click();
  await page.getByLabel('What do you need?', { exact: true }).fill(title);
  await page.getByLabel('Description', { exact: true }).fill(needDetails().description);
  await page.getByLabel('Category', { exact: true }).selectOption('tools');
  await page.getByLabel('First day needed', { exact: true }).fill('2027-01-15'); await page.getByLabel('Last day needed', { exact: true }).fill('2027-01-17');
  await page.getByLabel('Needed soon', { exact: true }).check();
  await page.getByLabel('Lowest value ($)', { exact: true }).fill('100'); await page.getByLabel('Highest value ($)', { exact: true }).fill('250');
  await page.getByRole('button', { name: 'Post item need', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
  const need = await admin.from('item_need_posts').select('id,status,urgency,starts_on,ends_on,value_min,value_max').eq('community_id', f.community.id).eq('title', title).single();
  expect(need.error).toBeNull();
  return need.data!;
}
async function openNeed(page: Page, f: Fixture, needId: string, title = needDetails().title) {
  await page.goto(`${needsPage(f)}/${needId}`); await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
}
async function offerInBrowser(page: Page, listingTitle: string, note = 'My drill is free that weekend.') {
  const form = page.getByRole('form', { name: 'Answer with a Listing' });
  await form.getByLabel('Your Listing').selectOption({ label: listingTitle });
  await form.getByLabel('Note to the author').fill(note);
  await form.getByRole('button', { name: 'Offer this Listing', exact: true }).click();
  await expect(page.getByRole('article', { name: `Response: ${listingTitle}`, exact: true })).toContainText('You offered your Listing');
}
async function borrowFromResponse(page: Page, listingTitle: string) {
  const form = page.getByRole('article', { name: `Response: ${listingTitle}`, exact: true }).getByRole('form', { name: `Borrow Request for ${listingTitle}` });
  await expect(form.getByLabel('First day', { exact: true })).toHaveValue('2027-01-15'); await expect(form.getByLabel('Last day', { exact: true })).toHaveValue('2027-01-17');
  await form.getByRole('button', { name: 'Send Borrow Request', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Borrow Request sent for Fri, Jan 15, 2027 through Sun, Jan 17, 2027.');
  return form;
}

test('lane 1 trunk has no item Need Posts; head answers with an existing Listing and the author sends a separate Borrow Request', async ({ page, browser }, info) => {
  test.setTimeout(180000);
  const f = await borrowingFixture('need-trunk'); const root = `.pilot-evidence/issue-11-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) { const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`])); }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext(device(info, { baseURL: `http://127.0.0.1:${port}` }));
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(result => result.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.bob.email);
    await trunk.goto(needsPage(f)); await expect(trunk.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(trunk.getByRole('heading', { name: 'Community requests', exact: true })).toHaveCount(0);
    await expect(trunk.getByRole('button', { name: 'Ask for an item', exact: true })).toHaveCount(0);
    await trunk.goto(`/communities/${f.community.id}/listings/${f.listing.id}`); await expect(trunk.getByRole('form', { name: 'Request this item' })).toBeVisible();
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await signIn(page, f.bob.email);
  const need = await postNeedInBrowser(page, f);
  const alice = await second(browser, info, f.alice.email);
  try { await openNeed(alice.page, f, need.id); await offerInBrowser(alice.page, drillDetails.title); } finally { await alice.context.close(); }
  await page.reload(); await borrowFromResponse(page, drillDetails.title);
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  const records = await borrowRecords(f.listing.id);
  expect(records.requests.map(row => [row.borrower_id, row.status, row.exchange_id])).toEqual([[f.bob.id, 'requested', null]]);
  expect(records.exchanges).toEqual([]);
  await capture(page, info, 1, { trunk: 'No Need Post route or form; Listing Borrow Request form unchanged', need, records });
});

test('lane 2 Bob posts an item need, Alice answers with her drill, and Bob sends a separate Borrow Request', async ({ page, browser }, info) => {
  const f = await borrowingFixture('need-primary');
  await signIn(page, f.bob.email);
  const need = await postNeedInBrowser(page, f);
  expect(need).toMatchObject({ status: 'open', urgency: 'soon', starts_on: '2027-01-15', ends_on: '2027-01-17', value_min: 100, value_max: 250 });
  await expect(page.getByRole('region', { name: 'Responses', exact: true })).toContainText('No Listings offered yet.');
  const alice = await second(browser, info, f.alice.email);
  try { await openNeed(alice.page, f, need.id); await offerInBrowser(alice.page, drillDetails.title); } finally { await alice.context.close(); }
  const response = page.getByRole('article', { name: `Response: ${drillDetails.title}`, exact: true });
  await expect(response).toContainText(`${f.alice.email} offered a Listing`);
  await borrowFromResponse(page, drillDetails.title);
  await page.reload(); await expect(response).toContainText('Your Borrow Request for Fri, Jan 15, 2027 through Sun, Jan 17, 2027: Waiting for the owner.');
  const records = await borrowRecords(f.listing.id);
  expect(records.requests.map(row => [row.borrower_id, row.status, row.starts_on, row.ends_on])).toEqual([[f.bob.id, 'requested', '2027-01-15', '2027-01-17']]);
  expect(records.exchanges).toEqual([]);
  const responses = await admin.from('item_need_responses').select('listing_id,responder_id,status').eq('need_id', need.id);
  expect(responses.data).toEqual([{ listing_id: f.listing.id, responder_id: f.alice.id, status: 'offered' }]);
  await capture(page, info, 2, { need, responses: responses.data, records });
});

test('lane 3 Carol shares a new Listing while answering and returns to the response', async ({ page }, info) => {
  const f = await itemNeedFixture('need-new-listing');
  await signIn(page, f.carol.email); await openNeed(page, f, f.need.id);
  const form = page.getByRole('form', { name: 'Answer with a Listing' });
  await expect(form).toContainText('You have no published Listings in this Community yet.');
  await form.getByRole('button', { name: 'Share a new item for this need', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill("Carol's impact drill");
  await page.getByLabel('Description', { exact: true }).fill('Impact drill with a fresh battery.');
  await page.getByLabel('Condition', { exact: true }).fill('Like new.');
  await page.getByLabel('Estimated replacement value ($)').fill('150');
  await page.getByLabel('Available from 1').fill('2027-01-12'); await page.getByLabel('Available through 1').fill('2027-01-25');
  await page.getByRole('button', { name: 'Save Listing', exact: true }).click();
  await expect(form.getByLabel('Your Listing')).toHaveValue(/[0-9a-f-]{36}/);
  await expect(form.getByLabel('Your Listing').locator('option:checked')).toHaveText("Carol's impact drill");
  await offerInBrowser(page, "Carol's impact drill", 'Brand new to the Community.');
  const listing = await admin.from('listings').select('id,community_id,owner_id,status').eq('title', "Carol's impact drill").single();
  const response = await admin.from('item_need_responses').select('listing_id,community_id,responder_id').eq('need_id', f.need.id).single();
  expect(listing.data).toMatchObject({ community_id: f.community.id, owner_id: f.carol.id, status: 'published' });
  expect(response.data).toEqual({ listing_id: listing.data!.id, community_id: f.community.id, responder_id: f.carol.id });
  await capture(page, info, 3, { listing: listing.data, response: response.data });
});

test('lane 4 Bob edits, searches, filters, and withdraws his item need', async ({ page }, info) => {
  const f = await itemNeedFixture('need-edit');
  await signIn(page, f.bob.email); await openNeed(page, f, f.need.id);
  await page.getByRole('button', { name: 'Edit item need', exact: true }).click();
  await page.getByLabel('What do you need?', { exact: true }).fill('Hammer drill for concrete');
  await page.getByLabel('Urgent', { exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hammer drill for concrete', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: 'Urgent' })).toBeVisible();
  await page.getByRole('link', { name: `Back to Community requests in ${f.community.name}`, exact: true }).click();
  const status = page.getByRole('status');
  await expect(status).toHaveText('1 open item need');
  await page.getByLabel('Search item needs').fill('concrete'); await expect(status).toHaveText('1 open item need');
  await page.getByLabel('Search item needs').fill('canoe'); await expect(status).toHaveText('0 open item needs');
  await page.getByLabel('Search item needs').fill('');
  await page.getByLabel('Filter urgency').selectOption('flexible'); await expect(status).toHaveText('0 open item needs');
  await page.getByLabel('Filter urgency').selectOption('urgent'); await expect(status).toHaveText('1 open item need');
  await page.getByLabel('Filter category').selectOption('kitchen'); await expect(status).toHaveText('0 open item needs');
  await page.getByLabel('Filter category').selectOption('tools');
  await page.getByLabel('Needed on').fill('2027-02-01'); await expect(status).toHaveText('0 open item needs');
  await page.getByLabel('Needed on').fill('2027-01-16'); await expect(status).toHaveText('1 open item need');
  await page.getByRole('link', { name: 'Hammer drill for concrete', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw item need', exact: true }).click();
  await expect(page.getByText('This Need Post was withdrawn. Its history is retained.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit item need', exact: true })).toHaveCount(0);
  const persisted = await admin.from('item_need_posts').select('title,urgency,status,version').eq('id', f.need.id).single();
  expect(persisted.data).toEqual({ title: 'Hammer drill for concrete', urgency: 'urgent', status: 'withdrawn', version: 3 });
  await page.goto(needsPage(f)); await expect(page.getByRole('status')).toHaveText('0 open item needs');
  await capture(page, info, 4, persisted.data);
});

test('lane 5 right after a response and before approval there is no Exchange, reservation, Reputation Event, or interaction', async ({ page }, info) => {
  const f = await itemNeedFixture('need-no-effects');
  await respondToNeed(f.alice, f.need.id, f.listing.id);
  await signIn(page, f.bob.email); await openNeed(page, f, f.need.id);
  await expect(page.getByRole('region', { name: 'Responses', exact: true })).toContainText('Responses alone reserve nothing.');
  await expect(page.getByRole('article', { name: `Response: ${drillDetails.title}`, exact: true })).toContainText(`${f.alice.email} offered a Listing`);
  const effects = await workflowEffects(f.community.id);
  expect(effects).toEqual(none);
  const standing = await f.alice.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.alice.id });
  expect(standing.data.local).toEqual({ score: 50, title: 'Unproven', completedInteractions: 0 });
  await page.goto('/borrowing'); await expect(page.getByText('You have not requested any items yet.')).toBeVisible();
  await capture(page, info, 5, { effects, aliceLocal: standing.data.local });
});

test('lane 6 replayed response and Borrow Request intents create one response and one request', async ({ page }, info) => {
  const f = await itemNeedFixture('need-replay');
  const intent = randomUUID();
  const first = await respondToNeed(f.alice, f.need.id, f.listing.id, 'Same note', intent);
  expect(await respondToNeed(f.alice, f.need.id, f.listing.id, 'Same note', intent)).toEqual(first);
  expect((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: intent, p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: 'Different' })).error?.code).toBe('23505');
  await signIn(page, f.bob.email); await openNeed(page, f, f.need.id);
  const form = await borrowFromResponse(page, drillDetails.title);
  await form.getByRole('button', { name: 'Send Borrow Request', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Borrow Request sent');
  const requests = await borrowRecords(f.listing.id);
  expect(requests.requests.map(row => row.status)).toEqual(['requested']);
  const responses = await admin.from('item_need_responses').select('id').eq('need_id', f.need.id);
  expect(responses.data).toEqual([{ id: first.id }]);
  expect(await workflowEffects(f.community.id)).toEqual({ ...none, borrowRequests: 1 });
  await capture(page, info, 6, { response: first, requests: requests.requests });
});

test('lane 7 guessed, foreign, and withdrawn Listings are rejected or hidden', async ({ page }, info) => {
  const f = await itemNeedFixture('need-foreign');
  const foreign = await actor({ label: 'need-foreign-owner' });
  const created = await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Elsewhere circle', p_description: '' });
  const foreignListing = await publishDrill(foreign, created.data.id, { ...drillDetails, title: 'Foreign drill' });
  const attempts = {
    guessed: (await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: randomUUID(), p_note: '' })).error?.code,
    foreign: (await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: foreignListing.id, p_note: '' })).error?.code,
    otherMember: (await f.carol.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: '' })).error?.code,
  };
  expect(attempts).toEqual({ guessed: '42501', foreign: '42501', otherMember: '42501' });
  await respondToNeed(f.alice, f.need.id, f.listing.id);
  expect((await f.alice.client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_expected_version: 1 })).error).toBeNull();
  const spare = await publishDrill(f.alice, f.community.id, { ...drillDetails, title: 'Withdrawn spare drill' });
  await f.alice.client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: spare.id, p_expected_version: 1 });
  const withdrawn = (await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: spare.id, p_note: '' })).error?.code;
  expect(withdrawn).toBe('55000');
  await signIn(page, f.bob.email); await openNeed(page, f, f.need.id);
  await expect(page.getByRole('region', { name: 'Responses', exact: true })).toContainText('No Listings offered yet.');
  await expect(page.getByRole('article', { name: `Response: ${drillDetails.title}`, exact: true })).toHaveCount(0);
  await expect(page.getByText('Foreign drill')).toHaveCount(0);
  await capture(page, info, 7, { ...attempts, withdrawn });
});

test('lane 8 another member cannot edit the post and private images stay private', async ({ page, browser }, info) => {
  const f = await itemNeedFixture('need-private');
  await signIn(page, f.bob.email); await openNeed(page, f, f.need.id);
  const image = page.getByRole('region', { name: 'Need Post image', exact: true });
  await image.getByLabel('Optional private image (JPEG, PNG, WebP, up to 5 MB)').setInputFiles({ name: 'drill.png', mimeType: 'image/png', buffer: listingImageBytes });
  await image.getByRole('button', { name: 'Upload or retry image', exact: true }).click();
  await expect(image.getByRole('img', { name: 'What the author needs' })).toBeVisible();
  const stored = await admin.from('item_need_images').select('object_path,state').eq('need_id', f.need.id).single();
  expect(stored.data?.state).toBe('ready');
  const objectPath = stored.data!.object_path;
  const outsider = await actor({ label: 'need-private-outsider' });
  const denied = {
    edit: (await f.carol.client.rpc('save_item_need', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_need_id: f.need.id, p_expected_version: 1, p_details: needDetails({ title: 'Carol took over' }) })).error?.code,
    withdraw: (await f.carol.client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 1 })).error?.code,
    directUpdate: (await f.carol.client.from('item_need_posts').update({ title: 'Carol took over' }).eq('id', f.need.id)).error?.code,
    outsiderRead: (await outsider.client.storage.from('item-need-images').download(objectPath)).error !== null,
    outsiderSignedUrl: (await outsider.client.storage.from('item-need-images').createSignedUrl(objectPath, 30)).error !== null,
    memberRemove: (await f.carol.client.rpc('remove_item_need_image', { p_intent_id: randomUUID(), p_image_id: objectPath.split('/')[2] })).error?.code,
  };
  expect(denied).toEqual({ edit: '42501', withdraw: '42501', directUpdate: '42501', outsiderRead: true, outsiderSignedUrl: true, memberRemove: '42501' });
  const carol = await second(browser, info, f.carol.email);
  try {
    await openNeed(carol.page, f, f.need.id);
    await expect(carol.page.getByRole('region', { name: 'Need Post image', exact: true }).getByRole('img', { name: 'What the author needs' })).toBeVisible();
    await expect(carol.page.getByRole('button', { name: 'Edit item need', exact: true })).toHaveCount(0);
    await expect(carol.page.getByRole('button', { name: 'Remove image', exact: true })).toHaveCount(0);
  } finally { await carol.context.close(); }
  const intruder = await second(browser, info, outsider.email);
  try {
    await intruder.page.goto(`${needsPage(f)}/${f.need.id}`);
    await expect(intruder.page.getByRole('heading', { name: 'Community requests unavailable.', exact: true })).toBeVisible();
    await expect(intruder.page.getByText(needDetails().title)).toHaveCount(0);
    await capture(intruder.page, info, 8, denied);
  } finally { await intruder.context.close(); }
  const persisted = await admin.from('item_need_posts').select('title,version').eq('id', f.need.id).single();
  expect(persisted.data).toEqual({ title: needDetails().title, version: 1 });
});

test('lane 9 approval runs through the normal owner path with eligibility, availability, and overlap checks', async ({ page, browser }, info) => {
  const f = await itemNeedFixture('need-approval');
  await respondToNeed(f.alice, f.need.id, f.listing.id);
  await requestItem(f.carol, f.listing.id, '2027-01-16', '2027-01-18');
  await signIn(page, f.bob.email); await openNeed(page, f, f.need.id);
  const form = page.getByRole('article', { name: `Response: ${drillDetails.title}`, exact: true }).getByRole('form', { name: `Borrow Request for ${drillDetails.title}` });
  await form.getByLabel('First day', { exact: true }).fill('2027-03-01'); await form.getByLabel('Last day', { exact: true }).fill('2027-03-02');
  await form.getByRole('button', { name: 'Send Borrow Request', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText("Choose dates inside one of this Listing's availability ranges.");
  await form.getByLabel('First day', { exact: true }).fill('2027-01-15'); await form.getByLabel('Last day', { exact: true }).fill('2027-01-17');
  await form.getByRole('button', { name: 'Send Borrow Request', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Borrow Request sent');
  const alice = await second(browser, info, f.alice.email);
  try {
    await alice.page.goto(`/communities/${f.community.id}/listings/${f.listing.id}`);
    const bob = alice.page.getByRole('article', { name: `Borrow Request from ${f.bob.email} for Fri, Jan 15, 2027 through Sun, Jan 17, 2027`, exact: true });
    await expect(bob).toContainText("Meets this Listing's minimum of 45.");
    await bob.getByRole('button', { name: `Approve ${f.bob.email}`, exact: true }).click();
    await expect(bob.getByRole('heading', { name: 'Dates reserved', exact: true })).toBeVisible();
    const carol = alice.page.getByRole('article', { name: `Borrow Request from ${f.carol.email} for Sat, Jan 16, 2027 through Mon, Jan 18, 2027`, exact: true });
    await carol.getByRole('button', { name: `Approve ${f.carol.email}`, exact: true }).click();
    await expect(carol.getByRole('alert')).toContainText('Reservation conflict');
    await capture(alice.page, info, 9, await borrowRecords(f.listing.id));
  } finally { await alice.context.close(); }
  const records = await borrowRecords(f.listing.id);
  expect(records.requests.map(row => [row.borrower_id === f.bob.id ? 'bob' : 'carol', row.status])).toEqual([['carol', 'requested'], ['bob', 'approved']]);
  expect(records.reservations.map(row => row.dates)).toEqual(['[2027-01-15,2027-01-18)']);
  await page.reload(); await expect(page.getByRole('article', { name: `Response: ${drillDetails.title}`, exact: true })).toContainText('Approved and reserved');
});

test('lane 10 create and answer a need by keyboard with accessible dates, urgency, optional fields, and navigation', async ({ page, browser }, info) => {
  const f = await borrowingFixture('need-keyboard');
  await signIn(page, f.bob.email); await page.goto(`/communities/${f.community.id}`);
  const feed = page.getByRole('region', { name: 'Community requests feed', exact: true });
  await expect(feed).toContainText('No open item needs right now.');
  await feed.getByRole('link', { name: 'See all Community requests', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Ask for an item', exact: true }).focus(); await page.keyboard.press('Enter');
  const title = page.getByLabel('What do you need?', { exact: true }); await title.focus(); await page.keyboard.type('Camping tent for two');
  await page.keyboard.press('Tab'); await page.keyboard.type('Two nights at the lake.');
  await page.getByLabel('Category', { exact: true }).focus(); await page.getByLabel('Category', { exact: true }).selectOption('outdoors');
  await page.getByLabel('First day needed', { exact: true }).fill('2027-01-15'); await page.getByLabel('Last day needed', { exact: true }).fill('2027-01-16');
  await page.getByLabel('Flexible', { exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Needed soon', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Lowest value ($)', { exact: true })).toHaveValue(''); await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Post item need', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Camping tent for two', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: 'No value range given' })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: 'Fri, Jan 15, 2027 through Sat, Jan 16, 2027 (2 days, both included)' })).toBeVisible();
  await noHorizontalScroll(page);
  const need = await admin.from('item_need_posts').select('id,urgency,value_min,value_max,category').eq('community_id', f.community.id).single();
  expect(need.data).toMatchObject({ urgency: 'soon', value_min: null, value_max: null, category: 'outdoors' });
  await page.goto(`/communities/${f.community.id}`); await expect(feed.getByRole('link', { name: 'Camping tent for two', exact: true })).toBeVisible();
  const tent = await publishDrill(f.alice, f.community.id, { ...drillDetails, title: 'Two-person tent', category: 'outdoors' });
  const alice = await second(browser, info, f.alice.email);
  try {
    await alice.page.goto(`/communities/${f.community.id}`);
    await alice.page.getByRole('region', { name: 'Community requests feed', exact: true }).getByRole('link', { name: 'Camping tent for two', exact: true }).focus(); await alice.page.keyboard.press('Enter');
    const form = alice.page.getByRole('form', { name: 'Answer with a Listing' });
    await form.getByLabel('Your Listing').focus(); await form.getByLabel('Your Listing').selectOption({ label: 'Two-person tent' });
    await form.getByRole('button', { name: 'Offer this Listing', exact: true }).focus(); await alice.page.keyboard.press('Enter');
    await expect(alice.page.getByRole('article', { name: 'Response: Two-person tent', exact: true })).toContainText('You offered your Listing');
    await noHorizontalScroll(alice.page);
  } finally { await alice.context.close(); }
  await page.goto(`${needsPage(f)}/${need.data!.id}`);
  const send = page.getByRole('form', { name: 'Borrow Request for Two-person tent' }).getByRole('button', { name: 'Send Borrow Request', exact: true });
  await send.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('form', { name: 'Borrow Request for Two-person tent' }).getByRole('status')).toContainText('Borrow Request sent for Fri, Jan 15, 2027 through Sat, Jan 16, 2027.');
  await noHorizontalScroll(page);
  const records = await borrowRecords(tent.id);
  expect(records.requests.map(row => [row.borrower_id, row.status])).toEqual([[f.bob.id, 'requested']]);
  await capture(page, info, 10, { need: need.data, records: records.requests });
});
