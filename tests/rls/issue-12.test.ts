import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptHelp, actor, admin, anonKey, applyInvite, backendUrl, commitHelp, createCommunity, createHelpPost, helpFixture, helpListingFields, helpNeedFields, helpScheduleFields, issueInvite, publicClient, realtimeReady, receipt } from '../../scripts/verify/backend';
import { helpExchangeSchema, helpPostDetailSchema } from '../../src/features/help/model';

before(() => realtimeReady(), { timeout: 70000 });

type Person = { client: ReturnType<typeof publicClient> };

async function scenario(label: string) {
  const f = await helpFixture(label, 4);
  const [first, second, unrelated, offerer] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const needExchange = await acceptHelp(f.author, await commitHelp(first, 'need_post', need.id, 'Private note from first'));
  assert.equal((await first.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: needExchange.id, p_fields: helpScheduleFields({ meeting_point: 'Private gate code 4471' }) })).error, null);
  const listing = await createHelpPost(offerer, f.community.id, 'listing', helpListingFields());
  const listingExchange = await acceptHelp(offerer, await commitHelp(second, 'listing', listing.id, 'Private note from second'));
  const pendingCommitment = await commitHelp(second, 'need_post', need.id, 'Waiting');
  return { ...f, first, second, unrelated, offerer, need, needExchange, listing, listingExchange, pendingCommitment };
}

async function privateRows(person: Person, s: Awaited<ReturnType<typeof scenario>>) {
  const ids = [s.needExchange.id, s.listingExchange.id];
  const count = async (query: PromiseLike<{ data: unknown[] | null }>) => (await query).data?.length ?? 0;
  return {
    exchanges: await count(person.client.from('exchanges').select('id').in('id', ids)),
    exchangeEvents: await count(person.client.from('exchange_events').select('id').in('exchange_id', ids)),
    details: await count(person.client.from('help_exchange_details').select('exchange_id').in('exchange_id', ids)),
    slots: await count(person.client.from('help_slots').select('id').eq('need_post_id', s.need.id)),
    commitments: await count(person.client.from('help_commitments').select('id').eq('community_id', s.community.id)),
    helpAudit: await count(person.client.from('community_events').select('id').eq('community_id', s.community.id).in('kind', ['help_commitment_offered', 'help_commitment_accepted', 'help_scheduled', 'help_cancelled'])),
  };
}

test('foreign, nonparticipant, nonparticipant administrator, pending, and anonymous actors cannot read or change private help records', async () => {
  const s = await scenario('privacy');
  const foreign = await actor({ label: 'foreign' });
  assert.equal((await createCommunity(foreign.client)).error, null);
  const pending = await actor({ label: 'pending' });
  await applyInvite(pending, (await issueInvite(s.owner, s.community.id, pending.email)).id);
  const anon = { client: publicClient() };
  const none = { exchanges: 0, exchangeEvents: 0, details: 0, slots: 0, commitments: 0, helpAudit: 0 };
  const denied: Record<string, unknown> = {};
  for (const [name, person] of Object.entries({ unrelated: s.unrelated, administrator: s.owner, foreign, pending, anon })) {
    assert.deepEqual(await privateRows(person, s), none, `${name} reads no private help rows`);
    const codes = {
      accept: (await person.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: s.pendingCommitment })).error?.code,
      schedule: (await person.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: s.needExchange.id, p_fields: helpScheduleFields() })).error?.code,
      cancel: (await person.client.rpc('cancel_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: s.listingExchange.id, p_reason: 'Not mine' })).error?.code,
      editOthers: (await person.client.rpc('edit_help_post', { p_intent_id: randomUUID(), p_post_kind: 'need_post', p_post_id: s.need.id, p_fields: helpNeedFields(5) })).error?.code,
    };
    assert.deepEqual(codes, { accept: '42501', schedule: '42501', cancel: '42501', editOthers: '42501' }, `${name} cannot alter another helper's commitment`);
    denied[name] = codes;
  }
  for (const [name, person] of Object.entries({ foreign, pending, anon })) {
    assert.equal((await person.client.from('help_need_posts').select('id').eq('id', s.need.id)).data?.length ?? 0, 0, `${name} cannot browse posts`);
    assert.equal((await person.client.rpc('help_board', { p_community_id: s.community.id, p_search: '', p_post_kind: '', p_category: '' })).error?.code, '42501');
    assert.equal((await person.client.rpc('help_post', { p_post_kind: 'need_post', p_post_id: s.need.id })).error?.code, '42501');
    assert.equal((await person.client.rpc('commit_help', { p_intent_id: randomUUID(), p_post_kind: 'need_post', p_post_id: s.need.id, p_note: '' })).error?.code, '42501');
    assert.equal((await person.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: s.community.id, p_post_kind: 'listing', p_fields: helpListingFields() })).error?.code, '42501');
  }
  const bystander = helpPostDetailSchema.parse((await s.unrelated.client.rpc('help_post', { p_post_kind: 'need_post', p_post_id: s.need.id })).data);
  assert.deepEqual([bystander.post.id, bystander.exchanges, bystander.commitments, bystander.post.postKind === 'need_post' && bystander.post.openPlaces], [s.need.id, [], [], 1],
    'an unrelated member sees the post and remaining places but no helper logistics');
  assert.equal(JSON.stringify(bystander).includes('Private gate code 4471'), false);
  assert.equal((await s.unrelated.client.from('help_listings').select('id').eq('id', s.listing.id)).data?.length, 1);
  receipt('issue-12-rls-boundaries', { deniedActors: Object.keys(denied), denied, bystander: { exchanges: 0, commitments: 0, openPlaces: 1 } });
});

