import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activeMember, actor, admin, completedExchanges, createCommunity, membershipFixture, publicClient, receipt, seedIncident } from '../../scripts/verify/backend';
import { z } from 'zod';
import { standingSchema, trustSchema } from '../../src/features/reputation/model';

const ownReputationSchema = z.object({ global: standingSchema, communities: z.array(z.object({ membershipStatus: z.string(), history: z.array(z.unknown()) })) });
const memberProfileSchema = z.object({ sharedCommunities: z.array(z.object({ communityId: z.string() })) });

test('ordinary actors see shared detail and only redacted foreign trust', async () => {
  const { owner, community } = await membershipFixture('rls-standing');
  const subject = await activeMember(owner, community.id, 'standing-subject');
  const foreign = await actor({ label: 'foreign-administrator' });
  const other = await createCommunity(foreign.client, randomUUID(), 'Private foreign circle');
  assert.equal(other.error, null);
  const foreignId = String(other.data.id);
  await admin.from('memberships').insert({ community_id: foreignId, user_id: subject.id, role: 'member', status: 'active' }).throwOnError();
  await completedExchanges(foreignId, foreign.id, subject.id, 1, 'item');
  await seedIncident(foreignId, subject.id, 'serious_violation', 'confirmed');
  const result = await owner.client.rpc('global_trust', { p_subject: subject.id });
  assert.equal(result.error, null);
  const trust = trustSchema.parse(result.data);
  assert.deepEqual(trust, { globalScore: 51, completedInteractions: 1, incidents: [{ type: 'serious_violation', status: 'confirmed' }] });
  const serialized = JSON.stringify(result.data);
  for (const secret of [foreignId, foreign.id, 'Private foreign circle', 'source_id', 'community_id', 'messages', 'evidence']) assert.equal(serialized.includes(secret), false);
  const profile = await owner.client.rpc('member_profile', { p_community_id: community.id, p_subject: subject.id });
  assert.equal(profile.error, null);
  assert.deepEqual(memberProfileSchema.parse(profile.data).sharedCommunities.map(row => row.communityId), [community.id]);
  for (const table of ['exchanges', 'exchange_events', 'qualifying_interactions', 'reputation_events', 'trust_incidents'] as const) {
    const rows = await owner.client.from(table).select('*').eq('community_id', foreignId);
    assert.equal(rows.error, null);
    assert.deepEqual(rows.data, []);
  }
  const outsider = await actor({ label: 'unrelated' });
  for (const client of [outsider.client, publicClient()]) {
    assert.equal((await client.rpc('global_trust', { p_subject: subject.id })).error?.code, '42501');
    assert.equal((await client.rpc('member_directory', { p_community_id: community.id })).error?.code, '42501');
    assert.equal((await client.rpc('member_profile', { p_community_id: community.id, p_subject: subject.id })).error?.code, '42501');
  }
  receipt('issue-4-redaction', { trust, sharedCommunities: memberProfileSchema.parse(profile.data).sharedCommunities, foreignSourceRows: 'denied' });
});

test('removed members retain own history while current membership governs other profiles', async () => {
  const { owner, community } = await membershipFixture('former-standing');
  const subject = await activeMember(owner, community.id, 'former-subject');
  await completedExchanges(community.id, owner.id, subject.id, 1, 'item');
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', community.id).eq('user_id', subject.id).throwOnError();
  const own = await subject.client.rpc('my_reputation');
  assert.equal(own.error, null);
  const parsed = ownReputationSchema.parse(own.data);
  assert.deepEqual(parsed.global, { score: 51, title: 'Petty Bourgeoisie', completedInteractions: 1 });
  assert.equal(parsed.communities[0].membershipStatus, 'removed');
  assert.equal(parsed.communities[0].history.length, 1);
  assert.equal((await subject.client.from('reputation_events').select('id').eq('recipient_id', subject.id)).data?.length, 1);
  assert.equal((await subject.client.rpc('member_directory', { p_community_id: community.id })).error?.code, '42501');
  assert.equal((await subject.client.rpc('global_trust', { p_subject: owner.id })).error?.code, '42501');
  assert.equal((await owner.client.rpc('member_profile', { p_community_id: community.id, p_subject: subject.id })).error?.code, '42501');
  for (const table of ['reputation_events', 'qualifying_interactions', 'trust_incidents'] as const) {
    const rows = await owner.client.from(table).select('id').eq(table === 'qualifying_interactions' ? 'participant_id' : table === 'trust_incidents' ? 'subject_id' : 'recipient_id', subject.id);
    assert.equal(rows.error, null);
    assert.deepEqual(rows.data, []);
  }
  receipt('issue-4-former-membership', parsed);
});

test('clients cannot forge scores ledger facts completions configuration or audit', async () => {
  const { owner, community } = await membershipFixture('standing-writes');
  const subject = await activeMember(owner, community.id, 'write-subject');
  const [exchangeId] = await completedExchanges(community.id, owner.id, subject.id, 1, 'item');
  const client = subject.client;
  const denied = await Promise.all([
    client.from('reputation_events').insert({ community_id: community.id, recipient_id: subject.id, rule: 'forged', points: 100, source_kind: 'exchange', source_id: exchangeId, verified_by_command: 'client' }),
    client.from('qualifying_interactions').insert({ exchange_id: exchangeId, community_id: community.id, participant_id: subject.id }),
    client.from('exchange_events').insert({ exchange_id: exchangeId, community_id: community.id, kind: 'forged' }),
    client.from('exchanges').update({ state: 'cancelled' }).eq('id', exchangeId),
    client.from('reputation_rules').update({ points: 100 }).eq('rule', 'item_borrower_return'),
    client.from('reputation_titles').update({ min_score: 0 }).eq('title', 'Dictator'),
    client.from('trust_incidents').insert({ community_id: community.id, subject_id: owner.id, type: 'serious_violation', status: 'confirmed', source_kind: 'forged', source_id: randomUUID() }),
    client.from('community_events').insert({ community_id: community.id, actor_id: subject.id, intent_id: randomUUID(), kind: 'forged' }),
    client.rpc('settle_exchange_completions', { p_exchange_ids: [exchangeId] }),
  ]);
  for (const result of denied) assert.equal(result.error?.code, '42501');
  const own = await client.rpc('my_reputation');
  assert.deepEqual(ownReputationSchema.parse(own.data).global, { score: 51, title: 'Petty Bourgeoisie', completedInteractions: 1 });
  receipt('issue-4-write-denials', { codes: denied.map(result => result.error?.code), standing: own.data });
});
