import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptHelp, admin, commitHelp, createHelpPost, helpFixture, helpListingFields, helpNeedFields, helpScheduleFields, receipt } from '../../scripts/verify/backend';
import { helpExchangeSchema, helpPostDetailSchema, helpPostSchema } from '../../src/features/help/model';
import { deliverOne } from '../../supabase/functions/notifications/worker';

type Member = Awaited<ReturnType<typeof helpFixture>>['author'];

const board = async (member: Member, communityId: string, search = '', kind = '', category = '') => {
  const result = await member.client.rpc('help_board', { p_community_id: communityId, p_search: search, p_post_kind: kind, p_category: category });
  assert.equal(result.error, null);
  return helpPostSchema.array().parse(result.data);
};
const detail = async (member: Member, kind: 'listing' | 'need_post', postId: string) => {
  const result = await member.client.rpc('help_post', { p_post_kind: kind, p_post_id: postId });
  assert.equal(result.error, null);
  return helpPostDetailSchema.parse(result.data);
};
const openPlaces = async (member: Member, postId: string) => {
  const post = (await detail(member, 'need_post', postId)).post;
  assert.equal(post.postKind, 'need_post');
  return post.postKind === 'need_post' ? post.openPlaces : -1;
};
const schedule = (member: Member, exchangeId: string, fields: Record<string, unknown> = helpScheduleFields(), intent = randomUUID()) =>
  member.client.rpc('schedule_help_exchange', { p_intent_id: intent, p_exchange_id: exchangeId, p_fields: fields });
const cancel = (member: Member, exchangeId: string, reason: string, intent = randomUUID()) =>
  member.client.rpc('cancel_help_exchange', { p_intent_id: intent, p_exchange_id: exchangeId, p_reason: reason });
const reputation = async (ids: string[]) => ({
  events: (await admin.from('reputation_events').select('id').in('recipient_id', ids)).data?.length,
  interactions: (await admin.from('qualifying_interactions').select('id').in('participant_id', ids)).data?.length,
});

