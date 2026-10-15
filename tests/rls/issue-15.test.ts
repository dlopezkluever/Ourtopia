import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, addActiveMember, admin, anonKey, applyInvite, conversationFixture, createCommunity, issueInvite, publicClient, realtimeReady, receipt, sendMessage } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

test('only current participants can read private rows and inboxes, including against a nonparticipant administrator', async () => {
  const f = await conversationFixture('rls');
  const unrelated = await addActiveMember(f.owner, f.community.id, 'unrelated');
  const foreign = await actor({ label: 'foreign' }); await createCommunity(foreign.client);
  const pending = await actor({ label: 'pending' });
  await applyInvite(pending, (await issueInvite(f.owner, f.community.id, pending.email)).id);
  const outsider = await actor({ label: 'outsider' });
  await sendMessage(f.first, f.conversation.id, 'Private handoff instructions');
  const evidence = [];
  for (const [label, client] of [['administrator', f.owner.client], ['unrelated', unrelated.client], ['foreign', foreign.client], ['pending', pending.client], ['outsider', outsider.client], ['anonymous', publicClient()]] satisfies [string, ReturnType<typeof publicClient>][]) {
    for (const table of ['conversations', 'messages', 'message_selection_grants']) {
      const query = await client.from(table).select('*').eq(table === 'conversations' ? 'id' : 'conversation_id', f.conversation.id);
      assert.ok(query.error?.code === '42501' || (query.error === null && query.data?.length === 0), `${label} ${table}`);
    }
    const inbox = await client.rpc('conversation_inbox');
    assert.ok(inbox.error?.code === '42501' || inbox.data?.length === 0, `${label} inbox`);
    const events = await client.from('community_events').select('*').eq('community_id', f.community.id).in('kind', ['conversation_started', 'message_sent']);
    assert.ok(events.error?.code === '42501' || events.data?.length === 0, `${label} audit`);
    const notices = await client.from('notification_outbox').select('*').eq('community_id', f.community.id).in('kind', ['conversation_started', 'message_sent']);
    assert.ok(notices.error?.code === '42501' || notices.data?.length === 0, `${label} delivery metadata`);
    evidence.push({ label, conversationRows: 0, messageRows: 0, privateAuditRows: 0, deliveryRows: 0 });
  }
  assert.deepEqual((await f.second.client.from('messages').select('body').eq('conversation_id', f.conversation.id)).data, [{ body: 'Private handoff instructions' }]);
  receipt('issue-15-rls-boundaries', evidence);
});

test('ordinary clients cannot forge participants, messages, selection grants, audit or notification state', async () => {
  const f = await conversationFixture('forged');
  for (const client of [f.first.client, f.owner.client, publicClient()]) {
    for (const [table, values] of [
      ['conversations', { community_id: f.community.id, participant_low: f.owner.id, participant_high: f.second.id, started_by: f.owner.id }],
      ['messages', { conversation_id: f.conversation.id, community_id: f.community.id, author_id: f.second.id, intent_id: randomUUID(), body: 'Forged' }],
      ['message_selection_grants', { conversation_id: f.conversation.id, user_id: f.owner.id, dispute_id: randomUUID() }],
      ['community_events', { community_id: f.community.id, actor_id: f.first.id, kind: 'message_sent', intent_id: randomUUID() }],
      ['notification_outbox', { community_id: f.community.id, recipient_id: f.owner.id, channel: 'in_app', kind: 'message_sent' }],
    ] satisfies [string, Record<string, unknown>][]) {
      assert.equal((await client.from(table).insert(values)).error?.code, '42501', `insert ${table}`);
      assert.equal((await client.from(table).update(values).eq('id', f.conversation.id)).error?.code, '42501', `update ${table}`);
      assert.equal((await client.from(table).delete().eq('id', f.conversation.id)).error?.code, '42501', `delete ${table}`);
    }
  }
  assert.deepEqual((await f.owner.client.from('messages').select('*')).data, []);
  receipt('issue-15-rls-forgery', { clients: 3, tables: 5, mutationsDenied: 45 });
});

