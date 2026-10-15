import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, admin, anonKey, createCommunity, publicClient, receipt } from '../../scripts/verify/backend';
import { communitySchema } from '../../src/features/communities/model';

test('anonymous and unrelated accounts discover no protected records; foreign administrator has no special access', async () => {
  const owner = await actor();
  const foreign = await actor();
  const created = communitySchema.parse((await createCommunity(owner.client)).data);
  await createCommunity(foreign.client, randomUUID(), 'An unrelated private circle');
  const evidence = [];
  for (const [label, client] of [['anonymous', publicClient()], ['unrelated administrator', foreign.client]] satisfies [string, ReturnType<typeof publicClient>][]) {
    for (const table of ['communities', 'memberships', 'community_events']) {
      const column = table === 'communities' ? 'id' : 'community_id';
      const result = await client.from(table).select('*').eq(column, created.id);
      if (label === 'anonymous') assert.ok(result.error?.code === '42501' || result.data?.length === 0);
      else { assert.equal(result.error, null); assert.deepEqual(result.data, []); }
      evidence.push({ actor: label, table, rows: result.data?.length ?? 0, code: result.error?.code ?? null });
    }
  }
  receipt('rls-private-reads', evidence);
});

test('ordinary owner and outsider cannot write command-owned data or forge membership or immutable identity', async () => {
  const owner = await actor();
  const outsider = await actor();
  const created = communitySchema.parse((await createCommunity(owner.client)).data);
  const results = [];
  for (const client of [owner.client, outsider.client]) {
    const mutations = [
      await client.from('communities').insert({ name: 'Forged', created_by: outsider.id }),
      await client.from('communities').update({ id: randomUUID(), created_by: outsider.id, name: 'Hijacked' }).eq('id', created.id),
      await client.from('communities').delete().eq('id', created.id),
      await client.from('memberships').insert({ community_id: created.id, user_id: outsider.id, role: 'administrator', status: 'active' }),
      await client.from('memberships').update({ role: 'administrator', user_id: outsider.id }).eq('community_id', created.id),
      await client.from('community_events').insert({ community_id: created.id, actor_id: outsider.id, kind: 'forged', intent_id: randomUUID() }),
      await client.from('command_intents').select('*'),
    ];
    for (const mutation of mutations) { assert.equal(mutation.error?.code, '42501'); results.push(mutation.error.code); }
  }
  assert.deepEqual((await owner.client.from('communities').select('*').eq('id', created.id)).data, [created]);
  assert.deepEqual((await owner.client.from('memberships').select('user_id,role,status').eq('community_id', created.id)).data, [{ user_id: owner.id, role: 'administrator', status: 'active' }]);
  receipt('rls-forgery', { deniedWrites: results.length, codes: results, identityUnchanged: true });
});

test('realtime delivers owner hint and never discloses it to anonymous or foreign account', { timeout: 25000 }, async () => {
  const owner = await actor();
  const outsider = await actor();
  const created = communitySchema.parse((await createCommunity(owner.client)).data);
  const seen = { owner: 0, outsider: 0, anonymous: 0 };
  const channels = [];
  for (const [label, client] of [['owner', owner.client], ['outsider', outsider.client], ['anonymous', publicClient()]] satisfies ['owner' | 'outsider' | 'anonymous', ReturnType<typeof publicClient>][]) {
    const session = await client.auth.getSession();
    await client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
    const channel = client.channel(`privacy-${label}-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${created.id}` }, change => { if (label !== 'owner' || change.new.kind !== 'community_created') seen[label]++; });
    channel.on('system', {}, payload => { receipt(`realtime-system-${label}`, payload); });
    channels.push({ client, channel });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} realtime did not subscribe.`)), 10000);
      channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); } if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error(`${label} subscription ${status}`)); } });
    });
  }
  try {
    const { error } = await admin.from('community_events').insert({ community_id: created.id, actor_id: owner.id, intent_id: randomUUID(), kind: 'verification_hint' });
    assert.equal(error, null);
    const deadline = Date.now() + 8000;
    while (seen.owner === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(seen.owner, 1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(seen, { owner: 1, outsider: 0, anonymous: 0 });
    const removed = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', created.id).eq('user_id', owner.id);
    assert.equal(removed.error, null);
    assert.deepEqual((await owner.client.from('communities').select('*').eq('id', created.id)).data, []);
    const next = await admin.from('community_events').insert({ community_id: created.id, actor_id: owner.id, intent_id: randomUUID(), kind: 'after_removal_hint' });
    assert.equal(next.error, null);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(seen, { owner: 1, outsider: 0, anonymous: 0 });
    receipt('rls-realtime', { ...seen, afterRemovalAdditionalOwnerEvents: 0, afterRemovalVisibleCommunities: 0 });
  } finally { await Promise.all(channels.map(async ({ client, channel }) => { await client.removeChannel(channel); client.realtime.disconnect(); })); }
});

test('membership revocation reaches only the affected member as a content-free access hint', { timeout: 25000 }, async () => {
  const owner = await actor();
  const outsider = await actor();
  const created = communitySchema.parse((await createCommunity(owner.client)).data);
  const seen = { owner: 0, outsider: 0, anonymous: 0 };
  const payloads: Record<string, unknown>[] = [];
  const channels = [];
  for (const [label, client] of [['owner', owner.client], ['outsider', outsider.client], ['anonymous', publicClient()]] satisfies ['owner' | 'outsider' | 'anonymous', ReturnType<typeof publicClient>][]) {
    const session = await client.auth.getSession();
    await client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
    const channel = client.channel(`access-${label}-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${owner.id}` }, change => { seen[label]++; if (label === 'owner') payloads.push(change.new); });
    channels.push({ client, channel });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} realtime did not subscribe.`)), 10000);
      channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); } if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error(`${label} subscription ${status}`)); } });
    });
  }
  try {
    // Realtime can still deliver the hint committed by creation; count only hints caused by revocation.
    await new Promise(resolve => setTimeout(resolve, 1500));
    Object.assign(seen, { owner: 0, outsider: 0, anonymous: 0 }); payloads.length = 0;
    const removed = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', created.id).eq('user_id', owner.id);
    assert.equal(removed.error, null);
    const deadline = Date.now() + 8000;
    while (seen.owner === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(seen, { owner: 1, outsider: 0, anonymous: 0 });
    assert.deepEqual(Object.keys(payloads[0]).sort(), ['community_id', 'id', 'user_id']);
    assert.deepEqual((await owner.client.from('communities').select('*').eq('id', created.id)).data, []);
    assert.deepEqual((await outsider.client.from('membership_access_hints').select('*').eq('user_id', owner.id)).data, []);
    const anonymousRead = await publicClient().from('membership_access_hints').select('*').eq('user_id', owner.id);
    assert.ok(anonymousRead.error?.code === '42501' || anonymousRead.data?.length === 0);
    for (const client of [owner.client, outsider.client]) {
      const forged = await client.from('membership_access_hints').insert({ user_id: owner.id, community_id: created.id });
      assert.equal(forged.error?.code, '42501');
    }
    receipt('rls-membership-hints', { ...seen, payloadKeys: Object.keys(payloads[0]).sort(), outsiderRows: 0, clientWritesDenied: 2 });
  } finally { await Promise.all(channels.map(async ({ client, channel }) => { await client.removeChannel(channel); client.realtime.disconnect(); })); }
});
