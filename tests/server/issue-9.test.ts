import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import {
  admin, approveBorrow, checkedOutFixture, completeReturn, decideBorrow, disputeView, itemHandoff, itemReturn, listingImageBytes, loanEffects, localScores,
  overdueCheckedOutFixture, receipt, recordReturn, reportIssue, requestItem, returnAction, returnCondition, returnReminders, settleFixtureNotices, withReturnWindows,
} from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

const suiteStarted = new Date().toISOString();
const labels = ['return-primary', 'return-race', 'return-conflict', 'return-silence', 'return-reschedule', 'return-custody-confirmed', 'return-custody-missing',
  'return-custody-disputed', 'return-custody-closed', 'return-custody-checked-out', 'return-overdue', 'return-rollback', 'return-photos',
  'return-guard-missing', 'return-guard-unconfirmed', 'return-guard-disputed'];
after(() => settleFixtureNotices(labels, suiteStarted));
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

test('Recorded Return and matching confirmation reach returned then completed once with Alice 52, Bob 51 and one interaction each', async () => {
  const f = await checkedOutFixture('return-primary');
  assert.equal((await returnAction(f.alice, f.exchangeId, 0, 'confirm_return', { condition_matches: true })).error?.code, '55000');
  assert.equal((await returnAction(f.bob, f.exchangeId, 0, 'record_return', { condition: '', accessories: '' })).error?.code, '22023');
  const intent = randomUUID();
  const first = await returnAction(f.bob, f.exchangeId, 0, 'record_return', returnCondition, intent);
  assert.equal(first.error, null);
  assert.deepEqual((await returnAction(f.bob, f.exchangeId, 0, 'record_return', returnCondition, intent)).data, first.data);
  assert.equal((await returnAction(f.bob, f.exchangeId, 0, 'record_return', { ...returnCondition, condition: 'Changed' }, intent)).error?.code, '23505');
  assert.equal((await returnAction(f.alice, f.exchangeId, 0, 'record_return', returnCondition)).error?.code, '55000');
  const pending = await itemReturn(f.alice, f.exchangeId);
  assert.deepEqual({ state: pending.state, condition: pending.record?.condition, accessories: pending.record?.accessories, recordedBy: pending.record?.recorded_by, borrowerConfirmed: !!pending.record?.borrower_confirmed_at, ownerConfirmed: pending.record?.owner_confirmed_at },
    { state: 'return_pending', ...returnCondition, recordedBy: f.bob.id, borrowerConfirmed: true, ownerConfirmed: null });
  assert.equal((await returnAction(f.bob, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true })).error?.code, '55000');
  assert.equal((await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: false })).error?.code, '22023');
  const confirmIntent = randomUUID();
  const confirmed = await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true }, confirmIntent);
  assert.equal(confirmed.error, null);
  assert.deepEqual((await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true }, confirmIntent)).data, confirmed.data);
  assert.equal((await returnAction(f.alice, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true })).error?.code, '55000');
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  const effects = await loanEffects(f.exchangeId);
  assert.deepEqual({ state: effects.state, interactions: effects.interactions, events: effects.events, feed: effects.feed, milestones: effects.milestones, reservation: effects.reservation }, {
    state: 'completed', interactions: 2, feed: 1, milestones: ['completion_settled', 'item_completed', 'item_returned'], reservation: { blocking: false, custody_unresolved: false },
    events: [{ rule: 'item_borrower_return', points: 1, recipient_id: f.bob.id }, { rule: 'item_owner_share', points: 2, recipient_id: f.alice.id }],
  });
  assert.deepEqual(await localScores(f.community.id, f.alice, f.bob), [52, 51]);
  const aliceView = await itemReturn(f.alice, f.exchangeId); const bobView = await itemReturn(f.bob, f.exchangeId);
  assert.deepEqual([aliceView.standing, bobView.standing], [{ score: 52, title: 'Petty Bourgeoisie', completedInteractions: 1 }, { score: 51, title: 'Petty Bourgeoisie', completedInteractions: 1 }]);
  const mine = await f.alice.client.rpc('my_reputation'); assert.equal(mine.error, null);
  assert.deepEqual((mine.data as { global: unknown }).global, { score: 52, title: 'Petty Bourgeoisie', completedInteractions: 1 });
  const notices = await admin.from('notification_outbox').select('recipient_id,channel').eq('community_id', f.community.id).eq('kind', 'item_completed');
  assert.deepEqual(notices.data!.map(row => `${row.recipient_id}:${row.channel}`).sort(), [f.alice.id, f.bob.id].flatMap(id => [`${id}:email`, `${id}:in_app`]).sort());
  const feed = await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id });
  assert.equal(feed.error, null);
  assert.deepEqual(Object.keys((feed.data as Record<string, unknown>[])[0]).sort(), ['borrower', 'completed_at', 'id', 'kind', 'owner', 'title']);
  for (const secret of [returnCondition.condition, returnCondition.accessories, 'Front porch', 'object_path', f.exchangeId]) assert.equal(JSON.stringify(feed.data).includes(secret), false, secret);
  for (const [table, row] of [['exchanges', { state: 'returned' }], ['item_returns', { condition: 'forged' }], ['community_feed', { kind: 'item_loan_completed' }]] as const) {
    assert.equal((await f.owner.client.from(table).update(row).eq(table === 'exchanges' ? 'id' : 'exchange_id', f.exchangeId)).error?.code, '42501');
  }
  assert.equal((await f.owner.client.from('reputation_events').insert({ community_id: f.community.id, recipient_id: f.owner.id, rule: 'item_owner_share', points: 2, source_kind: 'exchange', source_id: randomUUID(), verified_by_command: 'forged' })).error?.code, '42501');
  assert.equal((await f.owner.client.rpc('process_due_item_returns')).error?.code, '42501');
  receipt('issue-9-primary', { effects, scores: [52, 51], feed: feed.data, replay: 'same result', changedIntent: '23505' });
});

