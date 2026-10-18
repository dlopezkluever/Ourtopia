import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { admin, applyInvite, decideApplication, issueInvite, completedItemFixture, createCommunity, evidenceMessages, messageEvidenceFixture, messageEvidenceView, receipt, reportIssue, sendMessage, settleFixtureNotices, startConversation, submitDisputeMessages } from '../../scripts/verify/backend';
import { messageSnapshotSchema, submissionSchema } from '../../src/features/message-evidence/model';

const suiteStarted = new Date().toISOString();
after(() => settleFixtureNotices(['msg-primary', 'msg-denials', 'msg-removed-inside-removed', 'msg-removed-inside-suspended', 'msg-removed-outside', 'msg-denials-foreign'], suiteStarted));

const snapshotRows = (disputeId: string) => admin.from('dispute_message_evidence').select('*').eq('dispute_id', disputeId).order('submitted_at').order('id');
const intentRows = async (actorId: string, intent: string) => (await admin.from('command_intents').select('intent_id').eq('actor_id', actorId).eq('intent_id', intent)).data;

test('A participant copies one selected counterparty message into append-only case evidence with semantic retries and duplicate reuse', async () => {
  const f = await messageEvidenceFixture('msg-primary');
  const chosen = f.messages[2]; const intent = randomUUID();
  const first = await submitDisputeMessages(f.bob, f.disputeId, [chosen.id], intent);
  assert.equal(first.error, null);
  const outcome = submissionSchema.parse(first.data);
  assert.equal(outcome.added, 1);
  const [snapshot] = outcome.snapshots;
  assert.deepEqual({ ...snapshot, id: undefined, submitted_at: undefined }, {
    id: undefined, submitted_at: undefined, dispute_id: f.disputeId, community_id: f.community.id, source_message_id: chosen.id,
    source_author_id: f.alice.id, source_created_at: snapshot.source_created_at, body: 'It was intact when I handed it over.', submitter_id: f.bob.id,
  });
  assert.equal(Date.parse(snapshot.source_created_at), Date.parse(chosen.created_at));
  assert.ok(Date.parse(snapshot.submitted_at) >= Date.parse(chosen.created_at));
  assert.deepEqual((await submitDisputeMessages(f.bob, f.disputeId, [chosen.id], intent)).data, first.data);
  assert.equal((await submitDisputeMessages(f.bob, f.disputeId, [f.messages[0].id], intent)).error?.code, '23505');
  const duplicate = submissionSchema.parse((await submitDisputeMessages(f.bob, f.disputeId, [chosen.id])).data);
  assert.equal(duplicate.added, 0);
  assert.deepEqual(duplicate.snapshots, [snapshot]);
  const counterparty = submissionSchema.parse((await submitDisputeMessages(f.alice, f.disputeId, [chosen.id])).data);
  assert.equal(counterparty.added, 1, 'the other participant keeps an independent submission');
  const rows = await snapshotRows(f.disputeId);
  assert.deepEqual(rows.data?.map(row => [row.source_message_id, row.submitter_id]), [[chosen.id, f.bob.id], [chosen.id, f.alice.id]]);
  assert.equal((await admin.from('dispute_message_evidence').update({ body: 'rewritten' }).eq('id', snapshot.id)).error?.code, '55000');
  assert.equal((await admin.from('dispute_message_evidence').delete().eq('id', snapshot.id)).error?.code, '55000');
  assert.deepEqual(messageSnapshotSchema.parse((await admin.from('dispute_message_evidence').select('*').eq('id', snapshot.id).single()).data), snapshot);
  const events = await admin.from('community_events').select('id,kind').eq('actor_id', f.bob.id).eq('intent_id', intent);
  assert.deepEqual(events.data?.map(row => row.kind), ['item_dispute_response']);
  const notices = await admin.from('notification_outbox').select('recipient_id,channel,kind,dispute_id').eq('event_id', events.data![0].id);
  assert.deepEqual(notices.data?.map(row => `${row.recipient_id}:${row.channel}`).sort(), [f.alice.id, f.owner.id].flatMap(id => [`${id}:email`, `${id}:in_app`]).sort());
  assert.ok(notices.data?.every(row => row.dispute_id === f.disputeId && row.kind === 'item_dispute_response'));
  assert.equal(JSON.stringify([events.data, notices.data]).includes('intact'), false);
  assert.deepEqual((await admin.from('community_events').select('id').eq('actor_id', f.bob.id).eq('kind', 'item_dispute_response').gte('created_at', snapshot.submitted_at)).data?.length, 1, 'a duplicate selection enqueues no second notice');
  const view = await messageEvidenceView(f.bob, f.disputeId);
  assert.equal(view.can_submit, true);
  assert.deepEqual(view.sources.map(row => row.body), evidenceMessages);
  receipt('issue-17-primary', { snapshot, duplicate: { added: duplicate.added, sameId: duplicate.snapshots[0].id === snapshot.id }, changedPayload: '23505', appendOnly: '55000', notices: notices.data });
});

