import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';
import { activeMember, admin, caseAction, completedExchanges, listingFixture, membershipFixture, receipt, reviewedDispute, seedIncident, seedReputationEvent, unresolvedDecidedDispute } from '../../scripts/verify/backend';

const standing = z.object({
  global: z.object({ score: z.number(), completedInteractions: z.number() }),
  communities: z.array(z.object({
    communityId: z.uuid(), local: z.object({ score: z.number(), completedInteractions: z.number(), title: z.string() }),
    history: z.array(z.object({ id: z.uuid(), points: z.number(), correctsEventId: z.uuid().nullable() })),
  })),
});
const trustSchema = z.object({ globalScore: z.number(), completedInteractions: z.number(), incidents: z.array(z.object({ type: z.string(), status: z.string() }).strict()) }).strict();

type Member = Awaited<ReturnType<typeof membershipFixture>>['owner'];

async function myStanding(member: Member) {
  const result = await member.client.rpc('my_reputation');
  assert.equal(result.error, null);
  return standing.parse(result.data);
}

// Mirrors the server's half-up rounding over completed-interaction weights.
function expectedGlobal(rows: { weight: number; score: number }[]) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  const weighted = rows.reduce((sum, row) => sum + row.weight * row.score, 0);
  return Math.floor((2 * weighted + total) / (2 * total));
}

test('Verified misconduct applies each rule once and a correction appends a linked compensation', async () => {
  const f = await unresolvedDecidedDispute('misconduct-ledger');
  const before = await admin.from('qualifying_interactions').select('id,participant_id').eq('exchange_id', f.exchangeId).order('participant_id');
  const expected = [['late_return', -2], ['unresolved_damage', -10], ['confirmed_theft', -30]] as const;
  const events: { id: string; rule: string; points: number }[] = [];
  for (const [rule, points] of expected) {
    const intent = randomUUID();
    const args = { p_intent_id: intent, p_dispute_id: f.disputeId, p_rule: rule, p_recipient_id: f.bob.id, p_reason: `Verified ${rule} from the case record.` };
    const result = await f.owner.client.rpc('record_verified_misconduct', args);
    assert.equal(result.error, null);
    assert.deepEqual((await f.owner.client.rpc('record_verified_misconduct', args)).data, result.data);
    const eventId = (result.data as { eventId: string }).eventId;
    const stored = await admin.from('reputation_events').select('id,rule,points').eq('id', eventId).single();
    assert.deepEqual(stored.data, { id: eventId, rule, points });
    assert.equal((await f.owner.client.rpc('record_verified_misconduct', { ...args, p_reason: 'Changed payload' })).error?.code, '23505');
    events.push(stored.data!);
  }
  assert.equal((await admin.from('reputation_events').select('id').eq('source_kind', 'dispute').eq('source_id', f.disputeId).eq('recipient_id', f.bob.id)).data?.length, 3);
  assert.deepEqual((await admin.from('trust_incidents').select('type,status').eq('source_kind', 'reputation_event').eq('source_id', events[2].id)).data,
    [{ type: 'serious_violation', status: 'confirmed' }]);

  const duplicate = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'A second intent must not repeat the penalty.' });
  assert.equal(duplicate.error?.code, '23505');
  const notBorrower = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'late_return',
    p_recipient_id: f.alice.id, p_reason: 'Late return is charged to the borrower only.' });
  assert.equal(notBorrower.error?.code, '22023');

  const correctionIntent = randomUUID();
  const correctionArgs = { p_intent_id: correctionIntent, p_event_id: events[1].id, p_reason: 'A dated repair receipt was verified after the decision.' };
  const correction = await f.owner.client.rpc('correct_reputation_event', correctionArgs);
  assert.equal(correction.error, null);
  assert.deepEqual((await f.owner.client.rpc('correct_reputation_event', correctionArgs)).data, correction.data);
  const correctionAgain = await f.owner.client.rpc('correct_reputation_event', { ...correctionArgs, p_intent_id: randomUUID() });
  assert.equal(correctionAgain.error?.code, '55000');
  const correctionChanged = await f.owner.client.rpc('correct_reputation_event', { ...correctionArgs, p_reason: 'Different reason' });
  assert.equal(correctionChanged.error?.code, '23505');

  const correctionRow = await admin.from('reputation_events').select('points,corrects_event_id,reason,verified_by,source_kind').eq('id', (correction.data as { eventId: string }).eventId).single();
  assert.deepEqual(correctionRow.data, { points: 10, corrects_event_id: events[1].id, reason: correctionArgs.p_reason, verified_by: f.owner.id, source_kind: 'reputation_correction' });
  const original = await admin.from('reputation_events').select('points,corrects_event_id').eq('id', events[1].id).single();
  assert.deepEqual(original.data, { points: -10, corrects_event_id: null });
  assert.deepEqual((await admin.from('qualifying_interactions').select('id,participant_id').eq('exchange_id', f.exchangeId).order('participant_id')).data, before.data);

  const mine = await myStanding(f.bob);
  const community = mine.communities.find(row => row.communityId === f.community.id);
  assert.deepEqual(community?.history.map(entry => entry.points).sort((a, b) => a - b), [-30, -10, -2, 10]);
  assert.equal(community?.local.score, 18);
  assert.ok(community?.history.some(entry => entry.id === events[1].id && entry.points === -10));
  assert.ok(community?.history.some(entry => entry.correctsEventId === events[1].id && entry.points === 10));
  receipt('issue-18-ledger', { weights: expected, correction: correctionRow.data, qualifyingInteractionsPreserved: before.data?.length ?? 0, localScore: community?.local.score });
});

