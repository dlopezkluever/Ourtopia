import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { actor, admin, borrowingFixture, completedItemFixture, handoffFixture, listingImageBytes, messageEvidenceFixture, prepareListingImage, publicClient, realtimeReady, receipt, settleFixtureNotices, uploadListingImage } from '../../scripts/verify/backend';

const suiteStarted = new Date().toISOString();
after(() => settleFixtureNotices(['moderation-rls-open', 'moderation-rls-closed'], suiteStarted));
before(() => realtimeReady(), { timeout: 70000 });

const suspend = (moderator: Awaited<ReturnType<typeof actor>>, communityId: string, userId: string, action = 'suspend') =>
  moderator.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: communityId, p_user_id: userId, p_action: action, p_reason: 'Actor matrix fixture.' });

test('Before and after suspension, direct reads follow the current lifecycle scope for each actor', async () => {
  const f = await handoffFixture('moderation-rls-open');
  const outsider = await actor({ label: 'moderation-outsider' });
  const beforeSuspension = await f.bob.client.from('listings').select('id').eq('community_id', f.community.id);
  assert.equal(beforeSuspension.data?.length, 1);
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  assert.deepEqual((await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data, []);
  assert.equal((await f.bob.client.from('exchanges').select('id').eq('id', f.exchangeId)).data?.length, 1);
  assert.deepEqual((await outsider.client.from('exchanges').select('id').eq('id', f.exchangeId)).data, []);
  assert.deepEqual((await f.owner.client.from('moderation_actions').select('id').eq('community_id', f.community.id).eq('subject_user_id', f.alice.id)).data, []);
  receipt('issue-20-rls-open', { suspendedBorrowerExchangeReads: 1 });
});

test('Completed Exchange access ends 30 days after completion for a suspended participant, and a removed participant keeps only the narrow channel', async () => {
  const recent = await completedItemFixture('moderation-rls-open', 1);
  const aged = await completedItemFixture('moderation-rls-closed', 31);
  assert.equal((await suspend(recent.owner, recent.community.id, recent.bob.id, 'remove')).error, null);
  assert.equal((await suspend(aged.owner, aged.community.id, aged.bob.id, 'remove')).error, null);
  assert.equal((await recent.bob.client.from('exchanges').select('id').eq('id', recent.exchangeId)).data?.length, 1);
  assert.deepEqual((await aged.bob.client.from('exchanges').select('id').eq('id', aged.exchangeId)).data, []);
  assert.deepEqual((await aged.bob.client.from('communities').select('id').eq('id', aged.community.id)).data, []);
});

test('The affected member reads their own moderation reason; other members and nonparticipant administrators do not', async () => {
  const f = await handoffFixture('moderation-rls-audit');
  const bystander = await actor({ label: 'moderation-bystander' });
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  const ownRecords = await f.bob.client.from('moderation_actions').select('action,reason').eq('community_id', f.community.id);
  assert.deepEqual(ownRecords.data, [{ action: 'suspend', reason: 'Actor matrix fixture.' }]);
  assert.deepEqual((await bystander.client.from('moderation_actions').select('id')).data, []);
  assert.deepEqual((await f.owner.client.from('moderation_actions').select('action').eq('community_id', f.community.id)).data, [{ action: 'suspend' }]);
});

test('Suspension inserts a membership access hint that only the affected member can read', async () => {
  const f = await handoffFixture('moderation-rls-hints');
  const bystander = await actor({ label: 'moderation-hint-bystander' });
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  const hints = await f.bob.client.from('membership_access_hints').select('community_id').eq('community_id', f.community.id);
  assert.ok((hints.data?.length ?? 0) >= 1);
  assert.deepEqual((await bystander.client.from('membership_access_hints').select('id').eq('community_id', f.community.id)).data, []);
  assert.deepEqual((await admin.from('notification_outbox').select('channel').eq('recipient_id', f.bob.id).eq('kind', 'membership_suspended')).data?.map(row => row.channel).sort(), ['email', 'in_app']);
});

test('Suspended and removed members lose Storage signed URLs and uploads; active members keep them', async () => {
  const f = await borrowingFixture('moderation-storage');
  const ready = await uploadListingImage(f.alice, f.listing.id);
  const pending = await prepareListingImage(f.alice, f.listing.id);
  assert.equal((await f.bob.client.storage.from('listing-images').createSignedUrl(ready.object_path, 30)).error, null);
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  assert.ok((await f.bob.client.storage.from('listing-images').createSignedUrl(ready.object_path, 30)).error);
  assert.equal((await f.alice.client.storage.from('listing-images').createSignedUrl(ready.object_path, 30)).error, null);
  assert.equal((await suspend(f.owner, f.community.id, f.alice.id, 'remove')).error, null);
  assert.ok((await f.alice.client.storage.from('listing-images').createSignedUrl(ready.object_path, 30)).error);
  assert.ok((await f.alice.client.storage.from('listing-images').upload(pending.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  receipt('issue-20-storage', { denied: 'signed-url and upload after suspension or removal' });
});

test('Realtime delivers community events to active members and administrators, never to suspended or removed members', async () => {
  const f = await handoffFixture('moderation-realtime');
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id)).error, null);
  const members = [f.owner, f.alice, f.bob, { client: publicClient() }];
  const deliveries: string[] = members.map(() => '');
  const channels = await Promise.all(members.map(async (member, index) => {
    const session = await member.client.auth.getSession();
    if (session.data.session) await member.client.realtime.setAuth(session.data.session.access_token);
    const kind = `moderation-realtime-${randomUUID()}`;
    const channel = member.client.channel(kind).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (change.new.kind === 'realtime_probe') deliveries[index] = change.new.id as string; });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return channel;
  }));
  try {
    const probe = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, intent_id: randomUUID(), kind: 'realtime_probe' }).select('id').single();
    assert.equal(probe.error, null);
    const deadline = Date.now() + 10000;
    while (!deliveries[0] && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(deliveries[0], probe.data.id);
    assert.equal(deliveries[1], probe.data.id);
    assert.equal(deliveries[2], '');
    assert.equal(deliveries[3], '');
    receipt('issue-20-realtime', { delivered: ['owner', 'active-member'], denied: ['suspended-member', 'anonymous'] });
  } finally {
    await Promise.all(channels.map((channel, index) => members[index].client.removeChannel(channel)));
    members.forEach(member => member.client.realtime.disconnect());
  }
});

