import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { admin, completedItemFixture, decideBorrow, password, requestItem } from '../../scripts/verify/backend';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: /Welcome to .*\./ })).toBeVisible();
}

async function openMetrics(page: Page, communityId: string) {
  await page.getByRole('link', { name: 'Pilot health and activity export' }).click();
  await expect(page.getByRole('heading', { name: 'Pilot health' })).toBeVisible();
  await expect(page.getByText(/Persisted activity for .* Totals reconcile/)).toBeVisible();
  expect(page.url()).toContain(`/metrics/${communityId}`);
}

async function save(page: Page, info: TestInfo, lane: number, data: unknown) {
  const path = info.outputPath(`lane-${lane}/scenario.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  writeFileSync(info.outputPath(`lane-${lane}/scenario.json`), JSON.stringify({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    project: info.project.name,
    viewport: page.viewportSize(),
    data,
  }, null, 2));
}

for (const lane of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  test(`lane ${lane} persisted pilot metrics reconcile and export on desktop and mobile`, async ({ page }, info) => {
    const fixture = await completedItemFixture(`pilot-metrics-lane-${lane}-${info.project.name}`);
    const request = await requestItem(fixture.bob, fixture.listing.id);
    const approved = await decideBorrow(fixture.alice, request);
    expect(approved.error).toBeNull();
    const decoys = await admin.from('exchanges').insert(['approved', 'cancelled', 'expired', 'closed_without_completion'].map(state => ({
      community_id: fixture.community.id,
      kind: 'item',
      provider_id: fixture.alice.id,
      receiver_id: fixture.bob.id,
      source_kind: 'listing',
      source_id: fixture.listing.id,
      state,
    })));
    expect(decoys.error).toBeNull();
    const persisted = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
    expect(persisted.error).toBeNull();
    const counts = (persisted.data as { counts: Record<string, number> }).counts;
    expect(counts.activeMembers).toBe(4);
    expect(counts.itemListings).toBe(1);
    expect(counts.borrowRequestsApproved).toBe(1);
    expect(counts.exchangesStarted).toBe(6);
    expect(counts.exchangesCompleted).toBe(1);

    await signIn(page, fixture.owner.email);
    await expect(page.getByRole('link', { name: 'Pilot health and activity export' })).toBeVisible();
    await openMetrics(page, fixture.community.id);
    await expect(page.getByText('Verified completed Exchanges')).toBeVisible();
    await expect(page.getByText('1 of 5')).toBeVisible();
    await expect(page.getByText('Simulated billing only. These are test subscription records, not paid revenue or a requirement for Community access.')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download auditable CSV' }).focus();
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe(`ourtopia-pilot-metrics-${fixture.community.id}.csv`);
    await save(page, info, lane, { counts, exportName: file.suggestedFilename() });
  });
}
