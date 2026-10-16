import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, admin, activeMember, applyInvite, decideApplication, issueInvite, failedDelivery, membershipFixture, publicClient, realtimeReady, receipt, sendMessage, startConversation } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

test('only current same-Community administrators inspect and retry; recipients retain own notice rights', async () => {
  const f = await failedDelivery('p23-rls');
  const foreign = await membershipFixture('p23-foreign');
  const unrelated = await actor();
  const pending = await actor();
  await applyInvite(pending, (await issueInvite(f.owner, f.community.id, pending.email)).id);
  const rejected = await actor();
  const rejectedApplication = await applyInvite(rejected, (await issueInvite(f.owner, f.community.id, rejected.email)).id);
  assert.equal((await decideApplication(f.owner, rejectedApplication.id, 'rejected', 'Attend orientation.')).error, null);
  const suspended = await activeMember(f.owner, f.community.id, 'p23-suspended');
  const removed = await activeMember(f.owner, f.community.id, 'p23-removed');
  assert.equal((await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', f.community.id).eq('user_id', suspended.id)).error, null);
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', removed.id)).error, null);
  const unverified = await actor({ verified: false });
  const denied = [f.applicant, foreign.owner, unrelated, pending, rejected, suspended, removed, unverified];
  const reminderArgs = { p_community_id: f.community.id, p_source_key: randomUUID(), p_event_id: f.email.event_id, p_recipient_id: f.applicant.id, p_channel: 'email', p_kind: 'handoff_reminder', p_due_at: new Date(Date.now() + 3600000).toISOString() };
  assert.equal((await admin.rpc('schedule_notification_reminder', reminderArgs)).error, null);
  for (const user of denied) {
    assert.equal((await user.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id })).error?.code, '42501');
    assert.equal((await user.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: f.email.id })).error?.code, '42501');
    if (user.id !== f.applicant.id) {
      assert.deepEqual((await user.client.from('notification_outbox').select('*').eq('id', f.email.id)).data, []);
      assert.deepEqual((await user.client.from('notification_attempts').select('*').eq('outbox_id', f.email.id)).data, []);
    }
    assert.ok((await user.client.from('notification_outbox').update({ state: 'delivered' }).eq('id', f.email.id)).error);
    assert.ok((await user.client.rpc('claim_notification', { p_outbox_id: f.email.id })).error);
    assert.equal((await user.client.rpc('finish_notification', { p_outbox_id: f.email.id, p_claim_token: randomUUID() })).error?.code, '42501');
    assert.equal((await user.client.rpc('schedule_notification_reminder', reminderArgs)).error?.code, '42501');
    assert.equal((await user.client.rpc('check_notification_claim', { p_outbox_id: f.email.id, p_claim_token: randomUUID() })).error?.code, '42501');
    assert.deepEqual((await user.client.from('notification_reminders').select('*').eq('community_id', f.community.id)).data, []);
    assert.equal((await user.client.from('notification_reminders').insert({ community_id: f.community.id })).error?.code, '42501');
  }
  const anon = publicClient();
  assert.ok((await anon.rpc('inspect_notification_deliveries', { p_community_id: f.community.id })).error);
  assert.equal((await anon.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: f.email.id })).error?.code, '42501');
  assert.equal((await anon.rpc('schedule_notification_reminder', reminderArgs)).error?.code, '42501');
  assert.ok((await anon.from('notification_outbox').select('*')).error);
  const claim = await admin.rpc('claim_notification', { p_outbox_id: f.inApp.id });
  await admin.rpc('finish_notification', { p_outbox_id: f.inApp.id, p_claim_token: claim.data.claim_token });
  assert.equal((await f.applicant.client.from('notifications').select('*').eq('outbox_id', f.inApp.id)).data?.length, 1);
  assert.deepEqual((await f.owner.client.from('notifications').select('*').eq('outbox_id', f.inApp.id)).data, []);
  const intent = randomUUID();
  assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: intent, p_outbox_id: f.email.id })).error, null);
  assert.equal((await admin.from('memberships').update({ role: 'member' }).eq('community_id', f.community.id).eq('user_id', f.owner.id)).error, null);
  assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: intent, p_outbox_id: f.email.id })).error?.code, '42501');
  assert.equal((await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id })).error?.code, '42501');
  assert.equal((await admin.from('memberships').update({ role: 'administrator' }).eq('community_id', f.community.id).eq('user_id', f.owner.id)).error, null);
  assert.equal((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.owner.id)).error, null);
  assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: intent, p_outbox_id: f.email.id })).error?.code, '42501');
  assert.equal((await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id })).error?.code, '42501');
  assert.deepEqual((await f.owner.client.from('notification_outbox').select('*').eq('id', f.email.id)).data, []);
  receipt('issue-23-boundaries', { denied: denied.map(user => user.id), anonymous: true, revokedIntentDenied: true, ownNotices: 1 });
});

