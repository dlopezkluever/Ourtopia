import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { acceptHelp, actor, admin, commitHelp, createCommunity, createHelpPost, helpFixture, helpListingFields, helpNeedFields, helpScheduleFields, password } from '../../scripts/verify/backend';

const appURL = process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`;

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openPost(page: Page, email: string, path: string, title: string) {
  await signIn(page, email); await page.goto(path);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

async function newPage(browser: Browser, page: Page) {
  const context = await browser.newContext({ baseURL: appURL, viewport: page.viewportSize() ?? undefined });
  return { context, page: await context.newPage() };
}

const localFuture = (days: number, hour = 10) => {
  const date = new Date(Date.now() + days * 86400000); date.setHours(hour, 30, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const postPath = (communityId: string, kind: 'listing' | 'need_post', id: string) => `/help/${communityId}/${kind === 'listing' ? 'listing' : 'need'}/${id}`;

async function publishListing(page: Page, title: string) {
  await page.getByRole('button', { name: 'Offer help', exact: true }).click();
  const form = page.getByRole('form', { name: 'Offer help' });
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.getByLabel('Category', { exact: true }).selectOption('repairs');
  await form.getByLabel('Skill', { exact: true }).fill('Bike repair');
  await form.getByLabel('Skill level', { exact: true }).selectOption('experienced');
  await form.getByLabel('Availability', { exact: true }).fill('Weekday evenings');
  await form.getByLabel('Area you can help in', { exact: true }).fill('North side of the park');
  await form.getByRole('button', { name: 'Publish help offer', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return /\/listing\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
}

async function publishNeed(page: Page, title: string, helpers: number) {
  await page.getByRole('button', { name: 'Ask for help', exact: true }).click();
  const form = page.getByRole('form', { name: 'Ask for help' });
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.getByLabel('Category', { exact: true }).selectOption('moving');
  await form.getByLabel('Date and time', { exact: true }).fill(localFuture(4));
  await form.getByLabel('Duration (minutes)', { exact: true }).fill('120');
  await form.getByLabel('Location', { exact: true }).fill('14 Elm Court');
  await form.getByLabel('Helpers needed', { exact: true }).fill(String(helpers));
  await form.getByRole('button', { name: 'Publish Need Post', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return /\/need\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
}

const exchangeRegion = (page: Page, counterpart: string) => page.getByRole('region', { name: `Help Exchange with ${counterpart}` });
const sourceExchanges = async (sourceId: string) => (await admin.from('exchanges').select('id,kind,provider_id,receiver_id,state,community_id').eq('source_id', sourceId).order('created_at')).data ?? [];
const activeSlots = async (needId: string) => (await admin.from('help_slots').select('place,helper_id').eq('need_post_id', needId).eq('status', 'active').order('place')).data ?? [];

async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('persisted and authorization receipt', { body: JSON.stringify({ lane, project: info.project.name, viewport: page.viewportSize(), utc: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }), contentType: 'application/json' });
}

async function listingJourney(page: Page, browser: Browser, f: Awaited<ReturnType<typeof helpFixture>>, title: string) {
  const [requester] = f.members;
  await signIn(page, f.author.email); await page.getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Help board', exact: true })).toBeVisible();
  const listingId = await publishListing(page, title);
  const other = await newPage(browser, page);
  try {
    await signIn(other.page, requester.email); await other.page.goto(`/help/${f.community.id}`);
    await other.page.getByRole('link', { name: title, exact: true }).click();
    await other.page.getByLabel(`Note for ${f.author.email}`).fill('Could you look at my brakes?');
    await other.page.getByRole('button', { name: 'Request this help', exact: true }).click();
    await expect(other.page.getByText(`Your offer is waiting for ${f.author.email} to accept.`)).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: `Accept ${requester.email}`, exact: true }).click();
    const region = exchangeRegion(page, requester.email);
    await expect(region.getByText('Committed', { exact: true })).toBeVisible();
    await expect(region.getByText(`You help ${requester.email}`)).toBeVisible();
    await other.page.reload();
    await expect(exchangeRegion(other.page, f.author.email).getByText(`${f.author.email} helps you`)).toBeVisible();
  } finally { await other.context.close(); }
  const rows = await sourceExchanges(listingId);
  expect(rows.map(({ kind, provider_id, receiver_id, state, community_id }) => ({ kind, provider_id, receiver_id, state, community_id })))
    .toEqual([{ kind: 'help', provider_id: f.author.id, receiver_id: requester.id, state: 'committed', community_id: f.community.id }]);
  return { listingId, exchangeId: rows[0].id, requesterId: requester.id };
}

test('lane 1 fixed trunk lacks help and head commits one shared help Exchange with correct roles', async ({ page, browser }, info) => {
  const base = 'e246904e579ef4231dd90e62be01f5c6f9abfd65';
  const root = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/trunk-12-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) {
    const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 3;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const f = await helpFixture('trunk', 1);
  const trunk = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: page.viewportSize() ?? undefined });
  try {
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`).then(r => r.status, () => 0), { timeout: 30000 }).toBe(200);
    const baseline = await trunk.newPage(); await signIn(baseline, f.author.email);
    await expect(baseline.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(baseline.getByRole('link', { name: 'Help', exact: true })).toHaveCount(0);
    await baseline.goto(`/help/${f.community.id}`);
    await expect(baseline.getByRole('heading', { name: 'Help board' })).toHaveCount(0);
    await baseline.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally {
    await trunk.close();
    await new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } });
  }
  const result = await listingJourney(page, browser, f, 'Bike tune-ups');
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { base, trunkHelp: 'absent', ...result });
});

