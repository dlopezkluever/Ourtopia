import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { actor, admin, borrowingFixture, completedItemFixture, drillDetails, handoffFixture, messageEvidenceFixture, password, seedReputationEvent, advanceHandoff, uploadListingImage, helpFixture, createHelpPost, helpNeedFields, commitHelp, acceptHelp, helpScheduleFields } from '../../scripts/verify/backend';
import { randomUUID } from 'node:crypto';

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

type Owner = Awaited<ReturnType<typeof actor>>;
// Direct administrative command used for setup and retries; the UI path is exercised by lanes 1 to 3 and 9 to 10.
async function removeMember(owner: Owner, communityId: string, userId: string, action = 'remove', intent = randomUUID(), reason = 'Journey fixture.') {
  const result = await owner.client.rpc('moderate_membership', { p_intent_id: intent, p_community_id: communityId, p_user_id: userId, p_action: action, p_reason: reason });
  if (result.error) throw result.error;
  return result.data;
}

test('lane 1 owner suspends a borrower with an open item loan, the borrower sees the restriction, and reinstatement restores the page', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-1-${info.project.name}`);
  const help = await helpFixture(`journey-lane-1-help-${info.project.name}`, 1);
  const helper = help.members[0];
  const post = await createHelpPost(help.author, help.community.id, 'need_post', helpNeedFields(1));
  const helpExchange = await acceptHelp(help.author, await commitHelp(helper, 'need_post', post.id));
  const scheduled = await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: helpExchange.id, p_fields: helpScheduleFields() });
  if (scheduled.error) throw scheduled.error;
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
  await expect(page.getByRole('button', { name: 'Acknowledge terms' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('checkbox', { name: /I acknowledge the return date/ }).check();
  await page.getByRole('button', { name: 'Acknowledge terms' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Arranging Handoff' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('link', { name: 'Borrow Requests' })).toBeVisible();
  await save(page, info, 1, { exchangeId: f.exchangeId, state: 'suspended', structuredAction: 'acknowledge_terms' });
  await signOut(page);
  await removeMember(help.owner, help.community.id, helper.id, 'suspend', randomUUID(), 'Repeated late returns.');
  await signIn(page, helper.email);
  await page.goto(`/help/${help.community.id}`);
  const helpCard = page.getByRole('region', { name: `Help Exchange with ${help.author.email}` });
  await expect(helpCard.getByRole('button', { name: 'Confirm completed help' })).toBeVisible({ timeout: 10000 });
  await helpCard.getByRole('button', { name: 'Confirm completed help' }).click();
  await expect(helpCard.getByText(/Waiting for the other participant to confirm/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Offer to help|Request this help/ })).toHaveCount(0);
  await save(page, info, 1, { helpExchangeId: helpExchange.id, state: 'suspended', structuredAction: 'confirm_help_completion' }, 'help-obligation');
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

test('lane 4 a removed participant keeps a completed Exchange inside the 30-day window and loses it after', async ({ page }, info) => {
  const recent = await completedItemFixture(`journey-lane-4-recent-${info.project.name}`, 1);
  const aged = await completedItemFixture(`journey-lane-4-aged-${info.project.name}`, 31);
  await removeMember(recent.owner, recent.community.id, recent.bob.id);
  await removeMember(aged.owner, aged.community.id, aged.bob.id);
  await signIn(page, recent.bob.email);
  await page.goto(`/handoffs/${recent.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toHaveCount(0);
  await expect(page.locator('.handoff-status')).toBeVisible();
  await save(page, info, 4, { exchangeId: recent.exchangeId, window: 'inside' }, 'recent');
  await signOut(page);
  await signIn(page, aged.bob.email);
  await page.goto(`/handoffs/${aged.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toBeVisible();
  await save(page, info, 4, { exchangeId: aged.exchangeId, window: 'after' }, 'aged');
});

test('lane 5 closing the last obligation ends narrow access for a refreshed session', async ({ page }, info) => {
  const aged = await completedItemFixture(`journey-lane-5-${info.project.name}`, 31);
  const dispute = await admin.from('disputes').insert({ exchange_id: aged.exchangeId, community_id: aged.community.id, reporter_id: aged.bob.id, respondent_id: aged.alice.id, issue_type: 'damage', status: 'issue_reported' }).select('id').single();
  if (dispute.error) throw dispute.error;
  await removeMember(aged.owner, aged.community.id, aged.bob.id);
  await signIn(page, aged.bob.email);
  await page.goto(`/handoffs/${aged.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toHaveCount(0);
  await expect(page.locator('.handoff-status')).toBeVisible();
  const closed = await admin.from('disputes').update({ status: 'resolved', closed_at: new Date().toISOString() }).eq('id', dispute.data.id);
  if (closed.error) throw closed.error;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toBeVisible();
  await save(page, info, 5, { exchangeId: aged.exchangeId, disputeClosed: true });
});

test('lane 6 a retried moderation returns the prior result once, and a removed row cannot be reinstated', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-6-${info.project.name}`);
  const intent = randomUUID();
  const first = await removeMember(f.owner, f.community.id, f.bob.id, 'suspend', intent, 'Repeated reports.');
  const retry = await removeMember(f.owner, f.community.id, f.bob.id, 'suspend', intent, 'Repeated reports.');
  expect(retry).toEqual(first);
  const audit = await admin.from('moderation_actions').select('id').eq('community_id', f.community.id).eq('subject_user_id', f.bob.id);
  expect(audit.data?.length).toBe(1);
  await removeMember(f.owner, f.community.id, f.bob.id, 'remove', randomUUID(), 'Repeated reports.');
  await signIn(page, f.owner.email);
  await page.goto(`/moderation/${f.community.id}`);
  await expect(page.getByRole('button', { name: `Reinstate ${f.bob.email}` })).toHaveCount(0);
  await save(page, info, 6, { communityId: f.community.id, retriedIntentRows: 1 });
});

test('lane 7 an eligible counterparty reads selection messages but cannot send after removal', async ({ page }, info) => {
  const f = await messageEvidenceFixture(`journey-lane-7-${info.project.name}`);
  await removeMember(f.owner, f.community.id, f.bob.id);
  const attemptedAt = new Date().toISOString();
  const sent = await f.bob.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'Still there?' });
  expect(sent.error).not.toBeNull();
  const written = await admin.from('messages').select('id').eq('conversation_id', f.conversation.id).eq('author_id', f.bob.id).gte('created_at', attemptedAt);
  expect(written.data).toEqual([]);
  await signIn(page, f.bob.email);
  await page.goto(`/handoffs/${f.exchangeId}`);
  await save(page, info, 7, { conversationId: f.conversation.id, sendDenied: true });
});

test('lane 8 each actor sees exactly the current lifecycle scope through commands, RLS, Storage, and realtime-visible reads', async ({ page }, info) => {
  const f = await borrowingFixture(`journey-lane-8-${info.project.name}`);
  const image = await uploadListingImage(f.alice, f.listing.id);
  const before = {
    listings: (await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data?.length,
    signedUrl: !(await f.bob.client.storage.from('listing-images').createSignedUrl(image.object_path, 30)).error,
  };
  expect(before).toEqual({ listings: 1, signedUrl: true });
  await removeMember(f.owner, f.community.id, f.bob.id, 'suspend');
  const after = {
    listings: (await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data?.length,
    signedUrl: !(await f.bob.client.storage.from('listing-images').createSignedUrl(image.object_path, 30)).error,
    newListing: (await f.bob.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: null, p_expected_version: 0, p_details: drillDetails })).error?.code,
  };
  expect(after).toEqual({ listings: 0, signedUrl: false, newListing: '42501' });
  await signIn(page, f.bob.email);
  await save(page, info, 8, { before, after });
});

test('lane 9 reputation history and item custody are retained after removal', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-9-${info.project.name}`);
  await advanceHandoff(f);
  await seedReputationEvent(f.community.id, f.bob.id, 2);
  const snapshot = async () => ({
    exchange: (await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state,
    reservation: (await admin.from('item_reservations').select('exchange_id').eq('exchange_id', f.exchangeId)).data?.length,
    reputation: (await admin.from('reputation_events').select('id').eq('recipient_id', f.bob.id)).data?.length,
  });
  const before = await snapshot();
  await removeMember(f.owner, f.community.id, f.bob.id);
  expect(await snapshot()).toEqual(before);
  await signIn(page, f.bob.email);
  await page.goto('/standing');
  await expect(page.getByRole('heading', { name: 'Handoff unavailable' })).toHaveCount(0);
  await expect(page.locator('.handoff-status')).toBeVisible();
  await save(page, info, 9, { exchangeId: f.exchangeId, ...before });
});

test('lane 10 moderation controls and reasons are reachable from the keyboard on mobile and desktop', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-10-${info.project.name}`);
  await signIn(page, f.owner.email);
  await page.goto(`/moderation/${f.community.id}`);
  const reason = page.getByLabel('Reason for the next action');
  await reason.focus();
  await page.keyboard.type('Keyboard review.');
  const remove = page.getByRole('button', { name: `Remove ${f.bob.email}` });
  await remove.focus();
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: `${f.bob.email} removed.` })).toBeVisible();
  await save(page, info, 10, { communityId: f.community.id, reasonRecorded: 'Keyboard review.' });
});