test('nonparticipant administrator cannot inspect or retry private conversation notices', async () => {
  const f = await failedDelivery('p23-messages');
  const second = await activeMember(f.owner, f.community.id, 'p23-message-peer');
  const conversation = await startConversation(f.applicant, f.community.id, second.id);
  await sendMessage(f.applicant, conversation.id, 'Private planning text stays out of diagnostics.');
  const outbox = await admin.from('notification_outbox').select('id').eq('community_id', f.community.id).eq('kind', 'message_sent');
  assert.equal(outbox.error, null); assert.equal(outbox.data?.length, 1);
  const id = outbox.data![0].id;
  const claim = await admin.rpc('claim_notification', { p_outbox_id: id });
  assert.ok(claim.data);
  assert.equal((await admin.rpc('finish_notification', { p_outbox_id: id, p_claim_token: claim.data.claim_token, p_error: 'Private planning text stays out of diagnostics.' })).error, null);
  assert.deepEqual((await f.owner.client.from('notification_outbox').select('*').eq('id', id)).data, []);
  assert.deepEqual((await f.owner.client.from('notification_attempts').select('*').eq('outbox_id', id)).data, []);
  assert.equal((await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: id })).error?.code, '42501');
  const diagnostics = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
  assert.equal(diagnostics.error, null); assert.ok(!JSON.stringify(diagnostics.data).includes(id));
  receipt('issue-23-private-message-exclusion', { administrator: f.owner.id, privateNoticeHidden: true, privateAttemptHidden: true, retryDenied: true });
});

test('diagnostics sanitize provider errors in direct RLS reads and realtime exposes recipient-only hints', async () => {
  const f = await failedDelivery('p23-private', 'PRIVATE-BODY https://signed.test/?token=secret Bearer credentials');
  assert.equal((await admin.from('notification_outbox').update({ last_error: 'PRIVATE-BODY https://signed.test/?token=secret Bearer credentials' }).eq('id', f.email.id)).error, null);
  assert.equal((await admin.from('notification_attempts').update({ error: 'PRIVATE-BODY https://signed.test/?token=secret Bearer credentials' }).eq('outbox_id', f.email.id)).error, null);
  const outbox = await f.owner.client.from('notification_outbox').select('*').eq('id', f.email.id);
  const attempts = await f.owner.client.from('notification_attempts').select('*').eq('outbox_id', f.email.id);
  assert.equal(outbox.data?.[0].last_error, 'Delivery failed. Retry is scheduled.');
  assert.equal(attempts.data?.[0].error, 'Delivery failed. Retry is scheduled.');
  const foreign = await actor();
  const seen: Record<string, unknown[]> = { recipient: [], foreign: [], owner: [] };
  const clients = [['recipient', f.applicant], ['foreign', foreign], ['owner', f.owner]] as const;
  const channels = [];
  try {
    for (const [name, user] of clients) {
      const session = await user.client.auth.getSession();
      await user.client.realtime.setAuth(session.data.session!.access_token);
      const channel = user.client.channel(`p23-${name}-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${f.applicant.id}` }, payload => seen[name].push(payload.new));
      channels.push({ client: user.client, channel });
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Subscription timeout')), 15000); channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } }); });
    }
    const hint = await admin.from('notification_hints').insert({ recipient_id: f.applicant.id }).select('id').single();
    assert.equal(hint.error, null);
    const deadline = Date.now() + 10000;
    while (!seen.recipient.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(seen.recipient.length, 1); assert.equal(seen.foreign.length, 0); assert.equal(seen.owner.length, 0);
    assert.deepEqual(Object.keys(seen.recipient[0] as object).sort(), ['id', 'recipient_id']);
    receipt('issue-23-privacy', { outbox: outbox.data, attempts: attempts.data, hints: seen, storage: 'No Storage objects or buckets introduced.' });
  } finally { for (const { client, channel } of channels) { await client.removeChannel(channel); client.realtime.disconnect(); } }
});
