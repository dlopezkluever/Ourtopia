import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { actor, activeMember, admin, agreedRemedy, backendUrl, caseAction, createCommunity, decisionView, disputeFixture, disputeView, listingImageBytes, publicClient, realtimeReady, receipt, reviewedDispute, sendMessage, settleFixtureNotices, startConversation } from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';

const suiteStarted = new Date().toISOString();
before(() => realtimeReady(), { timeout: 70000 });
after(() => settleFixtureNotices(['decision-matrix', 'decision-removed', 'decision-surfaces', 'decision-trust', 'decision-realtime'], suiteStarted));

const actions = [['propose_remedy', { kind: 'repair', terms: 'forged' }], ['agree_remedy', { remedy_id: randomUUID() }], ['confirm_settlement', { remedy_id: randomUUID() }], ['request_review', { reason: 'forged' }], ['open_review', { note: 'forged' }], ['decide', { outcome: 'resolved', reason: 'forged' }], ['correct_outcome', { outcome: 'resolved', reason: 'forged' }], ['record_recovery', { reason: 'forged' }]] as const;

test('Only participants settle, only a non-participant same-Community administrator adjudicates, and outsiders read nothing', async () => {
  const f = await disputeFixture('decision-matrix'); await agreedRemedy(f);
  const outsider = await actor({ label: 'decision-outsider' }); const foreign = await actor({ label: 'decision-foreign-admin' });
  assert.equal((await createCommunity(foreign.client)).error, null);
  for (const member of [f.carol, outsider, foreign]) {
    assert.deepEqual((await member.client.from('dispute_actions').select('*').eq('dispute_id', f.disputeId)).data, []);
    assert.equal((await member.client.rpc('read_dispute_decisions', { p_exchange_id: f.exchangeId })).error?.code, '42501');
    for (const [action, details] of actions) assert.equal((await caseAction(member, f.disputeId, action, details)).error?.code, '42501', `${action} denied`);
  }
  assert.equal((await publicClient().rpc('read_dispute_decisions', { p_exchange_id: f.exchangeId })).error?.code, '42501');
  assert.equal((await publicClient().rpc('act_on_dispute', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_action: 'decide', p_details: {} })).error?.code, '42501');
  for (const [action, details] of actions.slice(0, 4)) assert.equal((await caseAction(f.owner, f.disputeId, action, details)).error?.code, '42501', `administrator cannot ${action}`);
  for (const [action, details] of actions.slice(4)) for (const member of [f.alice, f.bob]) assert.equal((await caseAction(member, f.disputeId, action, details)).error?.code, '42501', `participant cannot ${action}`);
  assert.equal((await admin.from('memberships').update({ role: 'administrator' }).eq('community_id', f.community.id).eq('user_id', f.alice.id)).error, null);
  assert.equal((await caseAction(f.alice, f.disputeId, 'open_review', { note: 'Reviewing my own loan' })).error?.code, '42501');
  const rows = await f.owner.client.from('dispute_actions').select('id,action').eq('dispute_id', f.disputeId);
  assert.deepEqual(rows.data?.map(row => row.action), ['remedy_proposed', 'remedy_agreed']);
  for (const member of [f.alice, f.bob, f.owner, f.carol]) {
    assert.equal((await member.client.from('dispute_actions').select('id').eq('dispute_id', f.disputeId)).data?.length, member === f.carol ? 0 : 2);
    assert.ok((await member.client.from('dispute_actions').insert({ dispute_id: f.disputeId, community_id: f.community.id, actor_id: member.id, action: 'outcome_recorded', from_status: 'repairing', to_status: 'resolved', outcome: 'resolved', body: 'forged' })).error);
    assert.ok((await member.client.from('dispute_actions').update({ body: 'rewritten' }).eq('id', rows.data![0].id)).error);
    assert.ok((await member.client.from('dispute_actions').delete().eq('id', rows.data![0].id)).error);
    assert.ok((await member.client.from('disputes').update({ status: 'resolved', closed_at: new Date().toISOString() }).eq('id', f.disputeId)).error);
  }
  assert.equal((await admin.from('dispute_actions').update({ body: 'rewritten' }).eq('id', rows.data![0].id)).error?.code, '42501');
  assert.equal((await admin.from('dispute_actions').select('id').eq('dispute_id', f.disputeId)).data?.length, 2);
  assert.equal((await admin.from('disputes').select('status').eq('id', f.disputeId).single()).data?.status, 'repairing');
  receipt('issue-16-actor-matrix', { participantsOnly: actions.slice(0, 4).map(a => a[0]), adjudicatorOnly: actions.slice(4).map(a => a[0]), denied: ['unrelated member', 'outsider', 'foreign administrator', 'anonymous', 'administrator who is a participant'], directWrites: 'denied', auditRewrite: '42501' });
});

