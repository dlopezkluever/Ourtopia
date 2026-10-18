import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { activeMember, actor, admin, advanceHandoff, agreedRemedyWithBothSidesAgreed, caseAction, completedItemFixture, createCommunity, decideBorrow, decisionView, disputeFixture, handoffFixture, helpDisputeFixture, password, recordReturn, reportIssue, requestItem, reviewedDispute, sendMessage, startConversation } from '../../scripts/verify/backend';

test.describe.configure({ timeout: 150000 });
const base = 'ecbb87b9c8da936ba4ada0a2491838374982da61';
const appURL = process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`;

async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function open(page: Page, email: string, exchangeId: string) {
  await signIn(page, email); await page.goto(`/disputes/${exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Remedies and decisions', exact: true })).toBeVisible();
  return page.getByRole('article', { name: 'Case decision' });
}
async function second(browser: Browser, info: TestInfo) {
  const context = await browser.newContext({ ...info.project.use, baseURL: appURL });
  return { context, page: await context.newPage() };
}
async function save(page: Page, info: TestInfo, lane: number, data: unknown, name = 'scenario') {
  const path = info.outputPath(`lane-${lane}/${name}.png`); mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true }); writeFileSync(info.outputPath(`lane-${lane}/${name}.json`), JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), project: info.project.name, data }, null, 2));
}
async function proposeRepair(page: Page, terms = 'Bob pays for a new case hinge by Friday.') {
  const card = page.getByRole('article', { name: 'Case decision' });
  await card.getByLabel('Remedy type').selectOption('repair'); await card.getByLabel('Remedy terms').fill(terms);
  await card.getByRole('button', { name: 'Propose remedy' }).click(); await expect(card).toContainText(terms);
}
async function decide(page: Page, outcome: 'Resolved' | 'Unresolved', reason: string) {
  const card = page.getByRole('article', { name: 'Case decision' });
  await card.getByRole('radio', { name: outcome, exact: true }).check(); await card.getByLabel('Reason for this outcome').fill(reason);
  await card.getByRole('button', { name: 'Record outcome' }).click(); await expect(card).toContainText(`Status ${outcome}`);
}
async function settleInBrowser(page: Page, browser: Browser, info: TestInfo, f: Awaited<ReturnType<typeof disputeFixture>>) {
  const bob = await open(page, f.bob.email, f.exchangeId); await proposeRepair(page);
  const { context, page: other } = await second(browser, info);
  try {
    const alice = await open(other, f.alice.email, f.exchangeId);
    await alice.getByRole('button', { name: 'Agree to this remedy' }).click(); await expect(alice).toContainText('Status Repairing');
    await page.reload(); await bob.getByRole('button', { name: 'Confirm settlement' }).click(); await expect(bob).toContainText('Settlement confirmations 1 of 2, including yours');
    await other.reload(); await alice.getByRole('button', { name: 'Confirm settlement' }).click(); await expect(alice).toContainText('Status Resolved');
  } finally { await context.close(); }
  await page.reload(); await expect(bob).toContainText('Status Resolved'); await expect(bob).toContainText('Settlement confirmations 2 of 2');
  const view = await decisionView(f.alice, f.exchangeId);
  expect(view.cases).toHaveLength(1); expect(view.cases[0].status).toBe('resolved');
  expect(view.cases[0].remedy).toMatchObject({ kind: 'repair', agreed: true }); expect(view.cases[0].remedy!.confirmed_by.sort()).toEqual([f.alice.id, f.bob.id].sort());
  expect(view.cases[0].history.map(row => row.action)).toEqual(['remedy_proposed', 'remedy_agreed', 'settlement_confirmed', 'settlement_confirmed', 'outcome_recorded']);
  return view;
}

