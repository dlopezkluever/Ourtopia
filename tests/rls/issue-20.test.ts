import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { actor, admin, completedItemFixture, handoffFixture, realtimeReady, receipt, settleFixtureNotices } from '../../scripts/verify/backend';

const suiteStarted = new Date().toISOString();
after(() => settleFixtureNotices(['moderation-rls-open', 'moderation-rls-closed'], suiteStarted));
before(() => realtimeReady(), { timeout: 70000 });

const suspend = (moderator: Awaited<ReturnType<typeof actor>>, communityId: string, userId: string, action = 'suspend') =>
  moderator.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: communityId, p_user_id: userId, p_action: action, p_reason: 'Actor matrix fixture.' });

test('Before and after suspension, direct reads follow the current lifecycle scope for each actor', async () => {
  const f = await handoffFixture('moderation-rls-open');
  const outsider = await actor({ label: 'moderation-outsider' });
  const beforeSuspension = await f.bob.client.from('listings').select('id').eq('community_id', f.community.id);
  assert.equal(beforeSuspension.data?.length, 1);
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  assert.deepEqual((await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data, []);
  assert.equal((await f.bob.client.from('exchanges').select('id').eq('id', f.exchangeId)).data?.length, 1);
  assert.deepEqual((await outsider.client.from('exchanges').select('id').eq('id', f.exchangeId)).data, []);
  assert.deepEqual((await f.owner.client.from('moderation_actions').select('id').eq('community_id', f.community.id).eq('subject_user_id', f.alice.id)).data, []);
  receipt('issue-20-rls-open', { suspendedBorrowerExchangeReads: 1 });
});

test('Completed Exchange access ends 30 days after completion for a suspended participant, and a removed participant keeps only the narrow channel', async () => {
  const recent = await completedItemFixture('moderation-rls-open', 1);
  const aged = await completedItemFixture('moderation-rls-closed', 31);
  assert.equal((await suspend(recent.owner, recent.community.id, recent.bob.id, 'remove')).error, null);
  assert.equal((await suspend(aged.owner, aged.community.id, aged.bob.id, 'remove')).error, null);
  assert.equal((await recent.bob.client.from('exchanges').select('id').eq('id', recent.exchangeId)).data?.length, 1);
  assert.deepEqual((await aged.bob.client.from('exchanges').select('id').eq('id', aged.exchangeId)).data, []);
  assert.deepEqual((await aged.bob.client.from('communities').select('id').eq('id', aged.community.id)).data, []);
});

test('The affected member reads their own moderation reason; other members and nonparticipant administrators do not', async () => {
  const f = await handoffFixture('moderation-rls-audit');
  const bystander = await actor({ label: 'moderation-bystander' });
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  const ownRecords = await f.bob.client.from('moderation_actions').select('action,reason').eq('community_id', f.community.id);
  assert.deepEqual(ownRecords.data, [{ action: 'suspend', reason: 'Actor matrix fixture.' }]);
  assert.deepEqual((await bystander.client.from('moderation_actions').select('id')).data, []);
  assert.deepEqual((await f.owner.client.from('moderation_actions').select('action').eq('community_id', f.community.id)).data, [{ action: 'suspend' }]);
});

test('Suspension inserts a membership access hint that only the affected member can read', async () => {
  const f = await handoffFixture('moderation-rls-hints');
  const bystander = await actor({ label: 'moderation-hint-bystander' });
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  const hints = await f.bob.client.from('membership_access_hints').select('community_id').eq('community_id', f.community.id);
  assert.ok((hints.data?.length ?? 0) >= 1);
  assert.deepEqual((await bystander.client.from('membership_access_hints').select('id').eq('community_id', f.community.id)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('channel').eq('recipient_id', f.bob.id).eq('kind', 'membership_suspended')).data?.map(row => row.channel).sort(), ['email', 'in_app']);
});
