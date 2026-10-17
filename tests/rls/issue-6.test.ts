import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  activeMember, actor, admin, approveBorrow, borrowingFixture, decideBorrow, publicClient, realtimeReady, receipt, requestItem,
} from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

type Client = Awaited<ReturnType<typeof actor>>['client'];
async function visible(client: Client, listingId: string, exchangeIds: string[]) {
  const [requests, reservations, exchanges, events] = await Promise.all([
    client.from('borrow_requests').select('id').eq('listing_id', listingId),
    client.from('item_reservations').select('exchange_id').eq('listing_id', listingId),
    client.from('exchanges').select('id').in('id', exchangeIds),
    client.from('exchange_events').select('id').in('exchange_id', exchangeIds),
  ]);
  return { requests: requests.data?.length ?? 0, reservations: reservations.data?.length ?? 0, exchanges: exchanges.data?.length ?? 0, events: events.data?.length ?? 0 };
}

async function foreignAdministrator() {
  const foreign = await actor({ label: 'borrow-foreign-admin' });
  assert.equal((await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Foreign lending circle', p_description: '' })).error, null);
  return foreign;
}

test('Only the two participants read requests, reservations, Exchanges, and audit; no one else does', async () => {
  const f = await borrowingFixture('borrow-rls-read');
  const approved = await approveBorrow(f.alice, await requestItem(f.bob, f.listing.id));
  await requestItem(f.carol, f.listing.id);
  const dave = await activeMember(f.owner, f.community.id, 'borrow-rls-dave');
  const outsider = await actor({ label: 'borrow-rls-outsider' });
  const foreign = await foreignAdministrator();
  const ids = [approved.exchange_id!];
  const seen = {
    alice: await visible(f.alice.client, f.listing.id, ids), bob: await visible(f.bob.client, f.listing.id, ids), carol: await visible(f.carol.client, f.listing.id, ids),
    dave: await visible(dave.client, f.listing.id, ids), administrator: await visible(f.owner.client, f.listing.id, ids),
    outsider: await visible(outsider.client, f.listing.id, ids), foreignAdministrator: await visible(foreign.client, f.listing.id, ids), anonymous: await visible(publicClient(), f.listing.id, ids),
  };
  assert.deepEqual(seen, {
    alice: { requests: 2, reservations: 1, exchanges: 1, events: 1 }, bob: { requests: 1, reservations: 1, exchanges: 1, events: 1 }, carol: { requests: 1, reservations: 0, exchanges: 0, events: 0 },
    dave: { requests: 0, reservations: 0, exchanges: 0, events: 0 }, administrator: { requests: 0, reservations: 0, exchanges: 0, events: 0 },
    outsider: { requests: 0, reservations: 0, exchanges: 0, events: 0 }, foreignAdministrator: { requests: 0, reservations: 0, exchanges: 0, events: 0 }, anonymous: { requests: 0, reservations: 0, exchanges: 0, events: 0 },
  });
  for (const [label, client] of [['alice', f.alice.client], ['dave', dave.client], ['administrator', f.owner.client]] as const) {
    const events = await client.from('community_events').select('kind').eq('community_id', f.community.id).like('kind', 'borrow%');
    assert.deepEqual(events.data, [], label);
  }
  const notices = await dave.client.from('notifications').select('id').in('kind', ['borrow_requested', 'borrow_approved']);
  assert.deepEqual(notices.data, []);
  receipt('issue-6-rls-reads', seen);
});

test('Borrow policy preserves billing privacy and ordinary Community events for an active peer', async () => {
  const f = await borrowingFixture('borrow-billing-privacy');
  const billing = await f.owner.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_kind: 'checkout' });
  assert.equal(billing.error, null);
  const persisted = await admin.from('community_events').select('id').eq('community_id', f.community.id).eq('kind', 'test_billing_requested');
  assert.equal(persisted.error, null);
  assert.equal(persisted.data?.length, 1);
  const privateEvents = await f.carol.client.from('community_events').select('id,kind,actor_id').eq('community_id', f.community.id).eq('kind', 'test_billing_requested');
  assert.equal(privateEvents.error, null);
  assert.deepEqual(privateEvents.data, []);
  const ordinaryEvents = await f.carol.client.from('community_events').select('kind').eq('community_id', f.community.id).eq('kind', 'community_created');
  assert.equal(ordinaryEvents.error, null);
  assert.deepEqual(ordinaryEvents.data, [{ kind: 'community_created' }]);
  receipt('issue-6-rls-billing-privacy', { persistedBillingEvents: persisted.data.length, peerBillingEvents: privateEvents.data, peerOrdinaryEvents: ordinaryEvents.data });
});