test('lane 1 trunk shows the open case without remedy controls; head records one mutually settled case', async ({ page, browser }, info) => {
  const f = await disputeFixture('decision-trunk');
  const root = `.pilot-evidence/issue-16-trunk-${info.project.name}`;
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  expect(tree.some(path => path.startsWith('src/features/dispute-decisions/'))).toBe(false);
  for (const file of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
    const target = `${root}/${file}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`); const port = Number(process.env.APP_PORT ?? 5173) + 9;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ ...info.project.use, baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false), { timeout: 60000 }).toBe(true);
    const trunk = await context.newPage(); await signIn(trunk, f.bob.email); await trunk.goto(`/disputes/${f.exchangeId}`);
    await expect(trunk.getByRole('article', { name: 'Structured case' })).toContainText('The drill case is damaged.');
    await expect(trunk.getByRole('button', { name: 'Propose remedy' })).toHaveCount(0); await expect(trunk.getByRole('heading', { name: 'Remedies and decisions' })).toHaveCount(0);
    await save(trunk, info, 1, { base, addedFeatureAbsent: true, issue8CaseRetained: true }, 'trunk');
  } finally { await context.close(); server.kill(); await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); }); }
  const view = await settleInBrowser(page, browser, info, f);
  await expect(page.getByRole('article', { name: 'Structured case' })).toContainText('The drill case is damaged.');
  await save(page, info, 1, view, 'head');
});

test('lane 2 participants propose repair, mutually agree and confirm settlement twice', async ({ page, browser }, info) => {
  const f = await disputeFixture('decision-browser-primary');
  const view = await settleInBrowser(page, browser, info, f);
  const persisted = await admin.from('dispute_actions').select('action,actor_id,remedy_kind,outcome').eq('dispute_id', f.disputeId).order('created_at');
  expect(persisted.data?.filter(row => row.action === 'settlement_confirmed').map(row => row.actor_id).sort()).toEqual([f.alice.id, f.bob.id].sort());
  expect((await admin.from('disputes').select('status,closed_at').eq('id', f.disputeId).single()).data?.status).toBe('resolved');
  await save(page, info, 2, { view, persisted: persisted.data });
});

test('lane 3 a contested report enters administrator review and closes with a reasoned unresolved outcome', async ({ page, browser }, info) => {
  const f = await disputeFixture('decision-browser-contested');
  const bob = await open(page, f.bob.email, f.exchangeId);
  await bob.getByLabel('Why does this case need administrator review?').fill('Alice says the crack was there before Handoff.');
  await bob.getByRole('button', { name: 'Request administrator review' }).click(); await expect(bob).toContainText('Status Disputed');
  await expect(bob.getByRole('button', { name: 'Propose remedy' })).toHaveCount(0);
  const { context, page: owner } = await second(browser, info);
  try {
    await signIn(owner, f.owner.email); await owner.goto('/disputes');
    await owner.getByRole('region', { name: 'Cases to review' }).getByRole('link', { name: /Disputed/ }).click();
    const card = owner.getByRole('article', { name: 'Case decision' });
    await expect(owner.getByRole('region', { name: 'Relevant Exchange records' })).toContainText('Condition: Good. Light marks on the case.');
    await card.getByRole('button', { name: 'Open administrator review' }).click(); await expect(card).toContainText('Status Administrator review');
    await decide(owner, 'Unresolved', 'Neither account can be verified from the Handoff record.');
  } finally { await context.close(); }
  await page.reload(); await expect(bob.locator('.dispute-unresolved')).toContainText('Unresolved outcome');
  await expect(bob).toContainText('Neither account can be verified from the Handoff record.');
  const view = await decisionView(f.bob, f.exchangeId);
  expect(view.cases[0].history.map(row => row.action)).toEqual(['review_requested', 'review_opened', 'outcome_recorded']);
  expect((await admin.from('dispute_actions').update({ body: 'rewrite' }).eq('dispute_id', f.disputeId)).error?.code).toBe('42501');
  await save(page, info, 3, view);
});

