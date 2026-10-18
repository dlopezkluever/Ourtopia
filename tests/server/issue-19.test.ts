import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { acceptHelp, admin, adminReturned, approveBorrow, checkedOutFixture, commitHelp, completeReturn, createHelpPost, helpFixture, helpNeedFields, helpScheduleFields, itemReturn, recordReturn, requestItem, returnAction, unresolvedDecidedDispute } from '../../scripts/verify/backend';
import { deliverOne } from '../../supabase/functions/notifications/worker';

type Member = Awaited<ReturnType<typeof checkedOutFixture>>['owner'];

const verifiedEvidence = { return_record: 'true', condition: 'true' };
const decide = (member: Member, exchangeId: string, outcome: string, reason: string, evidence: Record<string, string> = {}, intent = randomUUID()) =>
  member.client.rpc('decide_stalled_review', { p_intent_id: intent, p_exchange_id: exchangeId, p_outcome: outcome, p_reason: reason, p_evidence: evidence });

// Ages a recorded Return past its review window and runs the deadline worker that queues it.
async function queueStalledReturn(exchangeId: string) {
  const aged = await admin.from('item_returns').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', exchangeId);
  assert.equal(aged.error, null);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
}

// The Return is recorded by the borrower only, so one participant confirmation is missing and the review is queued.
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

async function stateOf(exchangeId: string) {
  const row = await admin.from('exchanges').select('state').eq('id', exchangeId).single();
  assert.equal(row.error, null);
  return row.data!.state;
}

test('A stalled item needs the record, a participant confirmation and a cited decision before verified completion', async () => {
  const f = await stalledItem('stalled-item-verified');
  const queue = await f.owner.client.rpc('read_stalled_review_queue', { p_community_id: f.community.id });
  assert.equal(queue.error, null);
  assert.ok((queue.data as { exchangeId: string }[]).some(row => row.exchangeId === f.exchangeId));

  // Repeated deadline runs do not complete the stalled Return on their own.
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  assert.equal(await stateOf(f.exchangeId), 'return_pending');

  const uncited = await decide(f.owner, f.exchangeId, 'verified_completion', 'Return and condition were checked in the case record.');
  assert.equal(uncited.error?.code, '55000');
  assert.match(uncited.error?.message ?? '', /evidence/);
  assert.equal((await f.bob.client.rpc('decide_stalled_review', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_outcome: 'verified_completion',
    p_reason: 'The borrower cannot self-verify completion.', p_evidence: verifiedEvidence })).error?.code, '42501');
  assert.equal((await f.alice.client.rpc('decide_stalled_review', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_outcome: 'verified_completion',
    p_reason: 'The owner cannot self-verify completion.', p_evidence: verifiedEvidence })).error?.code, '42501');
  assert.ok((await f.owner.client.from('exchanges').update({ state: 'completed' }).eq('id', f.exchangeId)).error);

  const intent = randomUUID();
  const verified = await decide(f.owner, f.exchangeId, 'verified_completion', 'Return recorded by the borrower and the condition matches the Handoff.', verifiedEvidence, intent);
  assert.equal(verified.error, null);
  assert.equal(verified.data.state, 'completed');
  assert.equal(verified.data.decision.outcome, 'verified_completion');
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data?.length, 2);
  // Ordinary item awards: item owner (provider) +2 under item_owner_share, borrower (receiver) +1 under item_borrower_return.
  const awards = await totals(f.exchangeId);
  assert.deepEqual(awards.map(row => [row.recipient_id === f.alice.id ? 'owner' : row.recipient_id === f.bob.id ? 'borrower' : 'other', row.points]).sort(),
    [['borrower', 1], ['owner', 2]]);
  const verifiers = await admin.from('reputation_events').select('verified_by_command').eq('exchange_id', f.exchangeId);
  assert.deepEqual(verifiers.data?.map(row => row.verified_by_command).sort(), ['decide_stalled_review', 'decide_stalled_review']);

  const replay = await decide(f.owner, f.exchangeId, 'verified_completion', 'Return recorded by the borrower and the condition matches the Handoff.', verifiedEvidence, intent);
  assert.deepEqual(replay.data, verified.data);
  assert.equal((await decide(f.owner, f.exchangeId, 'closed_without_completion', 'A changed payload must not reuse this intent.', {}, intent)).error?.code, '23505');
  assert.equal((await decide(f.owner, f.exchangeId, 'verified_completion', 'A second decision must not repeat the awards.', verifiedEvidence)).error?.code, '55000');
  assert.equal((await totals(f.exchangeId)).length, awards.length);
  const notices = await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'item_stalled_review_decided');
  assert.equal(notices.data?.length, 4);
});

