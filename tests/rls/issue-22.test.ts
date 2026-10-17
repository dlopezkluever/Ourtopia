import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, admin, createCommunity, publicClient, stripeWorker, realtimeReady, receipt } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

test('own billing is private across actors and command-owned state rejects direct writes', async () => {
  const owner = await actor({ label: 'billing-owner' });
  const foreign = await actor({ label: 'billing-foreign-admin' });
  const unrelated = await actor({ label: 'billing-unrelated' });
  const unverified = await actor({ label: 'billing-unverified', verified: false });
  const peerAdministrator = await actor({ label: 'billing-peer-administrator' });
  const peerMember = await actor({ label: 'billing-peer-member' });
  const pending = await actor({ label: 'billing-pending' });
  const rejected = await actor({ label: 'billing-rejected' });
  const removed = await actor({ label: 'billing-removed' });
  const ownCommunity = await createCommunity(owner.client);
  const foreignCommunity = await createCommunity(foreign.client);
  assert.equal(ownCommunity.error, null); assert.equal(foreignCommunity.error, null);
  assert.equal((await admin.from('memberships').insert([
    { community_id: ownCommunity.data.id, user_id: peerAdministrator.id, role: 'administrator', status: 'active' },
    { community_id: ownCommunity.data.id, user_id: peerMember.id, role: 'member', status: 'active' },
    { community_id: ownCommunity.data.id, user_id: pending.id, role: 'member', status: 'pending' },
    { community_id: ownCommunity.data.id, user_id: rejected.id, role: 'member', status: 'rejected' },
    { community_id: ownCommunity.data.id, user_id: removed.id, role: 'member', status: 'removed' },
  ])).error, null);
  const result = await owner.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: ownCommunity.data.id, p_kind: 'checkout' });
  assert.equal(result.error, null);
  const customer = `cus_${randomUUID().replaceAll('-', '')}`;
  assert.equal((await admin.from('billing_accounts').update({ customer_id: customer }).eq('account_id', owner.id)).error, null);
  assert.equal((await admin.from('billing_subscriptions').insert({ account_id: owner.id, customer_id: customer, subscription_id: `sub_${randomUUID().replaceAll('-', '')}`, status: 'active', cancel_at_period_end: false })).error, null);
  const denied = [foreign.client, unrelated.client, unverified.client, publicClient(), stripeWorker(), pending.client, rejected.client, removed.client];
  for (const table of ['billing_accounts', 'billing_jobs', 'billing_subscriptions']) {
    assert.deepEqual((await peerAdministrator.client.from(table).select('*').eq('account_id', owner.id)).data, [], `${table} leaked to a same-Community administrator`);
  }
  for (const peer of [{ label: 'administrator', client: peerAdministrator.client }, { label: 'member', client: peerMember.client }]) {
    assert.deepEqual((await peer.client.from('community_events').select('kind,actor_id').eq('community_id', ownCommunity.data.id).eq('kind', 'test_billing_requested')).data, [], `test billing activity leaked to a same-Community ${peer.label}`);
    assert.ok((await peer.client.from('community_events').select('id').eq('community_id', ownCommunity.data.id)).data?.length, `same-Community ${peer.label} lost ordinary Community events`);
  }
  assert.deepEqual((await owner.client.from('billing_jobs').select('account_id,kind')).data, [{ account_id: owner.id, kind: 'checkout' }]);
  assert.equal((await owner.client.from('billing_subscriptions').select('status')).data?.[0]?.status, 'active');
  for (const client of denied) {
    for (const table of ['billing_accounts', 'billing_jobs', 'billing_subscriptions']) {
      const read = await client.from(table).select('*');
      assert.ok(read.error || read.data?.length === 0, `${table} leaked across account boundary`);
    }
    assert.ok((await client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: ownCommunity.data.id, p_kind: 'checkout' })).error);
  }
  assert.equal((await owner.client.from('billing_subscriptions').select('*')).data?.length, 1);
  const attempts: { table: string; insert: Record<string, unknown>; update: Record<string, unknown>; key: string; value: string }[] = [
    { table: 'billing_accounts', insert: { account_id: owner.id, customer_id: 'cus_forged' }, update: { customer_id: 'cus_forged' }, key: 'account_id', value: owner.id },
    { table: 'billing_jobs', insert: { account_id: owner.id, community_id: ownCommunity.data.id, kind: 'checkout' }, update: { state: 'ready' }, key: 'account_id', value: owner.id },
    { table: 'billing_subscriptions', insert: { account_id: owner.id, customer_id: customer, subscription_id: 'sub_forged', status: 'active', cancel_at_period_end: false }, update: { status: 'canceled' }, key: 'account_id', value: owner.id },
    { table: 'stripe_receipts', insert: { event_id: 'evt_forged', event_type: 'customer.subscription.updated', subscription_id: 'sub_forged', customer_id: customer, fingerprint: 'forged' }, update: { state: 'processed' }, key: 'event_id', value: 'evt_forged' },
    { table: 'stripe_writers', insert: { subscription_id: 'sub_forged', event_id: 'evt_forged', claim_token: randomUUID(), lease_until: new Date().toISOString() }, update: { claim_token: randomUUID() }, key: 'subscription_id', value: 'sub_forged' },
  ];
  for (const attempt of attempts) {
    assert.equal((await owner.client.from(attempt.table).insert(attempt.insert)).error?.code, '42501');
    assert.equal((await owner.client.from(attempt.table).update(attempt.update).eq(attempt.key, attempt.value)).error?.code, '42501');
    assert.equal((await owner.client.from(attempt.table).delete().eq(attempt.key, attempt.value)).error?.code, '42501');
  }
  const commands = [
    { name: 'receive_stripe_receipt', args: { p_event_id: 'evt_forged', p_event_type: 'customer.subscription.updated', p_subscription_id: 'sub_forged', p_customer_id: customer, p_fingerprint: 'forged' } },
    { name: 'claim_stripe_receipt', args: { p_event_id: 'evt_forged' } },
    { name: 'finish_stripe_receipt', args: { p_event_id: 'evt_forged', p_claim_token: randomUUID() } },
    { name: 'claim_test_billing', args: { p_job_id: result.data.job_id } },
    { name: 'link_test_customer', args: { p_job_id: result.data.job_id, p_claim_token: randomUUID(), p_customer_id: 'cus_forged' } },
    { name: 'finish_test_billing', args: { p_job_id: result.data.job_id, p_claim_token: randomUUID() } },
  ];
  for (const command of commands) {
    assert.equal((await owner.client.rpc(command.name, command.args)).error?.code, '42501', `${command.name} did not enforce worker authority`);
  }
  for (const table of ['stripe_receipts', 'stripe_writers']) assert.ok((await owner.client.from(table).select('*')).error);
  const worker = stripeWorker();
  assert.ok((await worker.from('memberships').update({ role: 'administrator' }).eq('user_id', unrelated.id)).error);
  assert.ok((await worker.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Forbidden billing Community', p_description: '' })).error);
  assert.ok((await worker.rpc('decide_membership', { p_intent_id: randomUUID(), p_application_id: randomUUID(), p_decision: 'approved', p_reason: '' })).error);
  const peerRequest = await peerAdministrator.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: ownCommunity.data.id, p_kind: 'checkout' });
  assert.equal(peerRequest.error, null);
  assert.notEqual(peerRequest.data.job_id, result.data.job_id);
  assert.deepEqual((await peerAdministrator.client.from('billing_jobs').select('account_id')).data, [{ account_id: peerAdministrator.id }]);
  assert.deepEqual((await owner.client.from('memberships').select('role,status').eq('community_id', ownCommunity.data.id).eq('user_id', owner.id)).data, [{ role: 'administrator', status: 'active' }]);
  receipt('issue-22-rls-boundaries', { actorClasses: ['owner', 'same-Community administrator', 'foreign administrator', 'pending', 'rejected', 'removed', 'unrelated', 'unverified', 'anonymous', 'stripe worker'], directWritesDenied: true, webhookCannotChangeRoles: true, peerAdministratorCreatesOnlyOwnJob: true, billingAuditHiddenFromPeers: true });
});

