import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actor, admin, createCommunity, publicClient, unresolvedDecidedDispute } from '../../scripts/verify/backend';

test('Misconduct commands and ledger writes stay within the current Community administrator boundary', async () => {
  const f = await unresolvedDecidedDispute('misconduct-rls');
  const foreign = await actor({ label: 'misconduct-foreign-admin' });
  assert.equal((await createCommunity(foreign.client)).error, null);
  const penalty = { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage', p_recipient_id: f.bob.id, p_reason: 'Forged by foreign administrator.' };
  assert.equal((await foreign.client.rpc('record_verified_misconduct', penalty)).error?.code, '42501');
  assert.equal((await publicClient().rpc('record_verified_misconduct', penalty)).error?.code, '42501');
  assert.equal((await f.alice.client.rpc('record_verified_misconduct', penalty)).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('record_verified_misconduct', penalty)).error?.code, '42501');

  const recorded = await f.owner.client.rpc('record_verified_misconduct', { ...penalty, p_intent_id: randomUUID(), p_reason: 'Verified from the case record.' });
  assert.equal(recorded.error, null);
  const eventId = (recorded.data as { eventId: string }).eventId;
  const correction = { p_intent_id: randomUUID(), p_event_id: eventId, p_reason: 'Forged correction.' };
  assert.equal((await foreign.client.rpc('correct_reputation_event', correction)).error?.code, '42501');
  assert.equal((await f.alice.client.rpc('correct_reputation_event', correction)).error?.code, '42501');
  assert.equal((await publicClient().rpc('correct_reputation_event', correction)).error?.code, '42501');

  assert.ok((await f.owner.client.from('reputation_events').insert({ community_id: f.community.id, recipient_id: f.bob.id,
    rule: 'unresolved_damage', points: -10, source_kind: 'dispute', source_id: f.disputeId, exchange_id: f.exchangeId,
    verified_by_command: 'client', verified_by: f.owner.id, reason: 'Forged by direct write.' })).error);
  assert.ok((await f.owner.client.from('reputation_events').update({ points: 0 }).eq('id', eventId)).error);
  assert.ok((await f.owner.client.from('reputation_events').delete().eq('id', eventId)).error);
  assert.ok((await f.owner.client.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, kind: 'forged', intent_id: randomUUID() })).error);
  assert.ok((await f.owner.client.from('trust_incidents').insert({ community_id: f.community.id, subject_id: f.bob.id, type: 'serious_violation',
    status: 'confirmed', source_kind: 'forged', source_id: randomUUID() })).error);
  assert.ok((await f.owner.client.from('trust_incidents').update({ status: 'overturned' }).eq('subject_id', f.bob.id)).error);

  const ledger = await admin.from('reputation_events').select('id,points').eq('source_kind', 'dispute').eq('source_id', f.disputeId);
  assert.deepEqual(ledger.data, [{ id: eventId, points: -10 }]);
});

test('Foreign administrators cannot read another person\'s detailed or redacted trust, and members keep their own history', async () => {
  const f = await unresolvedDecidedDispute('misconduct-privacy');
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'confirmed_theft',
    p_recipient_id: f.bob.id, p_reason: 'Confirmed theft recorded for privacy checks.' });
  assert.equal(recorded.error, null);
  const foreign = await actor({ label: 'misconduct-privacy-foreign' });
  assert.equal((await createCommunity(foreign.client)).error, null);

  const foreignRead = await foreign.client.from('reputation_events').select('id').eq('recipient_id', f.bob.id);
  assert.equal(foreignRead.error, null);
  assert.deepEqual(foreignRead.data, []);
  assert.equal((await foreign.client.from('trust_incidents').select('id').eq('subject_id', f.bob.id)).data?.length, 0);
  assert.equal((await foreign.client.rpc('global_trust', { p_subject: f.bob.id })).error?.code, '42501');
  assert.equal((await foreign.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.bob.id })).error?.code, '42501');

  const own = await f.bob.client.from('reputation_events').select('id,points').eq('recipient_id', f.bob.id).eq('source_kind', 'dispute');
  assert.equal(own.error, null);
  assert.deepEqual(own.data, [{ id: (recorded.data as { eventId: string }).eventId, points: -30 }]);
});
