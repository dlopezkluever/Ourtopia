import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actor, admin, checkedOutFixture, createCommunity, publicClient, recordReturn } from '../../scripts/verify/backend';

test('Stalled review commands, reads and writes stay with the current Community administrator who is not a participant', async () => {
  const f = await checkedOutFixture('stalled-rls');
  await recordReturn(f);
  await admin.from('item_returns').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', f.exchangeId);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);

  const foreign = await actor({ label: 'stalled-foreign-admin' });
  assert.equal((await createCommunity(foreign.client)).error, null);
  const decision = { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_outcome: 'closed_without_completion', p_reason: 'Forged by a foreign administrator.', p_evidence: {} };
  assert.equal((await foreign.client.rpc('decide_stalled_review', decision)).error?.code, '42501');
  assert.equal((await publicClient().rpc('decide_stalled_review', decision)).error?.code, '42501');
  assert.equal((await f.alice.client.rpc('decide_stalled_review', decision)).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('decide_stalled_review', decision)).error?.code, '42501');
  assert.equal((await foreign.client.rpc('read_stalled_review_queue', { p_community_id: f.community.id })).error?.code, '42501');
  assert.equal((await foreign.client.rpc('read_stalled_review', { p_exchange_id: f.exchangeId })).error?.code, '42501');
  assert.equal((await publicClient().rpc('read_stalled_review_queue', { p_community_id: f.community.id })).error?.code, '42501');

  const forgedDecision = await f.owner.client.from('stalled_review_decisions').insert({ exchange_id: f.exchangeId, community_id: f.community.id,
    review_reason: 'missing_return_confirmation', outcome: 'verified_completion', reason: 'Forged direct decision.', decided_by: f.owner.id, intent_id: randomUUID() });
  assert.ok(forgedDecision.error);
  assert.ok((await f.owner.client.from('exchange_review_items').delete().eq('exchange_id', f.exchangeId)).error);
  assert.ok((await f.owner.client.from('exchanges').update({ state: 'completed' }).eq('id', f.exchangeId)).error);
  assert.ok((await f.bob.client.from('exchanges').update({ state: 'completed' }).eq('id', f.exchangeId)).error);

  const foreignRows = await foreign.client.from('stalled_review_decisions').select('exchange_id').eq('exchange_id', f.exchangeId);
  assert.deepEqual(foreignRows.data, []);
  const queue = await f.owner.client.rpc('read_stalled_review_queue', { p_community_id: f.community.id });
  assert.equal(queue.error, null);
  assert.ok((queue.data as { exchangeId: string }[]).some(row => row.exchangeId === f.exchangeId));
  const bobCase = await f.bob.client.rpc('read_stalled_review', { p_exchange_id: f.exchangeId });
  assert.equal(bobCase.error, null);
  assert.equal(bobCase.data.canDecide, false);
  assert.equal(bobCase.data.participant, true);
});
