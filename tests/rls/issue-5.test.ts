import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { actor, admin, drillDetails, listingFixture, listingImageBytes, prepareListingImage, publicClient, publishDrill, realtimeReady, receipt, uploadListingImage } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

test('Ordinary member cannot forge owner, mutate command-owned rows, or edit another Listing; local administrator can moderate', async () => {
  const f = await listingFixture('listing-roles'); const listing = await publishDrill(f.alice, f.community.id);
  const edit = { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: listing.id, p_expected_version: 1, p_details: { ...drillDetails, title: 'Moderated drill' } };
  assert.equal((await f.bob.client.rpc('save_listing', edit)).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: listing.id, p_expected_version: 1 })).error?.code, '42501');
  assert.equal((await f.bob.client.from('listings').update({ owner_id: f.bob.id }).eq('id', listing.id)).error?.code, '42501');
  assert.equal((await f.alice.client.from('listing_availability').insert({ listing_id: listing.id, starts_on: '2027-01-01', ends_on: '2027-01-02' })).error?.code, '42501');
  assert.equal((await f.alice.client.from('listing_images').insert({ id: randomUUID(), listing_id: listing.id, object_path: 'forged', mime_type: 'image/png', byte_size: 20 })).error?.code, '42501');
  const moderator = await f.owner.client.rpc('save_listing', edit); assert.equal(moderator.error, null); assert.equal(moderator.data.owner_id, f.alice.id);
  receipt('issue-5-roles', { deniedMember: true, moderated: moderator.data });
});

test('All inactive and unrelated actors lose rows, commands, and private Storage through their own credentials', async () => {
  const f = await listingFixture('listing-private'); const listing = await publishDrill(f.alice, f.community.id); const image = await uploadListingImage(f.alice, listing.id);
  const outsider = await actor({ label: 'listing-outsider' });
  const foreign = await actor({ label: 'listing-foreign-admin' });
  await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Foreign circle', p_description: '' });
  const checks = [];
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
    checks.push({ label: status, client: f.bob.client });
    for (const table of ['listings', 'listing_availability', 'listing_images']) {
      const result = await f.bob.client.from(table).select('*').eq(table === 'listings' ? 'id' : 'listing_id', listing.id);
      assert.deepEqual(result.data, []);
    }
    assert.ok((await f.bob.client.storage.from('listing-images').download(image.object_path)).error);
    assert.ok((await f.bob.client.storage.from('listing-images').createSignedUrl(image.object_path, 30)).error);
    assert.equal((await f.bob.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: null, p_expected_version: 0, p_details: drillDetails })).error?.code, '42501');
    assert.equal((await f.bob.client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: listing.id, p_expected_version: 1 })).error?.code, '42501');
    assert.equal((await f.bob.client.rpc('prepare_listing_image', { p_intent_id: randomUUID(), p_listing_id: listing.id, p_image_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: 10 })).error?.code, '42501');
    for (const command of ['complete_listing_image', 'remove_listing_image']) assert.equal((await f.bob.client.rpc(command, { p_intent_id: randomUUID(), p_image_id: image.id })).error?.code, '42501');
  }
  for (const client of [outsider.client, foreign.client, publicClient()]) {
    const result = await client.from('listings').select('*').eq('id', listing.id); assert.ok(result.error || result.data?.length === 0);
    assert.ok((await client.storage.from('listing-images').download(image.object_path)).error);
    assert.ok((await client.storage.from('listing-images').createSignedUrl(image.object_path, 30)).error);
    assert.equal((await client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: listing.id, p_expected_version: 1 })).error?.code, '42501');
    assert.equal((await client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: null, p_expected_version: 0, p_details: drillDetails })).error?.code, '42501');
    assert.equal((await client.rpc('prepare_listing_image', { p_intent_id: randomUUID(), p_listing_id: listing.id, p_image_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: 10 })).error?.code, '42501');
    for (const command of ['complete_listing_image', 'remove_listing_image']) assert.equal((await client.rpc(command, { p_intent_id: randomUUID(), p_image_id: image.id })).error?.code, '42501');
  }
  const publicRead = await fetch(`${process.env.VITE_SUPABASE_URL}/storage/v1/object/public/listing-images/${image.object_path}`); assert.equal(publicRead.ok, false);
  assert.equal((await f.alice.client.storage.from('listing-images').download(image.object_path)).error, null);
  assert.ok((await f.alice.client.storage.from('listing-images').upload(`${f.community.id}/${listing.id}/${randomUUID()}`, listingImageBytes, { contentType: 'image/png' })).error);
  receipt('issue-5-private-boundaries', { statuses: checks.map(value => value.label), outsider: 'denied', foreignAdministrator: 'denied', anonymous: 'denied', publicRead: publicRead.status });
});

test('Revoked owner retries require current membership and pending image access is restricted', async () => {
  const f = await listingFixture('listing-revoke'); const intent = randomUUID(); const listing = await publishDrill(f.alice, f.community.id, drillDetails, intent);
  const image = await prepareListingImage(f.alice, listing.id);
  assert.ok((await f.bob.client.storage.from('listing-images').upload(image.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  assert.equal((await f.alice.client.storage.from('listing-images').upload(image.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.ok((await f.bob.client.storage.from('listing-images').download(image.object_path)).error);
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.alice.id);
  assert.equal((await f.alice.client.rpc('save_listing', { p_intent_id: intent, p_community_id: f.community.id, p_listing_id: null, p_expected_version: 0, p_details: drillDetails })).error?.code, '42501');
  assert.equal((await f.alice.client.rpc('complete_listing_image', { p_intent_id: randomUUID(), p_image_id: image.id })).error?.code, '42501');
  assert.ok((await f.alice.client.storage.from('listing-images').download(image.object_path)).error);
  receipt('issue-5-current-membership', { retry: '42501', pendingOtherMember: 'denied', removedOwner: 'denied' });
});

test('Realtime sends only authorized event identity and inactive viewers receive no Listing event', async () => {
  const f = await listingFixture('listing-realtime');
  await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  const outsider = await actor({ label: 'listing-realtime-outsider' });
  const inactive = await Promise.all(['pending','rejected','removed'].map(async status => {
    const member = await actor({ label: `listing-rt-${status}` });
    const result = await admin.from('memberships').insert({ community_id: f.community.id, user_id: member.id, role: 'member', status }); assert.equal(result.error, null);
    return member;
  }));
  const foreign = await actor({ label: 'listing-rt-foreign-admin' });
  await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Private foreign circle', p_description: '' });
  const actors = [f.alice, f.bob, outsider, ...inactive, foreign, { client: publicClient() }]; const deliveries: Record<string, unknown>[] = actors.map(() => ({}));
  const channels = await Promise.all(actors.map(async (member, index) => {
    const session = await member.client.auth.getSession(); if (session.data.session) await member.client.realtime.setAuth(session.data.session.access_token);
    const channel = member.client.channel(`listing-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (change.new.kind === 'listing_published') deliveries[index] = change.new; });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    await publishDrill(f.alice, f.community.id);
    const deadline = Date.now() + 10000;
    while (!deliveries[0].id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(deliveries[0].kind, 'listing_published'); assert.deepEqual(deliveries.slice(1), actors.slice(1).map(() => ({})));
    assert.deepEqual(Object.keys(deliveries[0]).sort(), ['actor_id','community_id','created_at','id','intent_id','kind']);
    receipt('issue-5-realtime', deliveries);
  } finally { await Promise.all(actors.map((member, i) => member.client.removeChannel(channels[i]))); actors.forEach(member => member.client.realtime.disconnect()); }
});
