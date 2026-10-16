import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activeMember, admin, borrowingFixture, decideBorrow, drillDetails, receipt, requestItem, seedDueItemApproval, seedReputationEvent } from '../../scripts/verify/backend';
import { borrowRequestSchema, reservationSchema } from '../../src/features/borrowing/model';

test('request and owner choice persist one Exchange, inclusive reservation, deadline, audit and outbox', async () => {
  const f = await borrowingFixture('request'); const intent = randomUUID();
  const request = await requestItem(f.bob, f.listing.id, undefined, undefined, intent);
  assert.equal(request.status, 'requested'); assert.equal(request.exchange_id, null);
  assert.deepEqual(await requestItem(f.bob, f.listing.id, undefined, undefined, intent), request);
  const changed = await f.bob.client.rpc('submit_borrow_request', { p_intent_id: intent, p_listing_id: f.listing.id, p_starts_on: '2027-01-16', p_ends_on: '2027-01-17' }); assert.equal(changed.error?.code, '23505');
  assert.deepEqual((await admin.from('exchanges').select('id').eq('source_id', f.listing.id)).data, []);
  const decisionIntent = randomUUID(); const result = await decideBorrow(f.alice, request.id, 'approved', decisionIntent); assert.equal(result.error, null);
  const approved = borrowRequestSchema.parse(result.data); assert.equal(approved.status, 'approved');
  const reservation = await f.bob.client.from('item_reservations').select('*').eq('exchange_id', approved.exchange_id!).single();
  const r = reservationSchema.parse(reservation.data); assert.equal(r.blocking, true); assert.equal(r.replacement_value, 180);
  assert.equal(reservation.data?.dates, '[2027-01-15,2027-01-18)');
  const hours = (Date.parse(r.acknowledgment_due_at) - Date.now()) / 3600000; assert.ok(hours > 47.99 && hours <= 48);
  assert.deepEqual((await decideBorrow(f.alice, request.id, 'approved', decisionIntent)).data, approved);
  assert.equal((await decideBorrow(f.alice, request.id, 'rejected', decisionIntent)).error?.code, '23505');
  assert.equal((await decideBorrow(f.alice, request.id)).error?.code, '55000');
  const notices = await admin.from('notification_outbox').select('kind,channel,recipient_id').eq('community_id', f.community.id).like('kind','borrow_%');
  assert.equal(notices.data?.length, 4); assert.equal(notices.data?.filter(n => n.kind === 'borrow_approved').length, 2);
  receipt('issue-6-primary', { approved, reservation: reservation.data, notices: notices.data });
});

test('validation, changed availability, revoked borrower and live score reject without partial effects', async () => {
  const f = await borrowingFixture('guards');
  for (const [start,end] of [['2027-01-17','2027-01-15'],['2027-01-19','2027-01-25'],['2020-01-01','2020-01-02']]) {
    const invalid = await f.bob.client.rpc('submit_borrow_request', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_starts_on: start, p_ends_on: end }); assert.ok(invalid.error);
  }
  const request = await requestItem(f.bob, f.listing.id);
  await seedReputationEvent(f.community.id, f.bob.id, -10);
  assert.equal((await decideBorrow(f.alice, request.id)).error?.code, '23514');
  await seedReputationEvent(f.community.id, f.bob.id, 10);
  assert.equal((await decideBorrow(f.alice, request.id, 'approved', randomUUID(), 9)).error?.code, '55000');
  const revoke = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id); assert.equal(revoke.error, null);
  assert.equal((await decideBorrow(f.alice, request.id)).error?.code, '42501');
  const restore = await admin.from('memberships').update({ status: 'active' }).eq('community_id', f.community.id).eq('user_id', f.bob.id); assert.equal(restore.error, null);
  const edit = await f.alice.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: f.listing.id, p_expected_version: 1, p_details: { ...drillDetails, availability: [{ starts_on: '2027-02-01', ends_on: '2027-02-05' }] } }); assert.equal(edit.error, null);
  assert.equal((await decideBorrow(f.alice, request.id)).error?.code, '55000');
  assert.deepEqual((await admin.from('exchanges').select('id').eq('source_id', f.listing.id)).data, []);
  assert.deepEqual((await admin.from('item_reservations').select('*').eq('listing_id', f.listing.id)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind','borrow_approved')).data, []);
  assert.equal((await admin.from('borrow_requests').select('status').eq('id', request.id).single()).data?.status, 'requested');
  receipt('issue-6-rollback', { noExchange: true, noReservation: true, noApprovalNotice: true });
});