test('Borrowers, members, administrators, and anonymous callers cannot forge approvals, reservations, trust, or worker effects', async () => {
  const f = await borrowingFixture('borrow-rls-forge');
  const request = await requestItem(f.bob, f.listing.id);
  const foreign = await foreignAdministrator();
  const denied: Record<string, unknown> = {};
  const exchange = { community_id: f.community.id, kind: 'item', provider_id: f.alice.id, receiver_id: f.bob.id, source_kind: 'listing', source_id: f.listing.id, state: 'approved' };
  const forged = {
    insertRequest: await f.bob.client.from('borrow_requests').insert({ community_id: f.community.id, listing_id: f.listing.id, owner_id: f.alice.id, borrower_id: f.bob.id, starts_on: '2027-01-15', ends_on: '2027-01-17', status: 'approved' }),
    approveOwnRequest: await f.bob.client.from('borrow_requests').update({ status: 'approved' }).eq('id', request.id),
    insertExchange: await f.bob.client.from('exchanges').insert(exchange),
    insertReservation: await f.bob.client.from('item_reservations').insert({ exchange_id: randomUUID(), request_id: request.id, listing_id: f.listing.id, starts_on: '2027-01-15', ends_on: '2027-01-17', acknowledgment_due_at: new Date().toISOString(), condition: 'x', replacement_value: 1, lending_conditions: 'x' }),
    raiseScore: await f.bob.client.from('reputation_events').insert({ community_id: f.community.id, recipient_id: f.bob.id, rule: 'forged', points: 50, source_kind: 'forged', source_id: randomUUID(), verified_by_command: 'forged' }),
    shortenWindow: await f.alice.client.from('allocation_settings').update({ acknowledgment_window: '1 second' }).eq('singleton', true),
  };
  for (const [label, result] of Object.entries(forged)) { assert.equal(result.error?.code, '42501', label); denied[label] = result.error?.code; }
  for (const [label, client] of [['borrower', f.bob.client], ['other member', f.carol.client], ['administrator', f.owner.client], ['foreign administrator', foreign.client], ['anonymous', publicClient()]] as const) {
    const decision = await client.rpc('decide_borrow_request', { p_intent_id: randomUUID(), p_request_id: request.id, p_expected_version: 1, p_decision: 'approved' });
    assert.equal(decision.error?.code, '42501', `${label} decide`);
    for (const worker of [client.rpc('expire_item_approval', { p_exchange_id: randomUUID() }), client.rpc('expire_due_item_approvals')]) assert.equal((await worker).error?.code, '42501', `${label} worker`);
    denied[label] = decision.error?.code;
  }
  for (const [label, client] of [['outsider', (await actor({ label: 'borrow-rls-outsider' })).client], ['foreign administrator', foreign.client], ['anonymous', publicClient()]] as const) {
    assert.equal((await client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-01-15', p_ends_on: '2027-01-17' })).error?.code, '42501', label);
  }
  const unchanged = await admin.from('borrow_requests').select('status,version,exchange_id').eq('listing_id', f.listing.id);
  assert.deepEqual(unchanged.data, [{ status: 'requested', version: 1, exchange_id: null }]);
  assert.deepEqual((await admin.from('exchanges').select('id').eq('source_id', f.listing.id)).data, []);
  assert.deepEqual((await admin.from('allocation_settings').select('acknowledgment_window')).data, [{ acknowledgment_window: '48:00:00' }]);
  receipt('issue-6-rls-forgery', denied);
});

test('Inactive members cannot apply or decide; a removed borrower keeps only the open obligation', async () => {
  const f = await borrowingFixture('borrow-rls-inactive');
  const approved = await approveBorrow(f.alice, await requestItem(f.bob, f.listing.id));
  const pending = await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02');
  const statuses: Record<string, string | undefined> = {};
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
    const submit = await f.carol.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-02-03', p_ends_on: '2027-02-04' });
    assert.equal(submit.error?.code, '42501', status);
    assert.deepEqual((await f.carol.client.from('borrow_requests').select('id').eq('id', pending.id)).data, [], status);
    statuses[status] = submit.error?.code;
  }
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
  const obligation = await visible(f.bob.client, f.listing.id, [approved.exchange_id!]);
  assert.deepEqual(obligation, { requests: 1, reservations: 1, exchanges: 1, events: 1 });
  assert.deepEqual((await f.bob.client.from('listings').select('id').eq('id', f.listing.id)).data, []);
  assert.equal((await f.bob.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-02-03', p_ends_on: '2027-02-04' })).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.alice.id })).error?.code, '42501');
  const dave = await activeMember(f.owner, f.community.id, 'borrow-rls-dave');
  const daveRequest = await requestItem(dave, f.listing.id, '2027-02-03', '2027-02-04');
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.alice.id)).error, null);
  assert.equal((await decideBorrow(f.alice, daveRequest)).error?.code, '42501');
  assert.deepEqual((await admin.from('borrow_requests').select('status').eq('id', daveRequest.id)).data, [{ status: 'requested' }]);
  receipt('issue-6-rls-membership', { carol: statuses, removedBorrowerObligation: obligation, removedOwnerDecision: '42501' });
});