test('lane 2 publish a Help Listing, commit as requester, and accept as owner/helper', async ({ page, browser }, info) => {
  const f = await helpFixture('listing', 1);
  const result = await listingJourney(page, browser, f, 'Bike repair evenings');
  expect((await admin.from('help_exchange_details').select('commitment_id,slot_id').eq('exchange_id', result.exchangeId)).data).toHaveLength(1);
  await capture(page, info, 2, { ...result, roles: { helper: f.author.id, requester: result.requesterId } });
});

test('lane 3 a two-helper Need Post accepts one helper and keeps the second place available', async ({ page }, info) => {
  const f = await helpFixture('two-place', 1);
  const [helper] = f.members;
  await signIn(page, f.author.email); await page.goto(`/help/${f.community.id}`);
  const needId = await publishNeed(page, 'Move a piano', 2);
  await expect(page.getByText('2 of 2 places open', { exact: true })).toBeVisible();
  await commitHelp(helper, 'need_post', needId, 'Strong back here.');
  await page.reload();
  await page.getByRole('button', { name: `Accept ${helper.email}`, exact: true }).click();
  await expect(page.getByText('1 of 2 places open', { exact: true })).toBeVisible();
  const places = page.getByRole('list', { name: 'Helper places' });
  await expect(places.getByText(`Place 1 · ${helper.email} · Committed`)).toBeVisible();
  await expect(places.getByText('Place 2 · Open')).toBeVisible();
  const board = await helper.client.rpc('help_board', { p_community_id: f.community.id, p_search: '', p_post_kind: 'need_post', p_category: '' });
  expect((board.data as { openPlaces: number }[])[0].openPlaces).toBe(1);
  expect((await sourceExchanges(needId)).map(row => row.provider_id)).toEqual([helper.id]);
  await capture(page, info, 3, { needId, exchanges: 1, openPlaces: 1, slots: await activeSlots(needId) });
});

