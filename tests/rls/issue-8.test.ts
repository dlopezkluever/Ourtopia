import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { actor, activeMember, admin, advanceHandoff, backendUrl, completedItemFixture, createCommunity, disputeFixture, disputeView, handoffFixture, listingImageBytes, publicClient, realtimeReady, receipt, reportIssue, settleFixtureNotices, startConversation, sendMessage } from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';

const suiteStarted = new Date().toISOString();
before(() => realtimeReady(), { timeout: 70000 });
after(() => settleFixtureNotices(['case-privacy', 'case-surfaces', 'case-prior-removed', 'case-prior-suspended', 'case-prior-late-removed', 'case-prior-late-suspended', 'case-redacted', 'case-realtime'], suiteStarted));

test('Case rows, commands, submitted Storage and unsubmitted Handoff evidence enforce each actor boundary', async () => {
  const f = await handoffFixture('case-privacy'); await advanceHandoff(f, 'schedule');
  const handoff = evidenceSchema.parse((await f.bob.client.rpc('prepare_exchange_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length })).data);
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(handoff.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: handoff.id })).error, null);
  assert.equal((await reportIssue(f.bob, f.exchangeId)).error, null);
  const id = (await disputeView(f.bob, f.exchangeId)).cases[0].id;
  const photo = evidenceSchema.parse((await f.bob.client.rpc('prepare_dispute_evidence', { p_intent_id: randomUUID(), p_dispute_id: id, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length })).data);
  assert.ok((await f.alice.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  assert.deepEqual((await f.owner.client.from('exchange_evidence').select('id').eq('id', photo.id)).data, []);
  assert.ok((await f.owner.client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 60)).error);
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error, null);
  for (const member of [f.alice, f.bob, f.owner]) {
    assert.equal((await member.client.from('disputes').select('id').eq('id', id)).data?.[0]?.id, id);
    assert.equal((await member.client.from('dispute_responses').select('body').eq('dispute_id', id)).data?.[0]?.body, 'The drill case is damaged.');
    assert.equal((await member.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size, listingImageBytes.length);
    const signed = await member.client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 30);
    assert.equal(signed.error, null); assert.equal((await fetch(signed.data!.signedUrl)).status, 200);
    assert.equal((await member.client.from('disputes').update({ status: 'resolved' }).eq('id', id)).error?.code, '42501');
    assert.ok((await member.client.storage.from('exchange-evidence').remove([photo.object_path])).error || (await member.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size === listingImageBytes.length);
  }
  assert.equal((await f.owner.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId })).error?.code, '42501');
  const conversation = await startConversation(f.bob, f.community.id, f.alice.id);
  const message = await sendMessage(f.bob, conversation.id, 'This general conversation was never submitted as evidence.');
  assert.equal((await f.alice.client.from('messages').select('body').eq('id', message.id)).data?.[0]?.body, message.body);
  assert.deepEqual((await f.owner.client.from('messages').select('*').eq('id', message.id)).data, []);
  assert.deepEqual((await f.owner.client.from('conversations').select('*').eq('id', conversation.id)).data, []);
  assert.ok((await f.owner.client.storage.from('exchange-evidence').download(handoff.object_path)).error);
  assert.ok((await f.owner.client.storage.from('exchange-evidence').createSignedUrl(handoff.object_path, 30)).error);
  const outsider = await actor({ label: 'case-outsider' }); const foreign = await actor({ label: 'case-foreign-admin' });
  assert.equal((await createCommunity(foreign.client)).error, null);
  const denied = [f.carol, outsider, foreign];
  for (const member of denied) {
    assert.deepEqual((await member.client.from('disputes').select('*').eq('id', id)).data, []);
    assert.deepEqual((await member.client.from('dispute_responses').select('*').eq('dispute_id', id)).data, []);
    assert.deepEqual((await member.client.from('exchange_evidence').select('*').eq('id', photo.id)).data, []);
    assert.equal((await member.client.rpc('read_exchange_disputes', { p_exchange_id: f.exchangeId })).error?.code, '42501');
    assert.equal((await reportIssue(member, f.exchangeId)).error?.code, '42501');
    assert.equal((await member.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: id, p_body: 'forged' })).error?.code, '42501');
    assert.equal((await member.client.rpc('prepare_dispute_evidence', { p_intent_id: randomUUID(), p_dispute_id: id, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: 1 })).error?.code, '42501');
    assert.equal((await member.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error?.code, '42501');
    assert.ok((await member.client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.ok((await member.client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 30)).error);
    assert.ok((await member.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  }
  assert.equal((await f.owner.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: id, p_body: 'admin cannot act as participant' })).error?.code, '42501');
  assert.equal((await publicClient().rpc('read_exchange_disputes', { p_exchange_id: f.exchangeId })).error?.code, '42501');
  assert.ok((await fetch(`${backendUrl}/storage/v1/object/public/exchange-evidence/${photo.object_path}`)).status >= 400);
  receipt('issue-8-private-matrix', { allowedCaseReaders: ['owner participant', 'borrower participant', 'same Community administrator'], denied: ['unrelated member', 'outsider', 'foreign administrator', 'anonymous'], unsubmittedHandoff: 'administrator denied', signedURL: 'authorized first, 30 seconds' });
});

