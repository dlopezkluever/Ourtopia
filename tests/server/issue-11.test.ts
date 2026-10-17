import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { noticeKinds } from '../../src/features/notifications/model';
import {
  admin, approveBorrow, borrowNotices, decideBorrow, drillDetails, itemNeedFixture, listingImageBytes, needDetails, needRow, postNeed, publishDrill,
  receipt, requestItem, respondToNeed, workflowEffects,
} from '../../scripts/verify/backend';

const none = { exchanges: 0, reservations: 0, reputationEvents: 0, qualifyingInteractions: 0, borrowRequests: 0 };

test('A response delivers specific email and in-app copy without private Need Post content', async () => {
  const f = await itemNeedFixture('need-notice-copy');
  await respondToNeed(f.alice, f.need.id, f.listing.id, 'Private note excluded from email');
  const rows = await admin.from('notification_outbox').select('id,channel').eq('community_id', f.community.id).eq('kind', 'item_need_responded');
  assert.equal(rows.error, null);
  assert.equal(rows.data!.length, 2);
  const sent: { subject: string; text: string }[] = [];
  for (const row of rows.data!) await deliverOne(admin, async message => { sent.push(message); }, row.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Someone answered your item Need Post');
  assert.equal(sent[0].text, 'Sign in to Ourtopia and open Community requests to review the offered Listing and send a separate Borrow Request.');
  const notices = await f.bob.client.from('notifications').select('kind').in('outbox_id', rows.data!.map(row => row.id));
  assert.equal(notices.error, null);
  assert.deepEqual(notices.data, [{ kind: 'item_need_responded' }]);
  assert.equal(noticeKinds.item_need_responded.message, 'Someone answered your item Need Post with a Listing. Open Community requests to review it and send a separate Borrow Request.');
  receipt('issue-11-notice-copy', { email: { subject: sent[0].subject, text: sent[0].text }, inApp: noticeKinds.item_need_responded.message });
});
async function intentRows(actorId: string, intent: string) {
  return (await admin.from('command_intents').select('intent_id').eq('actor_id', actorId).eq('intent_id', intent)).data;
}

test('Bob posts an item need, Alice answers with her drill, and only Bob\'s separate Borrow Request and Alice\'s approval create an Exchange', async () => {
  const f = await itemNeedFixture('need-primary');
  assert.deepEqual({ status: f.need.status, version: f.need.version, author: f.need.author_id, urgency: f.need.urgency, dates: [f.need.starts_on, f.need.ends_on] },
    { status: 'open', version: 1, author: f.bob.id, urgency: 'soon', dates: ['2027-01-15', '2027-01-17'] });
  const intent = randomUUID();
  const response = await respondToNeed(f.alice, f.need.id, f.listing.id, 'My drill is free that weekend.', intent);
  assert.deepEqual(await respondToNeed(f.alice, f.need.id, f.listing.id, 'My drill is free that weekend.', intent), response);
  assert.equal((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: intent, p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: 'Changed note' })).error?.code, '23505');
  assert.deepEqual({ status: response.status, listing: response.listing_id, responder: response.responder_id }, { status: 'offered', listing: f.listing.id, responder: f.alice.id });
  assert.deepEqual(await workflowEffects(f.community.id), none);
  assert.deepEqual(await borrowNotices(f.community.id, 'item_need_responded'), [{ recipient_id: f.bob.id, channel: 'email', kind: 'item_need_responded' }, { recipient_id: f.bob.id, channel: 'in_app', kind: 'item_need_responded' }]);
  const events = await admin.from('community_events').select('kind,actor_id').eq('community_id', f.community.id).like('kind', 'item_need%').order('created_at');
  assert.deepEqual(events.data, [{ kind: 'item_need_published', actor_id: f.bob.id }, { kind: 'item_need_responded', actor_id: f.alice.id }]);

  const seen = await f.bob.client.from('item_need_responses').select('id,listing_id').eq('need_id', f.need.id);
  assert.deepEqual(seen.data, [{ id: response.id, listing_id: f.listing.id }]);
  const request = await requestItem(f.bob, response.listing_id, f.need.starts_on, f.need.ends_on);
  assert.deepEqual({ status: request.status, exchange: request.exchange_id }, { status: 'requested', exchange: null });
  assert.deepEqual(await workflowEffects(f.community.id), { ...none, borrowRequests: 1 });
  const approved = await approveBorrow(f.alice, request);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(await workflowEffects(f.community.id), { ...none, borrowRequests: 1, exchanges: 1, reservations: 1 });
  const exchange = await admin.from('exchanges').select('kind,source_kind,source_id,provider_id,receiver_id,state').eq('id', approved.exchange_id!).single();
  assert.deepEqual(exchange.data, { kind: 'item', source_kind: 'listing', source_id: f.listing.id, provider_id: f.alice.id, receiver_id: f.bob.id, state: 'approved' });
  receipt('issue-11-primary', { need: f.need, response, request, approved, effects: await workflowEffects(f.community.id) });
});