test('lane 4 stalled replacement review and one-sided settlement cannot close the case outside valid guards', async ({ page, browser }, info) => {
  const f = await disputeFixture('decision-browser-stalled'); const remedy = await agreedRemedyWithBothSidesAgreed(f, 'replacement', 'Bob buys the same drill model this week.');
  const bob = await open(page, f.bob.email, f.exchangeId);
  await expect(bob).toContainText('Status Replacement agreed'); await bob.getByRole('button', { name: 'Confirm settlement' }).click();
  await expect(bob).toContainText('Settlement confirmations 1 of 2, including yours'); await expect(bob).toContainText('Status Replacement agreed');
  expect((await caseAction(f.bob, f.disputeId, 'confirm_settlement', { remedy_id: remedy })).error?.code).toBe('55000');
  expect((await caseAction(f.bob, f.disputeId, 'request_review', { reason: 'not allowed now' })).error?.code).toBe('55000');
  const { context, page: owner } = await second(browser, info);
  try {
    const card = await open(owner, f.owner.email, f.exchangeId);
    await card.getByLabel('How has the agreed replacement stalled?').fill('Ten days passed and no replacement arrived.');
    await card.getByRole('button', { name: 'Open administrator review' }).click(); await expect(card).toContainText('Status Administrator review');
  } finally { await context.close(); }
  await page.reload(); await expect(bob.getByRole('button', { name: 'Confirm settlement' })).toHaveCount(0);
  expect((await caseAction(f.alice, f.disputeId, 'confirm_settlement', { remedy_id: remedy })).error?.code).toBe('55000');
  const view = await decisionView(f.bob, f.exchangeId); expect(view.cases[0].status).toBe('admin_review'); expect(view.cases[0].closed_at).toBeNull();
  await save(page, info, 4, { view, oneSidedSecondConfirm: '55000', settlementDuringReview: '55000' });
});

test('lane 5 an administrator resolves a post-completion case without changing completion or Qualifying Interactions', async ({ page }, info) => {
  const f = await completedItemFixture('decision-browser-completed', 3);
  const before = await Promise.all([admin.from('exchanges').select('state,completed_at').eq('id', f.exchangeId).single(), admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId).order('id')]);
  const reported = await reportIssue(f.alice, f.exchangeId, 'A chipped bit was found after completion.'); expect(reported.error).toBeNull();
  expect((await caseAction(f.bob, (reported.data as { id: string }).id, 'request_review', { reason: 'It was chipped before I borrowed it.' })).error).toBeNull();
  const card = await open(page, f.owner.email, f.exchangeId);
  await expect(page.getByRole('region', { name: 'Relevant Exchange records' })).toContainText('Fulfillment completed');
  await card.getByRole('button', { name: 'Open administrator review' }).click(); await expect(card).toContainText('Status Administrator review');
  await decide(page, 'Resolved', 'Wear consistent with normal use; no fault found.');
  const after = await Promise.all([admin.from('exchanges').select('state,completed_at').eq('id', f.exchangeId).single(), admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId).order('id')]);
  expect(after.map(r => r.data)).toEqual(before.map(r => r.data)); expect(before[1].data).toHaveLength(2);
  await save(page, info, 5, { before: before.map(r => r.data), after: after.map(r => r.data), view: await decisionView(f.bob, f.exchangeId) });
});

test('lane 6 racing and replayed administrator decisions keep one guarded outcome and stable notices', async ({ page }, info) => {
  const f = await reviewedDispute('decision-browser-race');
  const other = await activeMember(f.owner, f.community.id, 'decision-browser-admin2');
  expect((await admin.from('memberships').update({ role: 'administrator' }).eq('community_id', f.community.id).eq('user_id', other.id)).error).toBeNull();
  const card = await open(page, f.owner.email, f.exchangeId);
  await card.getByRole('radio', { name: 'Resolved', exact: true }).check(); await card.getByLabel('Reason for this outcome').fill('Repair receipt verified.');
  const intent = randomUUID(); const details = { outcome: 'unresolved', reason: 'The receipt does not match the item.' };
  const winner = await caseAction(other, f.disputeId, 'decide', details, intent); expect(winner.error).toBeNull();
  await card.getByRole('button', { name: 'Record outcome' }).click();
  await expect(card.getByRole('alert')).toHaveText('This case changed. Refresh before continuing.'); await expect(card).toContainText('Status Unresolved');
  for (let attempt = 0; attempt < 3; attempt++) expect((await caseAction(other, f.disputeId, 'decide', details, intent)).data).toEqual(winner.data);
  const outcomes = await admin.from('dispute_actions').select('id').eq('dispute_id', f.disputeId).eq('action', 'outcome_recorded');
  const notices = await admin.from('notification_outbox').select('recipient_id,channel').eq('dispute_id', f.disputeId).eq('kind', 'item_dispute_outcome');
  expect(outcomes.data).toHaveLength(1); expect(notices.data).toHaveLength(4);
  await save(page, info, 6, { staleBrowserDecision: 'rejected', outcomeRows: outcomes.data?.length, notices: notices.data });
});

