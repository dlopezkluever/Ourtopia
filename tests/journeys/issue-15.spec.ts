import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { actor, addActiveMember, admin, applyInvite, conversationFixture, createCommunity, issueInvite, password, sendMessage, startConversation } from '../../scripts/verify/backend';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function open(page: Page, email: string, id: string) {
  await signIn(page, email); await page.goto(`/messages/${id}`);
  await expect(page.getByRole('heading', { name: /^Conversation with / })).toBeVisible();
}

async function send(page: Page, email: string, body: string) {
  await page.getByLabel(`Message to ${email}`, { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('persisted and authorization receipt', { body: JSON.stringify({ lane, project: info.project.name, viewport: page.viewportSize(), utc: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }), contentType: 'application/json' });
}

test('lane 1 fixed trunk lacks messaging and head retains Community access with persisted private text', async ({ page, browser }, info) => {
  const base = '3f5f3fd0293421cc2688576acfc8d742e676dc4c';
  const root = `${process.env.EVIDENCE_DIR ?? '.pilot-evidence'}/trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) {
    const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 3;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const f = await conversationFixture('trunk');
  const trunk = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: page.viewportSize() ?? undefined });
  try {
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`).then(r => r.status, () => 0), { timeout: 30000 }).toBe(200);
    const baseline = await trunk.newPage(); await signIn(baseline, f.first.email);
    await expect(baseline.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(baseline.getByRole('link', { name: 'Messages', exact: true })).toHaveCount(0);
    await baseline.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally {
    await trunk.close();
    await new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once('exit', () => done()); server.kill(); } });
  }
  await open(page, f.first.email, f.conversation.id); await send(page, f.second.email, 'Head coordination is persisted.');
  await sendMessage(f.second, f.conversation.id, 'Both participants can reply.');
  await page.reload(); await expect(page.getByText('Both participants can reply.', { exact: true })).toBeVisible();
  expect((await f.second.client.from('messages').select('body').eq('conversation_id', f.conversation.id)).data).toHaveLength(2);
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { base, trunkMessaging: 'absent', durableMessages: 2, conversationId: f.conversation.id });
});

