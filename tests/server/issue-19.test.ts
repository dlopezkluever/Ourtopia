import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { acceptHelp, admin, adminReturned, checkedOutFixture, commitHelp, createHelpPost, helpFixture, helpNeedFields, helpScheduleFields, recordReturn, unresolvedDecidedDispute } from '../../scripts/verify/backend';

type Member = Awaited<ReturnType<typeof checkedOutFixture>>['owner'];

const decide = (member: Member, exchangeId: string, outcome: string, reason: string, evidence: Record<string, string> = {}, intent = randomUUID()) =>
  member.client.rpc('decide_stalled_review', { p_intent_id: intent, p_exchange_id: exchangeId, p_outcome: outcome, p_reason: reason, p_evidence: evidence });

// Ages a recorded Return past its review window and runs the service-role deadline worker that queues it.
async function queueStalledReturn(exchangeId: string) {
  const aged = await admin.from('item_returns').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', exchangeId);
  assert.equal(aged.error, null);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
}

async function stalledItem(label: string) {
  const f = await checkedOutFixture(label);
  await recordReturn(f);
  await queueStalledReturn(f.exchangeId);
  return f;
}

async function totals(exchangeId: string) {
  const awards = await admin.from('reputation_events').select('recipient_id,points').eq('exchange_id', exchangeId);
  assert.equal(awards.error, null);
  return awards.data ?? [];
}

test('A stalled item needs the record, a participant confirmation and a cited decision before verified completion', async () => {
  const f = await stalledItem('stalled-item-verified');
  const queue = await f.owner.client.rpc('read_stalled_review_queue', { p_community_id: f.community.id });
  assert.equal(queue.error, null);
  assert.ok((queue.data as { exchangeId: string }[]).some(row => row.exchangeId === f.exchangeId));

  const uncited = await decide(f.owner, f.exchangeId, 'verified_completion', 'Return and condition were checked in the case record.');
  assert.equal(uncited.error?.code, '55000');
  assert.match(uncited.error?.message ?? '', /evidence/);
  assert.equal((await f.bob.client.rpc('decide_stalled_review', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_outcome: 'verified_completion',
    p_reason: 'The borrower cannot self-verify completion.', p_evidence: { return_record: 'true', condition: 'true' } })).error?.code, '42501');
  assert.equal((await f.alice.client.rpc('decide_stalled_review', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_outcome: 'verified_completion',
    p_reason: 'The owner cannot self-verify completion.', p_evidence: { return_record: 'true', condition: 'true' } })).error?.code, '42501');
  assert.ok((await f.owner.client.from('exchanges').update({ state: 'completed' }).eq('id', f.exchangeId)).error);

  const intent = randomUUID();
  const verified = await decide(f.owner, f.exchangeId, 'verified_completion', 'Return recorded by the borrower and the condition matches the Handoff.',
    { return_record: 'true', condition: 'true' }, intent);
  assert.equal(verified.error, null);
  assert.equal(verified.data.state, 'completed');
  assert.equal(verified.data.decision.outcome, 'verified_completion');
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data?.length, 2);
  const awards = await totals(f.exchangeId);
  assert.equal(awards.reduce((sum, row) => sum + (row.recipient_id === f.alice.id ? row.points : 0), 0), 2);
  assert.equal(awards.reduce((sum, row) => sum + (row.recipient_id === f.bob.id ? row.points : 0), 0), 1);

  const replay = await decide(f.owner, f.exchangeId, 'verified_completion', 'Return recorded by the borrower and the condition matches the Handoff.',
    { return_record: 'true', condition: 'true' }, intent);
  assert.deepEqual(replay.data, verified.data);
  assert.equal((await decide(f.owner, f.exchangeId, 'closed_without_completion', 'A changed payload must not reuse this intent.', {}, intent)).error?.code, '23505');
  assert.equal((await decide(f.owner, f.exchangeId, 'verified_completion', 'A second decision must not repeat the awards.', { return_record: 'true', condition: 'true' })).error?.code, '55000');
  assert.equal((await totals(f.exchangeId)).length, awards.length);
  assert.equal((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'stalled_review_decided')).data?.length, 4);
});

test('Closing a stalled item without completion records a reason, awards nothing and keeps unrecovered custody', async () => {
  const f = await stalledItem('stalled-item-closed');
  const short = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'Too short');
  assert.equal(short.error?.code, '22023');
  const closed = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'The borrower never confirmed the Return after two reminders.');
  assert.equal(closed.error, null);
  assert.equal(closed.data.state, 'closed_without_completion');
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data?.length, 0);
  assert.deepEqual(await totals(f.exchangeId), []);
  const reservation = await admin.from('item_reservations').select('custody_unresolved').eq('exchange_id', f.exchangeId).single();
  assert.equal(reservation.data?.custody_unresolved, true);
  assert.equal((await f.alice.client.rpc('read_stalled_review', { p_exchange_id: f.exchangeId })).data?.decision?.outcome, 'closed_without_completion');
});

test('A stalled help Exchange verifies on one confirmation and cited work, awarding only the helper', async () => {
  const f = await helpFixture('stalled-help', 1);
  const [helper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  assert.equal((await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() })).error, null);
  const confirmed = await helper.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_expected_revision: 0, p_action: 'confirm', p_disagreement: null });
  assert.equal(confirmed.error, null);
  await admin.from('help_completions').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', exchange.id);
  assert.equal((await admin.rpc('process_due_help_completions')).error, null);

  assert.equal((await decide(f.author, exchange.id, 'verified_completion', 'The requester confirmed the work and cannot verify it.', { work_record: 'true' })).error?.code, '42501');
  assert.equal((await decide(f.owner, exchange.id, 'verified_completion', 'The schedule and the one confirmation support completion.', {})).error?.code, '55000');
  const verified = await decide(f.owner, exchange.id, 'verified_completion', 'The schedule and the helper confirmation support completion.', { work_record: 'true' });
  assert.equal(verified.error, null);
  assert.equal(verified.data.state, 'completed');
  const awards = await totals(exchange.id);
  assert.equal(awards.reduce((sum, row) => sum + (row.recipient_id === helper.id ? row.points : 0), 0), 3);
  assert.equal(awards.reduce((sum, row) => sum + (row.recipient_id === f.author.id ? row.points : 0), 0), 0);
});

test('An unresolved item issue leaves the deadline worker and reaches review, and closes without completion', async () => {
  const f = await unresolvedDecidedDispute('stalled-unresolved');
  assert.equal((await adminReturned(f)).error, null);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  const queued = await admin.from('exchange_review_items').select('reason').eq('exchange_id', f.exchangeId);
  assert.ok(queued.data?.some(row => row.reason === 'unresolved_dispute'));
  assert.equal((await decide(f.owner, f.exchangeId, 'verified_completion', 'The case was decided as unresolved and cannot complete.',
    { return_record: 'true', condition: 'true' })).error?.code, '55000');
  const closed = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'The unresolved case closes without completion awards.');
  assert.equal(closed.error, null);
  assert.equal(closed.data.state, 'closed_without_completion');
  assert.deepEqual(await totals(f.exchangeId), []);
});
