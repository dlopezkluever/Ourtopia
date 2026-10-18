import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { admin, completedItemFixture, handoffFixture, localScores, receipt, settleFixtureNotices } from '../../scripts/verify/backend';

const suiteStarted = new Date().toISOString();
after(() => settleFixtureNotices(['thanks-primary', 'thanks-race', 'thanks-incomplete', 'thanks-guards'], suiteStarted));

test('A completed Exchange partner can thank the recipient, with one point total and no new interaction', async () => {
  const f = await completedItemFixture('thanks-primary');
  const intent = randomUUID();
  const submit = (message: string, id = intent) => f.bob.client.rpc('thank_exchange', { p_intent_id: id, p_exchange_id: f.exchangeId, p_message: message });
  const first = await submit('Thanks for lending the drill.');
  assert.equal(first.error, null);
  assert.deepEqual(await submit('Thanks for lending the drill.'), first);
  assert.equal((await submit('Changed message')).error?.code, '23505');
  assert.equal((first.data as { points_awarded: boolean }).points_awarded, true);
  const reply = await f.alice.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'You are welcome.' });
  assert.equal(reply.error, null);
  assert.equal((reply.data as { points_awarded: boolean }).points_awarded, false);
  const repeated = await submit('Thanks again.', randomUUID());
  assert.equal(repeated.error, null);
  assert.equal((repeated.data as { points_awarded: boolean }).points_awarded, false);

  const entries = await admin.from('exchange_thank_yous').select('author_id,recipient_id,message').eq('exchange_id', f.exchangeId).order('created_at');
  assert.equal(entries.error, null);
  assert.equal(entries.data?.length, 3);
  const rewards = await admin.from('reputation_events').select('recipient_id,points').eq('exchange_id', f.exchangeId).eq('rule', 'exchange_thank_you');
  assert.deepEqual(rewards.data, [{ recipient_id: f.alice.id, points: 1 }]);
  assert.deepEqual(await localScores(f.community.id, f.alice, f.bob), [53, 51]);
  const interactions = await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId);
  assert.equal(interactions.data?.length, 2);
  const notices = await admin.from('notification_outbox').select('id,channel,recipient_id,kind').eq('event_id', (first.data as { event_id: string }).event_id);
  assert.deepEqual(notices.data?.map(row => [row.channel, row.recipient_id, row.kind]).sort(), [
    ['email', f.alice.id, 'exchange_thank_you'], ['in_app', f.alice.id, 'exchange_thank_you'],
  ]);
  const mail: { subject: string; text: string }[] = [];
  for (const notice of notices.data ?? []) if (notice.channel === 'email') await deliverOne(admin, async message => { mail.push(message); }, notice.id);
  assert.deepEqual(mail, [{ subject: 'Your Exchange partner thanked you', text: 'Sign in to Ourtopia and open your Community profile to read the thank-you.' }]);
  const feed = await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id });
  assert.equal(JSON.stringify(feed.data).includes('Thanks for lending the drill.'), true);
  assert.equal((await f.carol.client.from('reputation_events').insert({ community_id: f.community.id, recipient_id: f.alice.id, rule: 'exchange_thank_you', points: 50, source_kind: 'thank_you', source_id: f.exchangeId, exchange_id: f.exchangeId, verified_by_command: 'forged' })).error?.code, '42501');
  receipt('issue-10-thank-you', { thankYous: entries.data?.length, reward: rewards.data, interactions: interactions.data?.length, mail: mail[0] });
});

test('Opposite-direction concurrent submissions award only one point for the Exchange', async () => {
  const f = await completedItemFixture('thanks-race');
  const outcomes = await Promise.all([
    f.bob.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'Thanks, Alice.' }),
    f.alice.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'Thanks, Bob.' }),
  ]);
  assert.deepEqual(outcomes.map(row => row.error?.code ?? (row.data as { points_awarded: boolean }).points_awarded).sort(), [false, true]);
  const rewards = await admin.from('reputation_events').select('recipient_id,points').eq('exchange_id', f.exchangeId).eq('rule', 'exchange_thank_you');
  assert.equal(rewards.data?.length, 1);
  const feed = await f.carol.client.rpc('read_community_feed', { p_community_id: f.community.id });
  assert.equal((feed.data as unknown[]).length, 2);
  receipt('issue-10-thank-you-race', { outcomes: outcomes.map(row => row.data), reward: rewards.data });
});

test('Incomplete Exchanges and unrelated members cannot publish thank-yous', async () => {
  const f = await handoffFixture('thanks-incomplete');
  const pending = await f.bob.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'Thanks.' });
  assert.equal(pending.error?.code, '55000');
  const completed = await completedItemFixture('thanks-guards');
  const unrelated = await completed.carol.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: completed.exchangeId, p_message: 'Thanks.' });
  assert.equal(unrelated.error?.code, '42501');
  assert.equal((await completed.bob.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: completed.exchangeId, p_message: ' '.repeat(4) })).error?.code, '22023');
  receipt('issue-10-thank-you-guards', { incomplete: pending.error?.code, unrelated: unrelated.error?.code });
});
