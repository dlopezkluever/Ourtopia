import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import { actor, admin, createCommunity, messageEvidenceFixture, messageEvidenceView, publicClient, realtimeReady, receipt, settleFixtureNotices, submitDisputeMessages } from '../../scripts/verify/backend';

const suiteStarted = new Date().toISOString();
before(() => realtimeReady(), { timeout: 70000 });
after(() => settleFixtureNotices(['msg-rls-matrix', 'msg-rls-surfaces', 'msg-rls-realtime'], suiteStarted));

const project = () => {
  const id = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
  assert.match(id ?? '', /^ourtopia-issue-\d+$/);
  return id!;
};
const sql = (query: string) => execFileSync('docker', ['exec', `supabase_db_${project()}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', query], { encoding: 'utf8' }).trim();

test('Source messages and case snapshots are authorized independently for every actor', async () => {
  const f = await messageEvidenceFixture('msg-rls-matrix');
  const chosen = f.messages[2]; const unselected = f.messages.filter(row => row.id !== chosen.id);
  assert.equal((await submitDisputeMessages(f.bob, f.disputeId, [chosen.id])).error, null);
  const outsider = await actor({ label: 'msg-rls-outsider' }); const foreign = await actor({ label: 'msg-rls-foreign-admin' });
  assert.equal((await createCommunity(foreign.client)).error, null);
  const matrix: Record<string, { snapshots: number; sources: number; conversation: number }> = {};
  const readers = { reporter: f.bob, counterparty: f.alice, administrator: f.owner, member: f.carol, outsider, foreignAdministrator: foreign };
  for (const [name, member] of Object.entries(readers)) {
    const snapshots = await member.client.from('dispute_message_evidence').select('body,source_message_id').eq('dispute_id', f.disputeId);
    const sources = await member.client.from('messages').select('id').eq('conversation_id', f.conversation.id);
    const conversation = await member.client.from('conversations').select('id').eq('id', f.conversation.id);
    assert.equal(snapshots.error, null); assert.equal(sources.error, null); assert.equal(conversation.error, null);
    matrix[name] = { snapshots: snapshots.data!.length, sources: sources.data!.length, conversation: conversation.data!.length };
    if (snapshots.data!.length) assert.deepEqual(snapshots.data, [{ body: chosen.body, source_message_id: chosen.id }]);
  }
  assert.deepEqual(matrix, {
    reporter: { snapshots: 1, sources: 4, conversation: 1 }, counterparty: { snapshots: 1, sources: 4, conversation: 1 },
    administrator: { snapshots: 1, sources: 0, conversation: 0 }, member: { snapshots: 0, sources: 0, conversation: 0 },
    outsider: { snapshots: 0, sources: 0, conversation: 0 }, foreignAdministrator: { snapshots: 0, sources: 0, conversation: 0 },
  });
  for (const row of [chosen, ...unselected]) assert.deepEqual((await f.owner.client.from('messages').select('*').eq('id', row.id)).data, [], 'the snapshot never opens its source or adjacent text');
  const adminView = await messageEvidenceView(f.owner, f.disputeId);
  assert.equal(adminView.can_submit, false); assert.deepEqual(adminView.sources, []);
  assert.equal(unselected.some(row => JSON.stringify(adminView).includes(row.body)), false);
  for (const member of [f.carol, outsider, foreign]) assert.equal((await member.client.rpc('read_dispute_message_evidence', { p_dispute_id: f.disputeId })).error?.code, '42501');
  assert.equal((await publicClient().rpc('read_dispute_message_evidence', { p_dispute_id: f.disputeId })).error?.code, '42501');
  assert.deepEqual((await publicClient().from('dispute_message_evidence').select('*').eq('dispute_id', f.disputeId)).data ?? [], []);
  const snapshotId = (await admin.from('dispute_message_evidence').select('id').eq('dispute_id', f.disputeId).single()).data!.id;
  for (const member of [f.bob, f.alice, f.owner]) {
    assert.equal((await member.client.from('dispute_message_evidence').insert({ dispute_id: f.disputeId, community_id: f.community.id, source_message_id: unselected[0].id, source_author_id: unselected[0].author_id, source_created_at: unselected[0].created_at, body: 'forged', submitter_id: member.id })).error?.code, '42501');
    assert.equal((await member.client.from('dispute_message_evidence').update({ body: 'rewritten' }).eq('id', snapshotId)).error?.code, '42501');
    assert.equal((await member.client.from('dispute_message_evidence').delete().eq('id', snapshotId)).error?.code, '42501');
    assert.equal((await member.client.from('message_selection_grants').insert({ conversation_id: f.conversation.id, user_id: member.id, dispute_id: f.disputeId })).error?.code, '42501');
  }
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.owner.id)).error, null);
  assert.deepEqual((await f.owner.client.from('dispute_message_evidence').select('id').eq('dispute_id', f.disputeId)).data, [], 'a removed administrator loses case snapshots');
  receipt('issue-17-rls-matrix', { matrix, administratorSourceRowsPerMessage: 0, directWrites: '42501', anonymousRead: '42501', removedAdministrator: 0 });
});

test('Audit, delivery status, reminders, the delivery console and Storage never carry selected or unselected message text', async () => {
  const f = await messageEvidenceFixture('msg-rls-surfaces');
  const intent = randomUUID();
  assert.equal((await submitDisputeMessages(f.bob, f.disputeId, [f.messages[2].id], intent)).error, null);
  const event = (await admin.from('community_events').select('id,kind').eq('actor_id', f.bob.id).eq('intent_id', intent).single()).data!;
  assert.equal(event.kind, 'item_dispute_response');
  const reminder = await admin.from('notification_reminders').insert({ community_id: f.community.id, source_key: f.disputeId, recipient_id: f.alice.id, channel: 'email', kind: 'item_dispute_response', event_id: event.id, due_at: new Date(Date.now() + 3600000).toISOString() }).select('id').single();
  assert.equal(reminder.error, null);
  const foreign = await actor({ label: 'msg-rls-surface-foreign' }); assert.equal((await createCommunity(foreign.client)).error, null);
  for (const member of [f.alice, f.bob, f.carol, f.owner, foreign]) {
    assert.deepEqual((await member.client.from('community_events').select('*').eq('id', event.id)).data, []);
    assert.deepEqual((await member.client.from('notification_reminders').select('*').eq('id', reminder.data!.id)).data, []);
    const outbox = await member.client.from('notification_outbox').select('*').eq('event_id', event.id);
    assert.equal(outbox.error, null);
    assert.equal(outbox.data!.length, [f.alice.id, f.owner.id].includes(member.id) ? 2 : 0);
    for (const row of outbox.data!) assert.equal(row.recipient_id, member.id);
    const consoleRows = await member.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
    if (member.id === f.owner.id) {
      assert.equal(consoleRows.error, null);
      const text = JSON.stringify(consoleRows.data);
      assert.equal(text.includes('item_dispute'), false);
      for (const message of f.messages) assert.equal(text.includes(message.body), false);
    } else assert.equal(consoleRows.error?.code, '42501');
  }
  const surfaces = sql(`select concat_ws('|', (select count(*) from public.community_events where id = '${event.id}' and to_jsonb(community_events)::text like '%intact%'),
    (select count(*) from public.notification_outbox where event_id = '${event.id}' and to_jsonb(notification_outbox)::text like '%intact%'),
    (select count(*) from storage.objects where name like '${f.exchangeId}/%'))`);
  assert.equal(surfaces, '0|0|0', 'no audit or outbox row copies text and no Storage object is created');
  receipt('issue-17-privacy-surfaces', { event_read: 'excluded for everyone', outbox_status_read: 'recipients only', reminder_admin_read: 'excluded', inspect_notification_deliveries: 'case notices and text excluded', storage: 'no objects', bodiesInAuditOrOutbox: 0 });
});

test('Realtime publishes neither snapshots nor grants and delivers only recipient ID hints', async () => {
  const published = sql("select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('dispute_message_evidence', 'message_selection_grants', 'messages', 'community_events', 'notification_outbox', 'notification_hints')");
  assert.equal(published.includes('dispute_message_evidence') || published.includes('message_selection_grants'), false, published);
  assert.ok(published.split(',').includes('notification_hints'), published);
  const f = await messageEvidenceFixture('msg-rls-realtime');
  const foreign = await actor({ label: 'msg-rls-realtime-foreign' }); assert.equal((await createCommunity(foreign.client)).error, null);
  const members = [f.bob, f.alice, f.owner, f.carol, foreign];
  const bodies: unknown[][] = members.map(() => []); const hints: Record<string, unknown>[][] = members.map(() => []);
  const prior = new Set((await admin.from('notification_hints').select('id').in('recipient_id', members.map(m => m.id))).data!.map(r => r.id));
  const channels = await Promise.all(members.map(async (member, index) => {
    const session = await member.client.auth.getSession(); await member.client.realtime.setAuth(session.data.session!.access_token);
    const channel = member.client.channel(`message-evidence-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (String(change.new.kind).startsWith('item_dispute')) bodies[index].push(change.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints' }, change => { if (!prior.has(String(change.new.id))) hints[index].push(change.new); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime subscribe timed out')), 15000);
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { clearTimeout(timer); reject(new Error(`Realtime subscribe failed: ${status}`)); }
      });
    });
    return channel;
  }));
  try {
    const submission = await submitDisputeMessages(f.bob, f.disputeId, [f.messages[2].id]);
    assert.equal(submission.error, null);
    const submissionResult = z.object({ added: z.number() }).parse(submission.data);
    assert.equal(submissionResult.added, 1);
    const directHints = await admin.from('notification_hints').select('id,recipient_id').in('recipient_id', members.slice(0, 3).map(member => member.id));
    assert.equal(directHints.error, null);
    const submittedHints = directHints.data!.filter(row => !prior.has(row.id));
    assert.deepEqual(submittedHints.map(row => row.recipient_id).sort(), members.slice(0, 3).map(member => member.id).sort());
    const limit = Date.now() + 15000;
    while (hints.slice(0, 3).some(rows => rows.length === 0) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(bodies.map(rows => rows.length), [0, 0, 0, 0, 0]);
    for (let index = 0; index < 3; index++) {
      assert.ok(hints[index].length >= 1, `recipient ${index} hint counts ${JSON.stringify(hints.map(rows => rows.length))}`);
      for (const row of hints[index]) { assert.equal(row.recipient_id, members[index].id); assert.deepEqual(Object.keys(row).sort(), ['id', 'recipient_id']); }
    }
    assert.deepEqual(hints.slice(3).map(rows => rows.length), [0, 0]);
    receipt('issue-17-realtime', { rpcAdded: submissionResult.added, directHints: submittedHints, unpublished: ['dispute_message_evidence', 'message_selection_grants'], published, bodyCounts: bodies.map(rows => rows.length), realtimeHints: hints.map(rows => rows.length) });
  } finally { await Promise.all(members.map((member, index) => member.client.removeChannel(channels[index]))); members.forEach(member => member.client.realtime.disconnect()); }
});