test('billing projections do not leak through realtime or Storage and revoked members retain only account status', async () => {
  const owner = await actor({ label: 'billing-realtime-owner' });
  const stranger = await actor({ label: 'billing-realtime-stranger' });
  const community = await createCommunity(owner.client);
  assert.equal(community.error, null);
  const result = await owner.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: community.data.id, p_kind: 'checkout' });
  assert.equal(result.error, null);
  let received = 0;
  let subscriptionState = '';
  const channel = stranger.client.channel(`billing-private-${randomUUID()}`).on('postgres_changes', { event: '*', schema: 'public', table: 'billing_jobs' }, () => { received++; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime subscription timed out.')), 10000);
    channel.subscribe(status => { subscriptionState = status; if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR') { clearTimeout(timeout); resolve(); } });
  });
  try {
    await admin.from('billing_jobs').update({ last_error: 'Private receipt fixture' }).eq('id', result.data.job_id);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(received, 0);
  } finally { await stranger.client.removeChannel(channel); stranger.client.realtime.disconnect(); }
  const stored = await stranger.client.storage.from('billing').list(owner.id);
  assert.ok(stored.error || stored.data?.length === 0);
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', community.data.id).eq('user_id', owner.id)).error, null);
  assert.equal((await owner.client.rpc('request_test_billing', { p_intent_id: randomUUID(), p_community_id: community.data.id, p_kind: 'checkout' })).error?.code, '42501');
  assert.equal((await owner.client.from('billing_jobs').select('*')).data?.length, 1);
  assert.deepEqual((await owner.client.from('communities').select('*')).data, []);
  receipt('issue-22-rls-current', { realtimeForeignEvents: received, subscriptionState, storageEntity: 'none', removedMemberCommandDenied: true, ownBillingRetained: true });
});
