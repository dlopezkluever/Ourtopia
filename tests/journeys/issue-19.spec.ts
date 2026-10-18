import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { acceptHelp, admin, checkedOutFixture, commitHelp, createHelpPost, helpFixture, helpNeedFields, helpScheduleFields, password, recordReturn, requestItem, approveBorrow } from '../../scripts/verify/backend';
import { deliverOne } from '../../supabase/functions/notifications/worker';

test.describe.configure({ timeout: 240000 });

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function shot(page: Page, info: TestInfo, lane: number) {
  mkdirSync(`.pilot-evidence/issue-19/lane-${lane}`, { recursive: true });
  await page.screenshot({ path: `.pilot-evidence/issue-19/lane-${lane}/${info.project.name}.png`, fullPage: true });
}

// A Return recorded by the borrower only, aged past its review window and queued by the deadline worker.
async function stalledItem(label: string) {
  const f = await checkedOutFixture(label);
  await recordReturn(f);
  await admin.from('item_returns').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', f.exchangeId);
  const queued = await admin.rpc('process_due_item_returns');
  expect(queued.error).toBeNull();
  return f;
}

// A scheduled help Exchange with one helper confirmation, aged past its review window and queued.
async function stalledHelp(label: string) {
  const f = await helpFixture(label, 1);
  const [helper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  const scheduled = await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() });
  expect(scheduled.error).toBeNull();
  const confirmed = await helper.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_expected_revision: 0, p_action: 'confirm', p_disagreement: null });
  expect(confirmed.error).toBeNull();
  await admin.from('help_completions').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', exchange.id);
  expect((await admin.rpc('process_due_help_completions')).error).toBeNull();
  return { ...f, exchangeId: exchange.id };
}