test('Closing a stalled item without completion records a reason, awards nothing and keeps unrecovered custody until recovery', async () => {
  const f = await stalledItem('stalled-item-closed');
  const short = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'Too short');
  assert.equal(short.error?.code, '22023');
  const closed = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'The borrower never confirmed the Return after two reminders.');
  assert.equal(closed.error, null);
  assert.equal(closed.data.state, 'closed_without_completion');
  assert.equal(closed.data.custodyUnresolved, true);
  assert.equal(closed.data.canRecover, true);
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data?.length, 0);
  assert.deepEqual(await totals(f.exchangeId), []);
  const reservation = await admin.from('item_reservations').select('custody_unresolved,blocking').eq('exchange_id', f.exchangeId).single();
  assert.equal(reservation.data?.custody_unresolved, true);
  assert.equal(reservation.data?.blocking, true);
  assert.equal((await f.alice.client.rpc('read_stalled_review', { p_exchange_id: f.exchangeId })).data?.decision?.outcome, 'closed_without_completion');

  // Custody blocks allocation of the same Listing until a separate recorded recovery.
  const blocked = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id)).then(() => null, error => error);
  assert.equal((blocked as { code?: string } | null)?.code, '23P01');
  const bareRecovery = await f.owner.client.rpc('record_stalled_item_recovery', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_reason: 'Too short' });
  assert.equal(bareRecovery.error?.code, '22023');
  assert.equal((await f.alice.client.rpc('record_stalled_item_recovery', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId,
    p_reason: 'The owner recovered the drill from the borrower.' })).error?.code, '42501');
  const recovered = await f.owner.client.rpc('record_stalled_item_recovery', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId,
    p_reason: 'The owner recovered the drill from the borrower on Friday.' });
  assert.equal(recovered.error, null);
  assert.equal(recovered.data.custodyUnresolved, false);
  assert.equal(recovered.data.recovery.reason, 'The owner recovered the drill from the borrower on Friday.');
  assert.equal((await admin.from('item_reservations').select('custody_unresolved').eq('exchange_id', f.exchangeId).single()).data?.custody_unresolved, false);
  assert.equal((await f.owner.client.rpc('record_stalled_item_recovery', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId,
    p_reason: 'A second recovery must not repeat the decision.' })).error?.code, '55000');
  const allocated = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id));
  assert.equal(allocated.exchange_state, 'approved');
});

test('A stalled help Exchange verifies on one confirmation and cited work, awarding only the helper', async () => {
  const f = await helpFixture('stalled-help', 1);
  const [helper] = f.members;
  const { exchange } = await stalledHelp(f, helper);

  assert.equal((await decide(f.author, exchange.id, 'verified_completion', 'The requester confirmed the work and cannot verify it.', { work_record: 'true' })).error?.code, '42501');
  assert.equal((await decide(f.owner, exchange.id, 'verified_completion', 'The schedule and the one confirmation support completion.', {})).error?.code, '55000');
  const verified = await decide(f.owner, exchange.id, 'verified_completion', 'The schedule and the helper confirmation support completion.', { work_record: 'true' });
  assert.equal(verified.error, null);
  assert.equal(verified.data.state, 'completed');
  const awards = await totals(exchange.id);
  assert.equal(awards.reduce((sum, row) => sum + (row.recipient_id === helper.id ? row.points : 0), 0), 3);
  assert.equal(awards.reduce((sum, row) => sum + (row.recipient_id === f.author.id ? row.points : 0), 0), 0);
  assert.equal(awards.length, 1);
});

test('Closing a stalled help Exchange without completion awards nothing', async () => {
  const f = await helpFixture('stalled-help-closed', 1);
  const [helper] = f.members;
  const { exchange } = await stalledHelp(f, helper);
  const closed = await decide(f.owner, exchange.id, 'closed_without_completion', 'Only the helper confirmed and the requester never answered.');
  assert.equal(closed.error, null);
  assert.equal(closed.data.state, 'closed_without_completion');
  assert.deepEqual(await totals(exchange.id), []);
});

test('Two concurrent decisions for one stalled item yield one outcome and one set of awards', async () => {
  const f = await stalledItem('stalled-item-race');
  const reason = 'Return recorded by the borrower and the condition matches the Handoff.';
  const results = await Promise.all([
    decide(f.owner, f.exchangeId, 'verified_completion', reason, verifiedEvidence),
    decide(f.owner, f.exchangeId, 'verified_completion', reason, verifiedEvidence),
  ]);
  assert.equal(results.filter(result => result.error === null).length, 1);
  const loser = results.find(result => result.error !== null);
  assert.equal(loser?.error?.code, '55000');
  assert.equal((await admin.from('stalled_review_decisions').select('exchange_id').eq('exchange_id', f.exchangeId)).data?.length, 1);
  const awards = await totals(f.exchangeId);
  assert.equal(awards.reduce((sum, row) => sum + row.points, 0), 3);
  assert.equal(await stateOf(f.exchangeId), 'completed');
});

