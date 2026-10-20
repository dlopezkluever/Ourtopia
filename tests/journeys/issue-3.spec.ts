import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { actor, admin, applyInvite, createCommunity, decideApplication, issueInvite, mailboxLink, membershipFixture, password, publicClient, receipt } from '../../scripts/verify/backend';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, utc: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }), contentType: 'application/json' });
}

async function issueInBrowser(page: Page, email: string) {
  await page.getByLabel('Invitee email').fill(email);
  await page.getByRole('button', { name: 'Issue Invite', exact: true }).click();
  await expect(page.getByLabel('Share this Invite link')).toBeVisible();
  return (await page.getByLabel('Share this Invite link').inputValue()).split('invite=')[1];
}

async function applyInBrowser(page: Page, inviteId: string) {
  await page.goto(`/membership?invite=${inviteId}`);
  await page.getByRole('button', { name: 'Apply with Invite', exact: true }).click();
  await expect(page.getByText('Pending administrator approval', { exact: true })).toBeVisible();
}

async function approveInBrowser(page: Page, email: string, decision = 'approved', reason = '') {
  await expect(page.getByLabel(`Decision for ${email}`, { exact: true })).toBeVisible();
  await page.getByLabel(`Decision for ${email}`, { exact: true }).selectOption(decision);
  await page.getByLabel(`Reason for ${email}`, { exact: true }).fill(reason);
  await page.getByRole('button', { name: `Confirm decision for ${email}`, exact: true }).click();
  await expect(page.getByLabel(`Decision for ${email}`, { exact: true })).toBeHidden();
}

// Notice delivery is asynchronous: the background notice worker sends the row and the administrator console
// only refetches on mount, focus or a 5 second poll. Reload and retry within a budget that covers both.
async function expectDeliveredNotice(page: Page, label: string) {
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45000, intervals: [1000, 2000, 3000] });
}

// The applicant page only refetches on mount, focus or a poll, so retry assertions across reloads.
async function expectAfterReload(page: Page, check: () => Promise<void>) {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout: 45000, intervals: [1000, 2000, 3000] });
}

test('lane 1 trunk regression records Invite absence and head grants access only after approval', async ({ page, browser }, info) => {
  const base = 'a0eff460f5707d128141857d275f21c1a111ac1c';
  const root = `.pilot-evidence/trunk-${info.project.name}`;
  mkdirSync(root, { recursive: true });
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) {
    const target = `${root}/${path}`;
    mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`);
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', '56036', '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const fixture = await membershipFixture('trunk-regression');
  const trunk = await browser.newContext();
  try {
    const baseline = await trunk.newPage();
    await expect.poll(async () => { try { return (await fetch('http://127.0.0.1:56036')).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    await baseline.goto('http://127.0.0.1:56036');
    await baseline.getByLabel('Email address').fill(fixture.owner.email);
    await baseline.getByLabel('Password', { exact: true }).fill(password);
    await baseline.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(baseline.getByRole('heading', { name: `Welcome to ${fixture.community.name}.` })).toBeVisible();
    await expect(baseline.getByRole('button', { name: 'Issue Invite', exact: true })).toHaveCount(0);
    await baseline.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await trunk.close(); server.kill(); }
  const invite = await issueInvite(fixture.owner, fixture.community.id, fixture.applicant.email);
  await signIn(page, fixture.applicant.email);
  await applyInBrowser(page, invite.id);
  expect((await fixture.applicant.client.from('communities').select('*').eq('id', fixture.community.id)).data).toEqual([]);
  const application = await fixture.owner.client.from('membership_applications').select('id').eq('invite_id', invite.id).single();
  expect((await decideApplication(fixture.owner, application.data!.id)).error).toBeNull();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open Community', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Welcome to ${fixture.community.name}.` })).toBeVisible();
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { base, trunkInviteUi: 'absent', pendingDenied: true, applicationId: application.data!.id });
});