test('lane 4 schedule then cancel one helper with a reason reopens only that place without points', async ({ page }, info) => {
  const f = await helpFixture('cancel', 2);
  const [first, second] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2, { title: 'Clear the gutters' }));
  await acceptHelp(f.author, await commitHelp(first, 'need_post', need.id));
  const kept = await acceptHelp(f.author, await commitHelp(second, 'need_post', need.id));
  await openPost(page, first.email, postPath(f.community.id, 'need_post', need.id), 'Clear the gutters');
  const region = exchangeRegion(page, f.author.email);
  await region.getByLabel('Start time', { exact: true }).fill(localFuture(3, 9));
  await region.getByLabel('Duration (minutes)', { exact: true }).fill('90');
  await region.getByLabel('Meeting point', { exact: true }).fill('Back porch');
  await region.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(region.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(region.getByText(/Back porch/)).toBeVisible();
  await region.getByLabel('Reason for cancelling', { exact: true }).fill('My ladder broke.');
  await region.getByRole('button', { name: 'Cancel help', exact: true }).click();
  await expect(region.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(region.getByText('You cancelled: My ladder broke.')).toBeVisible();
  await expect(page.getByText('1 of 2 places open', { exact: true })).toBeVisible();
  const points = {
    events: (await admin.from('reputation_events').select('id').in('recipient_id', [f.author.id, first.id, second.id])).data?.length,
    interactions: (await admin.from('qualifying_interactions').select('id').in('participant_id', [f.author.id, first.id, second.id])).data?.length,
  };
  expect(points).toEqual({ events: 0, interactions: 0 });
  expect((await admin.from('exchanges').select('state').eq('id', kept.id)).data).toEqual([{ state: 'committed' }]);
  expect(await activeSlots(need.id)).toEqual([{ place: 2, helper_id: second.id }]);
  await capture(page, info, 4, { needId: need.id, points, keptHelper: 'committed', activeSlots: 1 });
});

test('lane 5 racing two acceptances for the last place keeps the slot cap and one active helper', async ({ page, browser }, info) => {
  const f = await helpFixture('race', 2);
  const [first, second] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1, { title: 'One more pair of hands' }));
  await commitHelp(first, 'need_post', need.id); await commitHelp(second, 'need_post', need.id);
  const path = postPath(f.community.id, 'need_post', need.id);
  await openPost(page, f.author.email, path, 'One more pair of hands');
  const other = await newPage(browser, page);
  try {
    await openPost(other.page, f.author.email, path, 'One more pair of hands');
    await Promise.all([
      page.getByRole('button', { name: `Accept ${first.email}`, exact: true }).click(),
      other.page.getByRole('button', { name: `Accept ${second.email}`, exact: true }).click(),
    ]);
    await expect(page.getByText('0 of 1 places open', { exact: true }).or(page.getByRole('alert'))).toBeVisible();
    await expect(other.page.getByText('0 of 1 places open', { exact: true }).or(other.page.getByRole('alert'))).toBeVisible();
    const alerts = [...await page.getByRole('alert').allTextContents(), ...await other.page.getByRole('alert').allTextContents()];
    expect(alerts).toEqual(['Every place on this Need Post is filled.']);
  } finally { await other.context.close(); }
  const slots = await activeSlots(need.id);
  expect(slots).toHaveLength(1);
  expect((await sourceExchanges(need.id))).toHaveLength(1);
  await page.reload(); await expect(page.getByText('0 of 1 places open', { exact: true })).toBeVisible();
  await capture(page, info, 5, { needId: need.id, activeSlots: slots, exchanges: 1, loser: '55000' });
});

