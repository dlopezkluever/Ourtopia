import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, admin, anonKey, applyInvite, createCommunity, decideApplication, issueInvite, membershipFixture, publicClient, realtimeReady, receipt } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

async function boundaries() {
  const fixture = await membershipFixture('privacy');
  const pending = fixture.applicant;
  const rejected = await actor({ label: 'rejected' });
  const foreign = await actor({ label: 'foreign-admin' });
  const unrelated = await actor({ label: 'unrelated' });
  await createCommunity(foreign.client);
  const pendingApplication = await applyInvite(pending, (await issueInvite(fixture.owner, fixture.community.id, pending.email)).id);
  const rejectedApplication = await applyInvite(rejected, (await issueInvite(fixture.owner, fixture.community.id, rejected.email)).id);
  assert.equal((await decideApplication(fixture.owner, rejectedApplication.id, 'rejected', 'Attend orientation first.')).error, null);
  const denied: [string, ReturnType<typeof publicClient>][] = [['pending', pending.client], ['rejected', rejected.client], ['foreign administrator', foreign.client], ['unrelated verified', unrelated.client], ['anonymous', publicClient()]];
  return { ...fixture, pending, rejected, foreign, unrelated, pendingApplication, rejectedApplication, denied };
}

test('five denied actors cannot read ordinary content or administer; applicants read only their own application and decision', async () => {
  const f = await boundaries();
  const evidence = [];
  for (const [label, client] of f.denied) {
    for (const table of ['communities', 'memberships', 'community_events']) {
      const result = await client.from(table).select('*').eq(table === 'communities' ? 'id' : 'community_id', f.community.id);
      assert.ok(result.error?.code === '42501' || (result.error === null && result.data?.length === 0), `${label} read ${table}`);
      evidence.push({ label, table, rows: result.data?.length ?? 0, error: result.error?.code });
    }
    for (const result of [
      await client.rpc('issue_invite', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_email: 'victim@example.test' }),
      await client.rpc('decide_membership', { p_intent_id: randomUUID(), p_application_id: f.pendingApplication.id, p_decision: 'approved', p_reason: '' }),
      await client.rpc('require_current_membership', { p_community_id: f.community.id }),
      await client.rpc('claim_notification', { p_outbox_id: null }),
      await client.rpc('finish_notification', { p_outbox_id: randomUUID(), p_claim_token: randomUUID() }),
    ]) assert.equal(result.error?.code, '42501', `${label} command denial`);
    const applications = await client.from('membership_applications').select('id,reason,status').eq('community_id', f.community.id);
    if (label === 'pending') assert.deepEqual(applications.data, [{ id: f.pendingApplication.id, reason: null, status: 'pending' }]);
    else if (label === 'rejected') assert.deepEqual(applications.data, [{ id: f.rejectedApplication.id, reason: 'Attend orientation first.', status: 'rejected' }]);
    else assert.ok(applications.error?.code === '42501' || applications.data?.length === 0);
    const invites = await client.from('invites').select('redeemed_by').eq('community_id', f.community.id);
    if (label === 'pending') assert.deepEqual(invites.data, [{ redeemed_by: f.pending.id }]);
    else if (label === 'rejected') assert.deepEqual(invites.data, [{ redeemed_by: f.rejected.id }]);
    else assert.ok(invites.error?.code === '42501' || invites.data?.length === 0);
    const notices = await client.from('notification_outbox').select('recipient_id').eq('community_id', f.community.id);
    if (notices.data) for (const notice of notices.data) assert.equal(notice.recipient_id, label === 'rejected' ? f.rejected.id : label === 'pending' ? f.pending.id : 'no rows allowed');
  }
  assert.equal((await f.owner.client.from('communities').select('id').eq('id', f.community.id)).data?.[0].id, f.community.id);
  assert.equal((await f.owner.client.from('membership_applications').select('id').eq('community_id', f.community.id)).data?.length, 2);
  receipt('issue-3-rls-boundaries', evidence);
});

