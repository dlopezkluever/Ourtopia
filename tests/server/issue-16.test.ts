import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { activeMember, actor, admin, advanceHandoff, agreedRemedyWithBothSidesAgreed, approveBorrow, caseAction, checkedOutFixture, completedItemFixture, decideBorrow, decisionView, disputeFixture, handoffFixture, helpDisputeFixture, itemReturn, listingImageBytes, receipt, recordReturn, reportIssue, requestItem, returnAction, reviewedDispute, settleFixtureNotices } from '../../scripts/verify/backend';

const suiteStarted = new Date().toISOString();
after(() => settleFixtureNotices(['decision-primary', 'decision-one-sided', 'decision-contested', 'decision-stalled', 'decision-stalled-repair', 'decision-race', 'decision-completed', 'decision-unblock', 'decision-custody', 'decision-help', 'decision-atomic', 'decision-admin-return', 'decision-unresolved-return', 'decision-corrected-unresolved-return', 'decision-photo-admin', 'decision-photo-quiet'], suiteStarted));

const outbox = async (disputeId: string, kind: string) => (await admin.from('notification_outbox').select('recipient_id,channel').eq('dispute_id', disputeId).eq('kind', kind)).data!.map(row => `${row.recipient_id}:${row.channel}`).sort();
const both = (...ids: string[]) => ids.flatMap(id => [`${id}:email`, `${id}:in_app`]).sort();

