import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { admin, drillDetails, listingFixture, listingImageBytes, prepareListingImage, publishDrill, receipt } from '../../scripts/verify/backend';

test('Listing publication is durable, actor-owned, audited and intent-idempotent', async () => {
  const f = await listingFixture('listing-create');
  const intent = randomUUID();
  const listing = await publishDrill(f.alice, f.community.id, drillDetails, intent);
  assert.equal(listing.owner_id, f.alice.id);
  assert.equal(listing.replacement_value, 180); assert.equal(listing.minimum_score, 45);
  assert.deepEqual(await publishDrill(f.alice, f.community.id, drillDetails, intent), listing);
  const args = { p_intent_id: intent, p_community_id: f.community.id, p_listing_id: null, p_expected_version: 0, p_details: { ...drillDetails, title: 'Changed' } };
  assert.equal((await f.alice.client.rpc('save_listing', args)).error?.code, '23505');
  const dates = await f.bob.client.from('listing_availability').select('starts_on,ends_on,dates').eq('listing_id', listing.id).order('starts_on');
  assert.deepEqual(dates.data, [{ starts_on: '2027-01-10', ends_on: '2027-01-20', dates: '[2027-01-10,2027-01-21)' }, { starts_on: '2027-02-01', ends_on: '2027-02-05', dates: '[2027-02-01,2027-02-06)' }]);
  assert.equal((await f.alice.client.from('community_events').select('id').eq('actor_id', f.alice.id).eq('kind', 'listing_published')).data?.length, 1);
  const notices = await admin.from('notification_outbox').select('*').eq('community_id', f.community.id);
  assert.equal(JSON.stringify(notices.data).includes('/storage/'), false);
  receipt('issue-5-publication', { listing, dates: dates.data, noticeURLs: false });
});

test('Owner edits and withdraws without deleting history; stale versions fail', async () => {
  const f = await listingFixture('listing-edit'); const listing = await publishDrill(f.alice, f.community.id);
  const edit = { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: listing.id, p_expected_version: 1, p_details: { ...drillDetails, title: 'Makita drill and bits' } };
  const saved = await f.alice.client.rpc('save_listing', edit); assert.equal(saved.error, null); assert.equal(saved.data.version, 2);
  assert.deepEqual((await f.alice.client.rpc('save_listing', edit)).data, saved.data);
  assert.equal((await f.alice.client.rpc('save_listing', { ...edit, p_intent_id: randomUUID() })).error?.code, '55000');
  const withdraw = { p_intent_id: randomUUID(), p_listing_id: listing.id, p_expected_version: 2 };
  const withdrawn = await f.alice.client.rpc('withdraw_listing', withdraw); assert.equal(withdrawn.error, null); assert.equal(withdrawn.data.status, 'withdrawn');
  assert.deepEqual((await f.alice.client.rpc('withdraw_listing', withdraw)).data, withdrawn.data);
  assert.equal((await f.alice.client.rpc('withdraw_listing', { ...withdraw, p_expected_version: 3 })).error?.code, '23505');
  assert.equal((await f.bob.client.from('listings').select('id,status').eq('id', listing.id)).data?.[0].status, 'withdrawn');
  assert.equal((await f.bob.client.from('listing_availability').select('id').eq('listing_id', listing.id)).data?.length, 2);
  receipt('issue-5-lifecycle', { edited: saved.data, withdrawn: withdrawn.data });
});

test('Invalid and forged documents roll back Listing, availability, event and intent', async () => {
  const f = await listingFixture('listing-invalid');
  for (const details of [{ ...drillDetails, owner_id: f.bob.id }, { ...drillDetails, minimum_score: 101 }, { ...drillDetails, availability: [{ starts_on: '2027-02-10', ends_on: '2027-01-10' }] }, { ...drillDetails, availability: [] }]) {
    const intent = randomUUID();
    assert.ok((await f.alice.client.rpc('save_listing', { p_intent_id: intent, p_community_id: f.community.id, p_listing_id: null, p_expected_version: 0, p_details: details })).error);
    assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('intent_id', intent)).data, []);
    assert.deepEqual((await admin.from('community_events').select('id').eq('intent_id', intent)).data, []);
  }
  assert.deepEqual((await f.alice.client.from('listings').select('*').eq('community_id', f.community.id)).data, []);
  const listing = await publishDrill(f.alice, f.community.id);
  assert.ok((await f.alice.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: listing.id, p_expected_version: 1, p_details: { ...drillDetails, title: 'Must roll back', availability: [{ starts_on: 'bad', ends_on: 'bad' }] } })).error);
  const unchanged = await f.alice.client.from('listings').select('title,version,listing_availability(starts_on)').eq('id', listing.id).single();
  assert.equal(unchanged.data?.title, "Alice's Makita drill"); assert.equal(unchanged.data?.version, 1); assert.equal(unchanged.data?.listing_availability.length, 2);
  receipt('issue-5-rollback', unchanged.data);
});