async function openCase(page: Page, exchangeId: string) {
  await page.goto(`/stalled/case/${exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Stalled confirmation', exact: true })).toBeVisible();
}

async function recordVerifiedItem(page: Page, reason: string) {
  await page.getByRole('radio', { name: 'Verified completion' }).check();
  await page.getByRole('checkbox', { name: 'I checked the recorded Return' }).check();
  await page.getByRole('checkbox', { name: 'I checked the recorded condition and it is resolved' }).check();
  await page.getByLabel('Reason for this decision').fill(reason);
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
}

async function decisionCount(exchangeId: string) {
  const rows = await admin.from('stalled_review_decisions').select('outcome').eq('exchange_id', exchangeId);
  expect(rows.error).toBeNull();
  return rows.data ?? [];
}

test('lane 1 regression: administrator verifies a stalled item at head', async ({ page }, info) => {
  // Trunk (origin/master) has no stalled review route, so the head behavior is gated on its visible durable end state.
  const f = await stalledItem('lane-1');
  await signIn(page, f.owner.email);
  await openCase(page, f.exchangeId);
  await recordVerifiedItem(page, 'The borrower recorded the Return and the condition matches the Handoff.');
  await expect(page.getByText('Verified completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 1);
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe('completed');
});

test('lane 2 administrator verifies a stalled item from recorded evidence', async ({ page }, info) => {
  const f = await stalledItem('lane-2');
  await signIn(page, f.owner.email);
  await page.goto(`/stalled/${f.community.id}`);
  await expect(page.getByRole('link', { name: /Item loan/ })).toBeVisible();
  await openCase(page, f.exchangeId);
  await recordVerifiedItem(page, 'The borrower recorded the Return and the condition matches the Handoff.');
  await expect(page.getByText('Verified completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 2);
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe('completed');
  const awards = await admin.from('reputation_events').select('recipient_id,points').eq('exchange_id', f.exchangeId);
  expect(awards.data?.reduce((sum, row) => sum + row.points, 0)).toBe(3);
});

test('lane 3 administrator verifies a stalled help Exchange and awards only the helper', async ({ page }, info) => {
  const f = await stalledHelp('lane-3');
  await signIn(page, f.owner.email);
  await openCase(page, f.exchangeId);
  await page.getByRole('radio', { name: 'Verified completion' }).check();
  await page.getByRole('checkbox', { name: 'I checked the supporting Exchange records or work evidence' }).check();
  await page.getByLabel('Reason for this decision').fill('The schedule and the helper confirmation support completion.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Verified completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 3);
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe('completed');
  const awards = await admin.from('reputation_events').select('recipient_id,points').eq('exchange_id', f.exchangeId);
  expect(awards.data).toEqual([{ recipient_id: f.members[0].id, points: 3 }]);
});

test('lane 4 incomplete evidence is rejected for an item and a help Exchange', async ({ page }, info) => {
  const item = await stalledItem('lane-4-item');
  await signIn(page, item.owner.email);
  await openCase(page, item.exchangeId);
  await page.getByRole('radio', { name: 'Verified completion' }).check();
  await page.getByRole('checkbox', { name: 'I checked the recorded Return' }).check();
  await page.getByLabel('Reason for this decision').fill('Only the Return was checked, not the condition.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Verified completion is missing');
  expect((await admin.from('exchanges').select('state').eq('id', item.exchangeId).single()).data?.state).toBe('return_pending');
  await shot(page, info, 4);

  const help = await stalledHelp('lane-4-help');
  await signIn(page, help.owner.email);
  await openCase(page, help.exchangeId);
  await page.getByRole('radio', { name: 'Verified completion' }).check();
  await page.getByLabel('Reason for this decision').fill('No work evidence has been cited for this Help Exchange.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Verified completion is missing');
  expect(await decisionCount(help.exchangeId)).toEqual([]);
});

test('lane 5 administrator closes a stalled item without completion', async ({ page }, info) => {
  const f = await stalledItem('lane-5');
  await signIn(page, f.owner.email);
  await openCase(page, f.exchangeId);
  await page.getByRole('radio', { name: 'Close without completion' }).check();
  await page.getByLabel('Reason for this decision').fill('The owner could not reach the borrower to confirm the Return.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Closed without completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 5);
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe('closed_without_completion');
  const awards = await admin.from('reputation_events').select('id').eq('exchange_id', f.exchangeId);
  expect(awards.data).toEqual([]);
});

test('lane 6 two administrator tabs racing one decision persist one outcome and one award set', async ({ browser, baseURL }, info) => {
  const f = await stalledItem('lane-6');
  const first = await browser.newContext({ baseURL, viewport: info.project.use.viewport ?? undefined });
  const second = await browser.newContext({ baseURL, viewport: info.project.use.viewport ?? undefined });
  try {
    const pageA = await first.newPage();
    const pageB = await second.newPage();
    await signIn(pageA, f.owner.email);
    await signIn(pageB, f.owner.email);
    await openCase(pageA, f.exchangeId);
    await openCase(pageB, f.exchangeId);
    for (const page of [pageA, pageB]) {
      await page.getByRole('radio', { name: 'Verified completion' }).check();
      await page.getByRole('checkbox', { name: 'I checked the recorded Return' }).check();
      await page.getByRole('checkbox', { name: 'I checked the recorded condition and it is resolved' }).check();
      await page.getByLabel('Reason for this decision').fill('The borrower recorded the Return and the condition matches the Handoff.');
    }
    await Promise.all([
      pageA.getByRole('button', { name: 'Record decision', exact: true }).click(),
      pageB.getByRole('button', { name: 'Record decision', exact: true }).click(),
    ]);
    await expect(pageA.getByText('Verified completion', { exact: false }).or(pageA.getByRole('alert')).first()).toBeVisible();
    await expect(pageB.getByText('Verified completion', { exact: false }).or(pageB.getByRole('alert')).first()).toBeVisible();
    await shot(pageA, info, 6);
    expect(await decisionCount(f.exchangeId)).toHaveLength(1);
    const awards = await admin.from('reputation_events').select('points').eq('exchange_id', f.exchangeId);
    expect(awards.data?.reduce((sum, row) => sum + row.points, 0)).toBe(3);
  } finally {
    await first.close();
    await second.close();
  }
});

test('lane 7 a closed item without recovery keeps custody blocking until a recorded recovery', async ({ page }, info) => {
  const f = await stalledItem('lane-7');
  await signIn(page, f.owner.email);
  await openCase(page, f.exchangeId);
  await page.getByRole('radio', { name: 'Close without completion' }).check();
  await page.getByLabel('Reason for this decision').fill('The borrower never confirmed the Return after reminders.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Unrecovered. The item stays blocked', { exact: false })).toBeVisible();
  const blocked = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id)).then(() => null, error => error);
  expect((blocked as { code?: string } | null)?.code).toBe('23P01');
  await shot(page, info, 7);

  await page.getByLabel('How the owner recovered the item').fill('The owner recovered the drill from the borrower on Friday.');
  await page.getByRole('button', { name: 'Record recovery', exact: true }).click();
  await expect(page.getByText('Recovery recorded', { exact: false })).toBeVisible();
  await expect(page.getByText('Clear', { exact: true })).toBeVisible();
  const allocated = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id));
  expect(allocated.exchange_state).toBe('approved');
});

test('lane 8 self-verification and foreign administrator disposition are denied', async ({ page, browser, baseURL }, info) => {
  const f = await stalledItem('lane-8');
  await signIn(page, f.alice.email);
  await openCase(page, f.exchangeId);
  await expect(page.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  await expect(page.getByText('Only an administrator who is not a participant records the decision.')).toBeVisible();
  await shot(page, info, 8);

  const outsider = await browser.newContext({ baseURL, viewport: info.project.use.viewport ?? undefined });
  try {
    const outsiderPage = await outsider.newPage();
    const foreign = await admin.auth.admin.createUser({ email: `lane-8-foreign-${randomUUID()}@example.test`, password, email_confirm: true });
    expect(foreign.error).toBeNull();
    await signIn(outsiderPage, foreign.data.user!.email!);
    await outsiderPage.goto(`/stalled/case/${f.exchangeId}`);
    await expect(outsiderPage.getByRole('alert')).toContainText('Stalled review unavailable.');
    await expect(outsiderPage.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  } finally {
    await outsider.close();
  }
});

test('lane 9 a failed decision email retries without changing the outcome or notice identity', async ({ page }, info) => {
  const f = await stalledItem('lane-9');
  await signIn(page, f.owner.email);
  await openCase(page, f.exchangeId);
  await page.getByRole('radio', { name: 'Close without completion' }).check();
  await page.getByLabel('Reason for this decision').fill('The borrower never answered after the second reminder.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Closed without completion', { exact: false }).first()).toBeVisible();

  const email = await admin.from('notification_outbox').select('id').eq('community_id', f.community.id)
    .eq('kind', 'item_stalled_review_decided').eq('recipient_id', f.alice.id).eq('channel', 'email').single();
  expect(email.error).toBeNull();
  const failed = await deliverOne(admin, async () => { throw new Error('Synthetic provider outage'); }, email.data!.id) as { state: string };
  expect(failed.state).toBe('failed');
  expect((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).eq('id', email.data!.id)).error).toBeNull();
  const delivered = await deliverOne(admin, async () => undefined, email.data!.id) as { state: string };
  expect(delivered.state).toBe('delivered');

  await page.reload();
  await expect(page.getByText('Closed without completion', { exact: false }).first()).toBeVisible();
  expect(await decisionCount(f.exchangeId)).toEqual([{ outcome: 'closed_without_completion' }]);
  await shot(page, info, 9);
});

test('lane 10 keyboard-only administrator decides a help review and reads its recorded outcome on mobile and desktop', async ({ page }, info) => {
  const f = await stalledHelp('lane-10');
  await signIn(page, f.owner.email);
  await openCase(page, f.exchangeId);
  await page.getByRole('radio', { name: 'Verified completion' }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('checkbox', { name: 'I checked the supporting Exchange records or work evidence' }).focus();
  await page.keyboard.press('Space');
  await page.getByLabel('Reason for this decision').focus();
  await page.keyboard.type('The schedule and the helper confirmation support completion.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Verified completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 10);
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe('completed');
});