test('Administrator review stays confined to submissions and relevant records after a participant is removed', async () => {
  const f = await disputeFixture('decision-removed');
  const photo = evidenceSchema.parse((await f.bob.client.rpc('prepare_dispute_evidence', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length })).data);
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error, null);
  const conversation = await startConversation(f.bob, f.community.id, f.alice.id);
  const message = await sendMessage(f.bob, conversation.id, 'Private note that was never submitted to the case.');
  assert.equal((await caseAction(f.bob, f.disputeId, 'request_review', { reason: 'Please review my photo.' })).error, null);
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
  assert.equal((await caseAction(f.owner, f.disputeId, 'open_review', {})).error, null);
  const view = await decisionView(f.owner, f.exchangeId);
  assert.equal(view.cases[0].status, 'admin_review'); assert.equal(view.records.handoff?.condition, 'Good. Light marks on the case.');
  const serialized = JSON.stringify(view);
  for (const hidden of ['Front porch at 12 Maple Street', message.body, conversation.id]) assert.equal(serialized.includes(hidden), false, `${hidden} is not exposed`);
  assert.equal((await disputeView(f.owner, f.exchangeId)).cases[0].evidence[0].id, photo.id);
  assert.equal((await f.owner.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size, listingImageBytes.length);
  assert.deepEqual((await f.owner.client.from('messages').select('*').eq('id', message.id)).data, []);
  assert.deepEqual((await f.owner.client.from('conversations').select('*').eq('id', conversation.id)).data, []);
  assert.equal((await f.owner.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId })).error?.code, '42501');
  assert.deepEqual((await f.owner.client.from('item_handoffs').select('location').eq('exchange_id', f.exchangeId)).data, []);
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved', reason: 'The submitted photo cannot date the damage.' })).error, null);
  assert.equal((await decisionView(f.bob, f.exchangeId)).cases[0].status, 'unresolved');
  assert.equal((await f.bob.client.rpc('prepare_dispute_evidence', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length })).error?.code, '55000');
  assert.ok((await fetch(`${backendUrl}/storage/v1/object/public/exchange-evidence/${photo.object_path}`)).status >= 400);
  receipt('issue-16-removed-review', { administratorReads: ['case', 'submitted photo', 'Handoff condition'], hidden: ['Handoff place', 'unsubmitted message', 'conversation', 'Handoff record'], removedParticipantReadsOutcome: true });
});

test('Audit, delivery status, reminders and the console never expose decision notices to non-recipients', async () => {
  const f = await reviewedDispute('decision-surfaces');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'resolved', reason: 'Settled in review.' })).error, null);
  const foreign = await actor({ label: 'decision-surfaces-foreign' }); assert.equal((await createCommunity(foreign.client)).error, null);
  const events = await admin.from('community_events').select('id,kind').eq('community_id', f.community.id).in('kind', ['item_dispute_review', 'item_dispute_outcome']);
  assert.equal(events.data?.length, 3);
  const reminder = await admin.from('notification_reminders').insert({ community_id: f.community.id, source_key: f.disputeId, recipient_id: f.bob.id, channel: 'email', kind: 'item_dispute_outcome', event_id: events.data![0].id, due_at: new Date(Date.now() + 3600000).toISOString() }).select('id').single();
  assert.equal(reminder.error, null);
  const expected = new Map([[f.alice.id, 6], [f.bob.id, 4], [f.owner.id, 2], [f.carol.id, 0], [foreign.id, 0]]);
  for (const member of [f.alice, f.bob, f.carol, f.owner, foreign]) {
    assert.deepEqual((await member.client.from('community_events').select('*').in('id', events.data!.map(e => e.id))).data, []);
    assert.deepEqual((await member.client.from('notification_reminders').select('*').eq('id', reminder.data!.id)).data, []);
    const rows = await member.client.from('notification_outbox').select('recipient_id,kind').eq('dispute_id', f.disputeId).in('kind', ['item_dispute_review', 'item_dispute_outcome']);
    assert.equal(rows.error, null); assert.equal(rows.data!.length, expected.get(member.id), `outbox rows for ${member.email}`);
    for (const row of rows.data!) assert.equal(row.recipient_id, member.id);
    const consoleRows = await member.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
    if (member.id === f.owner.id) { assert.equal(consoleRows.error, null); assert.equal(JSON.stringify(consoleRows.data).includes('item_dispute'), false); }
    else assert.equal(consoleRows.error?.code, '42501');
  }
  receipt('issue-16-privacy-surfaces', { event_read: 'decision audit excluded', outbox_status_read: 'recipient only', reminder_admin_read: 'excluded', inspect_notification_deliveries: 'excluded', counts: Object.fromEntries(expected) });
});