test('Racing Return records, confirmations and Finalize produce one state change, one award per rule and one interaction per participant', async () => {
  const f = await checkedOutFixture('return-race');
  const records = await Promise.all([returnAction(f.bob, f.exchangeId, 0, 'record_return', returnCondition), returnAction(f.alice, f.exchangeId, 0, 'record_return', returnCondition)]);
  assert.deepEqual(records.map(result => result.error?.code ?? 'ok').sort(), ['55000', 'ok']);
  const pending = await itemReturn(f.bob, f.exchangeId); const confirmer = pending.record!.recorded_by === f.bob.id ? f.alice : f.bob;
  const outcomes = await Promise.all([
    returnAction(confirmer, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true }),
    returnAction(confirmer, f.exchangeId, pending.revision, 'confirm_return', { condition_matches: true }),
    admin.rpc('process_due_item_returns'), admin.rpc('process_due_item_returns'),
  ]);
  assert.deepEqual(outcomes.slice(0, 2).map(result => result.error?.code ?? 'ok').sort(), ['55000', 'ok']);
  assert.equal(outcomes[2].error, null); assert.equal(outcomes[3].error, null);
  const effects = await loanEffects(f.exchangeId);
  assert.deepEqual({ state: effects.state, interactions: effects.interactions, events: effects.events?.length, feed: effects.feed, milestones: effects.milestones }, { state: 'completed', interactions: 2, events: 2, feed: 1, milestones: ['completion_settled', 'item_completed', 'item_returned'] });
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_return_recorded')).data?.length, 1);
  assert.equal((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'item_completed')).data?.length, 4);
  assert.deepEqual(await localScores(f.community.id, f.alice, f.bob), [52, 51]);
  receipt('issue-9-race', { records: records.map(result => result.error?.code ?? 'ok'), confirmations: outcomes.slice(0, 2).map(result => result.error?.code ?? 'ok'), effects });
});