test('Exact 30-day expiry: a removed participant keeps a completed Exchange just inside the window and loses it just outside', async () => {
  const inside = await completedItemFixture('moderation-boundary-inside', 30 - 1 / 1440);
  const outside = await completedItemFixture('moderation-boundary-outside', 30 + 1 / 1440);
  assert.equal((await suspend(inside.owner, inside.community.id, inside.bob.id, 'remove')).error, null);
  assert.equal((await suspend(outside.owner, outside.community.id, outside.bob.id, 'remove')).error, null);
  assert.equal((await inside.bob.client.from('exchanges').select('id').eq('id', inside.exchangeId)).data?.length, 1);
  assert.deepEqual((await outside.bob.client.from('exchanges').select('id').eq('id', outside.exchangeId)).data, []);
});

test('An open Dispute keeps a removed participant past 30 days, and closing it ends the last obligation access', async () => {
  const aged = await completedItemFixture('moderation-open-dispute', 31);
  const opened = await admin.from('disputes').insert({ exchange_id: aged.exchangeId, community_id: aged.community.id, reporter_id: aged.bob.id, respondent_id: aged.alice.id, issue_type: 'damage', status: 'issue_reported' }).select('id').single();
  assert.equal(opened.error, null);
  assert.equal((await suspend(aged.owner, aged.community.id, aged.bob.id, 'remove')).error, null);
  assert.equal((await aged.bob.client.from('exchanges').select('id').eq('id', aged.exchangeId)).data?.length, 1);
  const closed = await admin.from('disputes').update({ status: 'resolved', closed_at: new Date().toISOString() }).eq('id', opened.data.id);
  assert.equal(closed.error, null);
  assert.deepEqual((await aged.bob.client.from('exchanges').select('id').eq('id', aged.exchangeId)).data, []);
});

test('A removed counterparty cannot send messages in a conversation, even one tied to an eligible Dispute', async () => {
  const f = await messageEvidenceFixture('moderation-readonly');
  assert.equal((await suspend(f.owner, f.community.id, f.bob.id, 'remove')).error, null);
  const attemptedAt = new Date().toISOString();
  const sent = await f.bob.client.rpc('send_message', { p_intent_id: randomUUID(), p_conversation_id: f.conversation.id, p_body: 'Still there?' });
  assert.ok(sent.error);
  assert.deepEqual((await admin.from('messages').select('id').eq('conversation_id', f.conversation.id).eq('author_id', f.bob.id).gte('created_at', attemptedAt)).data, []);
});