test('Help Listings and Need Posts are created, edited, withdrawn, browsed, searched, and filtered in their Community', async () => {
  const f = await helpFixture('board', 1);
  const [member] = f.members;
  const intent = randomUUID();
  const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields(), intent);
  assert.deepEqual(await createHelpPost(f.author, f.community.id, 'listing', helpListingFields(), intent), listing, 'same intent and payload replays');
  assert.equal((await f.author.client.rpc('create_help_post', { p_intent_id: intent, p_community_id: f.community.id, p_post_kind: 'listing', p_fields: helpListingFields({ title: 'Changed title' }) })).error?.code, '23505');
  const need = await createHelpPost(member, f.community.id, 'need_post', helpNeedFields(2));
  assert.equal(listing.postKind, 'listing');
  assert.deepEqual({ ...listing, id: undefined, createdAt: undefined, updatedAt: undefined }, {
    postKind: 'listing', id: undefined, communityId: f.community.id, ownerId: f.author.id, ownerEmail: f.author.email, title: 'Moving help with a van',
    description: 'I can lift and drive.', category: 'moving', skill: 'Lifting and van driving', skillLevel: 'experienced', availability: 'Weekend mornings',
    geographicConstraints: 'Within 3 miles of Maple Street', schedulingPreferences: 'Two days notice', status: 'open', createdAt: undefined, updatedAt: undefined,
  });
  assert.equal(need.postKind === 'need_post' && need.helpersNeeded, 2);
  assert.equal(need.postKind === 'need_post' && need.openPlaces, 2);
  assert.deepEqual((await board(member, f.community.id)).map(post => post.id), [need.id, listing.id]);
  assert.deepEqual((await board(member, f.community.id, 'van')).map(post => post.id), [listing.id]);
  assert.deepEqual((await board(member, f.community.id, 'maple street')).map(post => post.id), [need.id, listing.id], 'search covers area and location');
  assert.deepEqual((await board(member, f.community.id, '', 'need_post')).map(post => post.id), [need.id]);
  assert.deepEqual((await board(member, f.community.id, '', '', 'tutoring')).map(post => post.id), []);
  assert.deepEqual((await board(member, f.community.id, '100%')).map(post => post.id), [], 'search wildcards are literal');

  const edited = await f.author.client.rpc('edit_help_post', { p_intent_id: randomUUID(), p_post_kind: 'listing', p_post_id: listing.id, p_fields: helpListingFields({ title: 'Algebra tutoring', category: 'tutoring', skill: 'High school algebra', skill_level: 'professional' }) });
  assert.equal(edited.error, null);
  assert.deepEqual((await board(member, f.community.id, '', '', 'tutoring')).map(post => [post.id, post.title]), [[listing.id, 'Algebra tutoring']]);
  assert.equal((await member.client.rpc('edit_help_post', { p_intent_id: randomUUID(), p_post_kind: 'listing', p_post_id: listing.id, p_fields: helpListingFields() })).error?.code, '42501', 'only the author edits');

  const invalid = {
    missingSkill: (await f.author.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'listing', p_fields: helpListingFields({ skill: '' }) })).error?.code,
    pastNeed: (await f.author.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'need_post', p_fields: helpNeedFields(2, { starts_at: new Date(Date.now() - 60000).toISOString() }) })).error?.code,
    zeroHelpers: (await f.author.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'need_post', p_fields: helpNeedFields(0) })).error?.code,
    fractionalDuration: (await f.author.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'need_post', p_fields: helpNeedFields(2, { duration_minutes: 'long' }) })).error?.code,
    badKind: (await f.author.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: 'item', p_fields: helpListingFields() })).error?.code,
  };
  assert.deepEqual(invalid, { missingSkill: '22023', pastNeed: '22023', zeroHelpers: '22023', fractionalDuration: '22023', badKind: '22023' });

  assert.equal((await f.author.client.rpc('withdraw_help_post', { p_intent_id: randomUUID(), p_post_kind: 'listing', p_post_id: listing.id })).error, null);
  assert.deepEqual((await board(member, f.community.id)).map(post => post.id), [need.id]);
  assert.equal((await detail(member, 'listing', listing.id)).post.status, 'withdrawn');
  assert.equal((await member.client.rpc('commit_help', { p_intent_id: randomUUID(), p_post_kind: 'listing', p_post_id: listing.id, p_note: '' })).error?.code, '55000');
  assert.equal((await f.author.client.rpc('edit_help_post', { p_intent_id: randomUUID(), p_post_kind: 'listing', p_post_id: listing.id, p_fields: helpListingFields() })).error?.code, '55000');
  const audit = await admin.from('community_events').select('kind').eq('community_id', f.community.id).like('kind', 'help_post_%').order('created_at');
  assert.deepEqual(audit.data?.map(row => row.kind), ['help_post_created', 'help_post_created', 'help_post_edited', 'help_post_withdrawn']);
  receipt('issue-12-posts', { listing: listing.id, need: need.id, invalid, audit: audit.data });
});

