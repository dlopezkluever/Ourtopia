import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, addActiveMember, admin, applyInvite, conversationFixture, createCommunity, issueInvite, receipt, sendMessage, startConversation } from '../../scripts/verify/backend';
import { inboxRowSchema } from '../../src/features/messages/model';
import { deliverOne } from '../../supabase/functions/notifications/worker';

const rows = async (client: Awaited<ReturnType<typeof actor>>['client'], conversationId: string) =>
  (await client.from('messages').select('author_id,body').eq('conversation_id', conversationId).order('created_at').order('id')).data;

test('two active members start one Community conversation without an Exchange and exchange persisted text', async () => {
  const f = await conversationFixture('exchange-text');
  assert.deepEqual(Object.keys(f.conversation).sort(), ['community_id', 'created_at', 'id', 'participant_high', 'participant_low', 'started_by']);
  assert.equal(f.conversation.community_id, f.community.id);
  assert.deepEqual([f.conversation.participant_low, f.conversation.participant_high], [f.first.id, f.second.id].sort());
  assert.equal((await startConversation(f.second, f.community.id, f.first.id)).id, f.conversation.id, 'the reverse start reuses the pair conversation');
  await sendMessage(f.first, f.conversation.id, 'Can I pick up the ladder at 6?');
  await sendMessage(f.second, f.conversation.id, 'Yes, the side gate is open.');
  const expected = [{ author_id: f.first.id, body: 'Can I pick up the ladder at 6?' }, { author_id: f.second.id, body: 'Yes, the side gate is open.' }];
  assert.deepEqual(await rows(f.first.client, f.conversation.id), expected);
  assert.deepEqual(await rows(f.second.client, f.conversation.id), expected);
  const inbox = await f.second.client.rpc('conversation_inbox');
  assert.equal(inbox.error, null);
  assert.deepEqual(inboxRowSchema.array().parse(inbox.data).map(row => ({ id: row.id, community_id: row.community_id, counterpart_id: row.counterpart_id, counterpart_email: row.counterpart_email, can_send: row.can_send })),
    [{ id: f.conversation.id, community_id: f.community.id, counterpart_id: f.first.id, counterpart_email: f.first.email, can_send: true }]);
  receipt('issue-15-exchange', { conversation: f.conversation, messages: expected, inbox: inbox.data });
});

test('send retries are semantic: same intent returns the prior message, a changed body conflicts, concurrency writes once', async () => {
  const f = await conversationFixture('retry');
  const startIntent = randomUUID();
  const started = await startConversation(f.first, f.community.id, f.second.id, startIntent);
  assert.deepEqual(await startConversation(f.first, f.community.id, f.second.id, startIntent), started);
  assert.equal((await f.first.client.rpc('start_conversation', { p_intent_id: startIntent, p_community_id: f.community.id, p_participant_id: f.owner.id })).error?.code, '23505');
  const intent = randomUUID();
  const sent = await sendMessage(f.first, f.conversation.id, 'Leaving the drill on the porch.', intent);
  assert.deepEqual(await sendMessage(f.first, f.conversation.id, 'Leaving the drill on the porch.', intent), sent);
  assert.equal((await f.first.client.rpc('send_message', { p_intent_id: intent, p_conversation_id: f.conversation.id, p_body: 'Changed text' })).error?.code, '23505');
  const raced = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.second.client.rpc('send_message', { p_intent_id: raced, p_conversation_id: f.conversation.id, p_body: 'Thanks!' })));
  assert.ok(results.every(result => result.error === null));
  assert.equal(new Set(results.map(result => result.data.id)).size, 1);
  assert.deepEqual(await rows(f.first.client, f.conversation.id), [{ author_id: f.first.id, body: 'Leaving the drill on the porch.' }, { author_id: f.second.id, body: 'Thanks!' }]);
  const starts = await Promise.all([0, 1, 2].map(() => f.owner.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_participant_id: f.first.id })));
  assert.ok(starts.every(result => result.error === null));
  assert.equal(new Set(starts.map(result => result.data.id)).size, 1, 'concurrent starts converge on one pair conversation');
  assert.equal((await admin.from('messages').select('id').eq('author_id', f.first.id)).data?.length, 1);
  receipt('issue-15-retries', { sameIntent: sent.id, changedPayload: '23505', concurrentSends: results.length, distinctMessages: 1, concurrentStarts: 1 });
});

