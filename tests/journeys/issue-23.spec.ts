import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { admin, applyInvite, issueInvite, deliveryFixture, failedDelivery, membershipFixture, password } from '../../scripts/verify/backend';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

type Fixture = Awaited<ReturnType<typeof failedDelivery>>;
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function consoleFor(page: Page, f: Fixture) {
  await signIn(page, f.owner.email); await page.getByRole('link', { name: 'Notice deliveries', exact: true }).click();
  await page.getByLabel('Community', { exact: true }).selectOption(f.community.id);
  await expect(page.getByRole('heading', { name: 'Notice deliveries', exact: true })).toBeVisible();
}
function emailCard(page: Page, f: Fixture) { return page.getByRole('article', { name: `Membership approved email ${f.email.id}`, exact: true }); }
async function retryFromConsole(page: Page, f: Fixture) {
  await emailCard(page, f).getByRole('button', { name: 'Retry delivery' }).click();
  await expect(page.getByText('Retry requested. Delivery runs after the original workflow commits.', { exact: true })).toBeVisible();
}
async function stable(f: Fixture) {
  const membership = await f.applicant.client.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.applicant.id);
  expect(membership.data).toEqual([{ status: 'active' }]);
  const row = await admin.from('notification_outbox').select('id,state,event_id,recipient_id,channel,kind,attempts').eq('id', f.email.id).single(); expect(row.error).toBeNull();
  expect(row.data?.event_id).toBe(f.email.event_id);
  expect(row.data?.recipient_id).toBe(f.applicant.id); expect(row.data?.channel).toBe('email'); expect(row.data?.kind).toBe('membership_approved');
  const application = await f.applicant.client.from('membership_applications').select('status,decision_event_id').eq('id', f.application.id).single();
  expect(application.error).toBeNull(); expect(application.data).toEqual({ status: 'approved', decision_event_id: f.email.event_id });
  const notices = await f.applicant.client.from('notifications').select('id').eq('outbox_id', f.inApp.id); expect(notices.data).toHaveLength(1);
  return { membership: membership.data, application: application.data, delivery: row.data, inAppNotices: notices.data?.length };
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), backend: process.env.VITE_SUPABASE_URL, data }), contentType: 'application/json' });
}
async function deliverInApp(f: Fixture) { const { client, send } = localDelivery(); await deliverOne(client, send, f.inApp.id); }
async function recover(f: Fixture) { const { client, send } = localDelivery(); return deliverOne(client, send, f.email.id); }

test('lane 1 trunk absence and head preserve approved membership through retry', async ({ page, browser }, info) => {
  const base = '7aa1af9cf1dae27a32226bb0f52f408e29749aa2';
  const root = `.pilot-evidence/p23-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) { const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`])); }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 1;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ viewport: page.viewportSize() });
  const baselineFixture = await failedDelivery('p23-trunk');
  let baselineReceipt: unknown;
  try {
    const f = baselineFixture;
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`).then(response => response.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await trunk.goto(`http://127.0.0.1:${port}`);
    await trunk.getByLabel('Email address').fill(f.owner.email); await trunk.getByLabel('Password', { exact: true }).fill(password); await trunk.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(trunk.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(trunk.getByRole('link', { name: 'Notice deliveries', exact: true })).toHaveCount(0);
    await expect(trunk.getByText('Membership approved · Email · Failed · 1 attempt', { exact: true })).toBeVisible();
    const response = trunk.waitForResponse(response => response.url().includes('/rpc/retry_notification'));
    await trunk.getByRole('button', { name: 'Retry email notice', exact: true }).click();
    const retried = await response; await retried.finished(); expect(retried.status()).toBe(200);
    await recover(f); await deliverInApp(f);
    await expect(trunk.getByText('Membership approved · Email · Delivered · 2 attempts', { exact: true })).toBeVisible();
    baselineReceipt = await stable(f);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); }); }
  const f = await failedDelivery('p23-head-regression');
  await consoleFor(page, f); await retryFromConsole(page, f); await recover(f); await deliverInApp(f); await page.reload();
  await expect(emailCard(page, f).getByText('Delivered', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true }); await capture(page, info, 1, { trunk: baselineReceipt, head: await stable(f), addedConsole: true });
});