test('A conflicting Return condition opens the issue-8 Dispute path, keeps custody and blocks completion in commands and the database', async () => {
  const f = await checkedOutFixture('return-conflict');
  const pending = await recordReturn(f);
  assert.equal((await returnAction(f.alice, f.exchangeId, pending.revision, 'contest_return', { condition: '' })).error?.code, '22023');
  const contest = await returnAction(f.alice, f.exchangeId, pending.revision, 'contest_return', { condition: 'The chuck is cracked and one battery is missing.', issue_type: 'damage' });
  assert.equal(contest.error, null);
  const view = await itemReturn(f.bob, f.exchangeId);
  assert.deepEqual({ state: view.state, contestedBy: view.record?.contested_by, openDispute: view.open_dispute }, { state: 'return_pending', contestedBy: f.alice.id, openDispute: true });
  const cases = await disputeView(f.bob, f.exchangeId);
  assert.equal(cases.cases.length, 1); assert.equal(cases.cases[0].issue_type, 'damage'); assert.equal(cases.cases[0].reporter_id, f.alice.id);
  assert.match(cases.cases[0].responses[0].body, /chuck is cracked/);
  assert.equal((await returnAction(f.alice, f.exchangeId, view.revision, 'confirm_return', { condition_matches: true })).error?.code, '55000');
  assert.equal((await returnAction(f.bob, f.exchangeId, view.revision, 'record_return', returnCondition)).error?.code, '55000');
  assert.equal((await admin.from('exchanges').update({ state: 'returned' }).eq('id', f.exchangeId)).error?.code, '55000');
  assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  const effects = await loanEffects(f.exchangeId);
  assert.deepEqual({ state: effects.state, interactions: effects.interactions, events: effects.events, feed: effects.feed, reservation: effects.reservation },
    { state: 'return_pending', interactions: 0, events: [], feed: 0, reservation: { blocking: true, custody_unresolved: true } });
  const opened = await admin.from('notification_outbox').select('recipient_id').eq('community_id', f.community.id).eq('kind', 'item_dispute_opened').eq('channel', 'in_app');
  assert.deepEqual(opened.data!.map(row => row.recipient_id).sort(), [f.bob.id, f.owner.id].sort());
  assert.equal((await decideBorrow(f.alice, await requestItem(f.carol, f.listing.id))).error?.code, '23P01');
  receipt('issue-9-conflict', { view, dispute: cases.cases[0].status, effects });
});

test('Seven days of missing confirmation despite reminders queues review once without completion or points; email failure leaves state intact', async () => {
  const f = await checkedOutFixture('return-silence');
  await withReturnWindows({ confirmation_reminder_after: '1 second', review_after: '3 seconds' }, async () => {
    await recordReturn(f);
    await wait(1200);
    const reminders = (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).filter(row => row.current);
    assert.deepEqual(reminders.map(row => `${row.recipient_id}:${row.channel}`).sort(), [`${f.alice.id}:email`, `${f.alice.id}:in_app`]);
    const email = reminders.find(row => row.channel === 'email')!; const inApp = reminders.find(row => row.channel === 'in_app')!;
    const failed = await deliverOne(admin, async () => { throw new Error('Provider unavailable'); }, email.id) as { state: string };
    assert.equal(failed.state, 'failed');
    assert.ok(await deliverOne(admin, localDelivery().send, inApp.id));
    assert.equal((await itemReturn(f.bob, f.exchangeId)).state, 'return_pending');
    assert.equal((await admin.rpc('process_due_item_returns')).error, null);
    assert.deepEqual((await admin.from('exchange_review_items').select('id').eq('exchange_id', f.exchangeId)).data, []);
    await wait(2200);
    assert.equal((await admin.rpc('process_due_item_returns')).error, null);
    assert.equal((await admin.rpc('process_due_item_returns')).error, null);
  });
  const queued = await admin.from('exchange_review_items').select('reason').eq('exchange_id', f.exchangeId);
  assert.deepEqual(queued.data, [{ reason: 'missing_return_confirmation' }]);
  const effects = await loanEffects(f.exchangeId);
  assert.deepEqual({ state: effects.state, interactions: effects.interactions, events: effects.events, feed: effects.feed, reservation: effects.reservation },
    { state: 'return_pending', interactions: 0, events: [], feed: 0, reservation: { blocking: true, custody_unresolved: true } });
  assert.deepEqual((await f.owner.client.from('exchange_review_items').select('reason,exchange_id')).data?.filter(row => row.exchange_id === f.exchangeId).map(row => row.reason), ['missing_return_confirmation']);
  assert.deepEqual((await f.carol.client.from('exchange_review_items').select('id').eq('exchange_id', f.exchangeId)).data, []);
  const notices = await admin.from('notification_outbox').select('recipient_id').eq('community_id', f.community.id).eq('kind', 'item_return_review_queued').eq('channel', 'in_app');
  assert.deepEqual(notices.data!.map(row => row.recipient_id).sort(), [f.alice.id, f.bob.id, f.owner.id].sort());
  assert.equal((await itemReturn(f.alice, f.exchangeId)).review.length, 1);
  receipt('issue-9-silence', { queued: queued.data, effects, emailFailure: 'failed and retryable', inApp: 'delivered' });
});