test('Mutual repair and two settlement confirmations resolve one case with remedy, confirmations and semantic retries', async () => {
  const f = await disputeFixture('decision-primary');
  const propose = { kind: 'repair', terms: 'Bob pays for a new case hinge by Friday.' }; const intent = randomUUID();
  const proposed = await caseAction(f.bob, f.disputeId, 'propose_remedy', propose, intent); assert.equal(proposed.error, null);
  assert.deepEqual((await caseAction(f.bob, f.disputeId, 'propose_remedy', propose, intent)).data, proposed.data);
  assert.equal((await caseAction(f.bob, f.disputeId, 'propose_remedy', { ...propose, terms: 'Changed' }, intent)).error?.code, '23505');
  const remedyId = (proposed.data as { remedy: { id: string } }).remedy.id;
  assert.equal((await caseAction(f.bob, f.disputeId, 'agree_remedy', { remedy_id: remedyId })).error?.code, '55000');
  assert.equal((await caseAction(f.alice, f.disputeId, 'agree_remedy', { remedy_id: remedyId })).error, null);
  let view = await decisionView(f.bob, f.exchangeId); assert.equal(view.cases[0].status, 'repairing');
  assert.equal((await caseAction(f.bob, f.disputeId, 'confirm_settlement', { remedy_id: remedyId })).error, null);
  const last = await caseAction(f.alice, f.disputeId, 'confirm_settlement', { remedy_id: remedyId }); assert.equal(last.error, null);
  view = await decisionView(f.alice, f.exchangeId); const dispute = view.cases[0];
  assert.equal(dispute.status, 'resolved'); assert.ok(dispute.closed_at);
  assert.deepEqual(dispute.remedy?.confirmed_by.sort(), [f.alice.id, f.bob.id].sort());
  assert.deepEqual(dispute.history.map(row => row.action), ['remedy_proposed', 'remedy_agreed', 'settlement_confirmed', 'settlement_confirmed', 'outcome_recorded']);
  assert.deepEqual(dispute.outcome && { outcome: dispute.outcome.outcome, corrected: dispute.outcome.corrected }, { outcome: 'resolved', corrected: false });
  assert.equal(view.state, 'checked_out');
  assert.deepEqual((await admin.from('trust_incidents').select('status').eq('source_id', f.disputeId)).data, [{ status: 'resolved' }, { status: 'resolved' }]);
  assert.deepEqual((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data, []);
  assert.deepEqual(await outbox(f.disputeId, 'item_dispute_remedy'), both(f.alice.id, f.alice.id, f.bob.id));
  assert.deepEqual(await outbox(f.disputeId, 'item_dispute_outcome'), both(f.bob.id));
  assert.equal((await caseAction(f.bob, f.disputeId, 'propose_remedy', { kind: 'other', terms: 'Reopen' })).error?.code, '55000');
  receipt('issue-16-primary', { view, remedyNotices: await outbox(f.disputeId, 'item_dispute_remedy'), outcomeNotices: await outbox(f.disputeId, 'item_dispute_outcome') });
});

test('One-sided settlement, own-remedy agreement and superseded remedies never close the case', async () => {
  const f = await disputeFixture('decision-one-sided');
  assert.equal((await caseAction(f.bob, f.disputeId, 'confirm_settlement', { remedy_id: randomUUID() })).error?.code, '55000');
  const first = await agreedRemedyWithBothSidesAgreed(f);
  assert.equal((await caseAction(f.bob, f.disputeId, 'confirm_settlement', { remedy_id: first })).error, null);
  assert.equal((await caseAction(f.bob, f.disputeId, 'confirm_settlement', { remedy_id: first })).error?.code, '55000');
  let view = await decisionView(f.bob, f.exchangeId);
  assert.equal(view.cases[0].status, 'repairing'); assert.equal(view.cases[0].closed_at, null); assert.deepEqual(view.cases[0].remedy?.confirmed_by, [f.bob.id]);
  const replaced = await caseAction(f.alice, f.disputeId, 'propose_remedy', { kind: 'replacement', terms: 'Bob buys the same drill model.' }); assert.equal(replaced.error, null);
  assert.equal((await caseAction(f.alice, f.disputeId, 'confirm_settlement', { remedy_id: first })).error?.code, '55000');
  view = await decisionView(f.alice, f.exchangeId);
  assert.equal(view.cases[0].remedy?.agreed, false); assert.deepEqual(view.cases[0].remedy?.confirmed_by, []); assert.equal(view.cases[0].closed_at, null);
  assert.deepEqual(view.cases[0].next_actions, ['propose_remedy', 'request_review']);
  assert.equal((await admin.from('dispute_actions').select('id').eq('dispute_id', f.disputeId).eq('action', 'outcome_recorded')).data?.length, 0);
  receipt('issue-16-one-sided', view.cases[0]);
});

test('Contested escalation reaches a reasoned unresolved outcome and a linked correction appends without rewriting history', async () => {
  const f = await disputeFixture('decision-contested');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'resolved', reason: 'Too early' })).error?.code, '55000');
  assert.equal((await caseAction(f.bob, f.disputeId, 'request_review', {})).error?.code, '22023');
  assert.equal((await caseAction(f.bob, f.disputeId, 'request_review', { reason: 'We disagree about when the crack appeared.' })).error, null);
  assert.equal((await decisionView(f.alice, f.exchangeId)).cases[0].status, 'disputed');
  assert.equal((await caseAction(f.alice, f.disputeId, 'propose_remedy', { kind: 'repair', terms: 'Late offer' })).error?.code, '55000');
  assert.deepEqual(await outbox(f.disputeId, 'item_dispute_review'), both(f.alice.id, f.owner.id));
  assert.equal((await caseAction(f.owner, f.disputeId, 'open_review', { note: 'Reviewing both photos and the Handoff condition record.' })).error, null);
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved' })).error?.code, '22023');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved', reason: 'The Handoff record lists light marks only; neither account can be verified.' })).error, null);
  let view = await decisionView(f.owner, f.exchangeId);
  assert.equal(view.cases[0].status, 'unresolved'); assert.equal(view.cases[0].outcome?.reason, 'The Handoff record lists light marks only; neither account can be verified.');
  assert.deepEqual((await admin.from('trust_incidents').select('status').eq('source_id', f.disputeId)).data, [{ status: 'unresolved' }, { status: 'unresolved' }]);
  assert.deepEqual(await outbox(f.disputeId, 'item_dispute_outcome'), both(f.alice.id, f.bob.id));
  const outcomeRow = view.cases[0].outcome!.action_id;
  assert.equal((await caseAction(f.owner, f.disputeId, 'correct_outcome', { outcome: 'unresolved', reason: 'Same' })).error?.code, '22023');
  assert.equal((await caseAction(f.owner, f.disputeId, 'correct_outcome', { outcome: 'resolved', reason: 'Bob later supplied a dated receipt for the repair.' })).error, null);
  view = await decisionView(f.bob, f.exchangeId);
  assert.equal(view.cases[0].status, 'resolved');
  assert.deepEqual({ outcome: view.cases[0].outcome?.outcome, corrected: view.cases[0].outcome?.corrected }, { outcome: 'resolved', corrected: true });
  assert.equal(view.cases[0].history.at(-1)?.corrects_id, outcomeRow);
  assert.deepEqual((await admin.from('trust_incidents').select('status').eq('source_id', f.disputeId)).data, [{ status: 'resolved' }, { status: 'resolved' }]);
  assert.equal((await admin.from('dispute_actions').update({ body: 'rewritten' }).eq('id', outcomeRow)).error?.code, '42501');
  assert.equal((await admin.from('dispute_actions').delete().eq('id', outcomeRow)).error?.code, '42501');
  assert.equal((await admin.from('community_events').delete().eq('community_id', f.community.id).eq('kind', 'item_dispute_outcome')).error?.code, '42501');
  receipt('issue-16-contested', view.cases[0]);
});