test('lane 2 two members start from inbox and exchange persisted text in isolated browser sessions', async ({ page, browser }, info) => {
  const f = await conversationFixture('two-way');
  const otherCommunity = (await createCommunity(f.owner.client, randomUUID(), 'Separate Community')).data;
  const second = await browser.newContext({ baseURL: process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`, viewport: page.viewportSize() ?? undefined });
  try {
    await signIn(page, f.first.email); await page.getByRole('link', { name: 'Messages', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    await page.getByLabel('Community', { exact: true }).selectOption(f.community.id);
    await page.getByLabel('Member', { exact: true }).selectOption(f.second.id);
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await send(page, f.second.email, 'Can we meet at six?');
    const counterpart = await second.newPage(); await signIn(counterpart, f.second.email); await counterpart.goto('/messages');
    await counterpart.getByRole('navigation', { name: 'Conversations' }).getByRole('link').click();
    await expect(counterpart.getByText('Can we meet at six?', { exact: true })).toBeVisible();
    await send(counterpart, f.first.email, 'Six works for me.');
    await page.reload(); await expect(page.getByText('Six works for me.', { exact: true })).toBeVisible();
    expect((await f.first.client.from('conversations').select('id').eq('community_id', otherCommunity.id)).data).toEqual([]);
    expect((await f.second.client.from('messages').select('body').eq('conversation_id', f.conversation.id).order('created_at')).data).toEqual([{ body: 'Can we meet at six?' }, { body: 'Six works for me.' }]);
    await capture(page, info, 2, { conversationId: f.conversation.id, separateCommunityId: otherCommunity.id, persistedMessages: 2 });
  } finally { await second.close(); }
});

test('lane 3 general Community conversation works without any Exchange link', async ({ page }, info) => {
  const f = await conversationFixture('general');
  expect(Object.keys(f.conversation).sort()).toEqual(['community_id', 'created_at', 'id', 'participant_high', 'participant_low', 'started_by']);
  await open(page, f.first.email, f.conversation.id); await send(page, f.second.email, 'Who can help with the garden this weekend?');
  await page.reload(); await expect(page.getByText('Who can help with the garden this weekend?', { exact: true })).toBeVisible();
  await capture(page, info, 3, { conversation: f.conversation, exchangeLink: 'not required' });
});

test('lane 4 a lost response retries the same send once and text cannot be edited or deleted', async ({ page }, info) => {
  const f = await conversationFixture('retry'); await open(page, f.first.email, f.conversation.id);
  await page.route('**/rest/v1/rpc/send_message', async route => { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); });
  await page.getByLabel(`Message to ${f.second.email}`, { exact: true }).fill('One message despite a lost response.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry sending', exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' }); await page.reload();
  await page.getByRole('button', { name: 'Retry sending', exact: true }).click();
  await expect(page.getByText('One message despite a lost response.', { exact: true })).toHaveCount(1);
  const persisted = await f.first.client.from('messages').select('id,body').eq('conversation_id', f.conversation.id);
  expect(persisted.data).toHaveLength(1);
  expect((await f.first.client.from('messages').update({ body: 'Changed' }).eq('conversation_id', f.conversation.id)).error?.code).toBe('42501');
  expect((await f.first.client.from('messages').delete().eq('conversation_id', f.conversation.id)).error?.code).toBe('42501');
  await page.reload(); await expect(page.getByText('One message despite a lost response.', { exact: true })).toBeVisible();
  await capture(page, info, 4, { persisted: persisted.data, rewritesDenied: '42501' });
});

test('lane 5 realtime hints contain identities and the browser performs a fresh authorized message read', async ({ page }, info) => {
  const f = await conversationFixture('hints'); let subscribed = false; const frames: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const value = frame.payload.toString();
    if (value.includes(`messages-${f.first.id}`) && value.includes('phx_reply') && value.includes('"status":"ok"')) subscribed = true;
    if (value.includes('"event":"postgres_changes"') && value.includes('notification_hints')) frames.push(value);
  }));
  await open(page, f.first.email, f.conversation.id); await expect.poll(() => subscribed).toBe(true);
  const read = page.waitForResponse(response => response.url().includes('/rest/v1/messages?') && response.status() === 200);
  await sendMessage(f.second, f.conversation.id, 'Private realtime read-through body.');
  await read; await expect(page.getByText('Private realtime read-through body.', { exact: true })).toBeVisible();
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(frames.every(value => !value.includes('Private realtime read-through body.') && !value.includes('"body":'))).toBe(true);
  await capture(page, info, 5, { hints: frames.length, bodyInFrames: false, authorizedRead: true });
});

test('lane 6 nonparticipant administrator unrelated member foreign member and outsider cannot browse private content', async ({ page }, info) => {
  const f = await conversationFixture('privacy'); await sendMessage(f.first, f.conversation.id, 'Participant secret');
  const unrelated = await addActiveMember(f.owner, f.community.id, 'unrelated'); const outsider = await actor();
  const foreign = await actor(); await createCommunity(foreign.client);
  for (const person of [f.owner, unrelated, foreign, outsider]) {
    expect((await person.client.from('messages').select('*').eq('conversation_id', f.conversation.id)).data).toEqual([]);
    expect((await person.client.rpc('conversation_inbox')).data).toEqual([]);
    await signIn(page, person.email); await page.goto(`/messages/${f.conversation.id}`);
    await expect(page.getByRole('heading', { name: 'Conversation unavailable.' })).toBeVisible();
    await expect(page.getByText('Participant secret', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
  }
  await capture(page, info, 6, { deniedActors: ['administrator', 'unrelated', 'foreign', 'outsider'], messageRows: 0 });
});

test('lane 7 forged participants and inactive or foreign membership cannot start or send', async ({ page }, info) => {
  const f = await conversationFixture('inactive'); const foreign = await actor(); await createCommunity(foreign.client);
  const pending = await actor(); await applyInvite(pending, (await issueInvite(f.owner, f.community.id, pending.email)).id);
  expect((await f.first.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_participant_id: foreign.id })).error?.code).toBe('42501');
  expect((await f.first.client.from('conversations').insert({ community_id: f.community.id, participant_low: f.owner.id, participant_high: f.second.id, started_by: f.first.id })).error?.code).toBe('42501');
  for (const who of [pending, foreign]) {
    expect((await who.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_participant_id: f.second.id })).error?.code).toBe('42501');
  }
  for (const status of ['rejected', 'suspended', 'removed']) {
    expect((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error).toBeNull();
    expect((await f.first.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_participant_id: f.second.id })).error?.code).toBe('42501');
    expect((await f.first.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'Denied' })).error?.code).toBe('42501');
  }
  await signIn(page, f.first.email); await page.goto(`/messages/${f.conversation.id}`);
  await expect(page.getByRole('heading', { name: 'Conversation unavailable.' })).toBeVisible();
  await capture(page, info, 7, { forgedParticipants: '42501', inactiveSend: '42501', foreignStart: '42501' });
});

test('lane 8 membership invalidation clears cached content and drafts before fresh reads complete', async ({ page }, info) => {
  const f = await conversationFixture('cache'); await sendMessage(f.second, f.conversation.id, 'Clear this cached private text.');
  let subscribed = false;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const value = frame.payload.toString();
    if (value.includes(`messages-${f.first.id}`) && value.includes('phx_reply') && value.includes('"status":"ok"')) subscribed = true;
  }));
  await open(page, f.first.email, f.conversation.id); await expect(page.getByText('Clear this cached private text.', { exact: true })).toBeVisible();
  await expect.poll(() => subscribed).toBe(true);
  await page.getByLabel(`Message to ${f.second.email}`, { exact: true }).fill('Private unsent draft');
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/rest/v1/messages?*', async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  try {
    expect((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error).toBeNull();
    await expect(page.getByText('Clear this cached private text.', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('message-draft-')).length)).toBe(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Conversation unavailable.' })).toBeVisible();
  expect((await f.first.client.from('messages').select('*').eq('conversation_id', f.conversation.id)).data).toEqual([]);
  expect((await f.first.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'Denied' })).error?.code).toBe('42501');
  await page.unrouteAll({ behavior: 'wait' });
  await capture(page, info, 8, { heldReadCacheRows: 0, drafts: 0, freshRows: 0, send: '42501' });
});

test('lane 9 privileged future Dispute selection grant permits existing counterparty text without adjacent browsing or sending', async ({ page }, info) => {
  const f = await conversationFixture('selection'); const third = await addActiveMember(f.owner, f.community.id, 'third');
  const adjacent = await startConversation(f.first, f.community.id, third.id); await sendMessage(third, adjacent.id, 'Adjacent conversation secret');
  await sendMessage(f.second, f.conversation.id, 'Existing counterparty evidence');
  expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error).toBeNull();
  const grant = await admin.from('message_selection_grants').insert({ conversation_id: f.conversation.id, user_id: f.first.id, dispute_id: randomUUID() }).select().single();
  expect(grant.error).toBeNull(); await sendMessage(f.second, f.conversation.id, 'Later text remains private');
  await open(page, f.first.email, f.conversation.id);
  await expect(page.getByText('Existing counterparty evidence', { exact: true })).toBeVisible();
  await expect(page.getByText('Later text remains private', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  expect((await f.first.client.from('messages').select('*').eq('conversation_id', adjacent.id)).data).toEqual([]);
  expect((await f.first.client.from('communities').select('*').eq('id', f.community.id)).data).toEqual([]);
  expect((await f.first.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'Denied' })).error?.code).toBe('42501');
  await capture(page, info, 9, { fixture: 'service-only grant seam; Exchange eligibility is activated by ticket 16', grantId: grant.data.id, adjacentRows: 0, sendDenied: '42501' });
  expect((await admin.from('message_selection_grants').update({ ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', grant.data.id)).error).toBeNull();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Conversation unavailable.' })).toBeVisible();
});

test('lane 10 keyboard inbox compose status and focus work at desktop and mobile widths', async ({ page }, info) => {
  const f = await conversationFixture('keyboard'); await signIn(page, f.first.email); await page.goto('/messages');
  await page.getByLabel('Member', { exact: true }).selectOption(f.second.id);
  await page.getByLabel('Member', { exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  const field = page.getByLabel(`Message to ${f.second.email}`, { exact: true }); await expect(field).toBeVisible();
  await field.focus(); await page.keyboard.type('Keyboard handoff confirmed.');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(field).toHaveValue('Keyboard handoff confirmed.');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByText('Keyboard handoff confirmed.', { exact: true })).toBeVisible(); await expect(field).toBeFocused();
  await expect(page.locator('#message-status')).toHaveText('Sent');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, info, 10, { keyboardStart: true, keyboardSend: true, focusReturned: true, horizontalOverflow: false });
});
