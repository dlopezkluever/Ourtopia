import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, admin, createCommunity, publicClient, receipt } from '../../scripts/verify/backend';
import { communitySchema } from '../../src/features/communities/model';

test('verified creation atomically persists private Community, first active administrator, and audit', async () => {
  const owner = await actor();
  const intent = randomUUID();
  const { data, error } = await createCommunity(owner.client, intent);
  assert.equal(error, null);
  const community = communitySchema.parse(data);
  assert.equal(community.created_by, owner.id);
  const membership = await owner.client.from('memberships').select('role,status,user_id').eq('community_id', community.id);
  assert.deepEqual(membership.data, [{ role: 'administrator', status: 'active', user_id: owner.id }]);
  const events = await owner.client.from('community_events').select('kind,intent_id').eq('community_id', community.id);
  assert.deepEqual(events.data, [{ kind: 'community_created', intent_id: intent }]);
  receipt('server-creation', { communityId: community.id, membership: membership.data, events: events.data });
});

test('concurrent identical intent returns one result; changed payload fails with no partial state', async () => {
  const owner = await actor();
  const intent = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => createCommunity(owner.client, intent)));
  for (const result of results) assert.equal(result.error, null);
  const ids = results.map(result => communitySchema.parse(result.data).id);
  assert.equal(new Set(ids).size, 1);
  const retry = await createCommunity(owner.client, intent);
  assert.equal(communitySchema.parse(retry.data).id, ids[0]);
  const changed = await createCommunity(owner.client, intent, 'Different Community');
  assert.equal(changed.error?.code, '23505');
  const rows = await owner.client.from('communities').select('id');
  assert.deepEqual(rows.data, [{ id: ids[0] }]);
  const memberships = await owner.client.from('memberships').select('role,status');
  assert.deepEqual(memberships.data, [{ role: 'administrator', status: 'active' }]);
  const changedIntent = randomUUID();
  const race = await Promise.all([createCommunity(owner.client, changedIntent, 'First payload'), createCommunity(owner.client, changedIntent, 'Second payload')]);
  assert.equal(race.filter(result => result.error === null).length, 1);
  assert.equal(race.filter(result => result.error?.code === '23505').length, 1);
  receipt('server-idempotency', { sameIntentCalls: 8, uniqueResults: 1, changedPayloadCode: changed.error?.code, changedPayloadRaceSuccesses: 1 });
});

test('unverified DB user with authenticated JWT and forged verified claim cannot create', async () => {
  const unverified = await actor({ verified: false });
  const result = await createCommunity(unverified.client);
  assert.equal(result.error?.code, '42501');
  const communities = await admin.from('communities').select('id').eq('created_by', unverified.id);
  const memberships = await admin.from('memberships').select('community_id').eq('user_id', unverified.id);
  assert.deepEqual(communities.data, []);
  assert.deepEqual(memberships.data, []);
  const anonymous = await createCommunity(publicClient());
  assert.equal(anonymous.error?.code, '42501');
  receipt('server-unverified', { unverifiedCode: result.error?.code, anonymousCode: anonymous.error?.code, communities: 0, memberships: 0 });
});

test('invalid payload and revoked access retries leave state unchanged', async () => {
  const owner = await actor();
  const invalid = await createCommunity(owner.client, randomUUID(), ' ');
  assert.equal(invalid.error?.code, '22023');
  assert.deepEqual((await owner.client.from('communities').select('id')).data, []);
  const intent = randomUUID();
  const created = communitySchema.parse((await createCommunity(owner.client, intent)).data);
  const { error } = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', created.id).eq('user_id', owner.id);
  assert.equal(error, null);
  const stale = await createCommunity(owner.client, intent);
  assert.equal(stale.error?.code, '42501');
  assert.deepEqual((await owner.client.from('communities').select('id')).data, []);
  receipt('server-revoked-retry', { code: stale.error?.code, visibleCommunities: 0 });
});