test('lane 6 a lost acceptance response retries once and a cancelled place is reused with history kept', async ({ page }, info) => {
  const f = await helpFixture('retry', 1);
  const [helper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2, { title: 'Paint the fence' }));
  await commitHelp(helper, 'need_post', need.id);
  const path = postPath(f.community.id, 'need_post', need.id);
  await openPost(page, f.author.email, path, 'Paint the fence');
  await page.route('**/rest/v1/rpc/accept_help_commitment', async route => { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
  await page.getByRole('button', { name: `Accept ${helper.email}`, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('connection dropped');
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: `Accept ${helper.email}`, exact: true }).click();
  await expect(exchangeRegion(page, helper.email).getByText('Committed', { exact: true })).toBeVisible();
  const first = await sourceExchanges(need.id);
  expect(first).toHaveLength(1);
  expect((await helper.client.rpc('cancel_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: first[0].id, p_reason: 'Rain delay' })).error).toBeNull();
  await commitHelp(helper, 'need_post', need.id, 'Back on.');
  await page.reload();
  await page.getByRole('button', { name: `Accept ${helper.email}`, exact: true }).click();
  await expect(page.getByRole('list', { name: 'Helper places' }).getByText(`Place 1 · ${helper.email} · Committed`)).toBeVisible();
  const history = await sourceExchanges(need.id);
  expect(history.map(row => row.state)).toEqual(['cancelled', 'committed']);
  expect(await activeSlots(need.id)).toEqual([{ place: 1, helper_id: helper.id }]);
  await expect(page.getByText('Rain delay', { exact: false })).toBeVisible();
  await capture(page, info, 6, { needId: need.id, history: history.map(row => row.state), activeSlots: 1, lostResponseReplays: true });
});

test('lane 7 a Help Listing accepts several requesters without a Need Post slot cap', async ({ page }, info) => {
  const f = await helpFixture('several', 3);
  const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields({ title: 'Resume reviews' }));
  for (const member of f.members) await commitHelp(member, 'listing', listing.id);
  await openPost(page, f.author.email, postPath(f.community.id, 'listing', listing.id), 'Resume reviews');
  for (const member of f.members) {
    await page.getByRole('button', { name: `Accept ${member.email}`, exact: true }).click();
    await expect(exchangeRegion(page, member.email).getByText('Committed', { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/places open/)).toHaveCount(0);
  const rows = await sourceExchanges(listing.id);
  expect(rows.map(row => [row.provider_id, row.receiver_id, row.state])).toEqual(f.members.map(member => [f.author.id, member.id, 'committed']));
  expect((await admin.from('help_slots').select('id').in('exchange_id', rows.map(row => row.id))).data).toEqual([]);
  await capture(page, info, 7, { listingId: listing.id, requesters: rows.length, slots: 0 });
});

test('lane 8 item condition, replacement value, Handoff, and Return fields are rejected for help', async ({ page }, info) => {
  const f = await helpFixture('kind', 1);
  const [member] = f.members;
  const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields({ title: 'Garden planning' }));
  const exchange = await acceptHelp(f.author, await commitHelp(member, 'listing', listing.id));
  await signIn(page, member.email); await page.goto(`/help/${f.community.id}`);
  await page.getByRole('button', { name: 'Ask for help', exact: true }).click();
  const form = page.getByRole('form', { name: 'Ask for help' });
  await expect(form.getByText('Help needs no item condition, replacement value, or photos.')).toBeVisible();
  await expect(form.getByLabel(/condition|replacement|photo|handoff|return/i)).toHaveCount(0);
  const codes = {
    replacementValue: (await member.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'need_post', p_fields: helpNeedFields(1, { replacement_value: 250 }) })).error?.code,
    condition: (await member.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'listing', p_fields: helpListingFields({ condition: 'Good' }) })).error?.code,
    handoff: (await member.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields({ handoff_at: new Date().toISOString() }) })).error?.code,
    returnAt: (await member.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields({ return_at: new Date().toISOString() }) })).error?.code,
    itemState: (await admin.from('exchanges').update({ state: 'return_pending' }).eq('id', exchange.id)).error?.code,
    itemEvent: (await admin.from('exchange_events').insert({ exchange_id: exchange.id, community_id: f.community.id, kind: 'return_recorded' })).error?.code,
  };
  expect(codes).toEqual({ replacementValue: '22023', condition: '22023', handoff: '22023', returnAt: '22023', itemState: '23514', itemEvent: '23514' });
  await page.goto(postPath(f.community.id, 'listing', listing.id));
  await expect(exchangeRegion(page, f.author.email).getByText('Committed', { exact: true })).toBeVisible();
  await capture(page, info, 8, { exchangeId: exchange.id, codes });
});

