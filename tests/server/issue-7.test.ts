import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { admin, approveBorrow, handoffReminders, borrowingFixture, handoffFixture, advanceHandoff, handoffAction, handoffTerms, handoffSchedule, handoffCondition, itemHandoff, requestItem, withAcknowledgmentWindow, listingImageBytes, receipt } from '../../scripts/verify/backend';
import { handoffSchema, evidenceSchema } from '../../src/features/handoff/model';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

test('Terms, two-party schedule and condition reach checked_out once with optional photos skipped', async () => {
  const f = await handoffFixture('handoff-primary');
  assert.equal((await handoffAction(f.alice, f.exchangeId, 0, 'acknowledge_terms', handoffTerms)).error?.code, '42501');
  assert.equal((await handoffAction(f.bob, f.exchangeId, 0, 'acknowledge_terms', { return_date: true })).error?.code, '22023');
  assert.equal((await handoffAction(f.bob, f.exchangeId, 0, 'confirm_handoff', { condition_acknowledged: true })).error?.code, '55000');
  const h = await advanceHandoff(f, 'condition');
  const intent = randomUUID();
  const first = await handoffAction(f.bob, f.exchangeId, h.revision, 'confirm_handoff', { condition_acknowledged: true }, intent);
  assert.equal(first.error, null);
  const replay = await handoffAction(f.bob, f.exchangeId, h.revision, 'confirm_handoff', { condition_acknowledged: true }, intent);
  assert.deepEqual(replay.data, first.data);
  assert.equal((await handoffAction(f.bob, f.exchangeId, h.revision, 'confirm_handoff', { condition_acknowledged: false }, intent)).error?.code, '23505');
  assert.equal((await handoffAction(f.bob, f.exchangeId, h.revision, 'confirm_handoff', { condition_acknowledged: true })).error?.code, '55000');
  const stored = await itemHandoff(f.alice, f.exchangeId);
  assert.deepEqual({ state: stored.state, condition: stored.condition, accessories: stored.accessories, photos: stored.evidence.length, custody: stored.reservation.custody_unresolved }, { state: 'checked_out', ...handoffCondition, photos: 0, custody: true });
  assert.equal(Number.isFinite(Date.parse(stored.handed_off_at!)), true);
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_handed_off')).data?.length, 1);
  assert.equal((await handoffAction(f.alice, f.exchangeId, stored.revision, 'cancel', { reason: 'Too late' })).error?.code, '55000');
  assert.equal((await admin.from('exchanges').update({ state: 'handoff_pending' }).eq('id', f.exchangeId)).error?.code, '55000');
  receipt('issue-7-handoff', { stored, replay: 'same result', changedIntent: '23505', afterHandoffCancellation: '55000' });
});

test('Cancellation before checkout clears custody, releases identical dates and adds no penalty; terminal states cannot move', async () => {
  const results = [];
  for (const phase of ['approved', 'handoff_pending'] as const) {
    const f = await handoffFixture(`handoff-cancel-${phase}`);
    if (phase === 'handoff_pending') await advanceHandoff(f, 'terms');
    const before = await itemHandoff(f.bob, f.exchangeId);
    assert.equal((await handoffAction(f.bob, f.exchangeId, before.revision, 'cancel', { reason: '' })).error?.code, '22023');
    const cancelled = handoffSchema.parse((await handoffAction(f.bob, f.exchangeId, before.revision, 'cancel', { reason: 'Plans changed' })).data);
    assert.deepEqual({ state: cancelled.state, reason: cancelled.cancelled_reason, blocking: cancelled.reservation.blocking, custody: cancelled.reservation.custody_unresolved }, { state: 'cancelled', reason: 'Plans changed', blocking: false, custody: false });
    for (const state of ['approved', 'handoff_pending', 'checked_out', 'completed']) assert.equal((await admin.from('exchanges').update({ state }).eq('id', f.exchangeId)).error?.code, '55000');
    const later = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id));
    assert.equal(later.reservation?.blocking, true);
    assert.deepEqual((await admin.from('reputation_events').select('id').eq('community_id', f.community.id)).data, []);
    results.push({ phase, cancelled, later });
  }
  for (const terminal of ['completed', 'closed_without_completion', 'expired']) {
    const f = await handoffFixture(`handoff-terminal-${terminal}`);
    if (terminal === 'completed') {
      await advanceHandoff(f);
      for (const state of ['return_pending', 'returned']) assert.equal((await admin.from('exchanges').update({ state }).eq('id', f.exchangeId)).error, null);
    }
    if (terminal === 'expired') {
      const short = await borrowingFixture('handoff-terminal-expired-short');
      const loan = await withAcknowledgmentWindow('1 millisecond', async () => approveBorrow(short.alice, await requestItem(short.bob, short.listing.id)));
      assert.equal((await admin.rpc('expire_item_approval', { p_exchange_id: loan.exchange_id! })).error, null);
      assert.equal((await admin.from('exchanges').update({ state: 'approved' }).eq('id', loan.exchange_id!)).error?.code, '55000');
      continue;
    }
    assert.equal((await admin.from('exchanges').update({ state: terminal }).eq('id', f.exchangeId)).error, null);
    assert.equal((await admin.from('exchanges').update({ state: 'checked_out' }).eq('id', f.exchangeId)).error?.code, '55000');
    if (terminal === 'closed_without_completion') {
      const h = await itemHandoff(f.alice, f.exchangeId);
      assert.equal(h.reservation.custody_unresolved, false); assert.equal(h.reservation.blocking, false);
      assert.equal((await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id))).status, 'approved');
    }
  }
  receipt('issue-7-cancellation-terminal', results);
});

