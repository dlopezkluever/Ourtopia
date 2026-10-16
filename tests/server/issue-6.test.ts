import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  activeMember, admin, approveBorrow, borrowNotices, borrowRecords, borrowingFixture, decideBorrow, receipt, requestItem,
  overdueBorrowFixture, seedReputationEvent, withAcknowledgmentWindow,
} from '../../scripts/verify/backend';
import { borrowViewSchema } from '../../src/features/borrowing/model';
import { memberProfileSchema } from '../../src/features/profiles/model';

const hour = 3600000;

async function noPartialEffects(f: Awaited<ReturnType<typeof borrowingFixture>>, requestId: string, intent: string) {
  const records = await borrowRecords(f.listing.id);
  assert.deepEqual(records.exchanges, []);
  assert.deepEqual(records.reservations, []);
  assert.deepEqual(records.requests.find(request => request.id === requestId), { ...records.requests.find(request => request.id === requestId), status: 'requested', version: 1, exchange_id: null });
  assert.deepEqual(await borrowNotices(f.community.id, 'borrow_approved'), []);
  assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', f.alice.id).eq('intent_id', intent)).data, []);
  assert.deepEqual((await admin.from('community_events').select('id').eq('community_id', f.community.id).eq('kind', 'borrow_approved')).data, []);
  return records;
}

test('Bob requests Friday through Sunday, Alice sees 50 Unproven, and approval atomically reserves 48 hours', async () => {
  const f = await borrowingFixture('borrow-primary');
  const submitIntent = randomUUID();
  const request = await requestItem(f.bob, f.listing.id, '2027-01-15', '2027-01-17', submitIntent);
  assert.equal((await requestItem(f.bob, f.listing.id, '2027-01-15', '2027-01-17', submitIntent)).id, request.id);
  assert.equal((await f.bob.client.rpc('submit_borrow_request', { p_intent_id: submitIntent, p_listing_id: f.listing.id, p_starts_on: '2027-01-15', p_ends_on: '2027-01-18' })).error?.code, '23505');
  assert.deepEqual({ status: request.status, exchange: request.exchange_id, reservation: request.reservation }, { status: 'requested', exchange: null, reservation: null });
  assert.deepEqual((await borrowRecords(f.listing.id)).exchanges, []);
  assert.deepEqual(await borrowNotices(f.community.id, 'borrow_requested'), [{ recipient_id: f.alice.id, channel: 'email', kind: 'borrow_requested' }, { recipient_id: f.alice.id, channel: 'in_app', kind: 'borrow_requested' }]);

  const profile = memberProfileSchema.parse((await f.alice.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.bob.id })).data);
  assert.deepEqual({ local: profile.local, global: profile.trust.globalScore, title: profile.globalTitle, incidents: profile.trust.incidents },
    { local: { score: 50, title: 'Unproven', completedInteractions: 0 }, global: 50, title: 'Unproven', incidents: [] });

  const decisionIntent = randomUUID();
  const before = Date.now();
  const approved = borrowViewSchema.parse((await decideBorrow(f.alice, request, 'approved', decisionIntent)).data);
  const after = Date.now();
  assert.deepEqual({ status: approved.status, version: approved.version, state: approved.exchange_state, dates: approved.reservation && { starts: approved.reservation.starts_on, ends: approved.reservation.ends_on, blocking: approved.reservation.blocking } },
    { status: 'approved', version: 2, state: 'approved', dates: { starts: '2027-01-15', ends: '2027-01-17', blocking: true } });
  const due = Date.parse(approved.reservation!.acknowledgment_due_at);
  assert.ok(due >= before + 48 * hour - 2000 && due <= after + 48 * hour + 2000, `deadline ${approved.reservation!.acknowledgment_due_at}`);
  const replay = await decideBorrow(f.alice, request, 'approved', decisionIntent);
  assert.deepEqual(borrowViewSchema.parse(replay.data), approved);
  assert.equal((await decideBorrow(f.alice, request, 'rejected', decisionIntent)).error?.code, '23505');

  const records = await borrowRecords(f.listing.id);
  assert.deepEqual(records.exchanges, [{ id: approved.exchange_id, kind: 'item', state: 'approved', provider_id: f.alice.id, receiver_id: f.bob.id }]);
  assert.deepEqual(records.reservations.map(row => ({ dates: row.dates, blocking: row.blocking, custody: row.custody_unresolved })), [{ dates: '[2027-01-15,2027-01-18)', blocking: true, custody: false }]);
  assert.deepEqual((await admin.from('exchange_events').select('kind,actor_id').eq('exchange_id', approved.exchange_id!)).data, [{ kind: 'item_approved', actor_id: f.alice.id }]);
  assert.deepEqual(await borrowNotices(f.community.id, 'borrow_approved'), [{ recipient_id: f.bob.id, channel: 'email', kind: 'borrow_approved' }, { recipient_id: f.bob.id, channel: 'in_app', kind: 'borrow_approved' }]);
  receipt('issue-6-primary', { request, approved, records, profile: { local: profile.local, trust: profile.trust } });
});