test('Help Listing owner acceptance creates one committed help Exchange with the owner as helper and committer as requester', async () => {
  const f = await helpFixture('listing-accept', 2);
  const [requester, bystander] = f.members;
  const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields());
  const commitment = await commitHelp(requester, 'listing', listing.id, 'Saturday works for me.');
  assert.equal((await requester.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: commitment })).error?.code, '42501', 'committer cannot accept');
  assert.equal((await bystander.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: commitment })).error?.code, '42501', 'unrelated member cannot accept');
  const intent = randomUUID();
  const exchange = await acceptHelp(f.author, commitment, intent);
  assert.deepEqual(await acceptHelp(f.author, commitment, intent), exchange, 'retry returns the prior result');
  const other = await commitHelp(bystander, 'listing', listing.id);
  assert.equal((await f.author.client.rpc('accept_help_commitment', { p_intent_id: intent, p_commitment_id: other })).error?.code, '23505');
  assert.deepEqual({ state: exchange.state, helperId: exchange.helperId, requesterId: exchange.requesterId, sourceKind: exchange.sourceKind, sourceId: exchange.sourceId, place: exchange.place, communityId: exchange.communityId },
    { state: 'committed', helperId: f.author.id, requesterId: requester.id, sourceKind: 'listing', sourceId: listing.id, place: null, communityId: f.community.id });
  const row = await admin.from('exchanges').select('community_id,kind,provider_id,receiver_id,source_kind,source_id,state').eq('source_id', listing.id);
  assert.deepEqual(row.data, [{ community_id: f.community.id, kind: 'help', provider_id: f.author.id, receiver_id: requester.id, source_kind: 'listing', source_id: listing.id, state: 'committed' }]);
  assert.deepEqual((await admin.from('help_commitments').select('status,exchange_id').eq('id', commitment)).data, [{ status: 'accepted', exchange_id: exchange.id }]);
  assert.deepEqual((await admin.from('help_slots').select('id').eq('exchange_id', exchange.id)).data, []);
  const events = await admin.from('exchange_events').select('kind,actor_id').eq('exchange_id', exchange.id);
  assert.deepEqual(events.data, [{ kind: 'help_committed', actor_id: f.author.id }]);
  const outbox = await admin.from('notification_outbox').select('id,recipient_id,channel,kind').eq('community_id', f.community.id).like('kind', 'help_%').order('kind').order('channel');
  assert.deepEqual(outbox.data?.map(({ recipient_id, channel, kind }) => [kind, channel, recipient_id]), [
    ['help_commitment_accepted', 'email', requester.id], ['help_commitment_accepted', 'in_app', requester.id],
    ['help_commitment_offered', 'email', f.author.id], ['help_commitment_offered', 'in_app', f.author.id],
    ['help_commitment_offered', 'email', f.author.id], ['help_commitment_offered', 'in_app', f.author.id],
  ]);
  const inApp = outbox.data?.find(item => item.kind === 'help_commitment_accepted' && item.channel === 'in_app');
  assert.ok(inApp);
  const delivered = await deliverOne(admin, async () => { throw new Error('No email on in-app delivery.'); }, inApp.id);
  assert.equal((delivered as { state: string }).state, 'delivered');
  assert.deepEqual((await requester.client.from('notifications').select('kind').eq('outbox_id', inApp.id)).data, [{ kind: 'help_commitment_accepted' }]);
  assert.deepEqual(await reputation([f.author.id, requester.id]), { events: 0, interactions: 0 });
  receipt('issue-12-listing-acceptance', { exchange, outbox: outbox.data?.length, notice: 'delivered' });
});