test('A same-Community administrator sees the recorded Return while reviewing its case', async () => {
  const f = await handoffFixture('decision-admin-return'); await advanceHandoff(f);
  const recorded = await recordReturn(f);
  const reported = await reportIssue(f.bob, f.exchangeId, 'The return condition needs review.'); assert.equal(reported.error, null);
  const view = await decisionView(f.owner, f.exchangeId);
  assert.ok(view.records.return);
  assert.equal(view.records.return.condition, recorded.record?.condition);
  assert.equal(view.records.return.accessories, recorded.record?.accessories);
  assert.equal(view.records.return.recorded_by, recorded.record?.recorded_by);
  assert.equal(view.records.return.owner_confirmed_at, recorded.record?.owner_confirmed_at);
  assert.equal(view.records.return.borrower_confirmed_at, recorded.record?.borrower_confirmed_at);
  receipt('issue-16-admin-return', { status: view.cases[0].status, return: view.records.return });
});

test('A corrected administrator outcome to resolved unblocks a returned item, and due processing completes it', async () => {
  const f = await handoffFixture('decision-unresolved-return'); await advanceHandoff(f);
  const pending = await recordReturn(f);
  const reported = await reportIssue(f.bob, f.exchangeId, 'The Return condition remains disputed.'); assert.equal(reported.error, null);
  const disputeId = (reported.data as { id: string }).id;
  assert.equal((await caseAction(f.bob, disputeId, 'request_review', { reason: 'We disagree about the returned condition.' })).error, null);
  assert.equal((await caseAction(f.owner, disputeId, 'open_review', {})).error, null);
  assert.equal((await caseAction(f.owner, disputeId, 'decide', { outcome: 'unresolved', reason: 'The submitted records cannot establish the condition.' })).error, null);
  assert.equal((await decisionView(f.owner, f.exchangeId)).cases[0].status, 'unresolved');

  const confirmed = await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true });
  assert.equal(confirmed.error, null);
  let view = await decisionView(f.alice, f.exchangeId);
  assert.equal(view.state, 'returned'); assert.equal(view.cases[0].status, 'unresolved');
  assert.deepEqual((await admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId).eq('kind', 'item_completed')).data, []);

  assert.equal((await caseAction(f.owner, disputeId, 'correct_outcome', { outcome: 'resolved', reason: 'Bob later supplied a dated receipt for the repair.' })).error, null);
  view = await decisionView(f.alice, f.exchangeId);
  assert.equal(view.cases[0].status, 'resolved'); assert.deepEqual({ outcome: view.cases[0].outcome?.outcome, corrected: view.cases[0].outcome?.corrected }, { outcome: 'resolved', corrected: true });
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  assert.equal((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state, 'completed');
  assert.equal((await admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId).eq('kind', 'item_completed')).data?.length, 1);
  receipt('issue-16-unresolved-return', { state: 'completed', case: view.cases[0].status, completionEffects: 1 });
});