test('Invalid fields, own-need answers, withdrawn sources, and duplicate answers fail without partial effects', async () => {
  const f = await itemNeedFixture('need-guards');
  const invalid = [
    needDetails({ title: 'x' }), needDetails({ urgency: 'tomorrow' }), needDetails({ starts_on: '2027-01-18', ends_on: '2027-01-17' }), needDetails({ starts_on: '2020-01-01', ends_on: '2020-01-02' }),
    needDetails({ value_min: 100, value_max: null }), needDetails({ value_min: 300, value_max: 200 }), needDetails({ category: 'weapons' }), { ...needDetails(), extra: true }, null,
  ];
  for (const details of invalid) {
    const intent = randomUUID();
    const result = await f.bob.client.rpc('save_item_need', { p_intent_id: intent, p_community_id: f.community.id, p_need_id: null, p_expected_version: 0, p_details: details });
    assert.ok(['22023', '23514'].includes(result.error?.code ?? ''), `${JSON.stringify(details)} ${result.error?.code}`);
    assert.deepEqual(await intentRows(f.bob.id, intent), []);
  }
  const optional = await postNeed(f.carol, f.community.id, needDetails({ value_min: null, value_max: null, urgency: 'flexible' }));
  assert.equal(optional.urgency, 'flexible');

  const intent = randomUUID();
  const own = await publishDrill(f.bob, f.community.id, { ...drillDetails, title: "Bob's drill" });
  assert.equal((await f.bob.client.rpc('respond_to_item_need', { p_intent_id: intent, p_need_id: f.need.id, p_listing_id: own.id, p_note: '' })).error?.code, '22023');
  assert.deepEqual(await intentRows(f.bob.id, intent), []);
  await respondToNeed(f.alice, f.need.id, f.listing.id);
  const duplicate = randomUUID();
  assert.equal((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: duplicate, p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: 'again' })).error?.code, '23505');
  assert.deepEqual(await intentRows(f.alice.id, duplicate), []);
  assert.equal((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: 'x'.repeat(1001) })).error?.code, '22023');

  const spare = await publishDrill(f.alice, f.community.id, { ...drillDetails, title: 'Spare drill' });
  assert.equal((await f.alice.client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: spare.id, p_expected_version: spare.version })).error, null);
  assert.equal((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: spare.id, p_note: '' })).error?.code, '55000');
  assert.equal((await f.bob.client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 1 })).error, null);
  const late = await publishDrill(f.carol, f.community.id, { ...drillDetails, title: "Carol's drill" });
  assert.equal((await f.carol.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: late.id, p_note: '' })).error?.code, '55000');
  const responses = await admin.from('item_need_responses').select('listing_id,status').eq('need_id', f.need.id);
  assert.deepEqual(responses.data, [{ listing_id: f.listing.id, status: 'offered' }]);
  assert.deepEqual(await workflowEffects(f.community.id), none);
  receipt('issue-11-guards', { rejectedDetails: invalid.length, responses: responses.data });
});

test('Author and same-Community administrator edit and withdraw with versions; stale and repeated changes fail', async () => {
  const f = await itemNeedFixture('need-lifecycle');
  const intent = randomUUID();
  const edit = (version: number, title: string, key = randomUUID()) => ({ p_intent_id: key, p_community_id: f.community.id, p_need_id: f.need.id, p_expected_version: version, p_details: needDetails({ title }) });
  const edited = needRow.parse((await f.bob.client.rpc('save_item_need', edit(1, 'Drill with masonry bit', intent))).data);
  assert.deepEqual({ title: edited.title, version: edited.version }, { title: 'Drill with masonry bit', version: 2 });
  assert.deepEqual(needRow.parse((await f.bob.client.rpc('save_item_need', edit(1, 'Drill with masonry bit', intent))).data), edited);
  assert.equal((await f.bob.client.rpc('save_item_need', edit(1, 'Other title', intent))).error?.code, '23505');
  assert.equal((await f.bob.client.rpc('save_item_need', edit(1, 'Stale title'))).error?.code, '55000');
  assert.equal((await f.carol.client.rpc('save_item_need', edit(2, 'Carol rewrites it'))).error?.code, '42501');
  const moderated = needRow.parse((await f.owner.client.rpc('save_item_need', edit(2, 'Moderated drill need'))).data);
  assert.deepEqual({ title: moderated.title, author: moderated.author_id, version: moderated.version }, { title: 'Moderated drill need', author: f.bob.id, version: 3 });
  assert.equal((await f.carol.client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 3 })).error?.code, '42501');
  const withdrawn = needRow.parse((await f.bob.client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 3 })).data);
  assert.deepEqual({ status: withdrawn.status, version: withdrawn.version }, { status: 'withdrawn', version: 4 });
  assert.equal((await f.bob.client.rpc('save_item_need', edit(4, 'After withdrawal'))).error?.code, '55000');
  assert.equal((await f.bob.client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 4 })).error?.code, '55000');
  assert.equal((await admin.from('item_need_posts').update({ author_id: f.carol.id }).eq('id', f.need.id)).error?.code, '42501');
  assert.equal((await admin.from('item_need_posts').delete().eq('id', f.need.id)).error?.code, '42501');
  const events = await admin.from('community_events').select('kind,actor_id').eq('community_id', f.community.id).like('kind', 'item_need%').order('created_at');
  assert.deepEqual(events.data?.map(event => [event.kind, event.actor_id]), [['item_need_published', f.bob.id], ['item_need_edited', f.bob.id], ['item_need_edited', f.owner.id], ['item_need_withdrawn', f.bob.id]]);
  receipt('issue-11-lifecycle', { edited, moderated, withdrawn, events: events.data });
});