test('Recording a Return obsoletes Return due reminders; a corrected record reschedules confirmation reminders and obsolete work never delivers', async () => {
  const f = await checkedOutFixture('return-reschedule');
  const upcoming = await returnReminders(f.exchangeId, 'item_return_upcoming'); const overdue = await returnReminders(f.exchangeId, 'item_return_overdue');
  assert.deepEqual(upcoming.map(row => `${row.recipient_id}:${row.channel}`).sort(), [`${f.bob.id}:email`, `${f.bob.id}:in_app`]);
  assert.equal(overdue.length, 4); assert.ok([...upcoming, ...overdue].every(row => row.current));
  await withReturnWindows({ confirmation_reminder_after: '1 second' }, async () => {
    const first = await recordReturn(f);
    assert.ok([...await returnReminders(f.exchangeId, 'item_return_upcoming'), ...await returnReminders(f.exchangeId, 'item_return_overdue')].every(row => !row.current));
    await wait(1200);
    const original = await returnReminders(f.exchangeId, 'item_return_confirmation_due');
    const email = original.find(row => row.channel === 'email')!;
    assert.equal((await deliverOne(admin, async () => { throw new Error('Provider unavailable'); }, email.id) as { state: string }).state, 'failed');
    const corrected = await returnAction(f.bob, f.exchangeId, first.revision, 'record_return', { ...returnCondition, accessories: 'Two batteries, charger and case' });
    assert.equal(corrected.error, null);
    assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: email.id })).error?.code, '55000');
    assert.equal((await admin.from('notification_outbox').update({ next_attempt_at: new Date().toISOString() }).in('id', original.map(row => row.id))).error, null);
    for (const row of original) assert.equal((await admin.rpc('claim_notification', { p_outbox_id: row.id })).data, null);
    await wait(1200);
    const current = (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).filter(row => row.current);
    assert.equal(current.length, 2);
    const emails: unknown[] = []; const { send } = localDelivery();
    for (const row of current) assert.ok(await deliverOne(admin, async message => { emails.push(message); await send(message); }, row.id));
    assert.equal(emails.length, 1); assert.equal(JSON.stringify(emails).includes('charger and case'), false);
  });
  const states = (await returnReminders(f.exchangeId, 'item_return_confirmation_due')).map(row => `${row.current}:${row.state}`).sort();
  assert.deepEqual(states, ['false:suppressed', 'false:suppressed', 'true:delivered', 'true:delivered']);
  const view = await itemReturn(f.alice, f.exchangeId);
  assert.deepEqual({ state: view.state, accessories: view.record?.accessories, revision: view.revision }, { state: 'return_pending', accessories: 'Two batteries, charger and case', revision: 2 });
  assert.equal((await f.alice.client.from('notifications').select('kind').eq('kind', 'item_return_confirmation_due')).data?.length, 1);
  receipt('issue-9-reschedule', { states, view });
});