test('lane 2 administrator issues Invite invitee verifies applies and sees audited approval', async ({ page, context }, info) => {
  const owner = await actor({ label: 'journey-admin' });
  const community = (await createCommunity(owner.client, randomUUID(), 'Maple Street Welcome')).data;
  const email = `invitee-${randomUUID()}@example.test`;
  await signIn(page, owner.email);
  const inviteId = await issueInBrowser(page, email);
  const applicantContext = await context.browser()!.newContext();
  try {
    const applicantPage = await applicantContext.newPage();
    await applicantPage.goto('/');
    await applicantPage.getByRole('button', { name: 'Create account', exact: true }).first().click();
    await applicantPage.getByLabel('Email address').fill(email);
    await applicantPage.getByLabel('Password', { exact: true }).fill(password);
    await applicantPage.getByRole('button', { name: 'Create account', exact: true }).last().click();
    await expect(applicantPage.getByRole('status')).toContainText('Check your inbox');
    await applicantPage.goto(await mailboxLink(email, 'signup'));
    await expect(applicantPage.getByLabel('Community name')).toBeVisible();
    await applyInBrowser(applicantPage, inviteId);
    const application = await owner.client.from('membership_applications').select('*').eq('invite_id', inviteId).single();
    expect(application.data?.status).toBe('pending');
    expect((await admin.from('memberships').select('status').eq('community_id', community.id).eq('user_id', application.data!.applicant_id)).data).toEqual([{ status: 'pending' }]);
    await approveInBrowser(page, email);
    await expectDeliveredNotice(page, 'Membership application · In app · Delivered · 1 attempt');
    await expectDeliveredNotice(page, 'Membership application · Email · Delivered · 1 attempt');
    await expectAfterReload(applicantPage, () => expect(applicantPage.getByText('Approved', { exact: true })).toBeVisible({ timeout: 3000 }));
    await expect(applicantPage.getByRole('region', { name: 'Notifications' }).getByText('Your membership application was approved.', { exact: true })).toBeVisible();
    await applicantPage.getByRole('link', { name: 'Open Community' }).click();
    await expect(applicantPage.getByRole('heading', { name: 'Welcome to Maple Street Welcome.' })).toBeVisible();
    await expect(applicantPage.getByText('Member · Active member', { exact: true })).toBeVisible();
    await expect(applicantPage.getByLabel('Invitee email')).toHaveCount(0);
    await capture(applicantPage, info, 2, { application: application.data, verifiedByEmail: true });
  } finally { await applicantContext.close(); }
});