test('Repeated worker calls and a replayed intent keep the decided outcome stable', async () => {
  const f = await stalledItem('stalled-item-replay');
  const intent = randomUUID();
  const same = await Promise.all([
    decide(f.owner, f.exchangeId, 'closed_without_completion', 'The borrower never answered after the second reminder.', {}, intent),
    decide(f.owner, f.exchangeId, 'closed_without_completion', 'The borrower never answered after the second reminder.', {}, intent),
  ]);
  assert.equal(same[0].error, null);
  assert.deepEqual(same[1].data, same[0].data);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  assert.equal(await stateOf(f.exchangeId), 'closed_without_completion');
  assert.equal((await admin.from('stalled_review_decisions').select('decided_at').eq('exchange_id', f.exchangeId).single()).error, null);
});

test('A decision notice keeps its identity when the email provider fails and then succeeds', async () => {
  const f = await stalledItem('stalled-item-email');
  const decided = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'The borrower never answered after the second reminder.');
  assert.equal(decided.error, null);
  const before = await admin.from('stalled_review_decisions').select('decided_at,intent_id').eq('exchange_id', f.exchangeId).single();
  const email = await admin.from('notification_outbox').select('id,state').eq('community_id', f.community.id).eq('kind', 'item_stalled_review_decided')
    .eq('recipient_id', f.alice.id).eq('channel', 'email').single();
  assert.equal(email.error, null);
  const failed = await deliverOne(admin, async () => { throw new Error('Synthetic provider outage'); }, email.data!.id) as { state: string };
  assert.equal(failed.state, 'failed');
  assert.equal((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).eq('id', email.data!.id)).error, null);
  const sent: string[] = [];
  const delivered = await deliverOne(admin, async message => { sent.push(message.subject); }, email.data!.id) as { state: string };
  assert.equal(delivered.state, 'delivered');
  assert.equal(sent.length, 1);
  const after = await admin.from('stalled_review_decisions').select('decided_at,intent_id').eq('exchange_id', f.exchangeId).single();
  assert.deepEqual(after.data, before.data);
});

test('An unresolved item issue leaves the deadline worker and reaches review, and closes without completion', async () => {
  const f = await unresolvedDecidedDispute('stalled-unresolved');
  assert.equal((await adminReturned(f)).error, null);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  const queued = await admin.from('exchange_review_items').select('reason').eq('exchange_id', f.exchangeId);
  assert.ok(queued.data?.some(row => row.reason === 'unresolved_dispute'));
  assert.equal((await decide(f.owner, f.exchangeId, 'verified_completion', 'The case was decided as unresolved and cannot complete.',
    verifiedEvidence)).error?.code, '55000');
  const closed = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'The unresolved case closes without completion awards.');
  assert.equal(closed.error, null);
  assert.equal(closed.data.state, 'closed_without_completion');
  assert.deepEqual(await totals(f.exchangeId), []);
});

test('A stalled unresolved issue does not block an ordinary completion in the same deadline run', async () => {
  const stuck = await unresolvedDecidedDispute('stalled-batch-stuck');
  assert.equal((await adminReturned(stuck)).error, null);
  const normal = await checkedOutFixture('stalled-batch-normal');
  await completeReturn(normal);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  assert.equal(await stateOf(normal.exchangeId), 'completed');
  assert.equal(await stateOf(stuck.exchangeId), 'returned');
  assert.equal((await totals(normal.exchangeId)).reduce((sum, row) => sum + row.points, 0), 3);
});

test('A stalled Return whose confirmations now match completes ordinarily and cannot be closed without completion', async () => {
  const f = await stalledItem('stalled-item-matching');
  const confirmed = await returnAction(f.alice, f.exchangeId, (await itemReturn(f.alice, f.exchangeId)).revision, 'confirm_return', { condition_matches: true });
  assert.equal(confirmed.error, null);
  assert.equal(await stateOf(f.exchangeId), 'returned');
  const view = await f.owner.client.rpc('read_stalled_review', { p_exchange_id: f.exchangeId });
  assert.equal(view.error, null);
  assert.equal((view.data as { canDecide: boolean }).canDecide, false);
  const closed = await decide(f.owner, f.exchangeId, 'closed_without_completion', 'The owner closes a Return that both participants already confirmed.');
  assert.equal(closed.error?.code, '55000');
  assert.match(closed.error?.message ?? '', /ordinary path/);
  assert.equal(await stateOf(f.exchangeId), 'returned');
  assert.deepEqual(await totals(f.exchangeId), []);
});

// A help Exchange whose only confirmation is the helper's, aged past its review window by the service role.
async function stalledHelp(f: Awaited<ReturnType<typeof helpFixture>>, helper: Awaited<ReturnType<typeof helpFixture>>['members'][number]) {
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  assert.equal((await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() })).error, null);
  const confirmed = await helper.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_expected_revision: 0, p_action: 'confirm', p_disagreement: null });
  assert.equal(confirmed.error, null);
  assert.equal((await admin.from('help_completions').update({ review_due_at: new Date(Date.now() - 60000).toISOString() }).eq('exchange_id', exchange.id)).error, null);
  assert.equal((await admin.rpc('process_due_help_completions')).error, null);
  return { exchange };
}
