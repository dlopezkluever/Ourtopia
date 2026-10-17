import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { admin, advanceHandoff, completedItemFixture, disputeFixture, disputeView, handoffFixture, reportingBoundaryFixture, listingImageBytes, receipt, reportIssue } from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

test('Report, repeat report and respondent reply retain one case with append-only history and semantic retries', async () => {
  const f = await handoffFixture('case-primary'); await advanceHandoff(f);
  const intent = randomUUID(); const first = await reportIssue(f.bob, f.exchangeId, 'Broken case', 'damage', intent);
  assert.equal(first.error, null);
  assert.deepEqual((await reportIssue(f.bob, f.exchangeId, 'Broken case', 'damage', intent)).data, first.data);
  assert.equal((await reportIssue(f.bob, f.exchangeId, 'Different story', 'damage', intent)).error?.code, '23505');
  assert.equal((await reportIssue(f.bob, f.exchangeId, 'The hinge is cracked')).error, null);
  let view = await disputeView(f.alice, f.exchangeId); const id = view.cases[0].id;
  const replyIntent = randomUUID(); const args = { p_intent_id: replyIntent, p_dispute_id: id, p_body: 'I can see the crack. It was intact at Handoff.' };
  const reply = await f.alice.client.rpc('respond_to_dispute', args); assert.equal(reply.error, null);
  assert.deepEqual((await f.alice.client.rpc('respond_to_dispute', args)).data, reply.data);
  assert.equal((await f.alice.client.rpc('respond_to_dispute', { ...args, p_body: 'Changed' })).error?.code, '23505');
  view = await disputeView(f.bob, f.exchangeId);
  assert.equal(view.state, 'checked_out'); assert.equal(view.cases.length, 1);
  assert.equal(view.cases[0].status, 'issue_reported');
  assert.deepEqual(view.cases[0].responses.map(row => row.body), ['Broken case', 'The hinge is cracked', args.p_body]);
  assert.equal((await f.bob.client.from('dispute_responses').update({ body: 'rewrite' }).eq('dispute_id', id)).error?.code, '42501');
  assert.equal((await admin.from('dispute_responses').delete().eq('dispute_id', id)).error?.code, '42501');
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'issue_reported')).data?.length, 1);
  receipt('issue-8-primary', view);
});

test('Original reporting boundary includes exactly 30 days and rejects later time with Cron delayed', async () => {
  const rows = reportingBoundaryFixture();
  assert.equal(rows, 't\nt\nf');
  const inside = await completedItemFixture('case-before-deadline', 29.999);
  assert.equal((await reportIssue(inside.bob, inside.exchangeId)).error, null);
  const after = await completedItemFixture('case-after-deadline', 30.001);
  assert.equal((await reportIssue(after.bob, after.exchangeId)).error?.code, '22023');
  assert.deepEqual((await admin.from('disputes').select('id').eq('exchange_id', after.exchangeId)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('community_id', after.community.id).like('kind', 'item_dispute_%')).data, []);
  receipt('issue-8-boundary', { exactGuardResults: rows, before: 'accepted', after: '22023', partialEffects: 0 });
});

test('Invalid reports and closed-case mutations leave no partial effects', async () => {
  const f = await handoffFixture('case-atomic'); await advanceHandoff(f);
  for (const [body, type] of [['', 'damage'], ['A problem', 'unsupported']]) {
    const intent = randomUUID();
    assert.equal((await reportIssue(f.bob, f.exchangeId, body, type, intent)).error?.code, '22023');
    assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', f.bob.id).eq('intent_id', intent)).data, []);
  }
  assert.deepEqual((await admin.from('disputes').select('id').eq('exchange_id', f.exchangeId)).data, []);
  assert.deepEqual((await admin.from('trust_incidents').select('id').eq('community_id', f.community.id)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).like('kind', 'item_dispute_%')).data, []);
  assert.equal((await reportIssue(f.bob, f.exchangeId)).error, null);
  const view = await disputeView(f.bob, f.exchangeId); const id = view.cases[0].id;
  assert.equal((await admin.from('disputes').update({ status: 'resolved', closed_at: new Date().toISOString() }).eq('id', id)).error, null);
  const replies = await admin.from('dispute_responses').select('id,body').eq('dispute_id', id);
  assert.equal((await f.alice.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: id, p_body: 'Too late' })).error?.code, '55000');
  assert.equal((await f.bob.client.rpc('prepare_dispute_evidence', { p_intent_id: randomUUID(), p_dispute_id: id, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length })).error?.code, '55000');
  assert.deepEqual((await admin.from('dispute_responses').select('id,body').eq('dispute_id', id)).data, replies.data);
  assert.deepEqual((await admin.from('exchange_evidence').select('id').eq('dispute_id', id)).data, []);
  receipt('issue-8-atomic', { invalidReports: '22023', noPartialEffects: true, closedResponseAndUpload: '55000', history: replies.data });
});