test('Audit, delivery status, reminders and console reveal case metadata only to explicitly relevant recipients', async () => {
  const f = await disputeFixture('case-surfaces');
  const foreign = await actor({ label: 'case-delivery-foreign' }); assert.equal((await createCommunity(foreign.client)).error, null);
  const events = await admin.from('community_events').select('id').eq('community_id', f.community.id).eq('kind', 'item_dispute_opened');
  assert.equal(events.data?.length, 1);
  const reminder = await admin.from('notification_reminders').insert({ community_id: f.community.id, source_key: f.disputeId, recipient_id: f.bob.id, channel: 'email', kind: 'item_dispute_response', event_id: events.data![0].id, due_at: new Date(Date.now() + 3600000).toISOString() }).select('id').single();
  assert.equal(reminder.error, null);
  for (const member of [f.alice, f.bob, f.carol, f.owner, foreign]) {
    assert.deepEqual((await member.client.from('community_events').select('*').eq('id', events.data![0].id)).data, []);
    assert.deepEqual((await member.client.from('notification_reminders').select('*').eq('id', reminder.data!.id)).data, []);
    const outbox = await member.client.from('notification_outbox').select('recipient_id,kind').eq('community_id', f.community.id).eq('kind', 'item_dispute_opened');
    assert.equal(outbox.error, null);
    assert.equal(outbox.data!.length, [f.alice.id, f.owner.id].includes(member.id) ? 2 : 0);
    for (const row of outbox.data!) assert.equal(row.recipient_id, member.id);
    const consoleRows = await member.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
    if (member.id === f.owner.id) { assert.equal(consoleRows.error, null); assert.equal(JSON.stringify(consoleRows.data).includes('item_dispute'), false); }
    else assert.equal(consoleRows.error?.code, '42501');
  }
  const original = await f.carol.client.from('community_events').select('kind').eq('community_id', f.community.id).eq('kind', 'community_created');
  assert.deepEqual(original.data, [{ kind: 'community_created' }]);
  const adminNotices = await admin.from('notification_outbox').select('id,channel').eq('dispute_id', f.disputeId).eq('recipient_id', f.owner.id);
  const inApp = adminNotices.data!.find(row => row.channel === 'in_app')!;
  const email = adminNotices.data!.find(row => row.channel === 'email')!;
  const claim = await admin.rpc('claim_notification', { p_outbox_id: inApp.id }); assert.equal(claim.error, null);
  assert.equal((await admin.rpc('finish_notification', { p_outbox_id: inApp.id, p_claim_token: (claim.data as { claim_token: string }).claim_token })).error, null);
  assert.equal((await f.owner.client.from('notifications').select('id').eq('outbox_id', inApp.id)).data?.length, 1);
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.owner.id)).error, null);
  assert.deepEqual((await f.owner.client.from('notification_outbox').select('*').eq('dispute_id', f.disputeId)).data, []);
  assert.deepEqual((await f.owner.client.from('notifications').select('*').eq('outbox_id', inApp.id)).data, []);
  assert.deepEqual((await f.owner.client.from('notification_attempts').select('*').eq('outbox_id', inApp.id)).data, []);
  assert.deepEqual((await f.owner.client.from('disputes').select('*').eq('id', f.disputeId)).data, []);
  assert.equal((await admin.rpc('claim_notification', { p_outbox_id: email.id })).data, null);
  assert.equal((await admin.from('notification_outbox').select('state').eq('id', email.id).single()).data?.state, 'suppressed');
  receipt('issue-8-privacy-surfaces', { event_read: 'case audit excluded; Community creation visible', outbox_status_read: 'recipient only including administrator own notices', reminder_admin_read: 'case reminders excluded', inspect_notification_deliveries: 'case notices excluded' });
});