test('Unresolved outcomes stay prominent elsewhere as type and status only', async () => {
  const f = await reviewedDispute('decision-trust');
  assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved', reason: 'No agreement and no verifiable record.' })).error, null);
  const other = await createCommunity(f.alice.client, randomUUID(), 'decision-trust other'); assert.equal(other.error, null);
  const viewer = await activeMember(f.alice, (other.data as { id: string }).id, 'decision-trust-viewer');
  const trust = await viewer.client.rpc('global_trust', { p_subject: f.alice.id }); assert.equal(trust.error, null);
  assert.deepEqual((trust.data as { incidents: unknown[] }).incidents, [{ type: 'unresolved_dispute', status: 'unresolved' }]);
  assert.deepEqual((await viewer.client.from('dispute_actions').select('*').eq('dispute_id', f.disputeId)).data, []);
  assert.deepEqual((await viewer.client.from('trust_incidents').select('*').eq('source_id', f.disputeId)).data, []);
  receipt('issue-16-trust-indicator', trust.data);
});

test('Realtime carries recipient hints only and never decision bodies', async () => {
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
  assert.match(project ?? '', /^ourtopia-issue-\d+$/);
  const published = execFileSync('docker', ['exec', `supabase_db_${project}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('dispute_actions', 'disputes', 'trust_incidents', 'notification_outbox')"], { encoding: 'utf8' }).trim();
  assert.equal(published, '', 'decision tables are not published');
  const f = await reviewedDispute('decision-realtime');
  const foreign = await actor({ label: 'decision-realtime-foreign' }); assert.equal((await createCommunity(foreign.client)).error, null);
  const members = [f.alice, f.bob, f.owner, f.carol, foreign];
  const bodies: unknown[][] = members.map(() => []); const hints: Record<string, unknown>[][] = members.map(() => []);
  const prior = new Set((await admin.from('notification_hints').select('id').in('recipient_id', members.map(m => m.id))).data!.map(r => r.id));
  const channels = await Promise.all(members.map(async (member, index) => {
    const session = await member.client.auth.getSession(); await member.client.realtime.setAuth(session.data.session!.access_token);
    const channel = member.client.channel(`decision-privacy-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (String(change.new.kind).startsWith('item_dispute')) bodies[index].push(change.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints' }, change => { if (!prior.has(String(change.new.id))) hints[index].push(change.new); });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Realtime subscribe timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    assert.equal((await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'resolved', reason: 'Private reasoning never belongs in realtime.' })).error, null);
    const limit = Date.now() + 15000;
    while (hints.slice(0, 3).some(rows => rows.length === 0) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(bodies.map(rows => rows.length), [0, 0, 0, 0, 0]);
    for (let index = 0; index < 3; index++) {
      assert.ok(hints[index].length >= 1, `recipient ${index} hint counts ${JSON.stringify(hints.map(rows => rows.length))}`);
      for (const row of hints[index]) { assert.equal(row.recipient_id, members[index].id); assert.deepEqual(Object.keys(row).sort(), ['id', 'recipient_id']); }
    }
    assert.deepEqual(hints.slice(3).map(rows => rows.length), [0, 0]);
    receipt('issue-16-realtime', { unpublished: true, bodyCounts: bodies.map(rows => rows.length), hints: hints.map(rows => rows.length) });
  } finally { await Promise.all(members.map((member, index) => member.client.removeChannel(channels[index]))); members.forEach(member => member.client.realtime.disconnect()); }
});
