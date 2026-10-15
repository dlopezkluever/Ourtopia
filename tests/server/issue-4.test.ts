import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor, admin, applyInvite, completedExchanges, createCommunity, decideApplication, issueInvite, membershipFixture, receipt, seedReputationEvent } from '../../scripts/verify/backend';

type Actor = Awaited<ReturnType<typeof actor>>;

async function join(owner: Actor, communityId: string, member: Actor) {
  const application = await applyInvite(member, (await issueInvite(owner, communityId, member.email)).id);
  assert.equal((await decideApplication(owner, application.id)).error, null);
}

async function ownCommunity(owner: Actor, name: string) {
  const result = await createCommunity(owner.client, randomUUID(), name);
  assert.equal(result.error, null);
  return result.data.id as string;
}

async function standing(subject: Actor) {
  const result = await subject.client.rpc('my_reputation');
  assert.equal(result.error, null);
  return result.data as { global: { score: number; title: string; completedInteractions: number }; communities: { communityId: string; name: string; membershipStatus: string; local: { score: number; title: string; completedInteractions: number }; history: unknown[] }[] };
}

// Seeds one Community per entry: `completed` help Exchanges with the subject as requester (no automatic points), then one verified adjustment to reach `score`.
async function scenario(label: string, entries: { score: number; completed: number }[]) {
  const subject = await actor({ label: `${label}-subject` });
  const counterparty = await actor({ label: `${label}-counterparty` });
  const ids: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = await ownCommunity(subject, `${label} circle ${index}`);
    await completedExchanges(id, counterparty.id, subject.id, entry.completed);
    let remaining = entry.score - 50;
    while (remaining !== 0) {
      const step = Math.max(-100, Math.min(100, remaining));
      await seedReputationEvent(id, subject.id, step, `fixture_adjustment_${remaining}`);
      remaining -= step;
    }
    ids.push(id);
  }
  const result = await standing(subject);
  return { subject, ids, global: result.global, local: ids.map(id => result.communities.find(row => row.communityId === id)!.local) };
}

test('new approved member shows 50 Unproven locally and globally in directory, profile, and own standing', async () => {
  const { owner, applicant, community } = await membershipFixture('baseline');
  const pending = await actor({ label: 'baseline-pending' });
  await applyInvite(pending, (await issueInvite(owner, community.id, pending.email)).id);
  await join(owner, community.id, applicant);
  const directory = await owner.client.rpc('member_directory', { p_community_id: community.id });
  assert.equal(directory.error, null);
  assert.deepEqual(z.array(z.object({ email: z.string() })).parse(directory.data).map(row => row.email).sort(), [owner.email, applicant.email].sort());
  for (const row of directory.data) assert.deepEqual([row.score, row.title, row.completed_interactions], [50, 'Unproven', 0]);
  const profile = await owner.client.rpc('member_profile', { p_community_id: community.id, p_subject: applicant.id });
  assert.equal(profile.error, null);
  const data = profile.data as Record<string, unknown>;
  assert.deepEqual(data.local, { score: 50, title: 'Unproven', completedInteractions: 0 });
  assert.equal(data.globalTitle, 'Unproven');
  assert.deepEqual(data.trust, { globalScore: 50, completedInteractions: 0, incidents: [] });
  assert.deepEqual(data.history, []);
  assert.equal((await owner.client.rpc('member_profile', { p_community_id: community.id, p_subject: pending.id })).error?.code, '42501');
  const own = await standing(applicant);
  assert.deepEqual(own.global, { score: 50, title: 'Unproven', completedInteractions: 0 });
  assert.deepEqual(own.communities.map(row => [row.name, row.membershipStatus, row.local]), [[community.name, 'active', { score: 50, title: 'Unproven', completedInteractions: 0 }]]);
  receipt('issue-4-baseline', { directory: directory.data, profile: profile.data, own });
});