test('clients cannot promote themselves alter lifecycle identities or forge notices and delivery state', async () => {
  const f = await boundaries();
  let denials = 0;
  for (const [label, client] of [['owner', f.owner.client], ...f.denied] satisfies [string, ReturnType<typeof publicClient>][]) {
    for (const [table, values] of [
      ['memberships', { community_id: f.community.id, user_id: f.pending.id, role: 'administrator', status: 'active' }],
      ['invites', { community_id: f.community.id, community_name: 'Forged', recipient_email: f.pending.email, issued_by: f.pending.id, expires_at: new Date(Date.now() + 100000).toISOString() }],
      ['membership_applications', { community_id: f.community.id, applicant_id: f.pending.id, status: 'approved' }],
      ['notification_outbox', { community_id: f.community.id, recipient_id: f.pending.id, state: 'delivered' }],
      ['notifications', { recipient_id: f.pending.id, kind: 'forged' }],
      ['notification_hints', { recipient_id: f.pending.id }],
      ['notification_attempts', { id: randomUUID(), number: 1 }],
      ['membership_settings', { singleton: true, invite_lifetime: '100 years' }],
    ] satisfies [string, Record<string, unknown>][]) {
      assert.equal((await client.from(table).insert(values)).error?.code, '42501', `${label} insert ${table}`);
      const column = table === 'membership_settings' ? 'singleton' : table === 'memberships' ? 'community_id' : 'id';
      const target = table === 'membership_settings' ? true : table === 'memberships' ? f.community.id : f.pendingApplication.id;
      assert.equal((await client.from(table).update(values).eq(column, target)).error?.code, '42501', `${label} update ${table}`);
      assert.equal((await client.from(table).delete().eq(column, target)).error?.code, '42501', `${label} delete ${table}`);
      denials += 3;
    }
  }
  assert.equal((await admin.from('memberships').select('role,status').eq('community_id', f.community.id).eq('user_id', f.pending.id)).data?.[0].status, 'pending');
  receipt('issue-3-rls-writes', { denials, pendingUnchanged: true });
});

test('ordinary realtime content is denied to all five actors; notification hints contain only recipient identity', { timeout: 35000 }, async () => {
  const f = await boundaries();
  const seen: Record<string, number> = { owner: 0 };
  const channels = [];
  const eventId = randomUUID();
  const hints: Record<string, unknown>[] = [];
  const hintCounts: Record<string, number> = {};
  for (const [label, client] of [['owner', f.owner.client], ...f.denied] satisfies [string, ReturnType<typeof publicClient>][]) {
    seen[label] = 0; hintCounts[label] = 0;
    const session = await client.auth.getSession();
    await client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
    const channel = client.channel(`issue-3-privacy-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${f.community.id}` }, change => { if (change.new.id === eventId) seen[label]++; })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${f.pending.id}` }, change => { hintCounts[label]++; if (label === 'pending') hints.push(change.new); });
    channels.push({ client, channel });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} subscription timed out.`)), 12000);
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(`${label} ${status}`)); }
      });
    });
  }
  try {
    assert.equal((await admin.from('community_events').insert({ id: eventId, community_id: f.community.id, actor_id: f.owner.id, intent_id: randomUUID(), kind: 'privacy_probe' })).error, null);
    assert.equal((await admin.from('notification_hints').insert({ recipient_id: f.pending.id })).error, null);
    const deadline = Date.now() + 10000;
    while ((seen.owner !== 1 || hintCounts.pending !== 1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(seen, { owner: 1, pending: 0, rejected: 0, 'foreign administrator': 0, 'unrelated verified': 0, anonymous: 0 });
    assert.deepEqual(hintCounts, { owner: 0, pending: 1, rejected: 0, 'foreign administrator': 0, 'unrelated verified': 0, anonymous: 0 });
    assert.deepEqual(Object.keys(hints[0]).sort(), ['id', 'recipient_id']);
    receipt('issue-3-rls-realtime', { seen, hintCounts, hintKeys: Object.keys(hints[0]).sort() });
  } finally { await Promise.all(channels.map(async ({ client, channel }) => { await client.removeChannel(channel); client.realtime.disconnect(); })); }
});

test('current guard denies pending rejected suspended removed and revoked administrator retries', async () => {
  const f = await boundaries();
  const inviteIntent = randomUUID();
  await issueInvite(f.owner, f.community.id, f.unrelated.email, inviteIntent);
  for (const status of ['suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.owner.id)).error, null);
    assert.equal((await f.owner.client.rpc('require_current_membership', { p_community_id: f.community.id })).error?.code, '42501');
    assert.equal((await f.owner.client.rpc('issue_invite', { p_intent_id: inviteIntent, p_community_id: f.community.id, p_email: f.unrelated.email })).error?.code, '42501');
    assert.deepEqual((await f.owner.client.from('communities').select('*').eq('id', f.community.id)).data, []);
    assert.deepEqual((await f.owner.client.from('membership_applications').select('*').eq('community_id', f.community.id)).data, []);
  }
  receipt('issue-3-rls-current-guard', { revokedAdministratorRetryDenied: true, states: ['pending', 'rejected', 'suspended', 'removed'] });
});
