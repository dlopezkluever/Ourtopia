import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { admin, deliveryFixture, failedDelivery, receipt } from '../../scripts/verify/backend';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { localDelivery } from '../../supabase/functions/notifications/local';

test('administrator inspects safe durable attempts and retries the same identity after business commit', async () => {
  const f = await failedDelivery('p23-safe', 'private evidence https://secret.test/?token=bearer credential');
  const inspected = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
  assert.equal(inspected.error, null);
  const row = inspected.data.find((row: { id: string }) => row.id === f.email.id);
  assert.equal(row.state, 'failed'); assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'Email delivery failed. Retry is scheduled.');
  assert.equal(row.history[0].error, row.last_error);
  assert.ok(!JSON.stringify(inspected.data).includes('secret.test'));
  assert.ok(!('claim_token' in row)); assert.ok(!('recipient_email' in row));
  assert.equal((await admin.from('notification_outbox').update({ last_error: 'private evidence https://secret.test/?token=bearer credential' }).eq('id', f.email.id)).error, null);
  assert.equal((await f.owner.client.from('notification_outbox').select('last_error').eq('id', f.email.id).single()).data?.last_error, 'Delivery failed. Retry is scheduled.');
  const intent = randomUUID();
  const args = { p_intent_id: intent, p_outbox_id: f.email.id };
  const retry = await f.owner.client.rpc('retry_notification', args);
  assert.equal(retry.error, null);
  const { client, send } = localDelivery();
  const delivered = await deliverOne(client, send, f.email.id) as { state: string };
  assert.equal(delivered.state, 'delivered');
  assert.equal(await deliverOne(client, send, f.email.id), null);
  const mailbox = await fetch(`${process.env.TEST_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${f.applicant.email}`)}`);
  assert.equal(mailbox.status, 200);
  assert.equal(((await mailbox.json()) as { messages: unknown[] }).messages.length, 1);
  assert.deepEqual((await f.owner.client.rpc('retry_notification', args)).data, retry.data);
  assert.equal((await f.owner.client.rpc('retry_notification', { ...args, p_outbox_id: f.inApp.id })).error?.code, '23505');
  assert.equal((await f.owner.client.rpc('retry_notification', { ...args, p_intent_id: randomUUID() })).error?.code, '55000');
  await deliverOne(client, send, f.inApp.id);
  assert.equal((await f.applicant.client.from('notifications').select('id').eq('outbox_id', f.inApp.id)).data?.length, 1);
  assert.equal((await f.applicant.client.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.applicant.id)).data?.[0].status, 'active');
  receipt('issue-23-primary', { notice: row.id, attempts: 2, membership: 'active', inAppNotices: 1, safeProjection: row });
});

test('concurrent claims and retries preserve one attempt and one in-app notice', async () => {
  const f = await failedDelivery('p23-race');
  const intent = randomUUID();
  const retries = await Promise.all(Array.from({ length: 3 }, () => f.owner.client.rpc('retry_notification', { p_intent_id: intent, p_outbox_id: f.email.id })));
  assert.ok(retries.every(row => !row.error));
  assert.deepEqual(retries[0].data, retries[2].data);
  const claims = await Promise.all(Array.from({ length: 3 }, () => admin.rpc('claim_notification', { p_outbox_id: f.email.id })));
  assert.equal(claims.filter(row => row.data).length, 1);
  const claim = claims.find(row => row.data)!.data;
  assert.equal((await admin.rpc('finish_notification', { p_outbox_id: f.email.id, p_claim_token: randomUUID() })).error?.code, '55000');
  assert.equal((await admin.rpc('finish_notification', { p_outbox_id: f.email.id, p_claim_token: claim.claim_token })).error, null);
  const inApp = await admin.rpc('claim_notification', { p_outbox_id: f.inApp.id });
  const results = await Promise.all(Array.from({ length: 3 }, () => admin.rpc('finish_notification', { p_outbox_id: f.inApp.id, p_claim_token: inApp.data.claim_token })));
  assert.ok(results.every(row => row.data.state === 'delivered'));
  assert.equal((await f.applicant.client.from('notifications').select('id').eq('outbox_id', f.inApp.id)).data?.length, 1);
  const audit = await f.owner.client.from('community_events').select('id').eq('intent_id', intent);
  assert.equal(audit.data?.length, 1);
  receipt('issue-23-races', { winningClaims: 1, retries: retries.map(row => row.data.id), auditCount: audit.data?.length, notices: 1 });
});

test('rescheduled reminder suppresses obsolete due work and rechecks a claimed schedule at finish', async () => {
  const f = await deliveryFixture('p23-reminder');
  const source = randomUUID();
  const schedules = new Map<string, Record<string, unknown>>();
  async function schedule(due: string) {
    const event = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, intent_id: randomUUID(), kind: 'handoff_rescheduled' }).select('id').single();
    assert.equal(event.error, null);
    const args = { p_community_id: f.community.id, p_source_key: source, p_event_id: event.data!.id, p_recipient_id: f.applicant.id, p_channel: 'in_app', p_kind: 'handoff_reminder', p_due_at: due };
    const result = await admin.rpc('schedule_notification_reminder', args);
    assert.equal(result.error, null); schedules.set(result.data, args); return result.data;
  }
  const obsolete = await schedule(new Date(Date.now() - 5000).toISOString());
  const current = await schedule(new Date(Date.now() - 1000).toISOString());
  assert.equal((await admin.rpc('schedule_notification_reminder', schedules.get(obsolete)!)).data, obsolete);
  assert.equal((await admin.rpc('claim_notification', { p_outbox_id: obsolete })).data, null);
  const claim = await admin.rpc('claim_notification', { p_outbox_id: current });
  assert.ok(claim.data);
  const latest = await schedule(new Date(Date.now() - 500).toISOString());
  assert.equal((await admin.rpc('finish_notification', { p_outbox_id: current, p_claim_token: claim.data.claim_token })).data.state, 'suppressed');
  const { client, send } = localDelivery();
  await deliverOne(client, send, latest);
  const notices = await f.applicant.client.from('notifications').select('outbox_id').in('outbox_id', [obsolete, current, latest]);
  assert.deepEqual(notices.data, [{ outbox_id: latest }]);
  assert.equal((await admin.from('notification_reminders').select('id').eq('source_key', source)).data?.length, 1);
  receipt('issue-23-reminders', { obsolete, current, latest, notices: notices.data });
});

test('worker revalidates a claimed reminder before sending externally', async () => {
  const f = await deliveryFixture('p23-preflight');
  const source = randomUUID();
  async function schedule() {
    const event = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, intent_id: randomUUID(), kind: 'return_rescheduled' }).select('id').single();
    assert.equal(event.error, null);
    const args = { p_community_id: f.community.id, p_source_key: source, p_event_id: event.data!.id, p_recipient_id: f.applicant.id, p_channel: 'email', p_kind: 'return_reminder', p_due_at: new Date(Date.now() - 1000).toISOString() };
    const result = await admin.rpc('schedule_notification_reminder', args); assert.equal(result.error, null);
    assert.equal((await admin.rpc('schedule_notification_reminder', args)).data, result.data);
    assert.equal((await admin.rpc('schedule_notification_reminder', { ...args, p_due_at: new Date(Date.now() + 10000).toISOString() })).error?.code, '23505');
    return result.data;
  }
  const obsolete = await schedule();
  let sends = 0;
  const result = await deliverOne({ rpc: async (name, args) => {
    const result = await admin.rpc(name, args);
    if (name === 'claim_notification' && result.data) await schedule();
    return result;
  } }, async () => { sends++; }, obsolete);
  assert.equal(result, null); assert.equal(sends, 0);
  assert.equal((await admin.from('notification_outbox').select('state').eq('id', obsolete).single()).data?.state, 'suppressed');
  receipt('issue-23-preflight', { obsolete, externalSends: sends, state: 'suppressed' });
});

test('diagnostic pages retain every notice when creation timestamps tie and accept future structured kinds', async () => {
  const f = await deliveryFixture('p23-pages');
  const createdAt = new Date(Date.now() + 1000).toISOString();
  const seeded = await admin.from('notification_outbox').insert(Array.from({ length: 55 }, (_, index) => ({
    event_id: f.email.event_id, community_id: f.community.id, recipient_id: f.applicant.id,
    channel: 'in_app', kind: `future_notice_${index}`, created_at: createdAt,
  }))).select('id');
  assert.equal(seeded.error, null);
  const first = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id });
  assert.equal(first.error, null); assert.equal(first.data.length, 50);
  const second = await f.owner.client.rpc('inspect_notification_deliveries', { p_community_id: f.community.id, p_before: first.data.at(-1).id });
  assert.equal(second.error, null);
  const ids = [...first.data, ...second.data].map((row: { id: string }) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(seeded.data!.every(row => ids.includes(row.id)));
  receipt('issue-23-pages', { first: first.data.length, second: second.data.length, unique: ids.length, futureKinds: seeded.data?.length });
});