test('lane 9 another helper\'s logistics and foreign commitments are refused to unauthorized actors', async ({ page }, info) => {
  const f = await helpFixture('logistics', 2);
  const [helper, unrelated] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2, { title: 'Assemble shelves' }));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  expect((await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields({ meeting_point: 'Door code 9921' }) })).error).toBeNull();
  const foreign = await actor({ label: 'foreign' }); await createCommunity(foreign.client);
  const path = postPath(f.community.id, 'need_post', need.id);
  await openPost(page, unrelated.email, path, 'Assemble shelves');
  await expect(page.getByText('1 of 2 places open', { exact: true })).toBeVisible();
  await expect(page.getByText(/Door code 9921/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: /^Help Exchange with/ })).toHaveCount(0);
  const denied = {
    unrelatedDetails: (await unrelated.client.from('help_exchange_details').select('meeting_point').eq('exchange_id', exchange.id)).data?.length,
    unrelatedCancel: (await unrelated.client.rpc('cancel_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_reason: 'Not mine' })).error?.code,
    foreignCommit: (await foreign.client.rpc('commit_help', { p_intent_id: randomUUID(), p_post_kind: 'need_post', p_post_id: need.id, p_note: '' })).error?.code,
    foreignRead: (await foreign.client.from('help_need_posts').select('id').eq('id', need.id)).data?.length,
  };
  expect(denied).toEqual({ unrelatedDetails: 0, unrelatedCancel: '42501', foreignCommit: '42501', foreignRead: 0 });
  await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
  await signIn(page, foreign.email); await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Help post unavailable.' })).toBeVisible();
  await page.goto(`/help/${f.community.id}`);
  await expect(page.getByRole('heading', { name: 'Help board unavailable.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
  await openPost(page, helper.email, path, 'Assemble shelves');
  await expect(exchangeRegion(page, f.author.email).getByText(/Door code 9921/)).toBeVisible();
  expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', helper.id)).error).toBeNull();
  await expect(page.getByRole('note').filter({ hasText: 'Your Community access ended.' })).toBeVisible();
  await expect(exchangeRegion(page, f.author.email).getByText(/Door code 9921/)).toBeVisible();
  await expect(exchangeRegion(page, f.author.email).getByRole('button', { name: /^(Save|Update) schedule$/ })).toHaveCount(0);
  await expect(page.getByRole('search')).toHaveCount(0);
  await exchangeRegion(page, f.author.email).getByLabel('Reason for cancelling', { exact: true }).fill('Resolve my prior obligation');
  await exchangeRegion(page, f.author.email).getByRole('button', { name: 'Cancel help', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Help post unavailable.' })).toBeVisible();
  await expect(page.getByText(/Door code 9921/)).toHaveCount(0);
  await capture(page, info, 9, { needId: need.id, denied, participantSeesOwnLogistics: true, removedParticipant: 'own open obligation only; cancellation ends access' });
});

test('lane 10 create, accept, and schedule help by keyboard with accessible status and places', async ({ page }, info) => {
  const f = await helpFixture('keyboard', 1);
  const [helper] = f.members;
  await signIn(page, f.author.email); await page.goto(`/help/${f.community.id}`);
  const ask = page.getByRole('button', { name: 'Ask for help', exact: true });
  await ask.focus(); await page.keyboard.press('Enter');
  const form = page.getByRole('form', { name: 'Ask for help' });
  const title = form.getByLabel('Title', { exact: true });
  await title.focus(); await page.keyboard.type('Carry boxes downstairs');
  await page.keyboard.press('Tab'); await page.keyboard.type('Ten boxes.');
  await form.getByLabel('Date and time', { exact: true }).fill(localFuture(5));
  await form.getByLabel('Location', { exact: true }).focus(); await page.keyboard.type('Unit 4B');
  await page.keyboard.press('Tab'); await page.keyboard.press('Control+A'); await page.keyboard.type('2');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(form.getByLabel('Location', { exact: true })).toHaveValue('Unit 4B');
  await form.getByRole('button', { name: 'Publish Need Post', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Carry boxes downstairs', exact: true })).toBeVisible();
  const needId = /\/need\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  await commitHelp(helper, 'need_post', needId);
  await page.reload();
  const accept = page.getByRole('button', { name: `Accept ${helper.email}`, exact: true });
  await accept.focus(); await expect(accept).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Remaining places' })).toHaveText('1 of 2 places open');
  const region = exchangeRegion(page, helper.email);
  await region.getByLabel('Start time', { exact: true }).fill(localFuture(5, 14));
  await region.getByLabel('Meeting point', { exact: true }).focus(); await page.keyboard.type('Lobby');
  await page.keyboard.press('Tab');
  await expect(region.getByRole('button', { name: 'Save schedule', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(region.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Helper places' }).getByText(`Place 1 · ${helper.email} · Scheduled`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await sourceExchanges(needId)).map(row => row.state)).toEqual(['scheduled']);
  await capture(page, info, 10, { needId, keyboardCreate: true, keyboardAccept: true, keyboardSchedule: true, horizontalOverflow: false });
});