test('A case outcome corrected to unresolved keeps a returned item from completing, even when due processing runs', async () => {
  const f = await handoffFixture('decision-corrected-unresolved-return'); await advanceHandoff(f);
  const pending = await recordReturn(f);
  const reported = await reportIssue(f.bob, f.exchangeId, 'The Return condition remains disputed.'); assert.equal(reported.error, null);
  const disputeId = (reported.data as { id: string }).id;
  assert.equal((await caseAction(f.bob, disputeId, 'request_review', { reason: 'We disagree about the returned condition.' })).error, null);
  assert.equal((await caseAction(f.owner, disputeId, 'open_review', {})).error, null);
  assert.equal((await caseAction(f.owner, disputeId, 'decide', { outcome: 'resolved', reason: 'Repair receipt verified.' })).error, null);
  assert.equal((await caseAction(f.owner, disputeId, 'correct_outcome', { outcome: 'unresolved', reason: 'The submitted records cannot establish the condition.' })).error, null);
  const corrected = await decisionView(f.owner, f.exchangeId);
  assert.equal(corrected.cases[0].status, 'unresolved'); assert.equal(corrected.cases[0].outcome?.corrected, true);

  assert.equal((await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true })).error, null);
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  const view = await decisionView(f.alice, f.exchangeId);
  assert.equal(view.state, 'returned'); assert.equal(view.cases[0].status, 'unresolved');
  assert.deepEqual((await admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId).eq('kind', 'item_completed')).data, []);
  receipt('issue-16-corrected-unresolved-return', { state: view.state, case: view.cases[0].status, completionEffects: 0 });
});

test('A stalled replacement agreement enters review only with a reason and only valid guards close it', async () => {
  const f = await disputeFixture('decision-stalled');
  const remedy = await agreedRemedyWithBothSidesAgreed(f, 'replacement', 'Bob replaces the drill within a week.');
  assert.equal((await decisionView(f.bob, f.exchangeId)).cases[0].status, 'replacement_agreed');
  assert.equal((await caseAction(f.bob, f.disputeId, 'request_review', { reason: 'Contest' })).error?.code, '55000');
  assert.equal((await caseAction(f.owner, f.disputeId, 'open_review', {})).error?.code, '22023');
  assert.equal((await caseAction(f.owner, f.disputeId, 'open_review', { note: 'Two weeks passed without the replacement.' })).error, null);
  assert.equal((await caseAction(f.bob, f.disputeId, 'confirm_settlement', { remedy_id: remedy })).error?.code, '55000');
  assert.equal((await caseAction(f.owner, f.disputeId, 'open_review', { note: 'again' })).error?.code, '55000');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'resolved', reason: 'Bob delivered the replacement during review.' })).error, null);
  const view = await decisionView(f.bob, f.exchangeId);
  assert.deepEqual(view.cases[0].history.map(row => `${row.action}:${row.from_status}>${row.to_status}`), ['remedy_proposed:issue_reported>issue_reported', 'remedy_agreed:issue_reported>replacement_agreed', 'review_opened:replacement_agreed>admin_review', 'outcome_recorded:admin_review>resolved']);
  const repairing = await disputeFixture('decision-stalled-repair'); await agreedRemedyWithBothSidesAgreed(repairing);
  assert.equal((await caseAction(repairing.owner, repairing.disputeId, 'open_review', { note: 'Not stalled replacement' })).error?.code, '55000');
  receipt('issue-16-stalled', view.cases[0].history);
});

