import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeMember, admin, completedItemFixture, membershipFixture, publicClient, receipt } from '../../scripts/verify/backend';

test('pilot metrics deny same-community members, foreign administrators, anonymous users, and removed former administrators', async () => {
  const fixture = await completedItemFixture('pilot-metrics-rls');
  const member = await activeMember(fixture.owner, fixture.community.id, 'pilot-metrics-member');
  const foreign = await membershipFixture('pilot-metrics-foreign');

  const ownerRead = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(ownerRead.error, null);
  assert.deepEqual(Object.keys(ownerRead.data as object).sort(), ['billing', 'communityId', 'communityName', 'counts', 'generatedAt', 'sources']);
  assert.equal((await member.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id })).error?.code, '42501');
  assert.equal((await foreign.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id })).error?.code, '42501');
  assert.equal((await publicClient().rpc('read_pilot_metrics', { p_community_id: fixture.community.id })).error?.code, '42501');

  const removed = await admin.from('memberships').update({ status: 'removed' })
    .eq('community_id', fixture.community.id).eq('user_id', fixture.owner.id);
  assert.equal(removed.error, null);
  const former = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(former.error?.code, '42501');
  receipt('issue-25-metrics-rls', { owner: 'allowed', ordinaryMember: '42501', foreignAdministrator: '42501', anonymous: '42501', removedFormerAdministrator: '42501' });
});