test('overlapping requests coexist; concurrent approvals have exactly one winner and no loser effects', async () => {
  const f = await borrowingFixture('race'); const third = await activeMember(f.owner, f.community.id);
  const [a,b] = await Promise.all([requestItem(f.bob,f.listing.id), requestItem(third,f.listing.id)]);
  const decisions = await Promise.all([decideBorrow(f.alice,a.id),decideBorrow(f.alice,b.id)]);
  assert.equal(decisions.filter(r => !r.error).length,1); assert.equal(decisions.find(r => r.error)?.error?.code,'23P01');
  assert.equal((await admin.from('exchanges').select('id').eq('source_id',f.listing.id)).data?.length,1);
  const requests = await admin.from('borrow_requests').select('status,exchange_id').eq('listing_id',f.listing.id);
  assert.equal(requests.data?.filter(r => r.status === 'requested' && r.exchange_id === null).length,1);
  assert.equal((await admin.from('notification_outbox').select('id').eq('community_id',f.community.id).eq('kind','borrow_approved')).data?.length,2);
  receipt('issue-6-race', { requests: requests.data, errors: decisions.map(d => d.error?.code ?? null) });
});

test('adjacent inclusive ranges approve and decline creates no Exchange', async () => {
  const f = await borrowingFixture('adjacent');
  const first = await requestItem(f.bob,f.listing.id); const second = await requestItem(f.bob,f.listing.id,'2027-01-18','2027-01-20');
  assert.equal((await decideBorrow(f.alice,first.id)).error,null); assert.equal((await decideBorrow(f.alice,second.id)).error,null);
  const declined = await requestItem(f.bob,f.listing.id); assert.equal((await decideBorrow(f.alice,declined.id,'rejected')).error,null);
  assert.equal((await admin.from('borrow_requests').select('status,exchange_id').eq('id',declined.id).single()).data?.exchange_id,null);
  const ranges = await f.bob.client.from('item_reservations').select('dates').eq('listing_id',f.listing.id).order('starts_on');
  assert.deepEqual(ranges.data,[{ dates: '[2027-01-15,2027-01-18)' },{ dates: '[2027-01-18,2027-01-21)' }]);
  assert.equal((await admin.from('notification_outbox').select('id').eq('community_id',f.community.id).eq('kind','borrow_rejected')).data?.length,2);
  receipt('issue-6-calendar',ranges.data);
});

test('delayed and repeated expiry is durable, deadlines deny before worker, and early worker is a no-op', async () => {
  const f = await borrowingFixture('expiry'); const due = await seedDueItemApproval(f);
  assert.equal((await f.bob.client.rpc('check_item_approval',{ p_exchange_id: due.exchangeId })).error?.code,'55000');
  assert.equal((await admin.from('exchanges').update({ state: 'handoff_pending' }).eq('id',due.exchangeId)).error?.code,'55000');
  const [a,b] = await Promise.all([admin.rpc('expire_item_approval',{ p_exchange_id: due.exchangeId }),admin.rpc('expire_item_approval',{ p_exchange_id: due.exchangeId })]);
  assert.equal(a.error,null); assert.equal(b.error,null); assert.equal(z.object({ state: z.string() }).parse(a.data).state,'expired');
  assert.equal((await f.bob.client.from('item_reservations').select('blocking').eq('exchange_id',due.exchangeId).single()).data?.blocking,false);
  assert.equal((await admin.from('notification_outbox').select('id').eq('community_id',f.community.id).eq('kind','borrow_expired')).data?.length,4);
  const next = await requestItem(f.bob,f.listing.id); const approved = borrowRequestSchema.parse((await decideBorrow(f.alice,next.id)).data);
  const early = await admin.rpc('expire_item_approval',{ p_exchange_id: approved.exchange_id! }); assert.equal(z.object({state:z.string()}).parse(early.data).state,'approved');
  assert.equal((await f.bob.client.rpc('check_item_approval',{ p_exchange_id: approved.exchange_id! })).error,null);
  receipt('issue-6-expiry',{ due, expired: a.data, repeated: b.data, early: early.data });
});

test('overdue and closed unresolved custody block disjoint approvals; reservation dates cannot change', async () => {
  const f = await borrowingFixture('custody'); const prior = await seedDueItemApproval(f);
  assert.equal((await admin.from('exchanges').update({state:'checked_out'}).eq('id',prior.exchangeId)).error,null);
  const candidate = await requestItem(f.bob,f.listing.id,'2027-02-01','2027-02-02');
  assert.equal((await decideBorrow(f.alice,candidate.id)).error?.code,'23P01');
  assert.equal((await admin.from('exchanges').update({state:'closed_without_completion'}).eq('id',prior.exchangeId)).error,null);
  assert.equal((await decideBorrow(f.alice,candidate.id)).error?.code,'23P01');
  assert.equal((await admin.from('item_reservations').update({ends_on:'2027-01-18'}).eq('exchange_id',prior.exchangeId)).error?.code,'42501');
  assert.equal((await admin.from('item_reservations').update({custody_unresolved:false}).eq('exchange_id',prior.exchangeId)).error,null);
  assert.equal((await decideBorrow(f.alice,candidate.id)).error,null);
  receipt('issue-6-custody',{ prior, candidate, recoveredByFixture: true });
});