test('Prior participants retain the original eligible obligation and open case after removal, with no new unrelated activity', async () => {
  for (const status of ['removed', 'suspended'] as const) {
    const f = await completedItemFixture(`case-prior-${status}`, 29);
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
    assert.equal((await reportIssue(f.bob, f.exchangeId)).error, null);
    const view = await disputeView(f.bob, f.exchangeId); assert.equal(view.cases.length, 1);
    assert.equal((await f.bob.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: view.cases[0].id, p_body: 'I can still answer this obligation.' })).error, null);
    assert.deepEqual((await f.bob.client.from('listings').select('id').eq('id', f.listing.id)).data, []);
    assert.equal((await f.bob.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-03-01', p_ends_on: '2027-03-02' })).error?.code, '42501');
    const late = await completedItemFixture(`case-prior-late-${status}`, 31);
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', late.community.id).eq('user_id', late.bob.id)).error, null);
    assert.equal((await reportIssue(late.bob, late.exchangeId)).error?.code, '42501');
    assert.equal((await late.bob.client.rpc('read_exchange_disputes', { p_exchange_id: late.exchangeId })).error?.code, '42501');
    const historical = await admin.from('disputes').insert({ exchange_id: late.exchangeId, community_id: late.community.id, reporter_id: late.alice.id, respondent_id: late.bob.id, issue_type: 'damage', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }).select('id').single();
    assert.equal(historical.error, null);
    assert.equal((await late.bob.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: historical.data!.id, p_body: 'An open prior case remains my obligation after day 30.' })).error, null);
    const pending = await late.bob.client.rpc('prepare_dispute_evidence', { p_intent_id: randomUUID(), p_dispute_id: historical.data!.id, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
    const photo = evidenceSchema.parse(pending.data);
    assert.equal((await late.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
    assert.equal((await late.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error, null);
    assert.equal((await reportIssue(late.bob, late.exchangeId, 'A new issue after the window', 'other')).error?.code, '22023');
  }
  receipt('issue-8-prior-obligations', { removed: 'report and respond within original window', suspended: 'same', expired: '42501', unrelatedActivity: '42501' });
});

test('Global incident output contains type and status without source case identity or Community details', async () => {
  const f = await disputeFixture('case-redacted');
  const other = await createCommunity(f.alice.client); assert.equal(other.error, null);
  const communityId = (other.data as { id: string }).id;
  const viewer = await activeMember(f.alice, communityId, 'case-global-viewer');
  const result = await viewer.client.rpc('global_trust', { p_subject: f.alice.id }); assert.equal(result.error, null);
  const incidents = (result.data as { incidents: unknown[] }).incidents;
  assert.deepEqual(incidents, [{ type: 'unresolved_dispute', status: 'open' }]);
  assert.deepEqual((await viewer.client.from('trust_incidents').select('*').eq('source_id', f.disputeId)).data, []);
  assert.deepEqual((await f.carol.client.from('trust_incidents').select('*').eq('source_id', f.disputeId)).data, []);
  assert.deepEqual((await viewer.client.from('disputes').select('*').eq('id', f.disputeId)).data, []);
  receipt('issue-8-redacted-trust', result.data);
});

test('Realtime contains recipient ID hints and never case, response, evidence, audit, outbox or reminder bodies', async () => {
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
  assert.match(project ?? '', /^ourtopia-issue-\d+$/);
  const published = execFileSync('docker', ['exec', `supabase_db_${project}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('disputes', 'dispute_responses', 'exchange_evidence', 'notification_outbox', 'notification_reminders')"], { encoding: 'utf8' }).trim();
  assert.equal(published, '', 'case, evidence and delivery bodies are not published');
  const f = await handoffFixture('case-realtime'); await advanceHandoff(f);
  const foreign = await actor({ label: 'case-realtime-foreign' }); assert.equal((await createCommunity(foreign.client)).error, null);
  const members = [f.bob, f.alice, f.owner, f.carol, foreign];
  const bodies: unknown[][] = members.map(() => []); const hints: Record<string, unknown>[][] = members.map(() => []);
  const prior = new Set((await admin.from('notification_hints').select('id').in('recipient_id', members.map(m => m.id))).data!.map(r => r.id));
  const channels = await Promise.all(members.map(async (member, index) => {
    const session = await member.client.auth.getSession(); await member.client.realtime.setAuth(session.data.session!.access_token);
    const channel = member.client.channel(`case-privacy-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (String(change.new.kind).startsWith('item_dispute')) bodies[index].push(change.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints' }, change => { if (!prior.has(String(change.new.id))) hints[index].push(change.new); });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Realtime subscribe timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    assert.equal((await reportIssue(f.bob, f.exchangeId, 'Private case text never belongs in realtime')).error, null);
    const limit = Date.now() + 15000;
    while (hints.slice(0, 3).some(rows => rows.length === 0) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(bodies.map(rows => rows.length), [0, 0, 0, 0, 0]);
    for (let index = 0; index < 3; index++) {
      assert.ok(hints[index].length >= 1, `recipient ${index} hint counts ${JSON.stringify(hints.map(rows => rows.length))}`);
      for (const row of hints[index]) { assert.equal(row.recipient_id, members[index].id); assert.deepEqual(Object.keys(row).sort(), ['id', 'recipient_id']); }
    }
    assert.deepEqual(hints.slice(3).map(rows => rows.length), [0, 0]);
    receipt('issue-8-realtime', { unpublishedCaseTables: true, bodyCounts: bodies.map(rows => rows.length), hints: hints.map(rows => rows.length), hintKeys: ['id', 'recipient_id'] });
  } finally { await Promise.all(members.map((member, index) => member.client.removeChannel(channels[index]))); members.forEach(member => member.client.realtime.disconnect()); }
});
