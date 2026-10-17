import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  actor, admin, drillDetails, itemNeedFixture, listingImageBytes, needDetails, postNeed, publicClient, publishDrill, realtimeReady, receipt, respondToNeed,
} from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

test('Private response notices and image audit stay hidden from nonparticipants, including administrators and realtime subscribers', async () => {
  const f = await itemNeedFixture('need-notice-privacy');
  const foreign = await foreignAdministrator('need-notice-foreign');
  const outsider = await actor({ label: 'need-notice-outsider' });
  const members = [f.bob, f.alice, f.carol, f.owner, foreign, outsider, { client: publicClient() }];
  const privateKinds = ['item_need_responded', 'item_need_response_withdrawn', 'item_need_image_prepared', 'item_need_image_completed', 'item_need_image_removed'];
  const deliveries: string[][] = members.map(() => []);
  const channels = await Promise.all(members.map(async (member, index) => {
    const session = await member.client.auth.getSession();
    if (session.data.session) await member.client.realtime.setAuth(session.data.session.access_token);
    const channel = member.client.channel(`need-private-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => {
      if (privateKinds.includes(String(change.new.kind))) deliveries[index].push(String(change.new.kind));
    });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    const response = await respondToNeed(f.alice, f.need.id, f.listing.id, 'Private response notice');
    const image = await readyImage(f.bob, f.need.id);
    assert.equal((await f.bob.client.rpc('remove_item_need_image', { p_intent_id: randomUUID(), p_image_id: image.id })).error, null);
    assert.equal((await f.alice.client.rpc('withdraw_item_need_response', { p_intent_id: randomUUID(), p_response_id: response.id })).error, null);
    const notices = await admin.from('notification_outbox').select('id,event_id').eq('community_id', f.community.id).eq('kind', 'item_need_responded');
    assert.equal(notices.error, null);
    assert.equal(notices.data!.length, 2);
    const eventId = notices.data![0].event_id;
    const reminder = await admin.rpc('schedule_notification_reminder', { p_community_id: f.community.id, p_source_key: randomUUID(), p_event_id: eventId, p_recipient_id: f.alice.id, p_channel: 'email', p_kind: 'item_need_responded', p_due_at: '2027-01-01T00:00:00Z' });
    assert.equal(reminder.error, null);
    const persisted = await admin.from('community_events').select('kind').eq('community_id', f.community.id).in('kind', privateKinds);
    assert.deepEqual(persisted.data?.map(row => row.kind).sort(), [...privateKinds].sort());
    for (const member of members) {
      const events = await member.client.from('community_events').select('*').eq('community_id', f.community.id).in('kind', privateKinds);
      assert.equal(events.error?.code ?? null, member === members[6] ? '42501' : null);
      assert.deepEqual(events.data ?? [], []);
      const rows = await member.client.from('notification_outbox').select('*').eq('community_id', f.community.id).eq('kind', 'item_need_responded');
      assert.equal(rows.error?.code ?? null, member === members[6] ? '42501' : null);
      const recipient = member === f.bob ? f.bob.id : member === f.alice ? f.alice.id : null;
      assert.equal(rows.data?.length ?? 0, member === f.bob ? 2 : member === f.alice ? 1 : 0);
      assert.ok((rows.data ?? []).every(row => row.recipient_id === recipient));
      const reminders = await member.client.from('notification_reminders').select('*').eq('community_id', f.community.id);
      assert.equal(reminders.error?.code ?? null, member === members[6] ? '42501' : null);
      assert.deepEqual(reminders.data ?? [], []);
    }
    const consoleRows = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
    assert.equal(consoleRows.error, null);
    assert.ok(Array.isArray(consoleRows.data));
    assert.equal(consoleRows.data.some(row => row.kind === 'item_need_responded'), false);
    assert.equal(consoleRows.data.some(row => row.kind === 'membership_approved'), true);
    assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: notices.data![0].id })).error?.code, '42501');
    await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
    assert.deepEqual((await f.bob.client.from('notification_outbox').select('*').eq('community_id', f.community.id).eq('kind', 'item_need_responded')).data, []);
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.deepEqual(deliveries, members.map(() => []));
    receipt('issue-11-private-notices', { privateKinds, deliveries, consoleRows: consoleRows.data, recipientOutboxCounts: [2, 1, 0, 0, 0, 0, 0] });
  } finally {
    await Promise.all(members.map((member, index) => member.client.removeChannel(channels[index])));
    members.forEach(member => member.client.realtime.disconnect());
  }
});

type Client = Awaited<ReturnType<typeof actor>>['client'];
async function foreignAdministrator(label: string) {
  const foreign = await actor({ label });
  const created = await foreign.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Foreign lending circle', p_description: '' });
  assert.equal(created.error, null);
  return { ...foreign, communityId: created.data.id as string };
}
async function visible(client: Client, needId: string) {
  const [needs, responses, images] = await Promise.all([
    client.from('item_need_posts').select('id').eq('id', needId),
    client.from('item_need_responses').select('id').eq('need_id', needId),
    client.from('item_need_images').select('id').eq('need_id', needId),
  ]);
  return { needs: needs.data?.length ?? 0, responses: responses.data?.length ?? 0, images: images.data?.length ?? 0 };
}
async function readyImage(member: Awaited<ReturnType<typeof actor>>, needId: string) {
  const prepared = await member.client.rpc('prepare_item_need_image', { p_intent_id: randomUUID(), p_need_id: needId, p_image_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  assert.equal(prepared.error, null);
  assert.equal((await member.client.storage.from('item-need-images').upload(prepared.data.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.equal((await member.client.rpc('complete_item_need_image', { p_intent_id: randomUUID(), p_image_id: prepared.data.id })).error, null);
  return { id: prepared.data.id as string, path: prepared.data.object_path as string };
}

test('Active members read the need, responses, and image; inactive, outsider, foreign administrator, and anonymous actors read nothing', async () => {
  const f = await itemNeedFixture('need-rls-read');
  await respondToNeed(f.alice, f.need.id, f.listing.id);
  const image = await readyImage(f.bob, f.need.id);
  const outsider = await actor({ label: 'need-rls-outsider' });
  const foreign = await foreignAdministrator('need-rls-foreign');
  const seen: Record<string, unknown> = {
    bob: await visible(f.bob.client, f.need.id), alice: await visible(f.alice.client, f.need.id), carol: await visible(f.carol.client, f.need.id), administrator: await visible(f.owner.client, f.need.id),
    outsider: await visible(outsider.client, f.need.id), foreignAdministrator: await visible(foreign.client, f.need.id), anonymous: await visible(publicClient(), f.need.id),
  };
  for (const client of [f.carol.client, f.alice.client]) assert.equal((await client.storage.from('item-need-images').download(image.path)).error, null);
  for (const client of [outsider.client, foreign.client, publicClient()]) {
    assert.ok((await client.storage.from('item-need-images').download(image.path)).error);
    assert.ok((await client.storage.from('item-need-images').createSignedUrl(image.path, 30)).error);
  }
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.carol.id)).error, null);
    seen[`carol-${status}`] = await visible(f.carol.client, f.need.id);
    assert.ok((await f.carol.client.storage.from('item-need-images').download(image.path)).error, status);
  }
  const publicRead = await fetch(`${process.env.VITE_SUPABASE_URL}/storage/v1/object/public/item-need-images/${image.path}`);
  assert.equal(publicRead.ok, false);
  const active = { needs: 1, responses: 1, images: 1 }; const hidden = { needs: 0, responses: 0, images: 0 };
  assert.deepEqual(seen, {
    bob: active, alice: active, carol: active, administrator: active, outsider: hidden, foreignAdministrator: hidden, anonymous: hidden,
    'carol-pending': hidden, 'carol-rejected': hidden, 'carol-suspended': hidden, 'carol-removed': hidden,
  });
  receipt('issue-11-rls-reads', { seen, publicRead: publicRead.status });
});

test('Guessed, foreign-Community, other members\', and withdrawn Listings cannot be linked, and all share one denial', async () => {
  const f = await itemNeedFixture('need-rls-links');
  const foreign = await foreignAdministrator('need-rls-link-foreign');
  const foreignListing = await publishDrill(foreign, foreign.communityId, { ...drillDetails, title: 'Foreign drill' });
  const respond = (client: Client, listingId: string, needId = f.need.id) => client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: needId, p_listing_id: listingId, p_note: '' });
  const denials = {
    guessed: (await respond(f.alice.client, randomUUID())).error,
    otherMember: (await respond(f.carol.client, f.listing.id)).error,
    foreignCommunity: (await respond(foreign.client, foreignListing.id)).error,
  };
  assert.deepEqual(Object.values(denials).map(error => [error?.code, error?.message]), [
    ['42501', 'Choose one of your own Listings in this Community.'], ['42501', 'Choose one of your own Listings in this Community.'], ['42501', 'Current active Community membership is required.'],
  ]);
  const crossNeed = await postNeed(foreign, foreign.communityId, needDetails({ title: 'Foreign need' }));
  assert.equal((await respond(f.alice.client, f.listing.id, crossNeed.id)).error?.code, '42501');
  assert.equal((await respond(f.alice.client, f.listing.id, randomUUID())).error?.code, '42501');
  assert.equal((await f.alice.client.from('item_need_responses').insert({ community_id: f.community.id, need_id: f.need.id, listing_id: foreignListing.id, responder_id: f.alice.id })).error?.code, '42501');
  const response = await respondToNeed(f.alice, f.need.id, f.listing.id);
  assert.equal((await f.alice.client.rpc('withdraw_listing', { p_intent_id: randomUUID(), p_listing_id: f.listing.id, p_expected_version: 1 })).error, null);
  assert.deepEqual((await f.bob.client.from('item_need_responses').select('id').eq('need_id', f.need.id)).data, []);
  assert.deepEqual((await f.alice.client.from('item_need_responses').select('id').eq('need_id', f.need.id)).data, [{ id: response.id }]);
  const persisted = await admin.from('item_need_responses').select('listing_id').eq('need_id', f.need.id);
  assert.deepEqual(persisted.data, [{ listing_id: f.listing.id }]);
  receipt('issue-11-rls-links', { denials, hiddenAfterListingWithdrawal: true });
});

test('Unauthorized edits, direct table writes, revoked authors, and image uploads are denied through ordinary credentials', async () => {
  const f = await itemNeedFixture('need-rls-edit');
  const foreign = await foreignAdministrator('need-rls-edit-foreign');
  const edit = (client: Client) => client.rpc('save_item_need', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_need_id: f.need.id, p_expected_version: 1, p_details: needDetails({ title: 'Hijacked' }) });
  for (const client of [f.carol.client, f.alice.client, foreign.client, publicClient()]) {
    assert.equal((await edit(client)).error?.code, '42501');
    assert.equal((await client.rpc('withdraw_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_expected_version: 1 })).error?.code, '42501');
    assert.equal((await client.rpc('prepare_item_need_image', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_image_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: 10 })).error?.code, '42501');
  }
  assert.equal((await f.carol.client.from('item_need_posts').update({ title: 'Hijacked' }).eq('id', f.need.id)).error?.code, '42501');
  assert.equal((await f.bob.client.from('item_need_posts').insert({ community_id: f.community.id, author_id: f.bob.id, title: 'Forged', description: 'x', category: 'tools', starts_on: '2027-01-01', ends_on: '2027-01-02', urgency: 'soon' })).error?.code, '42501');
  assert.equal((await f.bob.client.from('item_need_images').insert({ id: randomUUID(), need_id: f.need.id, object_path: 'forged', mime_type: 'image/png', byte_size: 10 })).error?.code, '42501');

  const prepared = await f.bob.client.rpc('prepare_item_need_image', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_image_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  assert.equal(prepared.error, null);
  assert.ok((await f.carol.client.storage.from('item-need-images').upload(prepared.data.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  assert.ok((await f.bob.client.storage.from('item-need-images').upload(`${f.community.id}/${f.need.id}/${randomUUID()}`, listingImageBytes, { contentType: 'image/png' })).error);
  assert.equal((await f.bob.client.storage.from('item-need-images').upload(prepared.data.object_path, listingImageBytes, { contentType: 'image/png' })).error, null);
  assert.ok((await f.carol.client.storage.from('item-need-images').download(prepared.data.object_path)).error, 'pending image stays private to the author');
  assert.equal((await f.owner.client.storage.from('item-need-images').download(prepared.data.object_path)).error, null);

  const intent = randomUUID();
  const save = () => f.bob.client.rpc('save_item_need', { p_intent_id: intent, p_community_id: f.community.id, p_need_id: null, p_expected_version: 0, p_details: needDetails({ title: 'Second need' }) });
  assert.equal((await save()).error, null);
  await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  assert.equal((await save()).error?.code, '42501');
  assert.equal((await edit(f.bob.client)).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('complete_item_need_image', { p_intent_id: randomUUID(), p_image_id: prepared.data.id })).error?.code, '42501');
  assert.ok((await f.bob.client.storage.from('item-need-images').download(prepared.data.object_path)).error);
  assert.equal((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: '' })).error, null);
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.alice.id);
  assert.equal((await f.alice.client.rpc('respond_to_item_need', { p_intent_id: randomUUID(), p_need_id: f.need.id, p_listing_id: f.listing.id, p_note: 'again' })).error?.code, '42501');
  const unchanged = await admin.from('item_need_posts').select('title,version').eq('id', f.need.id).single();
  assert.deepEqual(unchanged.data, { title: needDetails().title, version: 1 });
  receipt('issue-11-rls-edits', { unchanged: unchanged.data, suspendedAuthor: '42501', removedResponder: '42501' });
});

test('Realtime delivers Need Post events by identity to active members only', async () => {
  const f = await itemNeedFixture('need-rls-realtime');
  await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', f.carol.id);
  const outsider = await actor({ label: 'need-rt-outsider' });
  const foreign = await foreignAdministrator('need-rt-foreign');
  const actors = [f.alice, f.carol, outsider, foreign, { client: publicClient() }];
  const deliveries: Record<string, unknown>[] = actors.map(() => ({}));
  const channels = await Promise.all(actors.map(async (member, index) => {
    const session = await member.client.auth.getSession();
    if (session.data.session) await member.client.realtime.setAuth(session.data.session.access_token);
    const channel = member.client.channel(`item-need-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (change.new.kind === 'item_need_published') deliveries[index] = change.new; });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    await postNeed(f.bob, f.community.id, needDetails({ title: 'Ladder for gutters' }));
    const deadline = Date.now() + 10000;
    while (!deliveries[0].id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(deliveries[0].kind, 'item_need_published');
    assert.deepEqual(Object.keys(deliveries[0]).sort(), ['actor_id', 'community_id', 'created_at', 'id', 'intent_id', 'kind']);
    assert.deepEqual(deliveries.slice(1), actors.slice(1).map(() => ({})));
    receipt('issue-11-realtime', deliveries);
  } finally {
    await Promise.all(actors.map((member, index) => member.client.removeChannel(channels[index])));
    actors.forEach(member => member.client.realtime.disconnect());
  }
});