test('Standing clamps to 0 to 100, rounds the global score half up, and keeps completed Exchange counts', async () => {
  const low = await listingFixture('clamp-low');
  const high = await listingFixture('clamp-high');
  const bob = low.bob;
  await completedExchanges(low.community.id, low.alice.id, bob.id, 1, 'item');
  await completedExchanges(high.community.id, high.alice.id, bob.id, 1, 'item');
  await seedReputationEvent(low.community.id, bob.id, -100);
  await seedReputationEvent(low.community.id, bob.id, -100);
  await seedReputationEvent(high.community.id, bob.id, -50);
  const mine = await myStanding(bob);
  const lowRow = mine.communities.find(row => row.communityId === low.community.id);
  const highRow = mine.communities.find(row => row.communityId === high.community.id);
  assert.equal(lowRow?.local.score, 0);
  assert.equal(highRow?.local.score, 1);
  assert.equal(lowRow?.local.completedInteractions, 1);
  assert.equal(highRow?.local.completedInteractions, 1);
  assert.equal(mine.global.completedInteractions, 2);
  assert.equal(mine.global.score, expectedGlobal([{ weight: 1, score: 0 }, { weight: 1, score: 1 }]));
  assert.equal(mine.global.score, 1);

  await seedReputationEvent(high.community.id, bob.id, 100);
  const capped = await myStanding(bob);
  assert.equal(capped.communities.find(row => row.communityId === high.community.id)?.local.score, 100);
});

test('A low-volume serious incident stays visible in redacted cross-Community trust without foreign identity', async () => {
  const viewer = await membershipFixture('redact-big');
  const bob = await activeMember(viewer.owner, viewer.community.id, 'redact-bob');
  const small = await membershipFixture('redact-small');
  await completedExchanges(viewer.community.id, viewer.owner.id, bob.id, 400, 'item');
  await completedExchanges(small.community.id, small.owner.id, bob.id, 20, 'item');
  await seedIncident(small.community.id, bob.id, 'serious_violation', 'confirmed');

  const own = await myStanding(bob);
  const bigScore = own.communities.find(row => row.communityId === viewer.community.id)?.local.score ?? -1;
  const smallScore = own.communities.find(row => row.communityId === small.community.id)?.local.score ?? -1;
  const trust = await viewer.owner.client.rpc('global_trust', { p_subject: bob.id });
  assert.equal(trust.error, null);
  const data = trustSchema.parse(trust.data);
  assert.equal(data.completedInteractions, 420);
  assert.equal(data.globalScore, expectedGlobal([{ weight: 400, score: bigScore }, { weight: 20, score: smallScore }]));
  assert.deepEqual(data.incidents, [{ type: 'serious_violation', status: 'confirmed' }]);
  const text = JSON.stringify(trust.data);
  for (const hidden of [small.community.id, small.community.name, viewer.community.id, bob.id]) assert.ok(!text.includes(hidden), 'redacted trust must not carry identifiers');
  receipt('issue-18-redacted-trust', { globalScore: data.globalScore, incidents: data.incidents, weights: { big: 400, small: 20 } });
});