test('a two-helper Need Post accepts helpers independently, schedules one, and cancellation reopens only that place without points', async () => {
  const f = await helpFixture('need', 3);
  const [first, second, third] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const [c1, c2, c3] = [await commitHelp(first, 'need_post', need.id), await commitHelp(second, 'need_post', need.id), await commitHelp(third, 'need_post', need.id)];
  const e1 = await acceptHelp(f.author, c1);
  assert.deepEqual([e1.place, e1.helperId, e1.requesterId, e1.state, await openPlaces(f.author, need.id)], [1, first.id, f.author.id, 'committed', 1], 'one place stays open');
  const e2 = await acceptHelp(f.author, c2);
  assert.deepEqual([e2.place, await openPlaces(second, need.id)], [2, 0]);
  assert.equal((await f.author.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: c3 })).error?.code, '55000', 'a full Need Post refuses a third helper');
  assert.deepEqual((await admin.from('help_commitments').select('status').eq('id', c3)).data, [{ status: 'pending' }]);

  const fields = helpScheduleFields();
  const scheduled = await schedule(first, e1.id, fields);
  assert.equal(scheduled.error, null);
  const view = helpExchangeSchema.parse(scheduled.data);
  assert.deepEqual([view.state, new Date(view.startsAt ?? '').toISOString(), view.durationMinutes, view.meetingPoint], ['scheduled', fields.starts_at, 90, 'Side gate on Maple Street']);
  assert.equal((await schedule(first, e1.id, helpScheduleFields({ starts_at: new Date(Date.now() - 1000).toISOString() }))).error?.code, '22023');
  assert.deepEqual((await admin.from('notification_outbox').select('recipient_id').eq('kind', 'help_scheduled').eq('channel', 'in_app').eq('community_id', f.community.id)).data, [{ recipient_id: f.author.id }]);
  const owned = await detail(f.author, 'need_post', need.id);
  assert.deepEqual(owned.exchanges.map(row => [row.helperId, row.place, row.state]), [[first.id, 1, 'scheduled'], [second.id, 2, 'committed']], 'per-helper status');

  assert.equal((await cancel(f.author, e1.id, '')).error?.code, '22023', 'a reason is required');
  const cancelled = await cancel(f.author, e1.id, 'The couch delivery moved to next month.');
  assert.equal(cancelled.error, null);
  assert.deepEqual([helpExchangeSchema.parse(cancelled.data).state, helpExchangeSchema.parse(cancelled.data).cancelReason], ['cancelled', 'The couch delivery moved to next month.']);
  assert.equal((await cancel(first, e1.id, 'again')).error?.code, '55000');
  assert.equal(await openPlaces(third, need.id), 1, 'only the cancelled place reopens');
  assert.deepEqual((await admin.from('exchanges').select('state').eq('id', e2.id)).data, [{ state: 'committed' }]);
  const e3 = await acceptHelp(f.author, c3);
  assert.deepEqual([e3.place, await openPlaces(f.author, need.id)], [1, 0], 'the reopened place is reused');
  const history = await admin.from('exchange_events').select('kind').eq('exchange_id', e1.id).order('created_at');
  assert.deepEqual(history.data?.map(row => row.kind), ['help_committed', 'help_scheduled', 'help_cancelled']);
  assert.deepEqual((await admin.from('help_slots').select('place,status,helper_id').eq('need_post_id', need.id).order('created_at')).data,
    [{ place: 1, status: 'closed', helper_id: first.id }, { place: 2, status: 'active', helper_id: second.id }, { place: 1, status: 'active', helper_id: third.id }]);
  assert.deepEqual(await reputation([f.author.id, first.id, second.id, third.id]), { events: 0, interactions: 0 }, 'no automatic points before completion');
  const profile = await second.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: first.id });
  assert.deepEqual((profile.data as { local: unknown }).local, { score: 50, completedInteractions: 0, title: 'Unproven' });
  receipt('issue-12-need-post', { need: need.id, exchanges: [e1.id, e2.id, e3.id], history: history.data, reputation: 'none' });
});

test('concurrent acceptances for the last places never exceed the requested helper count', async () => {
  const f = await helpFixture('race', 6);
  const results: Record<number, number> = {};
  for (const places of [1, 2]) {
    const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(places));
    const commitments = await Promise.all(f.members.map(member => commitHelp(member, 'need_post', need.id)));
    const raced = await Promise.all(commitments.map(id => f.author.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: id })));
    const winners = raced.filter(result => result.error === null);
    assert.equal(winners.length, places);
    assert.ok(raced.filter(result => result.error).every(result => result.error?.code === '55000'));
    assert.deepEqual((await admin.from('help_slots').select('place').eq('need_post_id', need.id).eq('status', 'active').order('place')).data, Array.from({ length: places }, (_, index) => ({ place: index + 1 })));
    assert.equal((await admin.from('exchanges').select('id').eq('source_id', need.id)).data?.length, places);
    results[places] = winners.length;
  }
  receipt('issue-12-race', { concurrentAcceptances: f.members.length, winners: results });
});