test('messages are append-only and Community scope is immutable even for the service role', async () => {
  const f = await conversationFixture('append-only');
  const message = await sendMessage(f.first, f.conversation.id, 'Original text');
  for (const client of [f.first.client, f.second.client]) {
    assert.equal((await client.from('messages').update({ body: 'Edited' }).eq('id', message.id)).error?.code, '42501');
    assert.equal((await client.from('messages').delete().eq('id', message.id)).error?.code, '42501');
  }
  const other = (await createCommunity(f.owner.client)).data;
  assert.equal((await admin.from('messages').update({ body: 'Edited' }).eq('id', message.id)).error?.code, '55000');
  assert.equal((await admin.from('messages').delete().eq('id', message.id)).error?.code, '55000');
  assert.equal((await admin.from('conversations').update({ community_id: other.id }).eq('id', f.conversation.id)).error?.code, '55000');
  assert.equal((await admin.from('conversations').delete().eq('id', f.conversation.id)).error?.code, '55000');
  assert.deepEqual(await rows(f.second.client, f.conversation.id), [{ author_id: f.first.id, body: 'Original text' }]);
  receipt('issue-15-append-only', { clientRewrite: '42501', serviceRewrite: '55000', scopeChange: '55000' });
});

test('start and send require current active membership of both people in the same Community', async () => {
  const f = await conversationFixture('guards');
  const foreign = await actor({ label: 'foreign' });
  const foreignCommunity = (await createCommunity(foreign.client)).data;
  const pending = await actor({ label: 'pending' });
  await applyInvite(pending, (await issueInvite(f.owner, f.community.id, pending.email)).id);
  const outsider = await actor({ label: 'outsider' });
  const start = (who: Awaited<ReturnType<typeof actor>>, community: string, participant: string) => who.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: community, p_participant_id: participant });
  const send = (who: Awaited<ReturnType<typeof actor>>, body = 'hello') => who.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: body });
  const codes: Record<string, string | undefined> = {
    self: (await start(f.first, f.community.id, f.first.id)).error?.code,
    foreignParticipant: (await start(f.first, f.community.id, foreign.id)).error?.code,
    pendingParticipant: (await start(f.first, f.community.id, pending.id)).error?.code,
    pendingStarter: (await start(pending, f.community.id, f.first.id)).error?.code,
    outsiderStarter: (await start(outsider, f.community.id, f.first.id)).error?.code,
    crossCommunity: (await start(foreign, foreignCommunity.id, f.first.id)).error?.code,
    adminSend: (await send(f.owner)).error?.code,
    outsiderSend: (await send(outsider)).error?.code,
    foreignSend: (await send(foreign)).error?.code,
    emptyBody: (await send(f.first, '   ')).error?.code,
    longBody: (await send(f.first, 'x'.repeat(4001))).error?.code,
    missingIntent: (await f.first.client.rpc('send_message', { p_intent_id: null, p_conversation_id: f.conversation.id, p_body: 'hi' })).error?.code,
  };
  assert.deepEqual(codes, { self: '22023', foreignParticipant: '42501', pendingParticipant: '42501', pendingStarter: '42501', outsiderStarter: '42501', crossCommunity: '42501', adminSend: '42501', outsiderSend: '42501', foreignSend: '42501', emptyBody: '22023', longBody: '22023', missingIntent: '22023' });
  const retryIntent = randomUUID();
  await sendMessage(f.first, f.conversation.id, 'Before suspension', retryIntent);
  for (const status of ['suspended', 'removed', 'rejected']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error, null);
    assert.equal((await send(f.first)).error?.code, '42501', `${status} send`);
    assert.equal((await f.first.client.rpc('send_message', { p_intent_id: retryIntent, p_conversation_id: f.conversation.id, p_body: 'Before suspension' })).error?.code, '42501', `${status} prior-result retry`);
    assert.equal((await start(f.first, f.community.id, f.second.id)).error?.code, '42501', `${status} start`);
    assert.deepEqual(await rows(f.first.client, f.conversation.id), [], `${status} read`);
  }
  assert.equal((await admin.from('memberships').update({ status: 'active' }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error, null);
  assert.equal((await start(f.second, f.community.id, f.first.id)).data?.id, f.conversation.id);
  assert.equal((await admin.from('messages').select('id').eq('conversation_id', f.conversation.id)).data?.length, 1);
  receipt('issue-15-guards', { codes, inactiveStates: ['suspended', 'removed', 'rejected'], writtenMessages: 1 });
});