test('Custody: only confirmed physical recovery releases the reservation; missing, disputed and closed-without-completion Returns stay blocking', async () => {
  const results: Record<string, unknown> = {};
  const confirmed = await checkedOutFixture('return-custody-confirmed'); await completeReturn(confirmed);
  const later = await approveBorrow(confirmed.alice, await requestItem(confirmed.carol, confirmed.listing.id));
  assert.equal(later.status, 'approved'); results.confirmed = await loanEffects(confirmed.exchangeId);
  const missing = await checkedOutFixture('return-custody-missing'); await recordReturn(missing);
  assert.equal((await decideBorrow(missing.alice, await requestItem(missing.carol, missing.listing.id))).error?.code, '23P01');
  assert.equal((await decideBorrow(missing.alice, await requestItem(missing.carol, missing.listing.id, '2027-02-01', '2027-02-02'))).error?.code, '23P01');
  results.missing = (await loanEffects(missing.exchangeId)).reservation;
  const disputed = await checkedOutFixture('return-custody-disputed'); const pending = await recordReturn(disputed);
  assert.equal((await returnAction(disputed.alice, disputed.exchangeId, pending.revision, 'contest_return', { condition: 'Missing charger', issue_type: 'missing_item' })).error, null);
  assert.equal((await decideBorrow(disputed.alice, await requestItem(disputed.carol, disputed.listing.id, '2027-02-01', '2027-02-02'))).error?.code, '23P01');
  results.disputed = (await loanEffects(disputed.exchangeId)).reservation;
  const closed = await checkedOutFixture('return-custody-closed'); await recordReturn(closed);
  assert.equal((await admin.from('exchanges').update({ state: 'closed_without_completion' }).eq('id', closed.exchangeId)).error, null);
  assert.equal((await admin.from('exchanges').update({ state: 'return_pending' }).eq('id', closed.exchangeId)).error?.code, '55000');
  assert.deepEqual((await loanEffects(closed.exchangeId)).reservation, { blocking: true, custody_unresolved: true });
  assert.equal((await decideBorrow(closed.alice, await requestItem(closed.carol, closed.listing.id, '2027-02-01', '2027-02-02'))).error?.code, '23P01');
  const held = await checkedOutFixture('return-custody-checked-out');
  assert.equal((await admin.from('exchanges').update({ state: 'closed_without_completion' }).eq('id', held.exchangeId)).error, null);
  assert.deepEqual((await loanEffects(held.exchangeId)).reservation, { blocking: true, custody_unresolved: true });
  for (const f of [missing, disputed, closed, held]) assert.deepEqual((await admin.from('reputation_events').select('id').eq('exchange_id', f.exchangeId)).data, []);
  assert.equal((await admin.from('item_reservations').update({ custody_unresolved: false }).eq('exchange_id', missing.exchangeId)).error?.code, '55000');
  receipt('issue-9-custody', results);
});

test('The returned transition fails closed: a privileged update without a confirmed, uncontested, undisputed Return keeps custody', async () => {
  const blocked = { state: 'return_pending', interactions: 0, events: [], feed: 0, reservation: { blocking: true, custody_unresolved: true } };
  const effectsOf = async (exchangeId: string) => {
    const e = await loanEffects(exchangeId);
    return { state: e.state, interactions: e.interactions, events: e.events, feed: e.feed, reservation: e.reservation };
  };
  const missing = await checkedOutFixture('return-guard-missing');
  assert.equal((await admin.from('exchanges').update({ state: 'return_pending' }).eq('id', missing.exchangeId)).error, null);
  assert.equal((await admin.from('exchanges').update({ state: 'returned' }).eq('id', missing.exchangeId)).error?.code, '55000');
  assert.deepEqual(await effectsOf(missing.exchangeId), blocked);
  const unconfirmed = await checkedOutFixture('return-guard-unconfirmed'); await recordReturn(unconfirmed);
  assert.equal((await admin.from('exchanges').update({ state: 'returned' }).eq('id', unconfirmed.exchangeId)).error?.code, '55000');
  assert.deepEqual(await effectsOf(unconfirmed.exchangeId), blocked);
  const disputed = await checkedOutFixture('return-guard-disputed'); await recordReturn(disputed);
  assert.equal((await reportIssue(disputed.alice, disputed.exchangeId, 'The chuck is loose.')).error, null);
  assert.equal((await admin.from('item_returns').update({ owner_confirmed_at: new Date().toISOString() }).eq('exchange_id', disputed.exchangeId)).error, null);
  assert.equal((await admin.from('exchanges').update({ state: 'returned' }).eq('id', disputed.exchangeId)).error?.code, '55000');
  assert.deepEqual(await effectsOf(disputed.exchangeId), blocked);
  for (const f of [missing, unconfirmed, disputed]) {
    assert.equal((await decideBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02'))).error?.code, '23P01');
  }
  receipt('issue-9-returned-guard', { missing: await effectsOf(missing.exchangeId), unconfirmed: await effectsOf(unconfirmed.exchangeId), disputed: await effectsOf(disputed.exchangeId) });
});

test('An overdue unrecorded Return queues review after seven days while the item stays checked out', async () => {
  const f = await overdueCheckedOutFixture('return-overdue');
  const overdue = await returnReminders(f.exchangeId, 'item_return_overdue');
  assert.equal(overdue.length, 4); assert.ok(overdue.every(row => Date.parse(row.reminder_due_at!) <= Date.now()));
  assert.deepEqual(await returnReminders(f.exchangeId, 'item_return_upcoming'), []);
  await withReturnWindows({ review_after: '1 second' }, async () => { assert.equal((await admin.rpc('process_due_item_returns')).error, null); });
  assert.deepEqual((await admin.from('exchange_review_items').select('reason').eq('exchange_id', f.exchangeId)).data, [{ reason: 'overdue_return' }]);
  assert.equal((await itemHandoff(f.bob, f.exchangeId)).state, 'checked_out');
  receipt('issue-9-overdue', { overdue: overdue.map(row => row.state), review: 'overdue_return' });
});

test('A failure after mutation rolls back the Return record, state, audit, intent and notices together', async () => {
  const f = await checkedOutFixture('return-rollback'); const intent = randomUUID();
  assert.equal((await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.bob.id, intent_id: intent, kind: 'item_return_recorded' })).error, null);
  assert.equal((await returnAction(f.bob, f.exchangeId, 0, 'record_return', returnCondition, intent)).error?.code, '23505');
  const view = await itemReturn(f.bob, f.exchangeId);
  assert.deepEqual({ state: view.state, record: view.record, revision: view.revision }, { state: 'checked_out', record: null, revision: 0 });
  assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', f.bob.id).eq('intent_id', intent)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'item_return_recorded')).data, []);
  assert.ok((await returnReminders(f.exchangeId, 'item_return_overdue')).every(row => row.current));
  receipt('issue-9-rollback', { error: '23505', view });
});