test('400 versus 20 interactions weights the global score 20 to 1 with distinct local histories', async () => {
  const first = await membershipFixture('weight-a');
  const second = await membershipFixture('weight-b');
  const subject = first.applicant;
  await join(first.owner, first.community.id, subject);
  await join(second.owner, second.community.id, subject);
  await completedExchanges(first.community.id, first.owner.id, subject.id, 400);
  await completedExchanges(second.community.id, second.owner.id, subject.id, 20);
  await seedReputationEvent(first.community.id, subject.id, 10);
  await seedReputationEvent(second.community.id, subject.id, 31);
  const own = await standing(subject);
  const local = (id: string) => own.communities.find(row => row.communityId === id)!;
  assert.deepEqual(local(first.community.id).local, { score: 60, title: 'Comrade', completedInteractions: 400 });
  assert.deepEqual(local(second.community.id).local, { score: 81, title: 'Revolutionary', completedInteractions: 20 });
  assert.equal(local(first.community.id).history.length, 1);
  assert.equal(local(second.community.id).history.length, 1);
  // (400 × 60 + 20 × 81) / 420 = 61.0; the unweighted mean would be 70.5.
  assert.deepEqual(own.global, { score: 61, title: 'Comrade', completedInteractions: 420 });
  const trust = await first.owner.client.rpc('global_trust', { p_subject: subject.id });
  assert.deepEqual(trust.data, { globalScore: 61, completedInteractions: 420, incidents: [] });
  const helper = await standing(first.owner);
  assert.deepEqual(helper.global, { score: 100, title: 'Dictator', completedInteractions: 400 });
  receipt('issue-4-weighting', { subject: own, helper: helper.global });
});

test('half-up ties, zero weights, clamps, and every title boundary follow the literal arithmetic', async () => {
  const tie = await scenario('tie', [{ score: 50, completed: 1 }, { score: 51, completed: 1 }]);
  assert.deepEqual(tie.global, { score: 51, title: 'Petty Bourgeoisie', completedInteractions: 2 });
  const below = await scenario('below-half', [{ score: 50, completed: 2 }, { score: 51, completed: 1 }]);
  assert.deepEqual(below.global, { score: 50, title: 'Petty Bourgeoisie', completedInteractions: 3 });
  const zero = await scenario('zero-weight', [{ score: 70, completed: 1 }, { score: 0, completed: 0 }]);
  assert.deepEqual(zero.global, { score: 70, title: 'Revolutionary', completedInteractions: 1 });
  assert.deepEqual(zero.local[1], { score: 0, title: 'Unproven', completedInteractions: 0 });
  const clamps = await scenario('clamp', [{ score: 100, completed: 1 }, { score: 0, completed: 1 }]);
  await seedReputationEvent(clamps.ids[0], clamps.subject.id, 100);
  await seedReputationEvent(clamps.ids[1], clamps.subject.id, -100);
  const clamped = await standing(clamps.subject);
  assert.deepEqual(clamped.communities.map(row => row.local.score).sort((a, b) => a - b), [0, 100]);
  assert.deepEqual(clamped.global, { score: 50, title: 'Petty Bourgeoisie', completedInteractions: 2 });
  const scores = [0, 39, 40, 54, 55, 69, 70, 84, 85, 94, 95, 100];
  const titles = await scenario('titles', scores.map(score => ({ score, completed: 1 })));
  assert.deepEqual(titles.local.map(row => [row.score, row.title]), [
    [0, 'Lumpen'], [39, 'Lumpen'], [40, 'Petty Bourgeoisie'], [54, 'Petty Bourgeoisie'], [55, 'Comrade'], [69, 'Comrade'],
    [70, 'Revolutionary'], [84, 'Revolutionary'], [85, 'General'], [94, 'General'], [95, 'Dictator'], [100, 'Dictator'],
  ]);
  // 785 / 12 = 65.42.
  assert.deepEqual(titles.global, { score: 65, title: 'Comrade', completedInteractions: 12 });
  receipt('issue-4-arithmetic', { tie: tie.global, below: below.global, zero: [zero.global, zero.local], clamped: clamped.global, titles: [titles.local, titles.global] });
});

