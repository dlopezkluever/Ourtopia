import { expect, test, type Page } from '@playwright/test';
import { admin, checkedOutFixture, completeReturn, password } from '../../scripts/verify/backend';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('A participant thanks their partner after completion and the note appears on the profile and private Community feed', async ({ page }) => {
  const f = await checkedOutFixture('thanks-journey');
  await completeReturn(f);
  await signIn(page, f.bob.email);
  await page.goto(`/handoffs/${f.exchangeId}`);
  await expect(page.getByRole('region', { name: 'Completed loan' })).toBeVisible();
  const message = 'Thanks for lending your drill and making the repair possible.';
  const thankYou = page.getByRole('region', { name: 'Thank your Exchange partner' });
  await thankYou.getByLabel(/A public thank-you/).fill(message);
  await thankYou.getByRole('button', { name: 'Thank your partner', exact: true }).click();
  await expect(thankYou.getByRole('status')).toContainText('one thank-you point');
  const thankYous = await admin.from('exchange_thank_yous').select('message,author_id,recipient_id').eq('exchange_id', f.exchangeId);
  expect(thankYous.data).toEqual([{ message, author_id: f.bob.id, recipient_id: f.alice.id }]);
  const rewards = await admin.from('reputation_events').select('points,recipient_id').eq('exchange_id', f.exchangeId).eq('rule', 'exchange_thank_you');
  expect(rewards.data).toEqual([{ points: 1, recipient_id: f.alice.id }]);
  const interactions = await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId);
  expect(interactions.data).toHaveLength(2);

  await page.goto(`/communities/${f.community.id}/members/${f.alice.id}`);
  await expect(page.getByRole('region', { name: 'Thank-yous received' })).toContainText(message);
  await page.goto(`/communities/${f.community.id}`);
  await expect(page.getByRole('region', { name: 'Community activity feed' })).toContainText(message);
  await expect(page.getByText('No thank-yous yet.')).toHaveCount(0);
});