test('same-helper retries are idempotent, duplicate active places are impossible, and a cancelled place can be reused', async () => {
  const f = await helpFixture('retry', 1);
  const [helper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const intent = randomUUID();
  const commitment = await commitHelp(helper, 'need_post', need.id, '', intent);
  assert.equal(await commitHelp(helper, 'need_post', need.id, '', intent), commitment);
  assert.equal((await helper.client.rpc('commit_help', { p_intent_id: randomUUID(), p_post_kind: 'need_post', p_post_id: need.id, p_note: '' })).error?.code, '55000', 'one pending offer per post');
  const acceptIntent = randomUUID();
  const accepted = await Promise.all([0, 1, 2, 3].map(() => f.author.client.rpc('accept_help_commitment', { p_intent_id: acceptIntent, p_commitment_id: commitment })));
  assert.ok(accepted.every(result => result.error === null));
  assert.equal(new Set(accepted.map(result => helpExchangeSchema.parse(result.data).id)).size, 1);
  const exchange = helpExchangeSchema.parse(accepted[0].data);
  assert.equal((await helper.client.rpc('commit_help', { p_intent_id: randomUUID(), p_post_kind: 'need_post', p_post_id: need.id, p_note: '' })).error?.code, '55000', 'an active helper cannot offer again');
  const duplicate = await admin.from('help_slots').insert({ need_post_id: need.id, community_id: f.community.id, place: 2, helper_id: helper.id, exchange_id: exchange.id });
  assert.equal(duplicate.error?.code, '23505');
  const overflow = await admin.from('help_slots').insert({ need_post_id: need.id, community_id: f.community.id, place: 3, helper_id: f.author.id, exchange_id: exchange.id });
  assert.equal(overflow.error?.code, '23514');
  assert.equal((await cancel(helper, exchange.id, 'I have a conflict that day.')).error, null);
  const again = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id, 'Free again.'));
  assert.notEqual(again.id, exchange.id);
  const slots = await admin.from('help_slots').select('helper_id,status,exchange_id').eq('need_post_id', need.id).order('created_at');
  assert.deepEqual(slots.data, [{ helper_id: helper.id, status: 'closed', exchange_id: exchange.id }, { helper_id: helper.id, status: 'active', exchange_id: again.id }]);
  assert.deepEqual((await admin.from('exchanges').select('state').eq('source_id', need.id).order('created_at')).data, [{ state: 'cancelled' }, { state: 'committed' }]);
  assert.equal((await admin.from('help_slots').update({ status: 'active', closed_at: null }).eq('exchange_id', exchange.id)).error?.code, '23514', 'a closed place cannot reopen');
  receipt('issue-12-retries', { sameIntentAccepts: accepted.length, exchanges: 1, duplicateSlot: '23505', overflow: '23514', reused: again.id });
});

test('a Help Listing accepts several requesters without the Need Post slot cap', async () => {
  const f = await helpFixture('many', 4);
  const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields());
  const exchanges = [];
  for (const member of f.members) exchanges.push(await acceptHelp(f.author, await commitHelp(member, 'listing', listing.id)));
  assert.deepEqual(exchanges.map(row => [row.requesterId, row.helperId, row.state, row.place]), f.members.map(member => [member.id, f.author.id, 'committed', null]));
  assert.equal(new Set(exchanges.map(row => row.id)).size, 4);
  assert.equal((await admin.from('help_slots').select('id').in('exchange_id', exchanges.map(row => row.id))).data?.length, 0);
  receipt('issue-12-listing-requesters', { requesters: exchanges.length });
});