test('Optional Return photos use stable identities, stay participant-only and are compared with Handoff evidence without transitions', async () => {
  const f = await checkedOutFixture('return-photos');
  const args = { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length };
  const prepared = await f.bob.client.rpc('prepare_return_evidence', args); assert.equal(prepared.error, null);
  assert.deepEqual((await f.bob.client.rpc('prepare_return_evidence', args)).data, prepared.data);
  assert.equal((await f.bob.client.rpc('prepare_return_evidence', { ...args, p_byte_size: 10 })).error?.code, '23505');
  assert.equal((await f.bob.client.rpc('prepare_exchange_evidence', { ...args, p_intent_id: randomUUID(), p_evidence_id: randomUUID() })).error?.code, '55000');
  const photo = evidenceSchema.parse(prepared.data); const complete = { p_intent_id: randomUUID(), p_evidence_id: photo.id };
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', complete)).error?.code, '22023');
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  const done = await f.bob.client.rpc('complete_exchange_evidence', complete); assert.equal(done.error, null);
  assert.deepEqual((await f.bob.client.rpc('complete_exchange_evidence', complete)).data, done.data);
  const view = await itemReturn(f.alice, f.exchangeId);
  assert.deepEqual(view.evidence.map(row => [row.purpose, row.state]), [['return', 'ready']]);
  assert.equal(view.state, 'checked_out'); assert.deepEqual((await itemHandoff(f.alice, f.exchangeId)).evidence, []);
  assert.equal((await f.alice.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size, listingImageBytes.length);
  for (const client of [f.carol.client, f.owner.client]) {
    assert.ok((await client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.deepEqual((await client.from('exchange_evidence').select('id').eq('id', photo.id)).data, []);
    assert.equal((await client.rpc('prepare_return_evidence', { ...args, p_intent_id: randomUUID(), p_evidence_id: randomUUID() })).error?.code, '42501');
  }
  await completeReturn(f);
  assert.equal((await f.bob.client.rpc('prepare_return_evidence', { ...args, p_intent_id: randomUUID(), p_evidence_id: randomUUID() })).error?.code, '55000');
  receipt('issue-9-photos', { photo: done.data, compared: view.evidence.length });
});