test('Racing and replayed administrator decisions persist one outcome with stable notices', async () => {
  const f = await reviewedDispute('decision-race');
  const second = await activeMember(f.owner, f.community.id, 'decision-race-admin2');
  assert.equal((await admin.from('memberships').update({ role: 'administrator' }).eq('community_id', f.community.id).eq('user_id', second.id)).error, null);
  const intents = [randomUUID(), randomUUID()];
  const decisions = [{ outcome: 'resolved', reason: 'Repair receipt verified.' }, { outcome: 'unresolved', reason: 'Evidence conflicts.' }];
  const results = await Promise.all([caseAction(f.owner, f.disputeId, 'decide', decisions[0], intents[0]), caseAction(second, f.disputeId, 'decide', decisions[1], intents[1])]);
  assert.deepEqual(results.map(r => r.error?.code ?? null).sort(), [null, '55000'].sort());
  const winner = results.findIndex(r => r.error === null); const winnerActor = [f.owner, second][winner];
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual((await caseAction(winnerActor, f.disputeId, 'decide', decisions[winner], intents[winner])).data, results[winner].data);
  assert.equal((await caseAction(winnerActor, f.disputeId, 'decide', { ...decisions[winner], reason: 'Changed' }, intents[winner])).error?.code, '23505');
  assert.equal((await admin.from('dispute_actions').select('id').eq('dispute_id', f.disputeId).in('action', ['outcome_recorded', 'outcome_corrected'])).data?.length, 1);
  assert.deepEqual(await outbox(f.disputeId, 'item_dispute_outcome'), both(f.alice.id, f.bob.id));
  const view = await decisionView(f.alice, f.exchangeId); assert.equal(view.cases[0].status, decisions[winner].outcome);
  receipt('issue-16-race', { winner: decisions[winner], loser: results[1 - winner].error?.code, outcomeRows: 1, notices: await outbox(f.disputeId, 'item_dispute_outcome') });
});

test('A post-completion case resolves without changing completion, Qualifying Interactions or reputation', async () => {
  const f = await completedItemFixture('decision-completed', 5);
  const before = await Promise.all([admin.from('exchanges').select('state,completed_at').eq('id', f.exchangeId).single(), admin.from('qualifying_interactions').select('id,participant_id').eq('exchange_id', f.exchangeId).order('id'), admin.from('reputation_events').select('id,points').eq('exchange_id', f.exchangeId).order('id')]);
  const reported = await reportIssue(f.alice, f.exchangeId, 'A chipped bit was found after completion.'); assert.equal(reported.error, null);
  const disputeId = (reported.data as { id: string }).id;
  for (const [member, action, details] of [[f.bob, 'request_review', { reason: 'The bit was chipped already.' }], [f.owner, 'open_review', {}], [f.owner, 'decide', { outcome: 'resolved', reason: 'Wear consistent with normal use.' }]] as const) assert.equal((await caseAction(member, disputeId, action, details)).error, null);
  const afterRows = await Promise.all([admin.from('exchanges').select('state,completed_at').eq('id', f.exchangeId).single(), admin.from('qualifying_interactions').select('id,participant_id').eq('exchange_id', f.exchangeId).order('id'), admin.from('reputation_events').select('id,points').eq('exchange_id', f.exchangeId).order('id')]);
  assert.deepEqual(afterRows.map(r => r.data), before.map(r => r.data)); assert.equal(before[1].data?.length, 2);
  receipt('issue-16-post-completion', { before: before.map(r => r.data), decision: (await decisionView(f.bob, f.exchangeId)).cases[0].status });
});

