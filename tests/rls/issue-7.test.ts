import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { actor, activeMember, admin, backendUrl, handoffFixture, advanceHandoff, handoffAction, handoffTerms, handoffSchedule, itemHandoff, listingImageBytes, publicClient, realtimeReady, receipt } from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';

before(() => realtimeReady(), { timeout: 70000 });

test('All nonparticipants, including administrators and inactive members, are denied logistics, evidence, commands and Storage', async () => {
  const f = await handoffFixture('handoff-privacy'); await advanceHandoff(f, 'schedule');
  const prepared = await f.bob.client.rpc('prepare_exchange_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  const photo = evidenceSchema.parse(prepared.data);
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error, null);
  const outsider = await actor({ label: 'handoff-outsider' });
  const foreign = await actor({ label: 'handoff-foreign-admin' });
  assert.equal((await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Foreign Community', p_description: '' })).error, null);
  const clients = [f.carol.client, f.owner.client, outsider.client, foreign.client, publicClient()];
  const receipts = [];
  for (const [index, client] of clients.entries()) {
    assert.deepEqual((await client.from('item_handoffs').select('exchange_id').eq('exchange_id', f.exchangeId)).data ?? [], []);
    assert.deepEqual((await client.from('exchange_evidence').select('id').eq('exchange_id', f.exchangeId)).data ?? [], []);
    assert.equal((await client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId })).error?.code, '42501');
    for (const action of ['acknowledge_terms', 'propose_schedule', 'confirm_schedule', 'record_condition', 'confirm_handoff', 'cancel']) {
      assert.equal((await client.rpc('command_item_handoff', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_expected_revision: 3, p_action: action, p_details: { reason: 'forged' } })).error?.code, '42501');
    }
    assert.equal((await client.rpc('prepare_exchange_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: 1 })).error?.code, '42501');
    assert.equal((await client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error?.code, '42501');
    assert.ok((await client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.ok((await client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 60)).error);
    assert.ok((await client.storage.from('exchange-evidence').upload(`${f.exchangeId}/${randomUUID()}`, listingImageBytes, { contentType: 'image/png' })).error);
    receipts.push({ actor: index, reads: 0, commands: '42501', storage: 'denied' });
  }
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
    assert.equal((await handoffAction(f.carol, f.exchangeId, 3, 'cancel', { reason: 'forged' })).error?.code, '42501');
    assert.deepEqual((await f.carol.client.from('item_handoffs').select('*').eq('exchange_id', f.exchangeId)).data, []);
    assert.deepEqual((await f.carol.client.from('exchange_evidence').select('id').eq('exchange_id', f.exchangeId)).data, []);
    assert.ok((await f.carol.client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.ok((await f.carol.client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 60)).error);
    assert.ok((await f.carol.client.storage.from('exchange-evidence').upload(`${f.exchangeId}/${randomUUID()}`, listingImageBytes, { contentType: 'image/png' })).error);
    assert.equal((await f.carol.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error?.code, '42501');
  }
  assert.equal((await f.alice.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size, listingImageBytes.length);
  assert.equal((await itemHandoff(f.alice, f.exchangeId)).location, handoffSchedule().location);
  assert.ok((await fetch(`${backendUrl}/storage/v1/object/public/exchange-evidence/${photo.object_path}`)).status >= 400);
  receipt('issue-7-privacy-matrix', receipts);
});

test('Removed and suspended participants retain only the obligation; direct writes and impersonated uploads fail', async () => {
  const f = await handoffFixture('handoff-prior-obligation');
  for (const [member, status] of [[f.bob, 'removed'], [f.alice, 'suspended']] as const) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', member.id)).error, null);
    assert.deepEqual((await member.client.from('listings').select('id').eq('id', f.listing.id)).data, []);
    assert.equal((await member.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-02-01', p_ends_on: '2027-02-02' })).error?.code, '42501');
    assert.equal((await member.client.from('item_handoffs').update({ location: 'forged' }).eq('exchange_id', f.exchangeId)).error?.code, '42501');
    assert.equal((await member.client.from('exchanges').update({ state: 'checked_out' }).eq('id', f.exchangeId)).error?.code, '42501');
    assert.equal((await member.client.from('exchange_evidence').insert({ id: randomUUID(), exchange_id: f.exchangeId, uploader_id: member.id, object_path: 'forged', mime_type: 'image/png', byte_size: 1 })).error?.code, '42501');
  }
  await advanceHandoff(f, 'terms');
  const prepared = await f.bob.client.rpc('prepare_exchange_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  const photo = evidenceSchema.parse(prepared.data);
  assert.ok((await f.alice.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  assert.equal((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error, null);
  assert.ok((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png', upsert: true })).error);
  assert.equal((await handoffAction(f.alice, f.exchangeId, 1, 'propose_schedule', handoffSchedule())).error, null);
  assert.equal((await handoffAction(f.bob, f.exchangeId, 2, 'confirm_schedule')).error, null);
  assert.equal((await handoffAction(f.alice, f.exchangeId, 3, 'cancel', { reason: 'Cannot meet' })).error, null);
  assert.equal((await f.bob.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId })).error?.code, '42501');
  assert.ok((await f.bob.client.storage.from('exchange-evidence').download(photo.object_path)).error);
  receipt('issue-7-prior-obligation', { removedBorrower: 'terms, schedule, own evidence allowed', suspendedOwner: 'schedule and cancellation allowed', afterClosure: 'reads and Storage denied', newActivity: '42501' });
});

test('Realtime hides all Handoff/evidence bodies and private audit while recipients receive ID-only hints after removal', async () => {
  const f = await handoffFixture('handoff-realtime');
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
  const outsider = await actor({ label: 'handoff-rt-outsider' });
  const inactive = [];
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    const member = await activeMember(f.owner, f.community.id, `handoff-rt-${status}`);
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', member.id)).error, null);
    inactive.push(member);
  }
  const foreign = await actor({ label: 'handoff-rt-foreign' });
  assert.equal((await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Other Community', p_description: '' })).error, null);
  const members = [f.alice, f.bob, f.carol, f.owner, outsider, { client: publicClient() }, ...inactive, foreign];
  const prior = new Set((await admin.from('notification_hints').select('id').in('recipient_id', [f.alice.id, f.bob.id])).data!.map(row => row.id));
  const bodies: unknown[][] = members.map(() => []); const hints: Record<string, unknown>[][] = members.map(() => []);
  const channels = await Promise.all(members.map(async (member, index) => {
    const { data } = await member.client.auth.getSession(); if (data.session) await member.client.realtime.setAuth(data.session.access_token);
    const channel = member.client.channel(`handoff-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (String(change.new.kind).startsWith('item_')) bodies[index].push(change.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints' }, change => { if ([f.alice.id, f.bob.id].includes(String(change.new.recipient_id)) && !prior.has(String(change.new.id))) hints[index].push(change.new); });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Realtime subscription timeout')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    assert.equal((await handoffAction(f.bob, f.exchangeId, 0, 'acknowledge_terms', handoffTerms)).error, null);
    const deadline = Date.now() + 10000;
    while ((hints[0].length === 0 || hints[1].length === 0) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    await new Promise(done => setTimeout(done, 1000));
    assert.deepEqual(bodies.map(rows => rows.length), members.map(() => 0));
    assert.equal(hints[0].length >= 1 && hints[1].length >= 1, true);
    assert.deepEqual(hints.slice(2).map(rows => rows.length), members.slice(2).map(() => 0));
    for (const hint of hints.flat()) assert.deepEqual(Object.keys(hint).sort(), ['id', 'recipient_id']);
    const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
    assert.match(project ?? '', /^ourtopia-issue-\d+$/);
    const published = execFileSync('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('item_handoffs', 'exchange_evidence', 'item_reservations', 'exchanges')"], { encoding: 'utf8' }).trim();
    assert.equal(published, '', 'no Handoff, evidence, reservation or Exchange table is published to realtime');
    receipt('issue-7-realtime', { bodies: bodies.map(rows => rows.length), hints: hints.map(rows => rows.length), publishedHandoffTables: [] });
  } finally { await Promise.all(members.map((member, index) => member.client.removeChannel(channels[index]))); members.forEach(member => member.client.realtime.disconnect()); }
});
