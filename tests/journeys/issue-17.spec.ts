import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { admin, applyInvite, completedItemFixture, createCommunity, decideApplication, evidenceMessages, issueInvite, messageEvidenceFixture, messageEvidenceView, password, reportIssue, sendMessage, startConversation, submitDisputeMessages } from '../../scripts/verify/backend';

const base = 'ecbb87b9c8da936ba4ada0a2491838374982da61';
const [, , relevant, unrelatedText] = evidenceMessages;
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
}
async function openCase(page: Page, email: string, exchangeId: string) {
  await signIn(page, email); await page.goto(`/disputes/${exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Exchange issues', exact: true })).toBeVisible();
}
const evidence = (page: Page) => page.getByRole('region', { name: 'Submitted messages' });
const snapshots = (page: Page) => evidence(page).getByRole('listitem', { name: 'Message snapshot' });
async function submit(page: Page, ...bodies: string[]) {
  for (const body of bodies) await evidence(page).getByRole('checkbox', { name: body }).check();
  await evidence(page).getByRole('button', { name: 'Submit selected messages', exact: true }).click();
  await expect(evidence(page).getByRole('status')).toBeVisible();
}
async function save(page: Page, info: TestInfo, lane: number, data: unknown, name = 'scenario') {
  const path = info.outputPath(`lane-${lane}/${name}.png`); mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true }); writeFileSync(info.outputPath(`lane-${lane}/${name}.json`), JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), project: info.project.name, data }, null, 2));
}
async function expectAdministratorSeesOnlySelection(page: Page, f: Awaited<ReturnType<typeof messageEvidenceFixture>>, selected: string) {
  await openCase(page, f.owner.email, f.exchangeId);
  await expect(snapshots(page)).toHaveCount(1); await expect(snapshots(page)).toContainText(selected);
  for (const body of evidenceMessages.filter(body => body !== selected)) await expect(page.locator('main')).not.toContainText(body);
  await expect(evidence(page).getByRole('checkbox')).toHaveCount(0);
  expect((await f.owner.client.from('messages').select('id').eq('conversation_id', f.conversation.id)).data).toEqual([]);
}

test('lane 1 trunk has no message selection; head copies one selected message the administrator can review', async ({ page, browser }, info) => {
  test.setTimeout(150000); const f = await messageEvidenceFixture('msg-trunk');
  const root = `.pilot-evidence/issue-17-trunk-${info.project.name}`;
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  expect(tree.some(path => path.startsWith('src/features/message-evidence/'))).toBe(false);
  for (const file of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
    const target = `${root}/${file}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`); const port = Number(process.env.APP_PORT ?? 5173) + 9;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ ...info.project.use, baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false), { timeout: 60000 }).toBe(true);
    const trunk = await context.newPage(); await openCase(trunk, f.bob.email, f.exchangeId);
    await expect(trunk.getByRole('article', { name: 'Structured case' })).toBeVisible();
    await expect(trunk.getByRole('region', { name: 'Submitted messages' })).toHaveCount(0); await expect(trunk.getByText(relevant)).toHaveCount(0);
    await save(trunk, info, 1, { base, addedFeatureAbsent: true }, 'trunk');
  } finally { await context.close(); server.kill(); await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); }); }
  await openCase(page, f.bob.email, f.exchangeId); await submit(page, relevant);
  await expect(snapshots(page)).toContainText(relevant); await signOut(page);
  await expectAdministratorSeesOnlySelection(page, f, relevant);
  await save(page, info, 1, await messageEvidenceView(f.owner, f.disputeId), 'head');
});

test('lane 2 participant submits one of several messages and the administrator sees only that snapshot', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-primary');
  await openCase(page, f.bob.email, f.exchangeId);
  for (const body of evidenceMessages) await expect(evidence(page).getByRole('checkbox', { name: body })).toBeVisible();
  await submit(page, relevant); await expect(evidence(page).getByRole('status')).toHaveText('1 selected message copied into the case.');
  await page.reload(); await expect(snapshots(page)).toHaveCount(1); await signOut(page);
  await expectAdministratorSeesOnlySelection(page, f, relevant);
  const rows = await admin.from('dispute_message_evidence').select('source_message_id,body,submitter_id').eq('dispute_id', f.disputeId);
  expect(rows.data).toEqual([{ source_message_id: f.messages[2].id, body: relevant, submitter_id: f.bob.id }]);
  await save(page, info, 2, { persisted: rows.data, administratorSourceRows: 0 });
});

test('lane 3 a general Community conversation never linked to the Exchange is a valid source', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-unlinked');
  const conversation = await admin.from('conversations').select('*').eq('id', f.conversation.id).single();
  expect(Object.keys(conversation.data!).sort()).toEqual(['community_id', 'created_at', 'id', 'participant_high', 'participant_low', 'started_by']);
  expect(conversation.data!.community_id).toBe(f.community.id);
  await openCase(page, f.alice.email, f.exchangeId); await submit(page, evidenceMessages[1]);
  await expect(snapshots(page)).toContainText(evidenceMessages[1]);
  const view = await messageEvidenceView(f.bob, f.disputeId);
  expect(view.snapshots.map(row => [row.source_message_id, row.submitter_id])).toEqual([[f.messages[1].id, f.alice.id]]);
  await save(page, info, 3, { conversationColumns: Object.keys(conversation.data!), exchangeLink: null, snapshot: view.snapshots[0] });
});

test('lane 4 foreign, guessed and mismatched-party sources are never offered or copied', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-foreign');
  const unrelated = await startConversation(f.bob, f.community.id, f.carol.id); const carolText = await sendMessage(f.carol, unrelated.id, 'Carol private logistics');
  const other = await createCommunity(f.alice.client, randomUUID(), 'msg-browser-foreign-other circle'); expect(other.error).toBeNull();
  const otherId = (other.data as { id: string }).id;
  expect((await decideApplication(f.alice, (await applyInvite(f.bob, (await issueInvite(f.alice, otherId, f.bob.email)).id)).id)).error).toBeNull();
  const foreignText = await sendMessage(f.alice, (await startConversation(f.bob, otherId, f.alice.id)).id, 'Other Community text');
  await openCase(page, f.bob.email, f.exchangeId);
  await expect(evidence(page).getByRole('checkbox')).toHaveCount(evidenceMessages.length);
  await expect(evidence(page)).not.toContainText(carolText.body); await expect(evidence(page)).not.toContainText(foreignText.body);
  const codes = { unrelated: (await submitDisputeMessages(f.bob, f.disputeId, [carolText.id])).error?.code, foreign: (await submitDisputeMessages(f.bob, f.disputeId, [foreignText.id])).error?.code, guessed: (await submitDisputeMessages(f.bob, f.disputeId, [randomUUID()])).error?.code };
  expect(codes).toEqual({ unrelated: '42501', foreign: '42501', guessed: '42501' });
  expect((await admin.from('dispute_message_evidence').select('id').eq('dispute_id', f.disputeId)).data).toEqual([]);
  await save(page, info, 4, { codes, copiedRows: 0 });
});

test('lane 5 replaying the same selection returns the original snapshot once', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-replay');
  await openCase(page, f.bob.email, f.exchangeId); await submit(page, relevant);
  await expect(snapshots(page)).toHaveCount(1);
  const original = (await admin.from('dispute_message_evidence').select('id,submitted_at').eq('dispute_id', f.disputeId).single()).data!;
  await submit(page, relevant); await expect(evidence(page).getByRole('status')).toHaveText('Already submitted. The existing snapshot was kept.');
  await page.reload(); await expect(snapshots(page)).toHaveCount(1);
  const replay = await submitDisputeMessages(f.bob, f.disputeId, [f.messages[2].id]);
  expect((replay.data as { snapshots: { id: string }[] }).snapshots.map(row => row.id)).toEqual([original.id]);
  expect((await admin.from('dispute_message_evidence').select('id,submitted_at').eq('dispute_id', f.disputeId)).data).toEqual([original]);
  await save(page, info, 5, { original, replayIds: [original.id], rows: 1 });
});

test('lane 6 a nonparticipant administrator reads the snapshot but not its source conversation', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-admin');
  expect((await submitDisputeMessages(f.bob, f.disputeId, [f.messages[2].id])).error).toBeNull();
  await signIn(page, f.owner.email); await page.goto(`/messages/${f.conversation.id}`);
  await expect(page.getByRole('heading', { name: 'Conversation unavailable.' })).toBeVisible();
  for (const body of evidenceMessages) await expect(page.getByText(body)).toHaveCount(0);
  await page.goto(`/disputes/${f.exchangeId}`); await expect(snapshots(page)).toContainText(relevant);
  const direct = { snapshot: (await f.owner.client.from('dispute_message_evidence').select('body').eq('dispute_id', f.disputeId)).data, source: (await f.owner.client.from('messages').select('id').eq('id', f.messages[2].id)).data, conversation: (await f.owner.client.from('conversations').select('id').eq('id', f.conversation.id)).data };
  expect(direct).toEqual({ snapshot: [{ body: relevant }], source: [], conversation: [] });
  await save(page, info, 6, direct);
});

test('lane 7 a removed participant inside the window selects existing text and cannot send', async ({ page }, info) => {
  const f = await completedItemFixture('msg-browser-removed', 29);
  const conversation = await startConversation(f.alice, f.community.id, f.bob.id);
  const existing = await sendMessage(f.alice, conversation.id, 'The drill came back with a cracked case.');
  expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error).toBeNull();
  expect((await reportIssue(f.bob, f.exchangeId, 'It was cracked before I borrowed it.')).error).toBeNull();
  await openCase(page, f.bob.email, f.exchangeId); await submit(page, existing.body);
  await expect(snapshots(page)).toContainText(existing.body);
  await page.goto(`/messages/${conversation.id}`); await expect(page.getByText(existing.body, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  const send = (await f.bob.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: conversation.id, p_body: 'New text' })).error?.code;
  expect(send).toBe('42501');
  await save(page, info, 7, { existingReadable: true, send, snapshots: (await admin.from('dispute_message_evidence').select('body').eq('submitter_id', f.bob.id)).data });
});

test('lane 8 after the obligation window closes reads and submissions fail while administrators keep the snapshot', async ({ page }, info) => {
  const f = await completedItemFixture('msg-browser-expired', 31);
  const conversation = await startConversation(f.alice, f.community.id, f.bob.id);
  const message = await sendMessage(f.alice, conversation.id, 'I will split the repair cost.'); const other = await sendMessage(f.alice, conversation.id, 'Unselected remark.');
  const dispute = await admin.from('disputes').insert({ exchange_id: f.exchangeId, community_id: f.community.id, reporter_id: f.alice.id, respondent_id: f.bob.id, issue_type: 'damage', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }).select('id').single();
  expect(dispute.error).toBeNull();
  expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error).toBeNull();
  expect((await submitDisputeMessages(f.bob, dispute.data!.id, [message.id])).error).toBeNull();
  expect((await admin.from('disputes').update({ status: 'unresolved', closed_at: new Date().toISOString() }).eq('id', dispute.data!.id)).error).toBeNull();
  await openCase(page, f.owner.email, f.exchangeId); await expect(snapshots(page)).toContainText(message.body); await expect(page.locator('main')).not.toContainText(other.body);
  await signOut(page); await signIn(page, f.bob.email); await page.goto(`/disputes/${f.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Case unavailable' })).toBeVisible();
  const denied = { messages: (await f.bob.client.from('messages').select('id').eq('conversation_id', conversation.id)).data, snapshots: (await f.bob.client.from('dispute_message_evidence').select('id')).data, submit: (await submitDisputeMessages(f.bob, dispute.data!.id, [other.id])).error?.code };
  expect(denied).toEqual({ messages: [], snapshots: [], submit: '42501' });
  expect((await admin.from('dispute_message_evidence').select('body').eq('dispute_id', dispute.data!.id)).data).toEqual([{ body: message.body }]);
  await save(page, info, 8, { denied, preserved: 1 });
});

test('lane 9 the snapshot shows the exact source author, ID, timestamps, submitter and body', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-fields');
  await openCase(page, f.bob.email, f.exchangeId); await submit(page, relevant);
  const row = (await admin.from('dispute_message_evidence').select('*').eq('dispute_id', f.disputeId).single()).data!;
  const source = (await admin.from('messages').select('*').eq('id', f.messages[2].id).single()).data!;
  expect({ id: row.source_message_id, author: row.source_author_id, at: Date.parse(row.source_created_at), body: row.body }).toEqual({ id: source.id, author: source.author_id, at: Date.parse(source.created_at), body: source.body });
  expect(row.submitter_id).toBe(f.bob.id);
  const card = snapshots(page);
  await expect(card.locator('blockquote')).toHaveText(source.body);
  await expect(card).toContainText(`Source message${source.id}`);
  await expect(card.locator('dt', { hasText: 'Author' }).locator('xpath=following-sibling::dd[1]')).toHaveText('Respondent');
  await expect(card.locator('dt', { hasText: 'Submitted by' }).locator('xpath=following-sibling::dd[1]')).toHaveText('You');
  await expect(card.locator(`time[datetime="${row.source_created_at}"]`)).toHaveCount(1);
  await expect(card.locator(`time[datetime="${row.submitted_at}"]`)).toHaveCount(1);
  await save(page, info, 9, { snapshot: row, source: { id: source.id, author_id: source.author_id, created_at: source.created_at } });
});

test('lane 10 keyboard selection and submission keep selected-only disclosure clear at each width', async ({ page }, info) => {
  const f = await messageEvidenceFixture('msg-browser-keyboard');
  await openCase(page, f.bob.email, f.exchangeId);
  await expect(evidence(page).getByText('Only messages a participant selects are copied into this case.', { exact: false })).toBeVisible();
  const box = evidence(page).getByRole('checkbox', { name: relevant }); await box.focus(); await expect(box).toBeFocused();
  await page.keyboard.press('Space'); await expect(box).toBeChecked();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await expect(evidence(page).getByRole('button', { name: 'Submit selected messages' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(snapshots(page)).toContainText(relevant);
  await expect(evidence(page).getByRole('status')).toHaveText('1 selected message copied into the case.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(snapshots(page)).not.toContainText(unrelatedText);
  await save(page, info, 10, { keyboard: 'focus checkbox, Space, Tab, Enter', noHorizontalOverflow: true, snapshots: (await messageEvidenceView(f.alice, f.disputeId)).snapshots.length });
});