test('Settlement unblocks only otherwise-eligible completion and manufactures no confirmations', async () => {
  const f = await handoffFixture('decision-unblock');
  await advanceHandoff(f);
  const pending = await recordReturn(f);
  const reported = await reportIssue(f.bob, f.exchangeId);
  assert.equal(reported.error, null);
  const disputeId = (reported.data as { id: string }).id;
  const confirmations = await admin.from('item_returns').select('owner_confirmed_at,borrower_confirmed_at').eq('exchange_id', f.exchangeId).single();
  assert.equal(confirmations.error, null);
  assert.equal(confirmations.data?.owner_confirmed_at, null);
  assert.ok(confirmations.data?.borrower_confirmed_at);
  assert.equal((await admin.from('exchanges').update({ state: 'returned' }).eq('id', f.exchangeId)).error?.code, '55000');
  const remedy = await agreedRemedyWithBothSidesAgreed({ ...f, disputeId }, 'no_compensation', 'Normal wear. No payment needed.');
  assert.equal((await decisionView(f.bob, f.exchangeId)).cases[0].status, 'issue_reported');
  for (const member of [f.bob, f.alice]) assert.equal((await caseAction(member, disputeId, 'confirm_settlement', { remedy_id: remedy })).error, null);
  const view = await decisionView(f.bob, f.exchangeId);
  assert.equal(view.cases[0].status, 'resolved'); assert.equal(view.state, 'return_pending');
  assert.deepEqual((await admin.from('item_returns').select('owner_confirmed_at,borrower_confirmed_at').eq('exchange_id', f.exchangeId).single()).data, confirmations.data);
  assert.deepEqual((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data, []);
  assert.deepEqual((await admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId).eq('kind', 'completion_settled')).data, []);
  assert.equal((await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true })).error, null);
  const completedReturn = await itemReturn(f.alice, f.exchangeId);
  assert.ok(completedReturn.record?.owner_confirmed_at);
  assert.ok(completedReturn.record?.borrower_confirmed_at);
  assert.equal(completedReturn.state, 'completed');
  assert.equal((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state, 'completed');
  receipt('issue-16-unblock', { stateAfterSettlement: 'return_pending', stateAfterOrdinaryConfirmation: 'completed', interactionsBeforeOrdinaryConfirmation: 0 });
});

test('Closing a case leaves custody blocking allocation until a separate reasoned administrator recovery', async () => {
  const f = await reviewedDispute('decision-custody');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'resolved', reason: 'Bob will return the drill.' })).error, null);
  const blocked = await decideBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02'));
  assert.equal(blocked.error?.code, '23P01');
  assert.deepEqual((await admin.from('item_reservations').select('custody_unresolved,blocking').eq('exchange_id', f.exchangeId).single()).data, { custody_unresolved: true, blocking: true });
  assert.equal((await caseAction(f.alice, f.disputeId, 'record_recovery', { reason: 'I have it' })).error?.code, '42501');
  assert.equal((await caseAction(f.owner, f.disputeId, 'record_recovery', {})).error?.code, '22023');
  const intent = randomUUID(); const details = { reason: 'Alice confirmed in person that the drill is back in her garage.' };
  const recovered = await caseAction(f.owner, f.disputeId, 'record_recovery', details, intent); assert.equal(recovered.error, null);
  assert.deepEqual((await caseAction(f.owner, f.disputeId, 'record_recovery', details, intent)).data, recovered.data);
  assert.equal((await caseAction(f.owner, f.disputeId, 'record_recovery', details)).error?.code, '55000');
  assert.deepEqual((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data, { state: 'closed_without_completion' });
  assert.deepEqual((await admin.from('item_reservations').select('custody_unresolved,blocking').eq('exchange_id', f.exchangeId).single()).data, { custody_unresolved: false, blocking: false });
  const approved = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-02-03', '2027-02-04')); assert.equal(approved.status, 'approved');
  assert.deepEqual(await outbox(f.disputeId, 'item_dispute_recovery'), both(f.alice.id, f.bob.id));
  receipt('issue-16-custody', { closedCaseAllocation: '23P01', recovery: (recovered.data as { history: unknown[] }).history.at(-1), afterRecovery: approved.status });
});

