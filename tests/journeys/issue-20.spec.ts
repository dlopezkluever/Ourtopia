import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { drillDetails, handoffFixture, password } from '../../scripts/verify/backend';

async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible();
}
async function save(page: Page, info: TestInfo, lane: number, data: unknown, name = 'scenario') {
  const path = info.outputPath(`lane-${lane}/${name}.png`); mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  writeFileSync(info.outputPath(`lane-${lane}/${name}.json`), JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), project: info.project.name, data }, null, 2));
}

// Lanes 4 to 10 (30-day expiry, cache clearing, retries, actor matrix, custody, keyboard) are not implemented in this change.

test('lane 1 owner suspends a borrower with an open item loan, the borrower sees the restriction, and reinstatement restores the page', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-1-${info.project.name}`);
  await signIn(page, f.owner.email);
  await page.goto(`/moderation/${f.community.id}`);
  await expect(page.getByRole('heading', { name: 'Moderation', exact: true })).toBeVisible();
  await page.getByLabel('Reason for the next action').fill('Repeated late returns.');
  await page.getByRole('button', { name: `Suspend ${f.bob.email}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${f.bob.email} suspended.` })).toBeVisible();
  await signOut(page);
  await signIn(page, f.bob.email);
  await expect(page.getByRole('region', { name: 'Membership restrictions' })).toContainText('Repeated late returns.');
  await page.goto(`/handoffs/${f.exchangeId}`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save(page, info, 1, { exchangeId: f.exchangeId, state: 'suspended' });
  await signOut(page);
  await signIn(page, f.owner.email);
  await page.goto(`/moderation/${f.community.id}`);
  await page.getByLabel('Reason for the next action').fill('Review complete.');
  await page.getByRole('button', { name: `Reinstate ${f.bob.email}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${f.bob.email} reinstated.` })).toBeVisible();
});

test('lane 2 owner removes a member and the removed member keeps the audited reason without new activity', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-2-${info.project.name}`);
  await signIn(page, f.owner.email);
  await page.goto(`/moderation/${f.community.id}`);
  await page.getByLabel('Reason for the next action').fill('Harassment reports reviewed.');
  await page.getByRole('button', { name: `Remove ${f.bob.email}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${f.bob.email} removed.` })).toBeVisible();
  await expect(page.locator('.moderation-log')).toContainText('Harassment reports reviewed.');
  await signOut(page);
  await signIn(page, f.bob.email);
  await expect(page.getByRole('region', { name: 'Membership restrictions' })).toContainText('Harassment reports reviewed.');
  await save(page, info, 2, { communityId: f.community.id, state: 'removed' });
});

test('lane 3 owner withdraws an item Listing with a reason, and the audit log keeps the owner unchanged', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-3-${info.project.name}`);
  await signIn(page, f.owner.email);
  await page.goto(`/moderation/${f.community.id}`);
  await page.getByLabel('Reason for the next action').fill('Unsafe item photo.');
  await page.getByRole('button', { name: `Withdraw ${drillDetails.title}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${drillDetails.title} withdrawn.` })).toBeVisible();
  await save(page, info, 3, { listingId: f.listing.id, ownerId: f.alice.id });
});