test('lane 7 a closed case keeps custody blocking allocation until separate administrator recovery', async ({ page }, info) => {
  const f = await reviewedDispute('decision-browser-custody');
  expect((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'resolved', reason: 'Bob agreed to bring the drill back.' })).error).toBeNull();
  expect((await decideBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02'))).error?.code).toBe('23P01');
  const card = await open(page, f.owner.email, f.exchangeId); const records = page.getByRole('region', { name: 'Relevant Exchange records' });
  await expect(card).toContainText('Status Resolved'); await expect(records).toContainText('Item custody unresolved.');
  await card.getByLabel('How did the owner recover the item?').fill('Alice confirmed in person that the drill is back.');
  await card.getByRole('button', { name: 'Record item recovery' }).click(); await expect(records).toContainText('Item custody is resolved.');
  await expect(card).toContainText('Recorded item recovery');
  const approved = await decideBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-02-03', '2027-02-04')); expect(approved.error).toBeNull();
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe('closed_without_completion');
  await save(page, info, 7, { closedCaseAllocation: '23P01', afterRecovery: (approved.data as { status: string }).status });
});

test('lane 8 unsubmitted messages, audit rewrites and foreign administrators are denied', async ({ page }, info) => {
  const f = await reviewedDispute('decision-browser-denied');
  const conversation = await startConversation(f.bob, f.community.id, f.alice.id); const message = await sendMessage(f.bob, conversation.id, 'Never submitted to the case.');
  const foreign = await actor({ label: 'decision-browser-foreign' }); expect((await createCommunity(foreign.client)).error).toBeNull();
  expect((await caseAction(foreign, f.disputeId, 'decide', { outcome: 'resolved', reason: 'foreign' })).error?.code).toBe('42501');
  expect((await caseAction(f.carol, f.disputeId, 'decide', { outcome: 'resolved', reason: 'member' })).error?.code).toBe('42501');
  expect((await foreign.client.from('dispute_actions').select('*').eq('dispute_id', f.disputeId)).data).toEqual([]);
  expect((await f.owner.client.from('messages').select('*').eq('id', message.id)).data).toEqual([]);
  expect((await admin.from('dispute_actions').delete().eq('dispute_id', f.disputeId)).error?.code).toBe('42501');
  expect((await f.owner.client.from('dispute_actions').update({ body: 'rewrite' }).eq('dispute_id', f.disputeId)).error).not.toBeNull();
  await signIn(page, foreign.email); await page.goto(`/disputes/${f.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Case unavailable' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Remedies and decisions' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(message.body);
  await save(page, info, 8, { foreignDecision: '42501', memberDecision: '42501', unsubmittedMessage: 'hidden', auditDelete: '42501' });
});

test('lane 9 the shared case command settles a help-shaped Exchange without item records', async ({ page }, info) => {
  const f = await helpDisputeFixture('decision-browser-help');
  const card = await open(page, f.author.email, f.exchangeId);
  await expect(page.getByRole('region', { name: 'Relevant Exchange records' })).toContainText('Help Exchanges have no item condition, custody or Return records.');
  await card.getByLabel('Remedy type').selectOption('other'); await card.getByLabel('Remedy terms').fill('The helper returns Saturday to finish the move.');
  await card.getByRole('button', { name: 'Propose remedy' }).click(); await expect(card.locator('.decision-remedy')).toContainText('Another agreed resolution. The helper returns Saturday to finish the move.');
  const remedy = (await decisionView(f.helper, f.exchangeId)).cases[0].remedy!.id;
  for (const action of ['agree_remedy', 'confirm_settlement']) expect((await caseAction(f.helper, f.disputeId, action, { remedy_id: remedy })).error).toBeNull();
  await page.reload(); await card.getByRole('button', { name: 'Confirm settlement' }).click(); await expect(card).toContainText('Status Resolved');
  expect((await caseAction(f.owner, f.disputeId, 'record_recovery', { reason: 'n/a' })).error?.code).toBe('22023');
  const view = await decisionView(f.author, f.exchangeId); expect(view.kind).toBe('help'); expect(view.records.handoff).toBeNull(); expect(view.records.reservation).toBeNull();
  await save(page, info, 9, view);
});

test('lane 10 remedy and administrator decision screens work by keyboard and fit the viewport', async ({ page, browser }, info) => {
  const f = await disputeFixture('decision-browser-keyboard'); const card = await open(page, f.bob.email, f.exchangeId);
  await card.getByLabel('Remedy type').focus(); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab'); await expect(card.getByLabel('Remedy terms')).toBeFocused(); await page.keyboard.type('Bob replaces the cracked case.');
  await page.keyboard.press('Tab'); await expect(card.getByRole('button', { name: 'Propose remedy' })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(card).toContainText('Bob replaces the cracked case.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await save(page, info, 10, { keyboard: 'remedy proposal' }, 'remedy');
  const reviewed = await reviewedDispute('decision-browser-keyboard-admin');
  const { context, page: owner } = await second(browser, info);
  try {
    const decision = await open(owner, reviewed.owner.email, reviewed.exchangeId);
    await decision.getByRole('radio', { name: 'Unresolved', exact: true }).focus(); await owner.keyboard.press('Space');
    await expect(decision.getByRole('radio', { name: 'Unresolved', exact: true })).toBeChecked();
    await decision.getByLabel('Reason for this outcome').focus(); await owner.keyboard.type('No verifiable record either way.');
    await owner.keyboard.press('Tab'); await expect(decision.getByRole('button', { name: 'Record outcome' })).toBeFocused(); await owner.keyboard.press('Enter');
    await expect(decision).toContainText('Status Unresolved'); await expect(owner.locator('.dispute-unresolved')).toBeVisible();
    await expect(decision.getByRole('list', { name: 'Decision history' })).toContainText('Recorded the outcome');
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await save(owner, info, 10, { keyboard: 'administrator outcome', reasonsVisible: true, noHorizontalOverflow: true });
  } finally { await context.close(); }
});

test('same-Community administrator can inspect the Return record for an item case', async ({ browser }, info) => {
  const f = await handoffFixture('decision-admin-return-browser'); await advanceHandoff(f); await recordReturn(f);
  const reported = await reportIssue(f.bob, f.exchangeId, 'The recorded Return condition needs review.'); expect(reported.error).toBeNull();
  const disputeId = (reported.data as { id: string }).id;
  expect((await caseAction(f.bob, disputeId, 'request_review', { reason: 'Please compare the Return with the original Handoff record.' })).error).toBeNull();
  expect((await caseAction(f.owner, disputeId, 'open_review', {})).error).toBeNull();
  const { context, page } = await second(browser, info);
  try {
    const decision = await open(page, f.owner.email, f.exchangeId);
    const records = page.getByRole('region', { name: 'Relevant Exchange records' });
    await expect(records).toContainText('Return recorded');
    await expect(records).toContainText('Condition: Good. Light marks on the case.');
    await expect(records).toContainText('Two batteries and charger');
    await expect(records).toContainText('Owner confirmation: awaiting');
    await expect(records).toContainText('Borrower confirmation:');
    await expect(decision).toContainText('Administrator review');
    await save(page, info, 11, { adminCanInspectReturn: true, returnConditionVisible: true, confirmationStateVisible: true });
  } finally { await context.close(); }
});