test('Nonparticipants, administrators, unrelated and foreign conversations, guessed IDs and closed cases copy nothing', async () => {
  const f = await messageEvidenceFixture('msg-denials');
  const unrelated = await startConversation(f.bob, f.community.id, f.carol.id);
  const carolText = await sendMessage(f.carol, unrelated.id, 'Carol unrelated conversation text');
  const foreignCommunity = await createCommunity(f.alice.client, randomUUID(), 'msg-denials-foreign circle'); assert.equal(foreignCommunity.error, null);
  const foreignId = (foreignCommunity.data as { id: string }).id;
  const decision = await decideApplication(f.alice, (await applyInvite(f.bob, (await issueInvite(f.alice, foreignId, f.bob.email)).id)).id);
  assert.equal(decision.error, null);
  const foreignConversation = await startConversation(f.bob, foreignId, f.alice.id);
  const foreignText = await sendMessage(f.alice, foreignConversation.id, 'Same people, different Community');
  const valid = f.messages[2].id;
  const attempts: [string, Awaited<ReturnType<typeof messageEvidenceFixture>>['bob'], string[], string][] = [
    ['nonparticipant member', f.carol, [valid], '42501'],
    ['administrator impersonating a participant', f.owner, [valid], '42501'],
    ['unrelated conversation', f.bob, [carolText.id], '42501'],
    ['other-Community source with the same participants', f.bob, [foreignText.id], '42501'],
    ['guessed message ID', f.bob, [randomUUID()], '42501'],
    ['valid selection mixed with a mismatched source', f.bob, [valid, carolText.id], '42501'],
    ['empty selection', f.bob, [], '22023'],
  ];
  const codes: Record<string, string | undefined> = {};
  for (const [name, member, ids, code] of attempts) {
    const intent = randomUUID();
    codes[name] = (await submitDisputeMessages(member, f.disputeId, ids, intent)).error?.code;
    assert.equal(codes[name], code, name);
    assert.deepEqual(await intentRows(member.id, intent), [], `${name} records no intent`);
  }
  assert.deepEqual((await snapshotRows(f.disputeId)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('dispute_id', f.disputeId).eq('kind', 'item_dispute_response')).data, []);
  assert.equal((await admin.from('disputes').update({ status: 'resolved', closed_at: new Date().toISOString() }).eq('id', f.disputeId)).error, null);
  codes['closed case'] = (await submitDisputeMessages(f.bob, f.disputeId, [valid])).error?.code;
  assert.equal(codes['closed case'], '55000');
  assert.deepEqual((await snapshotRows(f.disputeId)).data, []);
  receipt('issue-17-denials', { codes, copiedRows: 0, notices: 0 });
});