test('realtime publishes recipient identities only and never private message bodies to participants or nonparticipants', { timeout: 45000 }, async () => {
  const f = await conversationFixture('realtime');
  const outsider = await actor({ label: 'outsider' });
  const foreign = await actor({ label: 'foreign' }); await createCommunity(foreign.client);
  const unrelated = await addActiveMember(f.owner, f.community.id, 'unrelated');
  const inactive = await addActiveMember(f.owner, f.community.id, 'inactive');
  assert.equal((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', inactive.id)).error, null);
  const channels = [];
  const counts: Record<string, { messages: number; hints: number }> = {};
  const hints: Record<string, unknown>[] = [];
  try {
    for (const [label, client] of [['participant', f.second.client], ['administrator', f.owner.client], ['outsider', outsider.client], ['foreign', foreign.client], ['unrelated', unrelated.client], ['inactive', inactive.client]] satisfies [string, ReturnType<typeof publicClient>][]) {
      counts[label] = { messages: 0, hints: 0 };
      const session = await client.auth.getSession(); await client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
      const bodyChannel = client.channel(`p15-body-${randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${f.conversation.id}` }, () => counts[label].messages++);
      const hintChannel = client.channel(`p15-hint-${randomUUID()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${f.second.id}` }, change => { counts[label].hints++; hints.push(change.new); });
      for (const channel of [bodyChannel, hintChannel]) {
        channels.push({ client, channel });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${label} subscription timed out`)), 10000);
          channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(status)); } });
        });
      }
    }
    for (const count of Object.values(counts)) count.hints = 0;
    await sendMessage(f.first, f.conversation.id, 'This body must never be in a realtime payload.');
    const deadline = Date.now() + 10000;
    while (counts.participant.hints === 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    await new Promise(done => setTimeout(done, 1200));
    assert.ok(counts.participant.hints >= 1, 'the participant must receive the committed hint');
    for (const [label, count] of Object.entries(counts)) {
      assert.equal(count.messages, 0, `${label} receives no bodies`);
      if (label !== 'participant') assert.equal(count.hints, 0, `${label} cannot subscribe to participant hints`);
    }
    assert.ok(hints.length > 0);
    for (const hint of hints) assert.deepEqual(Object.keys(hint).sort(), ['id', 'recipient_id']);
    assert.deepEqual((await f.second.client.from('messages').select('body').eq('conversation_id', f.conversation.id)).data, [{ body: 'This body must never be in a realtime payload.' }]);
    receipt('issue-15-rls-realtime', { counts, hintKeys: ['id', 'recipient_id'], freshAuthorizedRead: true });
  } finally { await Promise.all(channels.map(async ({ client, channel }) => { await client.removeChannel(channel); client.realtime.disconnect(); })); }
});

test('current membership revocation invalidates reads, candidates, inbox and writes without relying on JWT expiry', async () => {
  const f = await conversationFixture('revocation');
  await sendMessage(f.second, f.conversation.id, 'Visible before removal');
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.first.id)).error, null);
    assert.deepEqual((await f.first.client.from('conversations').select('*').eq('id', f.conversation.id)).data, []);
    assert.deepEqual((await f.first.client.from('messages').select('*').eq('conversation_id', f.conversation.id)).data, []);
    assert.deepEqual((await f.first.client.rpc('conversation_inbox')).data, []);
    assert.deepEqual((await f.first.client.rpc('conversation_candidates', { p_community_id: f.community.id })).data, []);
    assert.equal((await f.first.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'Denied' })).error?.code, '42501');
  }
  receipt('issue-15-rls-revocation', { states: ['pending', 'rejected', 'suspended', 'removed'], staleJwtReadRows: 0, sendDenied: '42501' });
});
