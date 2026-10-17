import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { acceptHelp, admin, commitHelp, createHelpPost, helpFixture, helpNeedFields, helpScheduleFields, password } from '../../scripts/verify/backend';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('both participants confirm one Help Exchange before it completes and awards only the helper', async ({ page }) => {
  const f = await helpFixture('issue-13-journey', 2);
  const [helper, other] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  const second = await acceptHelp(f.author, await commitHelp(other, 'need_post', need.id));
  assertNoError(await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() }));
  const path = `/help/${f.community.id}/need/${need.id}`;
  await signIn(page, helper.email);
  await page.goto(path);
  const card = page.getByRole('region', { name: `Help Exchange with ${f.author.email}` });
  await card.getByRole('button', { name: 'Confirm completed help' }).click();
  await expect(card).toContainText('Waiting for the other participant to confirm');
  expect((await admin.from('exchanges').select('state').eq('id', exchange.id).single()).data?.state).toBe('completion_pending');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, f.author.email);
  await page.goto(path);
  const requesterCard = page.getByRole('region', { name: `Help Exchange with ${helper.email}` });
  await requesterCard.getByRole('button', { name: 'Confirm completed help' }).click();
  await expect(requesterCard).toContainText('Help completed.');
  await expect(requesterCard).toContainText('Receiving help does not change your score.');
  await expect(requesterCard.getByRole('region', { name: 'Community Solidarity Score' })).toContainText('50');
  expect((await admin.from('exchanges').select('state').eq('id', exchange.id).single()).data?.state).toBe('completed');
  expect((await admin.from('exchanges').select('state').eq('id', second.id).single()).data?.state).toBe('committed');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, helper.email); await page.goto(path);
  const helperCard = page.getByRole('region', { name: `Help Exchange with ${f.author.email}` });
  await expect(helperCard.getByRole('region', { name: 'Community Solidarity Score' })).toContainText('53');
  await expect(helperCard).toContainText('You earned +3 for completing help.');
});

function assertNoError(result: { error: { message: string } | null }) {
  expect(result.error).toBeNull();
}