test('Penalties stay in the ledger after the penalized member leaves the Community', async () => {
  const f = await unresolvedDecidedDispute('misconduct-removal');
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'Verified before the membership ended.' });
  assert.equal(recorded.error, null);
  const removed = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  assert.equal(removed.error, null);
  const mine = await myStanding(f.bob);
  const community = mine.communities.find(row => row.communityId === f.community.id);
  assert.equal(community?.local.score, 40);
  assert.ok(community?.history.some(entry => entry.points === -10));
});

test('A replayed misconduct intent returns its stored result after the case outcome changes', async () => {
  const f = await reviewedDispute('misconduct-replay');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved', reason: 'The submitted evidence supports the reported damage.' })).error, null);
  const intent = randomUUID();
  const args = { p_intent_id: intent, p_dispute_id: f.disputeId, p_rule: 'unresolved_damage', p_recipient_id: f.bob.id, p_reason: 'Verified before the outcome changed.' };
  const first = await f.owner.client.rpc('record_verified_misconduct', args);
  assert.equal(first.error, null);
  assert.equal((await caseAction(f.owner, f.disputeId, 'correct_outcome', { outcome: 'resolved', reason: 'A dated receipt shows the repair was completed.' })).error, null);
  const replay = await f.owner.client.rpc('record_verified_misconduct', args);
  assert.equal(replay.error, null);
  assert.deepEqual(replay.data, first.data);
  const fresh = await f.owner.client.rpc('record_verified_misconduct', { ...args, p_intent_id: randomUUID() });
  assert.equal(fresh.error?.code, '55000');
});

test('Concurrent corrections of one event with distinct intents yield one linked correction', async () => {
  const f = await unresolvedDecidedDispute('misconduct-race');
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'Verified before the race.' });
  assert.equal(recorded.error, null);
  const eventId = (recorded.data as { eventId: string }).eventId;
  const attempts = await Promise.allSettled([randomUUID(), randomUUID()].map(intent => f.owner.client.rpc('correct_reputation_event', { p_intent_id: intent, p_event_id: eventId, p_reason: 'A dated receipt was verified.' })));
  const fulfilled = attempts.filter(attempt => attempt.status === 'fulfilled' && !attempt.value.error);
  const refused = attempts.filter(attempt => attempt.status === 'fulfilled' && attempt.value.error?.code === '55000');
  assert.equal(fulfilled.length, 1);
  assert.equal(refused.length, 1);
  const corrections = await admin.from('reputation_events').select('id').eq('corrects_event_id', eventId);
  assert.equal(corrections.data?.length, 1);
});

test('The database refuses a second linked correction for one event', async () => {
  const f = await unresolvedDecidedDispute('misconduct-index');
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'Verified before the direct insert.' });
  assert.equal(recorded.error, null);
  const original = await admin.from('reputation_events').select('community_id,recipient_id,exchange_id,points').eq('id', (recorded.data as { eventId: string }).eventId).single();
  assert.equal(original.error, null);
  const correction = await admin.from('reputation_events').insert({ community_id: original.data!.community_id, recipient_id: original.data!.recipient_id, exchange_id: original.data!.exchange_id,
    rule: 'correction:direct', points: 10, source_kind: 'reputation_correction', source_id: randomUUID(), verified_by_command: 'correct_reputation_event', verified_by: f.owner.id,
    corrects_event_id: (recorded.data as { eventId: string }).eventId, reason: 'Direct insert.' });
  assert.equal(correction.error, null);
  const second = await admin.from('reputation_events').insert({ community_id: original.data!.community_id, recipient_id: original.data!.recipient_id, exchange_id: original.data!.exchange_id,
    rule: 'correction:second', points: 10, source_kind: 'reputation_correction', source_id: randomUUID(), verified_by_command: 'correct_reputation_event', verified_by: f.owner.id,
    corrects_event_id: (recorded.data as { eventId: string }).eventId, reason: 'Second direct insert.' });
  assert.equal(second.error?.code, '23505');
});