test('Acknowledgment and expiry serialize on the same Exchange and reservation, including the exact deadline', async () => {
  const outcomes = [];
  for (const delay of [0, 970, 1100]) {
    const f = await borrowingFixture('handoff-deadline');
    const loan = await withAcknowledgmentWindow('1 second', async () => approveBorrow(f.alice, await requestItem(f.bob, f.listing.id)));
    const exchangeId = loan.exchange_id!;
    await new Promise(done => setTimeout(done, delay));
    const [ack, expiry] = await Promise.all([handoffAction(f.bob, exchangeId, 0, 'acknowledge_terms', handoffTerms), admin.rpc('expire_item_approval', { p_exchange_id: exchangeId })]);
    assert.equal(expiry.error, null);
    await admin.rpc('expire_item_approval', { p_exchange_id: exchangeId });
    const h = await itemHandoff(f.bob, exchangeId);
    if (!ack.error) { assert.equal(h.state, 'handoff_pending'); assert.equal(h.reservation.blocking, true); }
    else { assert.equal(ack.error.code, '55000'); assert.equal(h.state, 'expired'); assert.equal(h.reservation.blocking, false); }
    outcomes.push({ delay, state: h.state, ack: ack.error?.code ?? 'ok' });
  }
  assert.equal(outcomes[0].state, 'handoff_pending'); assert.equal(outcomes[2].state, 'expired');
  receipt('issue-7-deadline-race', outcomes);
});

test('A failure after mutation rolls back acknowledgment, Exchange, audit, intent and notices together', async () => {
  const f = await handoffFixture('handoff-rollback'); const intent = randomUUID();
  assert.equal((await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.bob.id, intent_id: intent, kind: 'item_terms_acknowledged' })).error, null);
  const result = await handoffAction(f.bob, f.exchangeId, 0, 'acknowledge_terms', handoffTerms, intent);
  assert.equal(result.error?.code, '23505');
  const h = await itemHandoff(f.bob, f.exchangeId);
  assert.deepEqual({ state: h.state, revision: h.revision, acknowledged: h.reservation.acknowledged_at, blocking: h.reservation.blocking }, { state: 'approved', revision: 0, acknowledged: null, blocking: true });
  assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', f.bob.id).eq('intent_id', intent)).data, []);
  assert.deepEqual((await admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId)).data, [{ kind: 'item_approved' }]);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'item_terms_acknowledged')).data, []);
  receipt('issue-7-rollback', { error: result.error.code, h, survivingExchangeEvents: ['item_approved'], commandIntent: false, notices: 0 });
});