test('Post-completion cases preserve fulfillment, completion time, Qualifying Interactions and numeric reputation', async () => {
  const f = await completedItemFixture('case-completed');
  const before = await admin.from('exchanges').select('state,completed_at').eq('id', f.exchangeId).single();
  const interactions = await admin.from('qualifying_interactions').select('id,participant_id').eq('exchange_id', f.exchangeId).order('id');
  const points = await admin.from('reputation_events').select('id,points').eq('exchange_id', f.exchangeId).order('id');
  assert.equal(interactions.data?.length, 2);
  assert.equal((await reportIssue(f.alice, f.exchangeId)).error, null);
  assert.deepEqual((await admin.from('exchanges').select('state,completed_at').eq('id', f.exchangeId).single()).data, before.data);
  assert.deepEqual((await admin.from('qualifying_interactions').select('id,participant_id').eq('exchange_id', f.exchangeId).order('id')).data, interactions.data);
  assert.deepEqual((await admin.from('reputation_events').select('id,points').eq('exchange_id', f.exchangeId).order('id')).data, points.data);
  assert.equal((await admin.from('exchanges').update({ completed_at: new Date().toISOString() }).eq('id', f.exchangeId)).error?.code, '42501');
  receipt('issue-8-post-completion', { before: before.data, interactions: interactions.data, points: points.data, view: await disputeView(f.bob, f.exchangeId) });
});

test('Racing reports create one case and an open case blocks ordinary finalization in the database', async () => {
  const f = await handoffFixture('case-race'); await advanceHandoff(f);
  for (const state of ['return_pending', 'returned']) assert.equal((await admin.from('exchanges').update({ state }).eq('id', f.exchangeId)).error, null);
  const reports = await Promise.all([reportIssue(f.bob, f.exchangeId, 'Broken handle'), reportIssue(f.alice, f.exchangeId, 'Inspect the handle')]);
  for (const result of reports) assert.equal(result.error, null);
  const outcomes = await Promise.all([admin.from('exchanges').update({ state: 'completed' }).eq('id', f.exchangeId), reportIssue(f.bob, f.exchangeId, 'More detail')]);
  assert.equal(outcomes[0].error?.code, '55000'); assert.equal(outcomes[1].error, null);
  const view = await disputeView(f.bob, f.exchangeId); assert.equal(view.state, 'returned'); assert.equal(view.cases.length, 1); assert.equal(view.cases[0].responses.length, 3);
  assert.deepEqual((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId)).data, []);
  const racing = await handoffFixture('case-racing-completion'); await advanceHandoff(racing);
  for (const state of ['return_pending', 'returned']) assert.equal((await admin.from('exchanges').update({ state }).eq('id', racing.exchangeId)).error, null);
  const simultaneous = await Promise.all([reportIssue(racing.bob, racing.exchangeId), reportIssue(racing.alice, racing.exchangeId), admin.from('exchanges').update({ state: 'completed' }).eq('id', racing.exchangeId)]);
  assert.equal(simultaneous[0].error, null); assert.equal(simultaneous[1].error, null);
  assert.ok(simultaneous[2].error === null || simultaneous[2].error.code === '55000');
  const final = await disputeView(racing.bob, racing.exchangeId); assert.equal(final.cases.length, 1); assert.equal(final.cases[0].responses.length, 2);
  assert.equal(final.state, simultaneous[2].error ? 'returned' : 'completed');
  receipt('issue-8-race', { openFirst: view, simultaneous: final, completionError: simultaneous[2].error?.code ?? null });
});

test('Case evidence uses existing upload reservation and durable completion with retry; incorrect uploads leave no ready evidence', async () => {
  const f = await disputeFixture('case-evidence');
  const args = { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length };
  const prepared = await f.bob.client.rpc('prepare_dispute_evidence', args); assert.equal(prepared.error, null);
  const photo = evidenceSchema.parse(prepared.data);
  assert.deepEqual((await f.bob.client.rpc('prepare_dispute_evidence', args)).data, prepared.data);
  assert.equal((await f.bob.client.rpc('prepare_dispute_evidence', { ...args, p_byte_size: 1 })).error?.code, '23505');
  const complete = { p_intent_id: randomUUID(), p_evidence_id: photo.id };
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', complete)).error?.code, '22023');
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  const done = await f.bob.client.rpc('complete_exchange_evidence', complete); assert.equal(done.error, null);
  assert.deepEqual((await f.bob.client.rpc('complete_exchange_evidence', complete)).data, done.data);
  assert.equal((await disputeView(f.alice, f.exchangeId)).cases[0].evidence[0].state, 'ready');
  assert.equal((await f.owner.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size, listingImageBytes.length);
  receipt('issue-8-evidence', { evidence: done.data, bucket: 'exchange-evidence', adminSubmittedOnly: true });
});

test('Opening and response notices reach counterparty and current administrators in app and email without case payloads', async () => {
  const f = await disputeFixture('case-notices');
  const rows = await admin.from('notification_outbox').select('*').eq('community_id', f.community.id).eq('kind', 'item_dispute_opened');
  assert.equal(rows.error, null);
  assert.deepEqual(rows.data!.map(row => `${row.recipient_id}:${row.channel}`).sort(), [f.alice.id, f.owner.id].flatMap(id => [`${id}:email`, `${id}:in_app`]).sort());
  const { send } = localDelivery();
  for (const row of rows.data!) assert.ok(await deliverOne(admin, send, row.id));
  const notices = await f.alice.client.from('notifications').select('kind').eq('kind', 'item_dispute_opened');
  assert.deepEqual(notices.data, [{ kind: 'item_dispute_opened' }]);
  assert.equal((await f.alice.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_body: 'I will inspect it.' })).error, null);
  const replies = await admin.from('notification_outbox').select('recipient_id,channel').eq('community_id', f.community.id).eq('kind', 'item_dispute_response');
  assert.deepEqual(replies.data!.map(row => `${row.recipient_id}:${row.channel}`).sort(), [f.bob.id, f.owner.id].flatMap(id => [`${id}:email`, `${id}:in_app`]).sort());
  receipt('issue-8-notices', { opened: rows.data!.map(({ recipient_id, channel, kind, state }) => ({ recipient_id, channel, kind, state })), replies: replies.data });
});
