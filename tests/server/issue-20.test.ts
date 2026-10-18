import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actor, admin, advanceHandoff, applyInvite, borrowingFixture, completedItemFixture, decideApplication, decideBorrow, drillDetails, handoffFixture, issueInvite, messageEvidenceFixture, receipt, reportIssue, requestItem, seedReputationEvent } from '../../scripts/verify/backend';

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

test('Approval re-checks the borrower membership and the Listing status; rejection stays open to the owner', async () => {
  const f = await borrowingFixture('moderation-borrow');
  const suspendedRequest = await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-03');
  assert.equal((await moderate(f.owner, f.community.id, f.carol.id, 'suspend', 'Under review.')).error, null);
  assert.equal((await decideBorrow(f.alice, suspendedRequest)).error?.code, '55000');
  assert.equal((await decideBorrow(f.alice, suspendedRequest, 'rejected')).error, null);
  const withdrawnRequest = await requestItem(f.bob, f.listing.id, '2027-03-01', '2027-03-03');
  assert.equal((await moderateContent(f.owner, f.community.id, 'listing', f.listing.id, 'Unsafe item.')).error, null);
  assert.equal((await decideBorrow(f.alice, withdrawnRequest)).error?.code, '55000');
  assert.deepEqual((await admin.from('item_reservations').select('exchange_id').eq('listing_id', f.listing.id)).data, []);
});

test('A removed participant can file a later Dispute only inside the original 30-day window', async () => {
  const recent = await completedItemFixture('moderation-window-open', 1);
  assert.equal((await moderate(recent.owner, recent.community.id, recent.bob.id, 'remove', 'Reviewed.')).error, null);
  assert.equal((await reportIssue(recent.bob, recent.exchangeId)).error, null);
  const aged = await completedItemFixture('moderation-window-closed', 31);
  assert.equal((await moderate(aged.owner, aged.community.id, aged.bob.id, 'remove', 'Reviewed.')).error, null);
  assert.equal((await reportIssue(aged.bob, aged.exchangeId)).error?.code, '42501');
});

test('Removal keeps Exchange custody, schedule records, and reputation events in place', async () => {
  const f = await handoffFixture('moderation-custody');
  await advanceHandoff(f);
  await seedReputationEvent(f.community.id, f.bob.id, 2);
  const snapshot = async () => ({
    exchange: (await admin.from('exchanges').select('state,provider_id,receiver_id').eq('id', f.exchangeId).single()).data,
    reservation: (await admin.from('item_reservations').select('exchange_id,custody_unresolved').eq('exchange_id', f.exchangeId).single()).data,
    events: (await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId)).data?.length,
    reputation: (await admin.from('reputation_events').select('id').eq('recipient_id', f.bob.id)).data?.length,
  });
  const before = await snapshot();
  assert.equal((await moderate(f.owner, f.community.id, f.bob.id, 'remove', 'Reviewed.')).error, null);
  assert.deepEqual(await snapshot(), before);
  assert.ok((before.reputation ?? 0) >= 1);
});

test('A nonparticipant administrator cannot read the conversation or its messages', async () => {
  const f = await messageEvidenceFixture('moderation-admin-conversation');
  assert.deepEqual((await f.owner.client.from('conversations').select('id').eq('id', f.conversation.id)).data, []);
  assert.deepEqual((await f.owner.client.from('messages').select('id').eq('conversation_id', f.conversation.id)).data, []);
});