test('completion settlement is idempotent by semantic identity and history is append-only', async () => {
  const { owner, applicant, community } = await membershipFixture('settlement');
  await join(owner, community.id, applicant);
  const pendingRow = await admin.from('exchanges').insert({ community_id: community.id, kind: 'item', provider_id: owner.id, receiver_id: applicant.id, source_kind: 'listing', source_id: randomUUID(), state: 'returned' }).select('id').single();
  assert.equal(pendingRow.error, null);
  const exchangeId = pendingRow.data!.id;
  assert.equal((await admin.rpc('settle_exchange_completions', { p_exchange_ids: [exchangeId] })).error?.code, '55000');
  assert.equal((await admin.from('reputation_events').select('id').eq('exchange_id', exchangeId)).data?.length, 0);
  assert.equal((await admin.from('qualifying_interactions').insert({ exchange_id: exchangeId, community_id: community.id, participant_id: owner.id })).error?.code, '23514');
  assert.equal((await admin.from('exchanges').update({ state: 'completed' }).eq('id', exchangeId)).error, null);
  assert.match((await admin.from('exchanges').update({ provider_id: applicant.id, receiver_id: owner.id }).eq('id', exchangeId)).error?.message ?? '', /immutable/);
  const first = await admin.rpc('settle_exchange_completions', { p_exchange_ids: [exchangeId] });
  const retry = await admin.rpc('settle_exchange_completions', { p_exchange_ids: [exchangeId, exchangeId] });
  assert.equal(first.error, null);
  assert.deepEqual(retry.data, [first.data[0], first.data[0]]);
  const events = (await admin.from('reputation_events').select('rule,recipient_id,points').eq('exchange_id', exchangeId).order('rule')).data;
  assert.deepEqual(events, [{ rule: 'item_borrower_return', recipient_id: applicant.id, points: 1 }, { rule: 'item_owner_share', recipient_id: owner.id, points: 2 }]);
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', exchangeId)).data?.length, 2);
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', exchangeId).eq('kind', 'completion_settled')).data?.length, 1);
  const outsider = await actor({ label: 'settlement-outsider' });
  assert.equal((await admin.from('qualifying_interactions').insert({ exchange_id: exchangeId, community_id: community.id, participant_id: outsider.id })).error?.code, '23514');
  const duplicate = await admin.from('reputation_events').insert({ community_id: community.id, recipient_id: owner.id, rule: 'item_owner_share', points: 5, source_kind: 'exchange', source_id: exchangeId, verified_by_command: 'retry' });
  assert.equal(duplicate.error?.code, '23505');
  for (const table of ['reputation_events', 'qualifying_interactions', 'exchange_events'] as const) {
    assert.equal((await admin.from(table).update({ created_at: new Date().toISOString() }).eq('exchange_id', exchangeId)).error?.code, '42501');
    assert.equal((await admin.from(table).delete().eq('exchange_id', exchangeId)).error?.code, '42501');
  }
  assert.equal((await admin.from('exchanges').delete().eq('id', exchangeId)).error?.code, '42501');
  const owners = await standing(owner);
  assert.deepEqual(owners.communities[0].local, { score: 52, title: 'Petty Bourgeoisie', completedInteractions: 1 });
  const borrower = await standing(applicant);
  assert.deepEqual(borrower.communities[0].local, { score: 51, title: 'Petty Bourgeoisie', completedInteractions: 1 });
  receipt('issue-4-settlement', { exchangeId, settlement: first.data, events, owner: owners.communities[0].local, borrower: borrower.communities[0].local });
});

test('profile queries replay deterministically while upstream history is unchanged', async () => {
  const { owner, applicant, community } = await membershipFixture('replay');
  await join(owner, community.id, applicant);
  await completedExchanges(community.id, owner.id, applicant.id, 3, 'item');
  const reads = async () => Promise.all([
    owner.client.rpc('member_directory', { p_community_id: community.id }),
    owner.client.rpc('member_profile', { p_community_id: community.id, p_subject: applicant.id }),
    applicant.client.rpc('my_reputation'),
    owner.client.rpc('global_trust', { p_subject: applicant.id }),
  ]).then(results => results.map(result => { assert.equal(result.error, null); return result.data; }));
  const before = await reads();
  const counts = async () => Promise.all(['reputation_events', 'qualifying_interactions', 'exchange_events'].map(async table => (await admin.from(table).select('id', { count: 'exact', head: true }).eq('community_id', community.id)).count));
  const countsBefore = await counts();
  for (let index = 0; index < 3; index++) assert.deepEqual(await reads(), before);
  assert.deepEqual(await counts(), countsBefore);
  assert.deepEqual((before[1] as { local: unknown }).local, { score: 53, title: 'Petty Bourgeoisie', completedInteractions: 3 });
  receipt('issue-4-replay', { before, countsBefore });
});