test('A response is withdrawn only by its responder or an administrator, then hides its Listing and cannot change again', async () => {
  const f = await itemNeedFixture('need-response-withdraw');
  const response = await respondToNeed(f.alice, f.need.id, f.listing.id);
  for (const member of [f.bob, f.carol]) assert.equal((await member.client.rpc('withdraw_item_need_response', { p_intent_id: randomUUID(), p_response_id: response.id })).error?.code, '42501');
  const intent = randomUUID();
  const withdrawn = await f.alice.client.rpc('withdraw_item_need_response', { p_intent_id: intent, p_response_id: response.id });
  assert.equal(withdrawn.data.status, 'withdrawn');
  assert.deepEqual((await f.alice.client.rpc('withdraw_item_need_response', { p_intent_id: intent, p_response_id: response.id })).data, withdrawn.data);
  assert.equal((await f.alice.client.rpc('withdraw_item_need_response', { p_intent_id: randomUUID(), p_response_id: response.id })).error?.code, '55000');
  assert.deepEqual((await f.bob.client.from('item_need_responses').select('id').eq('need_id', f.need.id)).data, []);
  assert.deepEqual((await f.alice.client.from('item_need_responses').select('id,status').eq('need_id', f.need.id)).data, [{ id: response.id, status: 'withdrawn' }]);
  assert.equal((await admin.from('item_need_responses').update({ status: 'offered', withdrawn_at: null }).eq('id', response.id)).error?.code, '42501');
  const again = await respondToNeed(f.alice, f.need.id, f.listing.id, 'Back again.');
  const moderated = await f.owner.client.rpc('withdraw_item_need_response', { p_intent_id: randomUUID(), p_response_id: again.id });
  assert.equal(moderated.data.status, 'withdrawn');
  assert.deepEqual(await workflowEffects(f.community.id), none);
  receipt('issue-11-response-withdrawal', { withdrawn: withdrawn.data, moderated: moderated.data });
});

test('One optional private image: reserve, upload, complete, refuse a second, remove, and refuse on a withdrawn need', async () => {
  const f = await itemNeedFixture('need-image');
  const prepare = (imageId = randomUUID(), intent = randomUUID()) => f.bob.client.rpc('prepare_item_need_image', { p_intent_id: intent, p_need_id: f.need.id, p_image_id: imageId, p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  const prepared = await prepare();
  assert.equal(prepared.error, null);
  const path = prepared.data.object_path as string;
  assert.equal(path, `${f.community.id}/${f.need.id}/${prepared.data.id}`);
  assert.equal((await f.bob.client.rpc('complete_item_need_image', { p_intent_id: randomUUID(), p_image_id: prepared.data.id })).error?.code, '55000');
  assert.equal((await f.bob.client.storage.from('item-need-images').upload(path, listingImageBytes, { contentType: 'image/png' })).error, null);
  const completed = await f.bob.client.rpc('complete_item_need_image', { p_intent_id: randomUUID(), p_image_id: prepared.data.id });
  assert.equal(completed.data.state, 'ready');
  assert.equal((await prepare()).error?.code, '22023');
  assert.equal((await f.carol.client.rpc('remove_item_need_image', { p_intent_id: randomUUID(), p_image_id: prepared.data.id })).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('remove_item_need_image', { p_intent_id: randomUUID(), p_image_id: prepared.data.id })).data.state, 'removed');
  assert.ok((await f.carol.client.storage.from('item-need-images').download(path)).error);
  assert.equal((await prepare()).error, null);
  assert.equal((await f.bob.client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 1 })).error, null);
  assert.equal((await prepare()).error?.code, '55000');
  receipt('issue-11-image', { path, completed: completed.data.state });
});

test('Borrowing through a response keeps availability and overlap guards', async () => {
  const f = await itemNeedFixture('need-guarded-borrow');
  const response = await respondToNeed(f.alice, f.need.id, f.listing.id);
  await assert.rejects(requestItem(f.bob, response.listing_id, '2027-03-01', '2027-03-02'), (error: { code?: string }) => error.code === '55000');
  const carol = await approveBorrow(f.alice, await requestItem(f.carol, f.listing.id, '2027-01-16', '2027-01-18'));
  assert.equal(carol.status, 'approved');
  const bob = await requestItem(f.bob, response.listing_id, f.need.starts_on, f.need.ends_on);
  assert.equal((await decideBorrow(f.alice, bob)).error?.code, '23P01');
  assert.deepEqual(await workflowEffects(f.community.id), { ...none, borrowRequests: 2, exchanges: 1, reservations: 1 });
  receipt('issue-11-guarded-borrow', { conflict: '23P01', effects: await workflowEffects(f.community.id) });
});