test('lane 2 administrator retries a failed decision email while membership stays approved', async ({ page }, info) => {
  const seed = await membershipFixture('p23-primary');
  const application = await applyInvite(seed.applicant, (await issueInvite(seed.owner, seed.community.id, seed.applicant.email)).id);
  await signIn(page, seed.owner.email);
  await page.getByLabel(`Decision for ${seed.applicant.email}`, { exact: true }).selectOption('approved');
  await page.getByRole('button', { name: `Confirm decision for ${seed.applicant.email}`, exact: true }).click();
  await expect(page.getByLabel(`Decision for ${seed.applicant.email}`, { exact: true })).toBeHidden();
  const outbox = await admin.from('notification_outbox').select('*').eq('application_id', application.id).eq('kind', 'membership_approved'); expect(outbox.error).toBeNull();
  const f = { ...seed, application, email: outbox.data!.find(row => row.channel === 'email')!, inApp: outbox.data!.find(row => row.channel === 'in_app')! };
  const failure = await deliverOne(admin, async () => { throw new Error('Controlled provider outage after approval.'); }, f.email.id) as { state: string }; expect(failure.state).toBe('failed');
  await deliverInApp(f); await page.getByRole('link', { name: 'Notice deliveries', exact: true }).click(); await page.getByLabel('Community', { exact: true }).selectOption(f.community.id);
  await expect(emailCard(page, f).getByText('Retryable failure', { exact: true })).toBeVisible();
  await retryFromConsole(page, f); await recover(f); await page.getByRole('button', { name: 'Refresh deliveries' }).click();
  await expect(emailCard(page, f).getByText('Delivered', { exact: true })).toBeVisible();
  const mailbox = await fetch(`${process.env.TEST_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${f.applicant.email}`)}`); expect(mailbox.status).toBe(200);
  const mail = await mailbox.json() as { messages: unknown[] }; expect(mail.messages).toHaveLength(1);
  await capture(page, info, 2, { ...await stable(f), deliveredEmails: mail.messages.length, businessApproval: 'browser' });
});

test('lane 3 attempt history matches failed pending and delivered durable states', async ({ page }, info) => {
  const f = await failedDelivery('p23-history'); await consoleFor(page, f);
  await expect(emailCard(page, f).getByText('Retryable failure', { exact: true })).toBeVisible();
  await emailCard(page, f).getByText('Attempt history (1)', { exact: true }).click(); await expect(emailCard(page, f).getByText(/Attempt 1\. Started/)).toBeVisible();
  await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
  await retryFromConsole(page, f); await recover(f); await deliverInApp(f); await page.reload();
  await emailCard(page, f).getByText('Attempt history (2)', { exact: true }).click(); await expect(emailCard(page, f).getByText(/Attempt 2\. Started/)).toBeVisible(); await capture(page, info, 3, await stable(f));
});

test('lane 4 worker claim and administrator retry race avoids duplicate effects', async ({ page }, info) => {
  const f = await failedDelivery('p23-race-ui'); await consoleFor(page, f);
  const intent = randomUUID();
  const retries = await Promise.all(Array.from({ length: 2 }, () => f.owner.client.rpc('retry_notification', { p_intent_id: intent, p_outbox_id: f.email.id })));
  expect(retries.every(row => !row.error)).toBe(true);
  const claims = await Promise.all(Array.from({ length: 3 }, () => admin.rpc('claim_notification', { p_outbox_id: f.email.id })));
  expect(claims.filter(row => row.data)).toHaveLength(1);
  const current = claims.find(row => row.data)!.data;
  const retry = await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: f.email.id }); expect(retry.error?.code).toBe('55000');
  await admin.rpc('finish_notification', { p_outbox_id: f.email.id, p_claim_token: current.claim_token }); await deliverInApp(f); await page.reload();
  await capture(page, info, 4, { claims: 1, ...await stable(f) });
});

test('lane 5 already processed retry intent returns its receipt without a second transition', async ({ page }, info) => {
  const f = await failedDelivery('p23-processed'); const args = { p_intent_id: randomUUID(), p_outbox_id: f.email.id };
  const first = await f.owner.client.rpc('retry_notification', args); expect(first.error).toBeNull();
  await consoleFor(page, f); await expect(emailCard(page, f).getByRole('button', { name: 'Retry delivery' })).toBeVisible();
  await recover(f); await deliverInApp(f);
  await emailCard(page, f).getByRole('button', { name: 'Retry delivery' }).click();
  await expect(page.getByText('This delivery has already moved on. Refresh for its current status.', { exact: true })).toBeVisible();
  expect((await f.owner.client.rpc('retry_notification', args)).data).toEqual(first.data);
  expect((await f.owner.client.rpc('retry_notification', { ...args, p_intent_id: randomUUID() })).error?.code).toBe('55000');
  await expect(emailCard(page, f).getByRole('button', { name: 'Retry delivery' })).toHaveCount(0); await capture(page, info, 5, await stable(f));
});

test('lane 6 reschedule suppresses obsolete due reminder work', async ({ page }, info) => {
  const f = await deliveryFixture('p23-obsolete'); const source = randomUUID();
  async function schedule() {
    const event = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, kind: 'handoff_rescheduled', intent_id: randomUUID() }).select('id').single(); expect(event.error).toBeNull();
    const result = await admin.rpc('schedule_notification_reminder', { p_community_id: f.community.id, p_source_key: source, p_event_id: event.data!.id, p_recipient_id: f.applicant.id, p_kind: 'handoff_reminder', p_channel: 'in_app', p_due_at: new Date(Date.now() - 1000).toISOString() }); expect(result.error).toBeNull(); return result.data;
  }
  const old = await schedule(); const current = await schedule(); const { client, send } = localDelivery();
  expect(await deliverOne(client, send, old)).toBeNull(); await deliverOne(client, send, current);
  const notices = await f.applicant.client.from('notifications').select('outbox_id').in('outbox_id', [old, current]); expect(notices.data).toEqual([{ outbox_id: current }]);
  await consoleFor(page, f); await expect(page.getByText('Obsolete reminder suppressed', { exact: true })).toBeVisible(); await capture(page, info, 6, { source, old, current, notices: notices.data });
});

test('lane 7 recipient reads own notice and foreign administrator cannot inspect failures', async ({ page }, info) => {
  const f = await failedDelivery('p23-recipient'); await deliverInApp(f); await signIn(page, f.applicant.email); await page.goto('/membership');
  await expect(page.getByText('Your membership application was approved.', { exact: true })).toBeVisible();
  const foreign = await membershipFixture('p23-foreign-ui'); await page.getByRole('button', { name: 'Sign out' }).click(); await signIn(page, foreign.owner.email);
  await page.goto(`/deliveries?community=${f.community.id}`); await expect(page.getByRole('alert')).toContainText('current administrator access');
  expect((await foreign.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id })).error?.code).toBe('42501');
  expect((await foreign.owner.client.from('notification_outbox').select('*').eq('id', f.email.id)).data).toEqual([]);
  await capture(page, info, 7, { recipientOwnNotice: true, foreignDenied: true });
});

test('lane 8 diagnostics exclude private bodies bearer URLs and credentials', async ({ page }, info) => {
  const secret = 'PRIVATE-EVIDENCE https://private.test/?token=bearer SUPER-CREDENTIAL';
  const f = await failedDelivery('p23-sanitize-ui', secret); await consoleFor(page, f);
  const diagnostics = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id }); expect(diagnostics.error).toBeNull();
  expect(JSON.stringify(diagnostics.data)).not.toMatch(/PRIVATE-EVIDENCE|private\.test|SUPER-CREDENTIAL|claim_token|recipient_email/);
  await emailCard(page, f).getByText('Attempt history (1)', { exact: true }).click(); await expect(page.getByText(secret)).toHaveCount(0);
  await expect(emailCard(page, f).getByText('Delivery failed. Retry is scheduled.', { exact: true })).toBeVisible(); await capture(page, info, 8, diagnostics.data);
});

test('lane 9 browser reload and fresh worker recover durable provider failure', async ({ page }, info) => {
  const f = await failedDelivery('p23-restart'); await deliverInApp(f); await consoleFor(page, f); await page.reload();
  await expect(emailCard(page, f).getByText('Retryable failure', { exact: true })).toBeVisible(); await retryFromConsole(page, f);
  const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {localDelivery} from './supabase/functions/notifications/local.ts'; import {deliverOne} from './supabase/functions/notifications/worker.ts'; const {client,send}=localDelivery(); await deliverOne(client,send,'${f.email.id}');`], { stdio: 'pipe', windowsHide: true });
  expect(await new Promise<number | null>(resolve => worker.once('exit', resolve))).toBe(0);
  await page.reload(); await expect(emailCard(page, f).getByText('Delivered', { exact: true })).toBeVisible(); await capture(page, info, 9, await stable(f));
});

test('lane 10 keyboard retry and attempt history fit mobile and desktop', async ({ page }, info) => {
  const f = await failedDelivery('p23-keyboard'); await consoleFor(page, f);
  const retry = emailCard(page, f).getByRole('button', { name: 'Retry delivery' }); await retry.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('Retry requested. Delivery runs after the original workflow commits.', { exact: true })).toBeVisible();
  await recover(f); await deliverInApp(f); await page.reload();
  const summary = emailCard(page, f).getByText('Attempt history (2)', { exact: true }); await summary.focus(); await page.keyboard.press('Enter');
  await expect(emailCard(page, f).getByText(/Attempt 2\. Started/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await capture(page, info, 10, { ...await stable(f), viewport: page.viewportSize(), keyboard: true });
});
