import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { actor, activeMember, admin, membershipFixture, publicClient, realtimeReady, receipt, handoffFixture, advanceHandoff, handoffAction, itemHandoff, listingImageBytes } from '../../scripts/verify/backend';
import { evidenceSchema } from '../../src/features/handoff/model';

before(() => realtimeReady(), { timeout: 70000 });

test('Only the same currently active account and Community can restore or mutate drafts', async () => {
  const { owner, community } = await membershipFixture('draft-privacy');
  const author = await activeMember(owner, community.id, 'draft-author');
  const member = await activeMember(owner, community.id, 'draft-neighbor');
  const foreign = await membershipFixture('draft-foreign');
  const outsider = await actor({ label: 'draft-outsider' });
  const args = { p_intent_id: randomUUID(), p_owner_id: author.id, p_community_id: community.id, p_kind: 'help_offer', p_expected_revision: 0, p_action: 'save', p_fields: { title: 'Private unfinished help', description: 'Private notes' } };
  assert.equal((await author.client.rpc('command_contribution_draft', args)).error, null);
  assert.equal((await author.client.from('contribution_drafts').select('fields').eq('community_id', community.id)).data?.[0].fields.title, 'Private unfinished help');
  for (const client of [owner.client, member.client, foreign.owner.client, outsider.client, publicClient()]) {
    const read = await client.from('contribution_drafts').select('*').eq('owner_id', author.id); assert.deepEqual(read.data ?? [], []);
    assert.ok((await client.from('contribution_drafts').insert({ owner_id: author.id, community_id: community.id, kind: 'item', revision: 1, status: 'editing', fields: {} })).error);
    assert.ok((await client.from('contribution_drafts').update({ fields: { title: 'forged' } }).eq('owner_id', author.id)).error);
    assert.ok((await client.from('contribution_drafts').delete().eq('owner_id', author.id)).error);
    assert.deepEqual((await client.from('community_events').select('*').eq('actor_id', author.id).like('kind', 'contribution_draft_%')).data ?? [], []);
  }
  for (const client of [outsider.client, foreign.owner.client, publicClient()]) assert.equal((await client.rpc('command_contribution_draft', { ...args, p_intent_id: randomUUID() })).error?.code, '42501');
  assert.equal((await author.client.rpc('command_contribution_draft', { ...args, p_intent_id: randomUUID(), p_community_id: foreign.community.id })).error?.code, '42501');
  for (const status of ['pending', 'rejected', 'suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', community.id).eq('user_id', author.id)).error, null);
    assert.deepEqual((await author.client.from('contribution_drafts').select('*')).data, []);
    for (const action of ['save', 'publish', 'discard']) assert.equal((await author.client.rpc('command_contribution_draft', { ...args, p_action: action, p_intent_id: randomUUID(), p_expected_revision: 1 })).error?.code, '42501');
    assert.equal((await author.client.rpc('command_contribution_draft', args)).error?.code, '42501');
  }
  receipt('issue-24-draft-privacy', { ownActive: 'read allowed', sameCommunityAdministrator: 'no draft read', nonowner: 'no read or direct writes', foreign: '42501', inactive: ['pending', 'rejected', 'suspended', 'removed'], replayAfterRevocation: '42501' });
});

test('Draft bodies are never delivered through realtime even to other Community administrators', async () => {
  const { owner, community } = await membershipFixture('draft-realtime');
  const member = await activeMember(owner, community.id);
  const bodies: unknown[] = [];
  const channels = await Promise.all([owner, member].map(async person => {
    const { data } = await person.client.auth.getSession(); await person.client.realtime.setAuth(data.session!.access_token);
    const channel = person.client.channel(`draft-private-${randomUUID()}`).on('postgres_changes', { event: '*', schema: 'public', table: 'contribution_drafts' }, change => bodies.push(change));
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timed out')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    return { channel, person };
  }));
  try {
    assert.equal((await member.client.rpc('command_contribution_draft', { p_intent_id: randomUUID(), p_owner_id: member.id, p_community_id: community.id, p_kind: 'item', p_expected_revision: 0, p_action: 'save', p_fields: { title: 'Secret draft body' } })).error, null);
    await new Promise(resolve => setTimeout(resolve, 1500)); assert.deepEqual(bodies, []);
    receipt('issue-24-realtime', { draftBodyEvents: 0, subscribedActors: ['author', 'administrator'] });
  } finally { await Promise.all(channels.map(({ person, channel }) => person.client.removeChannel(channel))); }
});

test('Interrupted evidence cannot bypass current obligation state, participant boundaries, private Storage, or client write bans', async () => {
  const f = await handoffFixture('draft-evidence-denied'); await advanceHandoff(f, 'schedule');
  const prepare = await f.bob.client.rpc('prepare_exchange_evidence', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_evidence_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  assert.equal(prepare.error, null); const photo = evidenceSchema.parse(prepare.data);
  for (const client of [f.owner.client, f.carol.client, publicClient()]) {
    assert.deepEqual((await client.from('exchange_evidence').select('*').eq('id', photo.id)).data ?? [], []);
    assert.ok((await client.storage.from('exchange-evidence').download(photo.object_path)).error);
    assert.ok((await client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 60)).error);
    assert.ok((await client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error);
    assert.equal((await client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error?.code, '42501');
  }
  assert.equal((await handoffAction(f.alice, f.exchangeId, (await itemHandoff(f.alice, f.exchangeId)).revision, 'cancel', { reason: 'No longer lending' })).error, null);
  assert.ok((await f.bob.client.storage.from('exchange-evidence').upload(photo.object_path, listingImageBytes, { contentType: 'image/png' })).error);
  assert.ok((await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: randomUUID(), p_evidence_id: photo.id })).error);
  assert.ok((await f.bob.client.from('exchange_evidence').update({ state: 'ready' }).eq('id', photo.id)).error);
  assert.deepEqual((await admin.from('exchange_evidence').select('state').eq('id', photo.id)).data, [{ state: 'pending' }]);
  receipt('issue-24-stale-evidence', { id: photo.id, unauthorizedStorage: 'denied', afterCancellationUpload: 'denied', state: 'pending' });
});