test('lane 3 rejected applicant sees the reason and cannot browse the Community', async ({ page, browser }, info) => {
  const f = await membershipFixture('rejection');
  const invite = await issueInvite(f.owner, f.community.id, f.applicant.email);
  await signIn(page, f.applicant.email); await applyInBrowser(page, invite.id);
  const administrator = await browser.newContext();
  try {
    const adminPage = await administrator.newPage(); await signIn(adminPage, f.owner.email);
    await approveInBrowser(adminPage, f.applicant.email, 'rejected', 'Please join our orientation first.');
    await expectAfterReload(page, () => expect(page.getByText('Rejected', { exact: true })).toBeVisible({ timeout: 3000 }));
    await expect(page.getByText('Decision reason. Please join our orientation first.', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Your membership application was rejected. Your decision reason is in your applications.', { exact: true })).toBeVisible({ timeout: 30000 });
    expect((await f.applicant.client.from('communities').select('*').eq('id', f.community.id)).data).toEqual([]);
    await capture(page, info, 3, { rejected: true, reason: 'Please join our orientation first.', accessibleRows: 0 });
    await page.goto(`/communities/${f.community.id}`);
    await expect(page.getByRole('heading', { name: 'Community unavailable.' })).toBeVisible();
  } finally { await administrator.close(); }
});

test('lane 4 expired consumed and unverified Invites fail with no access and no Cron', async ({ page }, info) => {
  const f = await membershipFixture('expired');
  const invite = await issueInvite(f.owner, f.community.id, f.applicant.email);
  expect((await admin.from('invites').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', invite.id)).error).toBeNull();
  await signIn(page, f.applicant.email);
  let releaseInitialRead!: () => void;
  let initialReadStarted!: () => void;
  const initialRead = new Promise<void>(resolve => { releaseInitialRead = resolve; });
  const readStarted = new Promise<void>(resolve => { initialReadStarted = resolve; });
  await page.route('**/rest/v1/membership_applications*', async route => {
    const response = await route.fetch(); initialReadStarted(); await initialRead; await route.fulfill({ response });
  });
  await page.goto(`/membership?invite=${invite.id}`);
  await readStarted;
  await page.getByRole('button', { name: 'Apply with Invite', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('expired');
  releaseInitialRead();
  await expect(page.getByRole('heading', { name: 'Your applications', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('expired');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  expect((await f.applicant.client.from('invites').select('*').eq('id', invite.id)).data).toEqual([]);
  const fresh = await issueInvite(f.owner, f.community.id, f.applicant.email);
  await applyInBrowser(page, fresh.id);
  await page.getByRole('button', { name: 'Apply with Invite', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('consumed');
  const unverified = await actor({ verified: false });
  const locked = await issueInvite(f.owner, f.community.id, unverified.email);
  expect((await unverified.client.rpc('redeem_invite', { p_intent_id: randomUUID(), p_invite_id: locked.id })).error?.code).toBe('42501');
  expect((await f.applicant.client.from('communities').select('*').eq('id', f.community.id)).data).toEqual([]);
  await capture(page, info, 4, { expired: '22023', consumed: '55000', unverified: '42501', cron: 'not required' });
});

test('lane 5 switch two approved Communities lists only active memberships and clears prior cached content', async ({ page }, info) => {
  const f = await membershipFixture('first-circle');
  const second = (await createCommunity(f.owner.client, randomUUID(), 'Second Circle Private')).data;
  const hidden = (await createCommunity(f.owner.client, randomUUID(), 'Pending Circle Hidden')).data;
  for (const communityId of [f.community.id, second.id]) {
    const application = await applyInvite(f.applicant, (await issueInvite(f.owner, communityId, f.applicant.email)).id);
    expect((await decideApplication(f.owner, application.id)).error).toBeNull();
  }
  await applyInvite(f.applicant, (await issueInvite(f.owner, hidden.id, f.applicant.email)).id);
  await signIn(page, f.applicant.email);
  await page.goto(`/communities/${f.community.id}`);
  await expect(page.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
  const switcher = page.getByRole('navigation', { name: 'Your Communities' });
  await expect(switcher.getByRole('link')).toHaveCount(2);
  await expect(switcher.getByRole('link', { name: hidden.name, exact: true })).toHaveCount(0);
  let releaseRead!: () => void;
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  await page.route('**/rest/v1/communities*', async route => { const response = await route.fetch(); await heldRead; await route.fulfill({ response }); });
  await switcher.getByRole('link', { name: second.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Opening your Communities…');
  releaseRead();
  await expect(page.getByRole('heading', { name: `Welcome to ${second.name}.` })).toBeVisible();
  await expect(page.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toHaveCount(0);
  await expect(page.getByText('A little more possible together.', { exact: true })).toHaveCount(1);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await capture(page, info, 5, { accessible: [f.community.id, second.id], hidden: hidden.id, oldHeadingCountWhileReadHeld: 0, switchClearsCache: true });
});

test('lane 6 redemption race and opposing decisions persist one terminal result with coherent notices', async ({ page }, info) => {
  const f = await membershipFixture('racing');
  const invite = await issueInvite(f.owner, f.community.id, f.applicant.email);
  const results = await Promise.all([0, 1].map(() => f.applicant.client.rpc('redeem_invite', { p_intent_id: randomUUID(), p_invite_id: invite.id })));
  expect(results.filter(result => !result.error)).toHaveLength(1);
  expect(results.find(result => result.error)?.error?.code).toBe('55000');
  const application = results.find(result => !result.error)!.data;
  const decisions = await Promise.all([decideApplication(f.owner, application.id), decideApplication(f.owner, application.id, 'rejected', 'Orientation is needed.')]);
  expect(decisions.filter(result => !result.error)).toHaveLength(1);
  expect(decisions.find(result => result.error)?.error?.code).toBe('55000');
  const winner = decisions.find(result => !result.error)!.data;
  const notices = await admin.from('notification_outbox').select('event_id,recipient_id,channel,kind').eq('application_id', application.id);
  expect(notices.data).toHaveLength(4);
  expect(new Set(notices.data!.map(row => JSON.stringify(row))).size).toBe(4);
  await signIn(page, f.applicant.email); await page.goto('/membership');
  await expect(page.getByText(winner.status === 'approved' ? 'Approved' : 'Rejected', { exact: true })).toBeVisible();
  await capture(page, info, 6, { redemptions: results.map(result => result.error?.code ?? 'ok'), decisions: decisions.map(result => result.error?.code ?? 'ok'), notices: notices.data });
});

test('lane 7 approval same intent recovers result and changed payload is rejected', async ({ page }, info) => {
  const f = await membershipFixture('retry');
  const application = await applyInvite(f.applicant, (await issueInvite(f.owner, f.community.id, f.applicant.email)).id);
  const intent = randomUUID();
  const approved = await decideApplication(f.owner, application.id, 'approved', '', intent);
  expect(approved.error).toBeNull();
  expect((await decideApplication(f.owner, application.id, 'approved', '', intent)).data).toEqual(approved.data);
  expect((await decideApplication(f.owner, application.id, 'rejected', 'Changed', intent)).error?.code).toBe('23505');
  expect((await f.owner.client.from('community_events').select('id').eq('id', approved.data.decision_event_id)).data).toHaveLength(1);
  await signIn(page, f.applicant.email); await page.goto('/membership');
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await capture(page, info, 7, { stableResult: approved.data, changedPayload: '23505', approvalEvents: 1 });
});

test('lane 8 pending rejected foreign unrelated and anonymous cannot read content or administer', async ({ page }, info) => {
  const f = await membershipFixture('boundaries');
  await applyInvite(f.applicant, (await issueInvite(f.owner, f.community.id, f.applicant.email)).id);
  const rejected = await actor();
  const application = await applyInvite(rejected, (await issueInvite(f.owner, f.community.id, rejected.email)).id);
  expect((await decideApplication(f.owner, application.id, 'rejected', 'Not this time.')).error).toBeNull();
  const foreign = await actor(); await createCommunity(foreign.client);
  const unrelated = await actor();
  const evidence = [];
  for (const [label, client, email] of [['pending', f.applicant.client, f.applicant.email], ['rejected', rejected.client, rejected.email], ['foreign', foreign.client, foreign.email], ['unrelated', unrelated.client, unrelated.email], ['anonymous', publicClient(), null]] as const) {
    for (const table of ['communities', 'memberships', 'community_events']) {
      const result = await client.from(table).select('*').eq(table === 'communities' ? 'id' : 'community_id', f.community.id);
      expect(result.error?.code === '42501' || result.data?.length === 0).toBe(true);
    }
    expect((await client.rpc('issue_invite', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_email: 'intruder@example.test' })).error?.code).toBe('42501');
    if (email) {
      await signIn(page, email); await page.goto(`/communities/${f.community.id}`);
      await expect(page.getByRole('heading', { name: 'Community unavailable.' })).toBeVisible();
      await expect(page.getByLabel('Invitee email')).toHaveCount(0);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByLabel('Email address')).toBeVisible();
    } else {
      await page.goto(`/communities/${f.community.id}`);
      await expect(page.getByRole('heading', { name: 'Good to have you here.' })).toBeVisible();
    }
    evidence.push({ label, ordinaryRows: 0, administration: '42501' });
  }
  receipt(`issue-3-browser-privacy-${info.project.name}`, evidence);
  await capture(page, info, 8, evidence);
});

test('lane 9 failed email retries keep approval and one durable delivered notice', async ({ page }, info) => {
  const f = await membershipFixture('failed-email');
  const application = await applyInvite(f.applicant, (await issueInvite(f.owner, f.community.id, f.applicant.email)).id);
  const decision = await decideApplication(f.owner, application.id);
  expect(decision.error).toBeNull();
  const email = await admin.from('notification_outbox').select('*').eq('event_id', decision.data.decision_event_id).eq('channel', 'email').single();
  const failed = await deliverOne(admin, async () => { throw new Error('Forced email failure.'); }, email.data!.id) as { state: string };
  expect(failed.state).toBe('failed');
  expect((await f.applicant.client.rpc('require_current_membership', { p_community_id: f.community.id })).error).toBeNull();
  await signIn(page, f.owner.email);
  await expect(page.getByText('Membership approved · Email · Failed · 1 attempt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry email notice' }).click();
  const { send } = localDelivery();
  await deliverOne(admin, send, email.data!.id);
  await expect.poll(async () => (await admin.from('notification_outbox').select('state').eq('id', email.data!.id).single()).data?.state).toBe('delivered');
  expect(await deliverOne(admin, send, email.data!.id)).toBeNull();
  const response = await fetch(`${process.env.TEST_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${f.applicant.email}`)}`);
  expect((await response.json() as { messages: unknown[] }).messages).toHaveLength(1);
  await expectDeliveredNotice(page, 'Membership approved · Email · Delivered · 2 attempts');
  await capture(page, info, 9, { outboxId: email.data!.id, approval: decision.data, deliveredEmails: 1 });
});

test('lane 10 application decision and switching work on mobile and by keyboard', async ({ page }, info) => {
  const f = await membershipFixture('keyboard');
  const second = (await createCommunity(f.owner.client, randomUUID(), 'Keyboard Second Circle')).data;
  const invite = await issueInvite(f.owner, f.community.id, f.applicant.email);
  await signIn(page, f.applicant.email); await page.goto('/membership');
  await page.getByLabel('Invite code or link').focus();
  await page.keyboard.type(invite.id); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Apply with Invite', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Pending administrator approval', { exact: true })).toBeVisible();
  const application = await f.owner.client.from('membership_applications').select('id').eq('invite_id', invite.id).single();
  expect((await decideApplication(f.owner, application.data!.id, 'rejected', 'Start with orientation.')).error).toBeNull();
  await expect(page.getByText('Decision reason. Start with orientation.', { exact: true })).toBeVisible();
  const fresh = await issueInvite(f.owner, f.community.id, f.applicant.email);
  await page.getByLabel('Invite code or link').fill(fresh.id);
  await page.getByRole('button', { name: 'Apply with Invite', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('Pending administrator approval', { exact: true })).toBeVisible();
  const newApplication = await f.owner.client.from('membership_applications').select('id').eq('invite_id', fresh.id).single();
  expect((await decideApplication(f.owner, newApplication.data!.id)).error).toBeNull();
  const another = await applyInvite(f.applicant, (await issueInvite(f.owner, second.id, f.applicant.email)).id);
  expect((await decideApplication(f.owner, another.id)).error).toBeNull();
  await page.goto(`/communities/${f.community.id}`);
  const target = page.getByRole('navigation', { name: 'Your Communities' }).getByRole('link', { name: second.name, exact: true });
  await target.focus(); await expect(target).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `Welcome to ${second.name}.` })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, info, 10, { keyboardApply: true, rejectionReason: 'Start with orientation.', switchedTo: second.id, viewport: page.viewportSize() });
});
