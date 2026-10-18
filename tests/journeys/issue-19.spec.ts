import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { checkedOutFixture, admin, password, recordReturn } from '../../scripts/verify/backend';

test.describe.configure({ timeout: 150000 });

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

// A Return recorded by the borrower and never confirmed, aged past its review window and queued by the deadline worker.
async function stalledItem(label: string) {
  const f = await checkedOutFixture(label);
  await recordReturn(f);
  await admin.from('item_returns').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', f.exchangeId);
  const queued = await admin.rpc('process_due_item_returns');
  expect(queued.error).toBeNull();
  return f;
}

async function shot(page: Page, info: TestInfo, lane: number) {
  mkdirSync(`.pilot-evidence/issue-19/lane-${lane}`, { recursive: true });
  await page.screenshot({ path: `.pilot-evidence/issue-19/lane-${lane}/${info.project.name}.png`, fullPage: true });
}

test('lane 2 administrator verifies a stalled item from recorded evidence', async ({ page }, info) => {
  const f = await stalledItem('lane-2');
  await signIn(page, f.owner.email);
  await page.goto(`/stalled/case/${f.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Stalled confirmation', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Verified completion' }).check();
  await page.getByRole('checkbox', { name: 'I checked the recorded Return' }).check();
  await page.getByRole('checkbox', { name: 'I checked the recorded condition and it is resolved' }).check();
  await page.getByLabel('Reason for this decision').fill('The borrower recorded the Return and the condition matches the Handoff.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Verified completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 2);
  const state = await admin.from('exchanges').select('state').eq('id', f.exchangeId).single();
  expect(state.data?.state).toBe('completed');
});

test('lane 5 administrator closes a stalled item without completion', async ({ page }, info) => {
  const f = await stalledItem('lane-5');
  await signIn(page, f.owner.email);
  await page.goto(`/stalled/case/${f.exchangeId}`);
  await page.getByRole('radio', { name: 'Close without completion' }).check();
  await page.getByLabel('Reason for this decision').fill('The owner could not reach the borrower to confirm the Return.');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Closed without completion', { exact: false }).first()).toBeVisible();
  await shot(page, info, 5);
  const state = await admin.from('exchanges').select('state').eq('id', f.exchangeId).single();
  expect(state.data?.state).toBe('closed_without_completion');
});

test('lane 8 participant cannot record a decision on their own stalled item', async ({ page }, info) => {
  const f = await stalledItem('lane-8');
  await signIn(page, f.alice.email);
  await page.goto(`/stalled/case/${f.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Stalled confirmation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  await expect(page.getByText('Only an administrator who is not a participant records the decision.')).toBeVisible();
  await shot(page, info, 8);
});