test('Reschedule rejects stale confirmation and suppresses queued and already claimed reminders; current reminder delivers both channels', async () => {
  const f = await handoffFixture('handoff-reminder'); await advanceHandoff(f, 'schedule');
  const outbox = { data: await handoffReminders(f.exchangeId) };
  assert.equal(outbox.data.length, 2); assert.ok(outbox.data.every(row => row.current));
  const claimed = await admin.rpc('claim_notification', { p_outbox_id: outbox.data!.find(row => row.channel === 'in_app')!.id });
  assert.equal(claimed.error, null);
  const old = await itemHandoff(f.bob, f.exchangeId);
  assert.equal((await handoffAction(f.alice, f.exchangeId, old.revision, 'propose_schedule', { ...handoffSchedule(), location: 'Side gate' })).error, null);
  assert.equal((await handoffAction(f.bob, f.exchangeId, old.revision, 'confirm_schedule')).error?.code, '55000');
  const claimedValue = claimed.data as { id: string; claim_token: string };
  assert.equal((await admin.rpc('check_notification_claim', { p_outbox_id: claimedValue.id, p_claim_token: claimedValue.claim_token })).data, false);
  assert.equal((await admin.from('notification_outbox').select('state').eq('id', claimedValue.id).single()).data?.state, 'suppressed');
  assert.deepEqual((await admin.from('notifications').select('id').in('outbox_id', outbox.data!.map(row => row.id))).data, []);
  const staleEmail = outbox.data!.find(row => row.channel === 'email')!;
  assert.equal((await admin.rpc('claim_notification', { p_outbox_id: staleEmail.id })).data, null);
  const current = await itemHandoff(f.bob, f.exchangeId);
  assert.equal((await handoffAction(f.bob, f.exchangeId, current.revision, 'confirm_schedule')).error, null);
  const reminders = await handoffReminders(f.exchangeId);
  assert.deepEqual(reminders.filter(row => !row.current).map(row => row.state), ['suppressed', 'suppressed']);
  const currentRows = reminders.filter(row => row.current);
  assert.equal(currentRows.length, 2);
  const email = currentRows.find(row => row.channel === 'email')!;
  const failed = await deliverOne(admin, async () => { throw new Error('Provider unavailable'); }, email.id) as { state: string };
  assert.equal(failed.state, 'failed'); assert.equal((await itemHandoff(f.alice, f.exchangeId)).state, 'handoff_pending');
  assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: email.id })).error, null);
  const emails: unknown[] = []; const { send } = localDelivery();
  for (const row of currentRows) await deliverOne(admin, async message => { emails.push(message); await send(message); }, row.id);
  assert.equal(emails.length, 1);
  assert.equal((await f.alice.client.from('notifications').select('kind').in('outbox_id', currentRows.map(row => row.id))).data?.[0]?.kind, 'item_handoff_upcoming');
  assert.equal(JSON.stringify(emails).includes('Side gate'), false);
  assert.equal(await deliverOne(admin, send, email.id), null);
  const mailbox = await fetch(`${process.env.TEST_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${f.alice.email}`)}`);
  assert.equal(((await mailbox.json()) as { messages: unknown[] }).messages.length, 1);
  receipt('issue-7-reminders', { stale: outbox.data, current: currentRows, emails });
});

test('Interrupted evidence uses a stable identity, checks stored metadata and never transitions the Exchange', async () => {
  const f = await handoffFixture('handoff-evidence'); await advanceHandoff(f, 'terms');
  const args = { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length };
  const prepared = await f.bob.client.rpc('prepare_exchange_evidence', args); assert.equal(prepared.error, null);
  assert.deepEqual((await f.bob.client.rpc('prepare_exchange_evidence', args)).data, prepared.data);
  assert.equal((await f.bob.client.rpc('prepare_exchange_evidence', { ...args, p_byte_size: 10 })).error?.code, '23505');
  const photo = evidenceSchema.parse(prepared.data);
  const completion = { p_intent_id: randomUUID(), p_evidence_id: photo.id };
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', completion)).error?.code, '22023');
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  const done = await f.bob.client.rpc('complete_exchange_evidence', completion); assert.equal(done.error, null);
  assert.deepEqual((await f.bob.client.rpc('complete_exchange_evidence', completion)).data, done.data);
  const h = await itemHandoff(f.bob, f.exchangeId);
  assert.equal(h.state, 'handoff_pending'); assert.equal(h.evidence.length, 1); assert.equal(h.evidence[0].state, 'ready');
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_evidence_completed')).data?.length, 1);
  assert.equal((await f.alice.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size, listingImageBytes.length);
  const pendingArgs = { ...args, p_intent_id: randomUUID(), p_evidence_id: randomUUID() };
  const pending = evidenceSchema.parse((await f.bob.client.rpc('prepare_exchange_evidence', pendingArgs)).data);
  for (const [member, revision, action, details] of [
    [f.alice, 1, 'propose_schedule', handoffSchedule()], [f.bob, 2, 'confirm_schedule', {}],
    [f.alice, 3, 'record_condition', handoffCondition], [f.bob, 4, 'confirm_handoff', { condition_acknowledged: true }],
  ] as const) assert.equal((await handoffAction(member, f.exchangeId, revision, action, details)).error, null);
  assert.equal((await f.bob.client.rpc('prepare_exchange_evidence', pendingArgs)).error, null);
  assert.equal((await f.bob.client.rpc('prepare_exchange_evidence', { ...pendingArgs, p_intent_id: randomUUID(), p_evidence_id: randomUUID() })).error?.code, '55000');
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(pending.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: pending.id })).error, null);
  assert.equal((await itemHandoff(f.bob, f.exchangeId)).state, 'checked_out');
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_handed_off')).data?.length, 1);
  receipt('issue-7-upload-recovery', { photo: done.data, h });
});
