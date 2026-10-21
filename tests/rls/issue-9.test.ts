import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  actor, activeMember, admin, backendUrl, checkedOutFixture, completeReturn, itemReturn, listingImageBytes, publicClient, realtimeReady, receipt, recordReturn,
  returnAction, returnCondition, settleFixtureNotices, withReturnWindows,
} from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';

const suiteStarted = new Date().toISOString();
after(() => settleFixtureNotices(['return-privacy', 'return-obligation', 'return-realtime'], suiteStarted));
before(() => realtimeReady(), { timeout: 70000 });

test('Nonparticipants, administrators, inactive members and foreign accounts cannot read or derive Return condition, evidence or timing', async () => {
  const f = await checkedOutFixture('return-privacy');
  const prepared = await f.bob.client.rpc('prepare_return_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  const photo = evidenceSchema.parse(prepared.data);
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error, null);
  await withReturnWindows({ confirmation_reminder_after: '3 days', review_after: '9 days' }, () => recordReturn(f));
  const recorded = await itemReturn(f.bob, f.exchangeId);
  const outsider = await actor({ label: 'return-outsider' });
  const foreign = await actor({ label: 'return-foreign-admin' });
  assert.equal((await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Foreign Community', p_description: '' })).error, null);
  const clients = [f.carol.client, f.owner.client, outsider.client, foreign.client, publicClient()];
  const secretTimes = [Date.parse(recorded.record!.review_due_at), Date.parse(recorded.record!.returned_at) + 3 * 86400000];
  const derivable = (values: unknown[]) => values.some(value => typeof value === 'string' && secretTimes.some(at => Math.abs(Date.parse(value) - at) < 1500));
  const receipts = [];
  for (const [index, client] of clients.entries()) {
    assert.deepEqual((await client.from('item_returns').select('exchange_id').eq('exchange_id', f.exchangeId)).data ?? [], []);
    assert.deepEqual((await client.from('exchange_evidence').select('id').eq('exchange_id', f.exchangeId)).data ?? [], []);
    assert.equal((await client.rpc('read_item_return', { p_exchange_id: f.exchangeId })).error?.code, '42501');
    for (const action of ['record_return', 'confirm_return', 'contest_return']) {
      assert.equal((await client.rpc('command_item_return', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_expected_revision: recorded.revision, p_action: action, p_details: { condition_matches: true } })).error?.code, '42501');
    }
    assert.equal((await client.rpc('prepare_return_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: 1 })).error?.code, '42501');
    assert.equal((await client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error?.code, '42501');
    assert.ok((await client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.ok((await client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 60)).error);
    assert.ok((await client.storage.from('exchange-evidence').upload(`${f.exchangeId}/${randomUUID()}`, listingImageBytes, { contentType: 'image/png' })).error);
    const exchangeEvents = await client.from('exchange_events').select('kind,created_at').eq('exchange_id', f.exchangeId).like('kind', 'item\\_return%');
    const audit = await client.from('community_events').select('kind,created_at').eq('community_id', f.community.id).like('kind', 'item\\_return%');
    const outbox = await client.from('notification_outbox').select('kind,next_attempt_at,reminder_due_at,created_at').eq('community_id', f.community.id).like('kind', 'item\\_return%');
    const reminders = await client.from('notification_reminders').select('kind,due_at').eq('source_key', f.exchangeId);
    for (const result of [exchangeEvents, audit, outbox, reminders]) assert.deepEqual(result.data ?? [], []);
    receipts.push({ actor: index, rows: 0, commands: '42501', storage: 'denied' });
  }
  const consoleRows = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
  assert.equal(consoleRows.error, null);
  const listed = consoleRows.data as { kind: string; next_attempt_at: string; reminder_due_at: string | null; created_at: string }[];
  assert.equal(listed.filter(row => row.kind.startsWith('item_')).length, 0);
  assert.equal(derivable(listed.flatMap(row => [row.next_attempt_at, row.reminder_due_at])), false);
  assert.ok(listed.some(row => row.kind.startsWith('borrow_')), 'the console still lists non-logistics notices');
  for (const status of ['pending', 'rejected', 'suspended']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
    assert.equal((await returnAction(f.carol, f.exchangeId, recorded.revision, 'confirm_return', { condition_matches: true })).error?.code, '42501');
    assert.deepEqual((await f.carol.client.from('item_returns').select('*').eq('exchange_id', f.exchangeId)).data, []);
    assert.ok((await f.carol.client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.equal((await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id })).error?.code, '42501');
  }
  assert.equal((await admin.from('memberships').update({ status: 'active' }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
  for (const [member, table] of [[f.owner, 'item_returns'], [f.alice, 'item_returns'], [f.bob, 'community_feed'], [f.owner, 'exchange_review_items']] as const) {
    assert.equal((await member.client.from(table).insert({ exchange_id: f.exchangeId, community_id: f.community.id })).error?.code, '42501');
  }
  assert.equal((await f.alice.client.from('item_returns').update({ owner_confirmed_at: new Date().toISOString() }).eq('exchange_id', f.exchangeId)).error?.code, '42501');
  assert.equal((await f.alice.client.from('exchanges').update({ state: 'returned' }).eq('id', f.exchangeId)).error?.code, '42501');
  const own = await f.alice.client.from('notification_outbox').select('kind').eq('recipient_id', f.alice.id).like('kind', 'item\\_return%');
  assert.ok((own.data ?? []).some(row => row.kind === 'item_return_recorded'), 'the recipient still reads her own notice status');
  assert.equal((await itemReturn(f.alice, f.exchangeId)).record?.condition, returnCondition.condition);
  assert.ok((await fetch(`${backendUrl}/storage/v1/object/public/exchange-evidence/${photo.object_path}`)).status >= 400);
  assert.equal((await returnAction(f.alice, f.exchangeId, recorded.revision, 'confirm_return', { condition_matches: true })).error, null);
  const feed = await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id });
  assert.equal(feed.error, null); assert.equal((feed.data as unknown[]).length, 1);
  for (const secret of [returnCondition.condition, returnCondition.accessories, photo.object_path, 'Front porch']) assert.equal(JSON.stringify(feed.data).includes(secret), false);
  for (const client of [outsider.client, foreign.client, publicClient()]) {
    assert.deepEqual((await client.from('community_feed').select('id').eq('community_id', f.community.id)).data ?? [], []);
    assert.ok((await client.rpc('read_community_feed', { p_community_id: f.community.id })).error);
  }
  assert.equal((await f.carol.client.from('community_feed').select('id').eq('community_id', f.community.id)).data?.length, 1);
  for (const status of ['removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
    assert.equal((await returnAction(f.carol, f.exchangeId, recorded.revision, 'confirm_return', { condition_matches: true })).error?.code, '42501');
    assert.deepEqual((await f.carol.client.from('item_returns').select('*').eq('exchange_id', f.exchangeId)).data, []);
    assert.ok((await f.carol.client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.equal((await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id })).error?.code, '42501');
  }
  receipt('issue-9-privacy-matrix', { receipts, console: 'no item_ rows', feed: feed.data });
});

test('Removed and suspended participants finish only their own Return obligation without regaining Community browsing', async () => {
  const f = await checkedOutFixture('return-obligation');
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
  assert.equal((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', f.alice.id)).error, null);
  for (const member of [f.bob, f.alice]) {
    assert.deepEqual((await member.client.from('listings').select('id').eq('id', f.listing.id)).data, []);
    assert.equal((await member.client.rpc('read_community_feed', { p_community_id: f.community.id })).error?.code, '42501');
    assert.equal((await member.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-02-01', p_ends_on: '2027-02-02' })).error?.code, '42501');
  }
  const view = await completeReturn(f);
  assert.equal(view.state, 'completed');
  assert.equal((await itemReturn(f.bob, f.exchangeId)).state, 'completed');
  const other = await checkedOutFixture('return-obligation');
  const removed = await activeMember(other.owner, other.community.id, 'return-obligation-removed');
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', other.community.id).eq('user_id', removed.id)).error, null);
  assert.equal((await returnAction(removed, other.exchangeId, 0, 'record_return', returnCondition)).error?.code, '42501');
  receipt('issue-9-prior-obligation', { removedBorrower: 'recorded Return', suspendedOwner: 'confirmed Return', state: view.state, browsing: '42501' });
});

test('Realtime carries only ID hints to participants; Return tables are not published and Return audit bodies never reach other members', async () => {
  const f = await checkedOutFixture('return-realtime');
  const outsider = await actor({ label: 'return-rt-outsider' });
  const members = [f.alice, f.bob, f.carol, f.owner, outsider, { client: publicClient() }];
  const prior = new Set((await admin.from('notification_hints').select('id').in('recipient_id', [f.alice.id, f.bob.id])).data!.map(row => row.id));
  const bodies: unknown[][] = members.map(() => []); const hints: Record<string, unknown>[][] = members.map(() => []);
  const channels = await Promise.all(members.map(async (member, index) => {
    const { data } = await member.client.auth.getSession(); if (data.session) await member.client.realtime.setAuth(data.session.access_token);
    const channel = member.client.channel(`return-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (String(change.new.kind).startsWith('item_')) bodies[index].push(change.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints' }, change => { if ([f.alice.id, f.bob.id].includes(String(change.new.recipient_id)) && !prior.has(String(change.new.id))) hints[index].push(change.new); });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Realtime subscription timeout')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    await completeReturn(f);
    const deadline = Date.now() + 10000;
    while ((hints[0].length === 0 || hints[1].length === 0) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    await new Promise(done => setTimeout(done, 1000));
    assert.deepEqual(bodies.map(rows => rows.length), members.map(() => 0));
    assert.equal(hints[0].length >= 1 && hints[1].length >= 1, true);
    assert.deepEqual(hints.slice(2).map(rows => rows.length), members.slice(2).map(() => 0));
    for (const hint of hints.flat()) assert.deepEqual(Object.keys(hint).sort(), ['id', 'recipient_id']);
    const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
    assert.match(project ?? '', /^ourtopia-issue-\d+$/);
    const published = execFileSync('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('item_returns', 'community_feed', 'exchange_review_items', 'exchange_events', 'exchange_evidence', 'exchanges')"], { encoding: 'utf8' }).trim();
    assert.equal(published, '', 'no Return, feed, review, evidence or Exchange table is published to realtime');
    receipt('issue-9-realtime', { bodies: bodies.map(rows => rows.length), hints: hints.map(rows => rows.length), publishedReturnTables: [] });
  } finally { await Promise.all(members.map((member, index) => member.client.removeChannel(channels[index]))); members.forEach(member => member.client.realtime.disconnect()); }
});