test('The shared case command settles a help-shaped Exchange without item condition, custody or Return records', async () => {
  const f = await helpDisputeFixture('decision-help');
  const proposed = await caseAction(f.helper, f.disputeId, 'propose_remedy', { kind: 'other', terms: 'I come back Saturday to finish the move.' }); assert.equal(proposed.error, null);
  const remedy = (proposed.data as { remedy: { id: string } }).remedy.id;
  assert.equal((await caseAction(f.author, f.disputeId, 'agree_remedy', { remedy_id: remedy })).error, null);
  for (const member of [f.author, f.helper]) assert.equal((await caseAction(member, f.disputeId, 'confirm_settlement', { remedy_id: remedy })).error, null);
  assert.equal((await caseAction(f.owner, f.disputeId, 'record_recovery', { reason: 'n/a' })).error?.code, '22023');
  const view = await decisionView(f.owner, f.exchangeId);
  assert.equal(view.kind, 'help'); assert.equal(view.state, 'committed'); assert.equal(view.records.handoff, null); assert.equal(view.records.reservation, null);
  assert.equal(view.cases[0].status, 'resolved'); assert.equal(view.cases[0].next_actions.includes('record_recovery'), false);
  assert.deepEqual((await admin.from('item_reservations').select('exchange_id').eq('exchange_id', f.exchangeId)).data, []);
  receipt('issue-16-help', view);
});

test('Invalid actions and unknown inputs leave no partial effects', async () => {
  const f = await disputeFixture('decision-atomic');
  for (const [action, details] of [['rewrite_history', {}], ['propose_remedy', { kind: 'cash', terms: 'x' }], ['propose_remedy', { kind: 'repair', terms: ' ' }], ['propose_remedy', { kind: 'repair', terms: 'x'.repeat(4001) }]] as const) {
    const intent = randomUUID();
    assert.equal((await caseAction(f.bob, f.disputeId, action, details, intent)).error?.code, '22023');
    assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', f.bob.id).eq('intent_id', intent)).data, []);
  }
  assert.equal((await f.bob.client.rpc('act_on_dispute', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_action: 'propose_remedy', p_details: ['repair'] })).error?.code, '22023');
  assert.deepEqual((await admin.from('dispute_actions').select('id').eq('dispute_id', f.disputeId)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('dispute_id', f.disputeId).neq('kind', 'item_dispute_opened')).data, []);
  assert.equal((await admin.from('disputes').select('status').eq('id', f.disputeId).single()).data?.status, 'issue_reported');
  receipt('issue-16-atomic', { invalid: '22023', partialEffects: 0 });
});

test('Same-Community administrators read Return photos only while a case exists on the Exchange', async () => {
  const f = await disputeFixture('decision-photo-admin');
  const outsider = await actor({ label: 'decision-photo-outsider' });
  const path = `${randomUUID()}/${randomUUID()}.png`;
  assert.equal((await admin.storage.from('exchange-evidence').upload(path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await admin.from('exchange_evidence').insert({ id: randomUUID(), exchange_id: f.exchangeId, community_id: f.community.id, uploader_id: f.bob.id,
    purpose: 'return', object_path: path, mime_type: 'image/png', byte_size: listingImageBytes.length, state: 'ready' })).error, null);
  assert.equal((await f.owner.client.storage.from('exchange-evidence').download(path)).error, null);
  assert.ok((await decisionView(f.owner, f.exchangeId)).evidence.some(photo => photo.object_path === path));
  assert.equal((await outsider.client.storage.from('exchange-evidence').download(path)).error === null, false);

  const quiet = await checkedOutFixture('decision-photo-quiet');
  const quietPath = `${randomUUID()}/${randomUUID()}.png`;
  assert.equal((await admin.storage.from('exchange-evidence').upload(quietPath, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await admin.from('exchange_evidence').insert({ id: randomUUID(), exchange_id: quiet.exchangeId, community_id: quiet.community.id, uploader_id: quiet.bob.id,
    purpose: 'return', object_path: quietPath, mime_type: 'image/png', byte_size: listingImageBytes.length, state: 'ready' })).error, null);
  assert.equal((await quiet.owner.client.storage.from('exchange-evidence').download(quietPath)).error === null, false);
  receipt('issue-16-photo-access', { adminWithCase: 'allowed', adminWithoutCase: 'denied', outsider: 'denied' });
});