test('Below-minimum, stale, ineligible, and non-owner decisions fail without partial effects', async () => {
  const f = await borrowingFixture('borrow-guards');
  await seedReputationEvent(f.community.id, f.bob.id, -10);
  const request = await requestItem(f.bob, f.listing.id);
  const intent = randomUUID();
  const below = await decideBorrow(f.alice, request, 'approved', intent);
  assert.equal(below.error?.code, '23514');
  await noPartialEffects(f, request.id, intent);

  for (const [label, member] of [['administrator', f.owner], ['other member', f.carol], ['borrower', f.bob]] as const) {
    assert.equal((await decideBorrow(member, request)).error?.code, '42501', label);
  }
  assert.equal((await decideBorrow(f.alice, { id: request.id, version: 7 })).error?.code, '55000');
  assert.equal((await f.alice.client.rpc('decide_borrow_request', { p_intent_id: randomUUID(), p_request_id: request.id, p_expected_version: 1, p_decision: 'maybe' })).error?.code, '22023');
  const records = await noPartialEffects(f, request.id, intent);

  await seedReputationEvent(f.community.id, f.bob.id, 10);
  const approved = await approveBorrow(f.alice, request);
  assert.equal(approved.status, 'approved');
  assert.equal((await decideBorrow(f.alice, request)).error?.code, '55000');
  assert.equal((await decideBorrow(f.alice, approved, 'rejected')).error?.code, '55000');

  const late = await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02');
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
  assert.equal((await decideBorrow(f.alice, late)).error?.code, '55000');
  assert.equal((await borrowRecords(f.listing.id)).exchanges.length, 1);

  const dave = await activeMember(f.owner, f.community.id, 'borrow-guards-dave');
  const pending = await requestItem(dave, f.listing.id, '2027-02-03', '2027-02-04');
  assert.equal((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', f.alice.id)).error, null);
  assert.equal((await decideBorrow(f.alice, pending)).error?.code, '42501');
  assert.equal((await borrowRecords(f.listing.id)).exchanges.length, 1);
  receipt('issue-6-guards', { belowMinimum: below.error, rolledBack: records, removedBorrower: '55000', suspendedOwner: '42501' });
});

test('Overlapping requests stay pending and concurrent approvals have exactly one winner', async () => {
  const f = await borrowingFixture('borrow-race');
  const rounds = [];
  for (const [start, end, otherStart, otherEnd] of [['2027-01-11', '2027-01-13', '2027-01-12', '2027-01-14'], ['2027-01-15', '2027-01-17', '2027-01-15', '2027-01-17'], ['2027-02-01', '2027-02-03', '2027-02-03', '2027-02-05']]) {
    const [first, second] = await Promise.all([requestItem(f.bob, f.listing.id, start, end), requestItem(f.carol, f.listing.id, otherStart, otherEnd)]);
    const exchangesBefore = (await borrowRecords(f.listing.id)).exchanges.length;
    const decisions = await Promise.all([decideBorrow(f.alice, first), decideBorrow(f.alice, second)]);
    assert.equal(decisions.filter(result => result.error === null).length, 1);
    const loser = decisions.find(result => result.error)!;
    assert.equal(loser.error?.code, '23P01');
    const records = await borrowRecords(f.listing.id);
    assert.equal(records.exchanges.length, exchangesBefore + 1);
    const losing = records.requests.find(request => request.id === (decisions[0].error ? first.id : second.id))!;
    assert.deepEqual({ status: losing.status, exchange: losing.exchange_id, version: losing.version }, { status: 'requested', exchange: null, version: 1 });
    rounds.push({ dates: [start, end, otherStart, otherEnd], errors: decisions.map(result => result.error?.code ?? null) });
  }
  const approvedNotices = await borrowNotices(f.community.id, 'borrow_approved');
  assert.equal(approvedNotices.length, 6);
  assert.equal((await borrowRecords(f.listing.id)).reservations.length, 3);
  receipt('issue-6-race', { rounds, approvedNotices });
});

test('Inclusive calendar dates map to half-open ranges; adjacent ranges approve and declines notify', async () => {
  const f = await borrowingFixture('borrow-calendar');
  assert.equal((await f.bob.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-01-19', p_ends_on: '2027-01-22' })).error?.code, '55000');
  assert.equal((await f.bob.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-01-17', p_ends_on: '2027-01-15' })).error?.code, '22023');
  assert.equal((await f.bob.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2020-01-15', p_ends_on: '2020-01-17' })).error?.code, '22023');
  assert.equal((await f.alice.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: '2027-01-15', p_ends_on: '2027-01-17' })).error?.code, '42501');
  const first = await approveBorrow(f.alice, await requestItem(f.bob, f.listing.id, '2027-01-15', '2027-01-17'));
  const adjacent = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-01-18', '2027-01-20'));
  const single = await approveBorrow(f.alice, await requestItem(f.bob, f.listing.id, '2027-01-10', '2027-01-10'));
  assert.equal((await decideBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-01-17', '2027-01-18'))).error?.code, '23P01');
  const declined = await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02');
  const rejected = borrowViewSchema.parse((await decideBorrow(f.alice, declined, 'rejected')).data);
  assert.deepEqual({ status: rejected.status, exchange: rejected.exchange_id, reservation: rejected.reservation }, { status: 'rejected', exchange: null, reservation: null });
  assert.deepEqual(await borrowNotices(f.community.id, 'borrow_rejected'), [{ recipient_id: f.carol.id, channel: 'email', kind: 'borrow_rejected' }, { recipient_id: f.carol.id, channel: 'in_app', kind: 'borrow_rejected' }]);
  const ranges = (await borrowRecords(f.listing.id)).reservations.map(row => row.dates);
  assert.deepEqual(ranges, ['[2027-01-10,2027-01-11)', '[2027-01-15,2027-01-18)', '[2027-01-18,2027-01-21)']);
  assert.equal((await f.bob.client.from('item_reservations').select('dates').eq('exchange_id', single.exchange_id!)).data?.[0]?.dates, '[2027-01-10,2027-01-11)');
  receipt('issue-6-calendar', { ranges, first: first.reservation, adjacent: adjacent.reservation, single: single.reservation, rejected });
});

test('Deadline guards hold before the worker; delayed, concurrent, and repeated workers expire once and release', async () => {
  const f = await borrowingFixture('borrow-expiry');
  const approved = await withAcknowledgmentWindow('3 seconds', async () => approveBorrow(f.alice, await requestItem(f.bob, f.listing.id)));
  const exchangeId = approved.exchange_id!;
  const early = borrowViewSchema.parse((await admin.rpc('expire_item_approval', { p_exchange_id: exchangeId })).data);
  assert.equal(early.status, 'approved');
  assert.equal((await admin.from('exchanges').update({ state: 'expired' }).eq('id', exchangeId)).error?.code, '55000');
  const blocked = await requestItem(f.carol, f.listing.id);
  await new Promise(done => setTimeout(done, Math.max(0, Date.parse(approved.reservation!.acknowledgment_due_at) - Date.now()) + 500));
  assert.equal((await admin.from('item_reservations').update({ acknowledged_at: new Date().toISOString() }).eq('exchange_id', exchangeId)).error?.code, '55000');
  assert.equal((await admin.from('exchanges').update({ state: 'handoff_pending' }).eq('id', exchangeId)).error?.code, '55000');
  const workers = await Promise.all([admin.rpc('expire_item_approval', { p_exchange_id: exchangeId }), admin.rpc('expire_due_item_approvals'), admin.rpc('expire_item_approval', { p_exchange_id: exchangeId })]);
  for (const result of workers) assert.equal(result.error, null);
  const repeated = borrowViewSchema.parse((await admin.rpc('expire_item_approval', { p_exchange_id: exchangeId })).data);
  assert.deepEqual({ status: repeated.status, version: repeated.version, state: repeated.exchange_state, blocking: repeated.reservation?.blocking }, { status: 'expired', version: 3, state: 'expired', blocking: false });
  assert.equal((await admin.from('item_reservations').update({ acknowledged_at: new Date().toISOString() }).eq('exchange_id', exchangeId)).error?.code, '55000');
  assert.equal((await admin.from('exchanges').update({ state: 'handoff_pending' }).eq('id', exchangeId)).error?.code, '55000');
  assert.equal((await admin.from('community_events').select('id').eq('community_id', f.community.id).eq('kind', 'borrow_expired')).data?.length, 1);
  assert.deepEqual((await admin.from('exchange_events').select('kind').eq('exchange_id', exchangeId).order('created_at')).data, [{ kind: 'item_approved' }, { kind: 'item_approval_expired' }]);
  assert.deepEqual((await borrowNotices(f.community.id, 'borrow_expired')).map(row => `${row.recipient_id === f.alice.id ? 'alice' : 'bob'}:${row.channel}`).sort(), ['alice:email', 'alice:in_app', 'bob:email', 'bob:in_app']);
  const next = await approveBorrow(f.alice, blocked);
  assert.equal(next.status, 'approved');
  assert.equal(z.number().parse((await admin.rpc('expire_due_item_approvals')).data) >= 0, true);
  receipt('issue-6-expiry', { early: early.status, workers: workers.map(result => result.data), repeated, released: next.reservation });
});

test('Unresolved custody blocks later disjoint approvals until recovery; reservation dates cannot be edited', async () => {
  const f = await borrowingFixture('borrow-custody');
  const loan = await overdueBorrowFixture(f);
  const after = await requestItem(f.carol, f.listing.id, '2027-02-01', '2027-02-02');
  const intent = randomUUID();
  assert.equal((await decideBorrow(f.alice, after, 'approved', intent)).error?.code, '23P01');
  assert.equal((await admin.from('item_reservations').update({ ends_on: '2027-01-16' }).eq('exchange_id', loan.exchange_id!)).error?.code, '42501');
  assert.equal((await admin.from('item_reservations').update({ custody_unresolved: false }).eq('exchange_id', loan.exchange_id!)).error?.code, '55000');
  assert.equal((await admin.from('exchanges').update({ state: 'closed_without_completion' }).eq('id', loan.exchange_id!)).error, null);
  assert.equal((await decideBorrow(f.alice, after)).error?.code, '23P01');
  const held = (await borrowRecords(f.listing.id)).reservations;
  assert.deepEqual(held.map(row => ({ dates: row.dates, blocking: row.blocking, custody: row.custody_unresolved })), [{ dates: '[2020-01-15,2020-01-18)', blocking: true, custody: true }]);
  assert.equal((await admin.from('item_reservations').update({ custody_unresolved: false }).eq('exchange_id', loan.exchange_id!)).error, null);
  const recovered = await approveBorrow(f.alice, after);
  assert.equal(recovered.status, 'approved');
  assert.deepEqual((await borrowRecords(f.listing.id)).reservations.map(row => [row.dates, row.blocking]), [['[2020-01-15,2020-01-18)', false], ['[2027-02-01,2027-02-03)', true]]);
  receipt('issue-6-custody', { blockedWhileCheckedOut: '23P01', blockedAfterClosure: '23P01', held, recovered: recovered.reservation });
});