test('Concurrent stale edits serialize and same intent creates once', async () => {
  const f = await listingFixture('listing-race'); const intent = randomUUID();
  const pair = await Promise.all([publishDrill(f.alice, f.community.id, drillDetails, intent), publishDrill(f.alice, f.community.id, drillDetails, intent)]);
  assert.equal(pair[0].id, pair[1].id);
  const edits = await Promise.all(['First edit', 'Second edit'].map(title => f.alice.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: pair[0].id, p_expected_version: 1, p_details: { ...drillDetails, title } })));
  assert.equal(edits.filter(value => !value.error).length, 1); assert.equal(edits.find(value => value.error)?.error?.code, '55000');
  receipt('issue-5-races', { pair, edits });
});

test('Private image preparation and completion recover interruptions without duplicate records', async () => {
  const f = await listingFixture('listing-image'); const listing = await publishDrill(f.alice, f.community.id);
  const image = await prepareListingImage(f.alice, listing.id);
  const complete = { p_intent_id: randomUUID(), p_image_id: image.id };
  assert.equal((await f.alice.client.rpc('complete_listing_image', complete)).error?.code, '55000');
  assert.equal((await f.alice.client.storage.from('listing-images').upload(image.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  const completed = await f.alice.client.rpc('complete_listing_image', complete); assert.equal(completed.error, null); assert.equal(completed.data.state, 'ready');
  assert.deepEqual((await f.alice.client.rpc('complete_listing_image', complete)).data, completed.data);
  assert.equal((await f.alice.client.rpc('complete_listing_image', { ...complete, p_image_id: randomUUID() })).error?.code, '42501');
  assert.equal((await f.alice.client.from('listing_images').select('id').eq('listing_id', listing.id)).data?.length, 1);
  assert.equal((await f.bob.client.storage.from('listing-images').download(image.object_path)).error, null);
  assert.ok((await f.alice.client.storage.from('listing-images').upload(image.object_path, listingImageBytes, { contentType: 'image/png', upsert: true })).error);
  const remove = { p_intent_id: randomUUID(), p_image_id: image.id };
  const removed = await f.alice.client.rpc('remove_listing_image', remove); assert.equal(removed.error, null); assert.equal(removed.data.state, 'removed');
  assert.deepEqual((await f.alice.client.rpc('remove_listing_image', remove)).data, removed.data);
  assert.ok((await f.bob.client.storage.from('listing-images').download(image.object_path)).error);
  assert.equal((await f.alice.client.from('listing_images').select('state').eq('id', image.id)).data?.[0].state, 'removed');
  receipt('issue-5-upload-recovery', { image, completed: completed.data });
});

test('Invalid image types, sizes and mismatched stored metadata cannot complete', async () => {
  const f = await listingFixture('listing-invalid-image'); const listing = await publishDrill(f.alice, f.community.id);
  for (const [mime, size] of [['text/html', 100], ['image/png', 0], ['image/png', 5242881]] as const) {
    const result = await f.alice.client.rpc('prepare_listing_image', { p_intent_id: randomUUID(), p_listing_id: listing.id, p_image_id: randomUUID(), p_mime_type: mime, p_byte_size: size }); assert.equal(result.error?.code, '23514');
  }
  assert.deepEqual((await f.alice.client.from('listing_images').select('*').eq('listing_id', listing.id)).data, []);
  const image = await prepareListingImage(f.alice, listing.id);
  const wrongSize = await f.alice.client.storage.from('listing-images').upload(image.object_path, Buffer.concat([listingImageBytes, Buffer.from('extra')]), { contentType: 'image/png' }); assert.equal(wrongSize.error, null);
  assert.equal((await f.alice.client.rpc('complete_listing_image', { p_intent_id: randomUUID(), p_image_id: image.id })).error?.code, '55000');
  assert.equal((await f.alice.client.from('listing_images').select('state').eq('id', image.id)).data?.[0].state, 'pending');
  receipt('issue-5-image-validation', { invalidMetadata: 'denied', incomplete: 'pending' });
});