test('Realtime carries no Borrow Request audit to anyone and id-only notice hints only to the recipient', async () => {
  const f = await borrowingFixture('borrow-rls-realtime');
  const dave = await activeMember(f.owner, f.community.id, 'borrow-rt-dave');
  const outsider = await actor({ label: 'borrow-rt-outsider' });
  const recipients = [f.alice.id, f.bob.id];
  const priorHints = await admin.from('notification_hints').select('id').in('recipient_id', recipients);
  assert.equal(priorHints.error, null);
  const priorHintIds = new Set(priorHints.data!.map(row => row.id));
  const actors = [f.alice, f.bob, f.carol, dave, f.owner, outsider, { client: publicClient() }];
  const events: unknown[][] = actors.map(() => []);
  const hints: Record<string, unknown>[][] = actors.map(() => []);
  const channels = await Promise.all(actors.map(async (member, index) => {
    const session = await member.client.auth.getSession(); if (session.data.session) await member.client.realtime.setAuth(session.data.session.access_token);
    const channel = member.client.channel(`borrow-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (String(change.new.kind).startsWith('borrow')) events[index].push(change.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints' }, change => {
        if (recipients.includes(String(change.new.recipient_id)) && !priorHintIds.has(String(change.new.id))) hints[index].push(change.new);
      });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    const request = await requestItem(f.bob, f.listing.id);
    await approveBorrow(f.alice, request);
    const deadline = Date.now() + 10000;
    while ((hints[0].length === 0 || hints[1].length === 0) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    await new Promise(done => setTimeout(done, 1500));
    assert.deepEqual(events, actors.map(() => []));
    assert.ok(hints[0].length >= 1 && hints[1].length >= 1);
    for (const hint of [...hints[0], ...hints[1]]) assert.deepEqual(Object.keys(hint).sort(), ['id', 'recipient_id']);
    assert.ok(hints[0].every(hint => hint.recipient_id === f.alice.id) && hints[1].every(hint => hint.recipient_id === f.bob.id));
    assert.deepEqual(hints.slice(2), actors.slice(2).map(() => []));
    receipt('issue-6-rls-realtime', { auditEventsDelivered: events.map(list => list.length), hintsDelivered: hints.map(list => list.length) });
  } finally { await Promise.all(actors.map((member, index) => member.client.removeChannel(channels[index]))); actors.forEach(member => member.client.realtime.disconnect()); }
});