test('A removed or suspended participant inside the eligible window selects existing counterparty text but never sends', async () => {
  for (const status of ['removed', 'suspended'] as const) {
    const f = await completedItemFixture(`msg-removed-inside-${status}`, 29);
    const conversation = await startConversation(f.alice, f.community.id, f.bob.id);
    const existing = await sendMessage(f.alice, conversation.id, 'You returned it with a cracked case.');
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
    assert.deepEqual((await f.bob.client.from('messages').select('id').eq('conversation_id', conversation.id)).data, [], 'no read before an eligible Dispute');
    assert.equal((await reportIssue(f.bob, f.exchangeId, 'The case was cracked before I borrowed it.')).error, null);
    const disputeId = (await admin.from('disputes').select('id').eq('exchange_id', f.exchangeId).single()).data!.id;
    await new Promise(resolve => setTimeout(resolve, 20));
    const later = await sendMessage(f.alice, conversation.id, 'Sent after the grant opened');
    assert.deepEqual((await f.bob.client.from('messages').select('body').eq('conversation_id', conversation.id)).data, [{ body: existing.body }]);
    const view = await messageEvidenceView(f.bob, disputeId);
    assert.deepEqual(view.sources.map(row => row.id), [existing.id]);
    assert.equal((await f.bob.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: conversation.id, p_body: 'New text' })).error?.code, '42501');
    assert.equal((await submitDisputeMessages(f.bob, disputeId, [later.id])).error?.code, '42501');
    const submitted = await submitDisputeMessages(f.bob, disputeId, [existing.id]);
    assert.equal(submitted.error, null);
    assert.equal(submissionSchema.parse(submitted.data).snapshots[0].body, existing.body);
    assert.equal((await admin.from('messages').select('id').eq('conversation_id', conversation.id)).data?.length, 2, 'no message was sent by the removed participant');
  }
  receipt('issue-17-removed-inside', { statuses: ['removed', 'suspended'], existingReadable: true, laterHidden: true, send: '42501' });
});

test('After the narrow obligation window closes, removed-participant reads and submissions fail while snapshots stay with administrators', async () => {
  const f = await completedItemFixture('msg-removed-outside', 31);
  const conversation = await startConversation(f.bob, f.community.id, f.alice.id);
  const message = await sendMessage(f.alice, conversation.id, 'I will cover half of the repair.');
  const other = await sendMessage(f.alice, conversation.id, 'Unselected later remark.');
  const dispute = await admin.from('disputes').insert({ exchange_id: f.exchangeId, community_id: f.community.id, reporter_id: f.alice.id, respondent_id: f.bob.id, issue_type: 'damage', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }).select('id').single();
  assert.equal(dispute.error, null); const disputeId = dispute.data!.id;
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
  assert.equal((await f.bob.client.from('messages').select('id').eq('conversation_id', conversation.id)).data?.length, 2, 'an open prior Dispute keeps existing text readable after day 30');
  const submitted = await submitDisputeMessages(f.bob, disputeId, [message.id]); assert.equal(submitted.error, null);
  const snapshot = submissionSchema.parse(submitted.data).snapshots[0];
  assert.equal((await admin.from('disputes').update({ status: 'unresolved', closed_at: new Date().toISOString() }).eq('id', disputeId)).error, null);
  assert.deepEqual((await f.bob.client.from('messages').select('id').eq('conversation_id', conversation.id)).data, []);
  assert.deepEqual((await f.bob.client.from('dispute_message_evidence').select('id').eq('dispute_id', disputeId)).data, []);
  assert.equal((await f.bob.client.rpc('read_dispute_message_evidence', { p_dispute_id: disputeId })).error?.code, '42501');
  assert.equal((await submitDisputeMessages(f.bob, disputeId, [other.id])).error?.code, '42501');
  const adminView = await messageEvidenceView(f.owner, disputeId);
  assert.deepEqual(adminView.snapshots, [snapshot]);
  assert.deepEqual(adminView.sources, []);
  assert.equal((await f.alice.client.from('dispute_message_evidence').select('id').eq('dispute_id', disputeId)).data?.length, 1);
  assert.deepEqual((await f.owner.client.from('messages').select('id').eq('conversation_id', conversation.id)).data, []);
  receipt('issue-17-removed-outside', { afterClose: { removedReads: 0, removedSnapshotReads: 0, submit: '42501' }, administratorSnapshots: 1, administratorSourceRows: 0 });
});