test('participants read only their own commitments, places, and schedule', async () => {
  const s = await scenario('participants');
  assert.deepEqual(await privateRows(s.first, s), { exchanges: 1, exchangeEvents: 2, details: 1, slots: 1, commitments: 1, helpAudit: 0 });
  assert.deepEqual(await privateRows(s.second, s), { exchanges: 1, exchangeEvents: 1, details: 1, slots: 0, commitments: 2, helpAudit: 0 });
  assert.deepEqual(await privateRows(s.offerer, s), { exchanges: 1, exchangeEvents: 1, details: 1, slots: 0, commitments: 1, helpAudit: 0 });
  assert.deepEqual(await privateRows(s.author, s), { exchanges: 1, exchangeEvents: 2, details: 1, slots: 1, commitments: 2, helpAudit: 0 });
  assert.deepEqual((await s.first.client.from('help_exchange_details').select('meeting_point').eq('exchange_id', s.needExchange.id)).data, [{ meeting_point: 'Private gate code 4471' }]);
  assert.deepEqual((await s.second.client.from('help_exchange_details').select('meeting_point').eq('exchange_id', s.needExchange.id)).data, []);
  const authorView = helpPostDetailSchema.parse((await s.author.client.rpc('help_post', { p_post_kind: 'need_post', p_post_id: s.need.id })).data);
  assert.deepEqual(authorView.commitments.map(row => [row.memberId, row.status]), [[s.second.id, 'pending'], [s.first.id, 'accepted']]);
  const secondView = helpPostDetailSchema.parse((await s.second.client.rpc('help_post', { p_post_kind: 'need_post', p_post_id: s.need.id })).data);
  assert.deepEqual([secondView.commitments.map(row => row.memberId), secondView.exchanges], [[s.second.id], []]);
  receipt('issue-12-rls-participants', { first: 'own only', second: 'own only', meetingPointToNonparticipant: 0 });
});

test('clients cannot write command-owned help state directly', async () => {
  const s = await scenario('writes');
  const attempts = {
    listingInsert: await s.first.client.from('help_listings').insert({ ...helpListingFields(), community_id: s.community.id, owner_id: s.first.id }),
    listingUpdate: await s.offerer.client.from('help_listings').update({ title: 'Changed' }).eq('id', s.listing.id),
    needUpdate: await s.author.client.from('help_need_posts').update({ helpers_needed: 9 }).eq('id', s.need.id),
    commitmentInsert: await s.unrelated.client.from('help_commitments').insert({ community_id: s.community.id, need_post_id: s.need.id, member_id: s.unrelated.id }),
    commitmentAccept: await s.author.client.from('help_commitments').update({ status: 'accepted' }).eq('id', s.pendingCommitment),
    slotInsert: await s.author.client.from('help_slots').insert({ need_post_id: s.need.id, community_id: s.community.id, place: 2, helper_id: s.second.id, exchange_id: s.listingExchange.id }),
    detailUpdate: await s.first.client.from('help_exchange_details').update({ meeting_point: 'Elsewhere' }).eq('exchange_id', s.needExchange.id),
    exchangeInsert: await s.first.client.from('exchanges').insert({ community_id: s.community.id, kind: 'help', provider_id: s.first.id, receiver_id: s.author.id, source_kind: 'need_post', source_id: s.need.id, state: 'committed' }),
    exchangeCancel: await s.first.client.from('exchanges').update({ state: 'cancelled' }).eq('id', s.needExchange.id),
    detailDelete: await s.first.client.from('help_exchange_details').delete().eq('exchange_id', s.needExchange.id),
  };
  const codes = Object.fromEntries(Object.entries(attempts).map(([key, value]) => [key, value.error?.code]));
  assert.deepEqual(codes, Object.fromEntries(Object.keys(attempts).map(key => [key, '42501'])));
  assert.deepEqual((await admin.from('exchanges').select('state').eq('id', s.needExchange.id)).data, [{ state: 'scheduled' }]);
  receipt('issue-12-rls-writes', codes);
});