test('a removed participant with an eligible selection grant reads only existing messages and can never send', async () => {
  const f = await conversationFixture('selection');
  const third = await addActiveMember(f.owner, f.community.id, 'selection-third');
  const unrelatedConversation = await startConversation(third, f.community.id, f.first.id);
  await sendMessage(third, unrelatedConversation.id, 'Unrelated logistics');
  await sendMessage(f.second, f.conversation.id, 'I returned the saw with a chipped blade.');
  await sendMessage(f.first, f.conversation.id, 'Thanks for telling me.');
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error, null);
  assert.deepEqual(await rows(f.first.client, f.conversation.id), []);
  const grant = await admin.from('message_selection_grants').insert({ conversation_id: f.conversation.id, user_id: f.first.id, dispute_id: randomUUID() }).select().single();
  assert.equal(grant.error, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  await sendMessage(f.second, f.conversation.id, 'Sent after the grant');
  const visible = await rows(f.first.client, f.conversation.id);
  assert.deepEqual(visible, [{ author_id: f.second.id, body: 'I returned the saw with a chipped blade.' }, { author_id: f.first.id, body: 'Thanks for telling me.' }]);
  assert.deepEqual(await rows(f.first.client, unrelatedConversation.id), []);
  assert.deepEqual((await f.first.client.from('communities').select('id').eq('id', f.community.id)).data, []);
  assert.equal((await f.first.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'New text' })).error?.code, '42501');
  assert.equal((await f.first.client.rpc('start_conversation', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_participant_id: f.second.id })).error?.code, '42501');
  const inbox = await f.first.client.rpc('conversation_inbox');
  assert.deepEqual(inboxRowSchema.array().parse(inbox.data).map(row => ({ id: row.id, can_send: row.can_send })), [{ id: f.conversation.id, can_send: false }]);
  const outsiderGrant = await admin.from('message_selection_grants').insert({ conversation_id: f.conversation.id, user_id: third.id, dispute_id: randomUUID() });
  assert.equal(outsiderGrant.error, null);
  assert.equal((await rows(third.client, f.conversation.id))?.length, 0, 'a grant never admits a nonparticipant');
  assert.equal((await admin.from('message_selection_grants').update({ ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', grant.data.id)).error, null);
  assert.deepEqual(await rows(f.first.client, f.conversation.id), [], 'a closed grant ends the narrow read');
  receipt('issue-15-selection-exception', { visibleWithGrant: visible.length, afterGrantHidden: true, sendDenied: '42501', unrelatedConversationRows: 0, closedGrantRows: 0 });
});

test('a committed send appends one private audit event and one durable in-app notice even across retries', async () => {
  const f = await conversationFixture('audit-notice'); const intent = randomUUID();
  const message = await sendMessage(f.first, f.conversation.id, 'Private text never enters an audit or notice. ', intent);
  await sendMessage(f.first, f.conversation.id, message.body, intent);
  const events = await admin.from('community_events').select('*').eq('actor_id', f.first.id).eq('intent_id', intent);
  assert.equal(events.error, null); assert.equal(events.data?.length, 1); assert.equal(events.data?.[0].kind, 'message_sent');
  const notices = await admin.from('notification_outbox').select('*').eq('event_id', events.data?.[0].id);
  assert.equal(notices.error, null); assert.equal(notices.data?.length, 1);
  const notice = notices.data?.[0]; assert.ok(notice);
  assert.equal(notice.recipient_id, f.second.id); assert.equal(notice.channel, 'in_app');
  assert.equal(JSON.stringify({ events: events.data, notices: notices.data }).includes(message.body), false);
  await deliverOne(admin, async () => { assert.fail('an in-app notice never calls an email provider'); }, notice.id);
  assert.equal(await deliverOne(admin, async () => {}, notice.id), null);
  assert.equal((await f.second.client.from('notifications').select('id').eq('outbox_id', notice.id)).data?.length, 1);
  assert.equal((await f.owner.client.from('notification_outbox').select('*').eq('id', notice.id)).data?.length, 0);
  assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: notice.id })).error?.code, '42501');
  assert.equal((await admin.from('community_events').update({ kind: 'rewritten' }).eq('id', events.data?.[0].id)).error?.code, '55000');
  receipt('issue-15-audit-notice', { messageId: message.id, eventId: events.data?.[0].id, noticeId: notice.id, deliveryCount: 1, privateBodyInMetadata: false });
});

test('an audit failure rolls back the message, hints, intent and outbox in the send transaction', async () => {
  const f = await conversationFixture('atomic-send');
  const intent = randomUUID();
  const collision = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.first.id, intent_id: intent, kind: 'message_sent' }).select('id').single();
  assert.equal(collision.error, null);
  const hintsBefore = await admin.from('notification_hints').select('id').in('recipient_id', [f.first.id, f.second.id]);
  assert.equal(hintsBefore.error, null);
  const failed = await f.first.client.rpc('send_message', { p_intent_id: intent, p_conversation_id: f.conversation.id, p_body: 'This message must roll back.' });
  assert.equal(failed.error?.code, '23505');
  assert.deepEqual(await rows(f.second.client, f.conversation.id), []);
  assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', f.first.id).eq('intent_id', intent)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('event_id', collision.data?.id)).data, []);
  const hintsAfter = await admin.from('notification_hints').select('id').in('recipient_id', [f.first.id, f.second.id]);
  assert.equal(hintsAfter.error, null);
  assert.deepEqual(hintsAfter.data, hintsBefore.data);
  const committed = await sendMessage(f.first, f.conversation.id, 'A fresh intent commits normally.');
  assert.deepEqual(await rows(f.second.client, f.conversation.id), [{ author_id: f.first.id, body: 'A fresh intent commits normally.' }]);
  receipt('issue-15-send-rollback', { failedCode: '23505', survivingFailedMessages: 0, survivingFailedIntents: 0, survivingFailedNotices: 0, hintCountUnchanged: true, committedMessageId: committed.id });
});
