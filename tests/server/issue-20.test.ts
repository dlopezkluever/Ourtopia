import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actor, admin, applyInvite, completedItemFixture, decideApplication, drillDetails, handoffFixture, issueInvite, receipt } from '../../scripts/verify/backend';

type Actor = Awaited<ReturnType<typeof actor>>;
const moderate = (moderator: Actor, communityId: string, userId: string, action: string, reason: string, intent = randomUUID()) =>
  moderator.client.rpc('moderate_membership', { p_intent_id: intent, p_community_id: communityId, p_user_id: userId, p_action: action, p_reason: reason });
const publish = (member: Actor, communityId: string) =>
  member.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: communityId, p_listing_id: null, p_expected_version: 0, p_details: drillDetails });
const moderateContent = (moderator: Actor, communityId: string, kind: string, subjectId: string, reason: string, intent = randomUUID()) =>
  moderator.client.rpc('moderate_content', { p_intent_id: intent, p_community_id: communityId, p_subject_kind: kind, p_subject_id: subjectId, p_reason: reason });

test('Suspension stops new Listings and reinstatement restores them; retries return the prior result and changed payloads fail', async () => {
  const f = await handoffFixture('moderation-suspend');
  const intent = randomUUID();
  const suspended = await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'Repeated late returns.', intent);
  assert.equal(suspended.error, null);
  assert.equal((suspended.data as { status: string }).status, 'suspended');
  assert.deepEqual((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'Repeated late returns.', intent)).data, suspended.data);
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'A different reason.', intent)).error?.code, '23505');
  assert.equal((await publish(f.bob, f.community.id)).error?.code, '42501');
  assert.deepEqual((await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data, []);
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'Second attempt on a suspended row.')).error?.code, '55000');
  const reinstated = await moderate(f.owner, f.community.id, f.bob.id, 'reinstate', 'Reviewed and restored.');
  assert.equal(reinstated.error, null);
  assert.equal((await publish(f.bob, f.community.id)).error, null);
  receipt('issue-20-suspend-reinstate', { suspended: suspended.data, reinstated: reinstated.data });
});

test('Suspended borrowers keep the structured obligation channel for their open Exchange', async () => {
  const f = await handoffFixture('moderation-obligation');
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'Under review.')).error, null);
  assert.equal((await f.bob.client.from('exchanges').select('id').eq('id', f.exchangeId)).data?.length, 1);
  assert.equal((await f.bob.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId })).error, null);
});

test('Removal is terminal: the row cannot be restored by a command or by editing it, and a new Invite reapplies', async () => {
  const f = await handoffFixture('moderation-remove');
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'remove', 'Repeated harassment reports.')).error, null);
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'reinstate', 'Trying to restore.')).error?.code, '55000');
  const edited = await admin.from('memberships').update({ status: 'active' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  assert.ok(edited.error, 'a trigger must reject restoring a removed row');
  assert.equal((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status, 'removed');
  const invite = await issueInvite(f.owner, f.community.id, f.bob.email);
  const application = await applyInvite(f.bob, invite.id);
  assert.equal((await decideApplication(f.owner, application.id)).error, null);
  assert.equal((await publish(f.bob, f.community.id)).error, null);
});

test('Only same-Community administrators moderate; members, self-moderation, and blank reasons are refused', async () => {
  const f = await handoffFixture('moderation-boundaries');
  assert.equal((await moderate(f.bob, f.community.id, f.alice.id, 'suspend', 'Not my decision.')).error?.code, '42501');
  assert.equal((await moderate(f.owner, f.community.id, f.owner.id, 'suspend', 'Myself.')).error?.code, '22023');
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', '   ')).error?.code, '22023');
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'promote', 'Not an action.')).error?.code, '22023');
});

test('Audit rows are immutable even for the service role', async () => {
  const f = await handoffFixture('moderation-audit');
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'Recorded reason.')).error, null);
  assert.ok((await admin.from('moderation_actions').update({ reason: 'Rewritten.' }).eq('community_id', f.community.id)).error);
  assert.ok((await admin.from('moderation_actions').delete().eq('community_id', f.community.id)).error);
});

test('Suspended authors cannot add exchange thank-yous; the completed Exchange and its records stay readable', async () => {
  const f = await completedItemFixture('moderation-thanks', 1);
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'suspend', 'Under review.')).error, null);
  const thanked = await f.bob.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'Thank you for the loan.' });
  assert.ok(thanked.error);
  assert.deepEqual((await admin.from('exchange_thank_yous').select('id').eq('exchange_id', f.exchangeId)).data, []);
  assert.equal((await f.bob.client.from('exchanges').select('id').eq('id', f.exchangeId)).data?.length, 1);
});

test('Content moderation withdraws with a reason, keeps the stored owner, and retries are idempotent', async () => {
  const f = await handoffFixture('moderation-content');
  const intent = randomUUID();
  const withdrawn = await moderateContent(f.owner, f.community.id, 'listing', f.listing.id, 'Unsafe item.', intent);
  assert.equal(withdrawn.error, null);
  assert.equal((withdrawn.data as { owner_id: string }).owner_id, f.alice.id);
  assert.deepEqual((await moderateContent(f.owner, f.community.id, 'listing', f.listing.id, 'Unsafe item.', intent)).data, withdrawn.data);
  assert.equal((await moderateContent(f.owner, f.community.id, 'listing', f.listing.id, 'Unsafe item.')).error?.code, '55000');
  assert.equal((await moderateContent(f.bob, f.community.id, 'listing', f.listing.id, 'Not my call.')).error?.code, '42501');
  assert.equal((await admin.from('listings').select('status').eq('id', f.listing.id).single()).data?.status, 'withdrawn');
  const notices = await admin.from('notification_outbox').select('recipient_id').eq('kind', 'content_moderated');
  assert.ok(notices.data?.some(row => row.recipient_id === f.alice.id));
});