test('a suspended or removed participant keeps only the open obligation and loses new help activity', async () => {
  const s = await scenario('obligation');
  for (const status of ['suspended', 'removed']) {
    const member = status === 'suspended' ? s.first : s.second;
    const exchange = status === 'suspended' ? s.needExchange : s.listingExchange;
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', s.community.id).eq('user_id', member.id)).error, null);
    assert.deepEqual((await member.client.from('exchanges').select('id,state').eq('id', exchange.id)).data, [{ id: exchange.id, state: status === 'suspended' ? 'scheduled' : 'committed' }]);
    assert.equal((await member.client.from('help_exchange_details').select('exchange_id').eq('exchange_id', exchange.id)).data?.length, 1);
    assert.equal((await member.client.from('help_listings').select('id').eq('community_id', s.community.id)).data?.length, 0, 'no broad browsing');
    assert.equal((await member.client.rpc('help_board', { p_community_id: s.community.id, p_search: '', p_post_kind: '', p_category: '' })).error?.code, '42501');
    assert.equal((await member.client.rpc('create_help_post', { p_intent_id: randomUUID(), p_community_id: s.community.id, p_post_kind: 'listing', p_fields: helpListingFields() })).error?.code, '42501');
    assert.equal((await member.client.rpc('commit_help', { p_intent_id: randomUUID(), p_post_kind: 'listing', p_post_id: s.listing.id, p_note: '' })).error?.code, '42501');
    assert.equal((await member.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() })).error?.code, '42501');
    const mine = helpExchangeSchema.array().parse((await member.client.rpc('my_help_exchanges')).data);
    assert.deepEqual(mine.map(row => row.id), [exchange.id]);
    const view = helpPostDetailSchema.parse((await member.client.rpc('help_post', { p_post_kind: exchange.sourceKind, p_post_id: exchange.sourceId })).data);
    assert.deepEqual([view.viewerActive, view.commitments, view.exchanges.map(row => row.id)], [false, [], [exchange.id]]);
    const cancelled = await member.client.rpc('cancel_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_reason: `Cancelled while ${status}` });
    assert.equal(cancelled.error, null);
    assert.equal((await member.client.from('exchanges').select('id').eq('id', exchange.id)).data?.length, 0, 'closed obligation ends access');
    assert.equal((await member.client.rpc('help_post', { p_post_kind: exchange.sourceKind, p_post_id: exchange.sourceId })).error?.code, '42501');
  }
  assert.equal((await s.author.client.rpc('accept_help_commitment', { p_intent_id: randomUUID(), p_commitment_id: s.pendingCommitment })).error?.code, '42501', 'a removed committer cannot be accepted');
  receipt('issue-12-rls-obligation', { suspended: 'read + cancel own open obligation', removed: 'read + cancel own open obligation', newActivity: '42501' });
});

test('realtime delivers only identity hints to the counterparty and publishes no help detail rows', async () => {
  const s = await scenario('realtime');
  const listen = async (person: { id: string; client: ReturnType<typeof publicClient> }) => {
    const session = await person.client.auth.getSession();
    await person.client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
    const hints: Record<string, unknown>[] = [];
    const details: unknown[] = [];
    const channels = [
      person.client.channel(`help-hints-${randomUUID()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${s.offerer.id}` }, change => hints.push(change.new)),
      person.client.channel(`help-details-${randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'help_exchange_details' }, change => details.push(change)),
    ];
    for (const channel of channels) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Help channel did not subscribe.')), 20000);
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error(status)); }
      });
    });
    return { hints, details, close: async () => { await Promise.all(channels.map(channel => person.client.removeChannel(channel))); person.client.realtime.disconnect(); } };
  };
  const foreign = await actor({ label: 'help-rt-foreign' });
  await createCommunity(foreign.client);
  const pending = await actor({ label: 'help-rt-pending' });
  await applyInvite(pending, (await issueInvite(s.owner, s.community.id, pending.email)).id);
  assert.equal((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', s.community.id).eq('user_id', s.second.id)).error, null);
  const listeners: Record<string, Awaited<ReturnType<typeof listen>>> = {};
  try {
    for (const [name, person] of Object.entries({ participant: s.offerer, unrelated: s.unrelated, administrator: s.owner, foreign, pending, inactive: s.second, anonymous: { id: randomUUID(), client: publicClient() } })) {
      listeners[name] = await listen(person);
    }
    const participant = listeners.participant;
    const commitment = await commitHelp(s.first, 'listing', s.listing.id);
    const exchange = await acceptHelp(s.offerer, commitment);
    assert.equal((await s.first.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() })).error, null);
    const deadline = Date.now() + 15000;
    while (participant.hints.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(participant.hints.length >= 2, 'offer and schedule each hint the listing owner');
    assert.ok(participant.hints.every(hint => JSON.stringify(Object.keys(hint).sort()) === '["id","recipient_id"]'));
    for (const [name, listener] of Object.entries(listeners)) {
      assert.equal(listener.details.length, 0, `${name} receives no detail events`);
      if (name !== 'participant') assert.equal(listener.hints.length, 0, `${name} receives no counterparty hints`);
    }
    receipt('issue-12-rls-realtime', { backend: backendUrl, actors: Object.fromEntries(Object.entries(listeners).map(([name, listener]) => [name, { hints: listener.hints.length, details: listener.details.length }])), hintKeys: ['id', 'recipient_id'] });
  } finally { await Promise.all(Object.values(listeners).map(listener => listener.close())); }
});