test('kind constraints reject item-only fields and states for help, and Community scope is immutable', async () => {
  const f = await helpFixture('kind', 1);
  const [member] = f.members;
  const listing = await createHelpPost(f.author, f.community.id, 'listing', helpListingFields());
  const exchange = await acceptHelp(f.author, await commitHelp(member, 'listing', listing.id));
  const rpc = (fields: Record<string, unknown>, kind = 'listing') => f.author.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_post_kind: kind, p_fields: fields });
  const rejected = {
    replacementValue: await rpc(helpListingFields({ replacement_value: 400 })),
    condition: await rpc(helpNeedFields(2, { condition: 'Like new' }), 'need_post'),
    handoff: await schedule(member, exchange.id, helpScheduleFields({ handoff_at: new Date().toISOString() })),
    returnField: await schedule(member, exchange.id, helpScheduleFields({ return: true })),
    photos: await rpc(helpListingFields({ photos: ['a.jpg'] })),
  };
  for (const result of Object.values(rejected)) {
    assert.equal(result.error?.code, '22023');
    assert.match(result.error?.message ?? '', /no item condition, replacement value, Handoff, Return, or photos/);
  }
  const itemState = await admin.from('exchanges').update({ state: 'checked_out' }).eq('id', exchange.id);
  const itemEvent = await admin.from('exchange_events').insert({ exchange_id: exchange.id, community_id: f.community.id, kind: 'handoff_recorded' });
  const item = await admin.from('exchanges').insert({ community_id: f.community.id, kind: 'item', provider_id: f.author.id, receiver_id: member.id, source_kind: 'listing', source_id: randomUUID(), state: 'approved' }).select('id').single();
  assert.equal(item.error, null);
  const commitment = (await admin.from('help_commitments').select('id').eq('exchange_id', exchange.id).single()).data?.id;
  const itemDetail = await admin.from('help_exchange_details').insert({ exchange_id: item.data?.id, community_id: f.community.id, commitment_id: commitment });
  const other = (await admin.from('communities').insert({ name: 'Other circle', created_by: f.owner.id }).select('id').single()).data?.id;
  const scope = {
    listing: (await admin.from('help_listings').update({ community_id: other }).eq('id', listing.id)).error?.code,
    exchange: (await admin.from('exchanges').update({ community_id: other }).eq('id', exchange.id)).error?.code,
    detail: (await admin.from('help_exchange_details').update({ community_id: other }).eq('exchange_id', exchange.id)).error?.code,
    commitment: (await admin.from('help_commitments').update({ community_id: other }).eq('id', commitment)).error?.code,
    deleteListing: (await admin.from('help_listings').delete().eq('id', listing.id)).error?.code,
    deleteDetail: (await admin.from('help_exchange_details').delete().eq('exchange_id', exchange.id)).error?.code,
  };
  assert.deepEqual({ itemState: itemState.error?.code, itemEvent: itemEvent.error?.code, itemDetail: itemDetail.error?.code }, { itemState: '23514', itemEvent: '23514', itemDetail: '23514' });
  assert.deepEqual(scope, { listing: '42501', exchange: '42501', detail: '42501', commitment: '42501', deleteListing: '42501', deleteDetail: '42501' });
  assert.deepEqual((await admin.from('exchanges').select('state,community_id').eq('id', exchange.id)).data, [{ state: 'committed', community_id: f.community.id }]);
  receipt('issue-12-kind', { rejected: Object.fromEntries(Object.entries(rejected).map(([key, value]) => [key, value.error?.code])), itemState: '23514', itemEvent: '23514', itemDetail: '23514', scope });
});

test('a forced late audit collision rolls back the whole acceptance', async () => {
  const f = await helpFixture('rollback', 1);
  const [helper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1));
  const commitment = await commitHelp(helper, 'need_post', need.id);
  const intent = randomUUID();
  assert.equal((await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.author.id, intent_id: intent, kind: 'help_commitment_accepted' })).error, null);
  assert.equal((await f.author.client.rpc('accept_help_commitment', { p_intent_id: intent, p_commitment_id: commitment })).error?.code, '23505');
  const after = {
    exchanges: (await admin.from('exchanges').select('id').eq('source_id', need.id)).data?.length,
    slots: (await admin.from('help_slots').select('id').eq('need_post_id', need.id)).data?.length,
    commitment: (await admin.from('help_commitments').select('status').eq('id', commitment).single()).data?.status,
    intents: (await admin.from('command_intents').select('intent_id').eq('actor_id', f.author.id).eq('intent_id', intent)).data?.length,
    notices: (await admin.from('notification_outbox').select('id').eq('recipient_id', helper.id).eq('kind', 'help_commitment_accepted')).data?.length,
  };
  assert.deepEqual(after, { exchanges: 0, slots: 0, commitment: 'pending', intents: 0, notices: 0 });
  assert.equal((await acceptHelp(f.author, commitment)).place, 1, 'a fresh intent then succeeds');
  receipt('issue-12-rollback', after);
});
