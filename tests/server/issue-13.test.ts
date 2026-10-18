import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptHelp, admin, commitHelp, createHelpPost, helpFixture, helpListingFields, helpNeedFields, helpScheduleFields } from '../../scripts/verify/backend';
import { feedSchema, feedSentence } from '../../src/features/feed/model';

const schedule = (member: Awaited<ReturnType<typeof helpFixture>>['author'], id: string) => member.client.rpc('schedule_help_exchange', {
  p_intent_id: randomUUID(), p_exchange_id: id, p_fields: helpScheduleFields(),
});
const confirm = (member: Awaited<ReturnType<typeof helpFixture>>['author'], id: string, revision: number, action = 'confirm', disagreement: string | null = null) =>
  member.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: id, p_expected_revision: revision, p_action: action, p_disagreement: disagreement });

test('both participants confirm one helper Exchange before shared completion and helper-only award', async () => {
  const f = await helpFixture('completion-award', 2);
  const [helper, otherHelper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const first = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  const second = await acceptHelp(f.author, await commitHelp(otherHelper, 'need_post', need.id));
  assert.equal((await schedule(helper, first.id)).error, null);
  const firstConfirmation = await confirm(helper, first.id, 0);
  assert.equal(firstConfirmation.error, null);
  assert.equal(firstConfirmation.data.state, 'completion_pending');
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', first.id)).data?.length, 0);
  assert.equal((await confirm(helper, first.id, 1)).error?.code, '55000');
  const completed = await confirm(f.author, first.id, 1);
  assert.equal(completed.error, null);
  assert.equal(completed.data.state, 'completed');
  assert.equal((await admin.from('qualifying_interactions').select('participant_id').eq('exchange_id', first.id)).data?.length, 2);
  const awards = await admin.from('reputation_events').select('recipient_id,rule,points').eq('exchange_id', first.id);
  assert.deepEqual(awards.data, [{ recipient_id: helper.id, rule: 'help_helper_completed', points: 3 }]);
  assert.equal((await admin.from('exchanges').select('state').eq('id', second.id).single()).data?.state, 'committed');
  assert.equal((await admin.from('help_slots').select('status').eq('exchange_id', second.id).single()).data?.status, 'active');
  assert.equal((await admin.from('help_completion_feed').select('exchange_id').eq('exchange_id', first.id)).data?.length, 1);
  const feed = await helper.client.rpc('read_community_feed', { p_community_id: f.community.id });
  assert.equal(feed.error, null);
  const entries = feedSchema.parse(feed.data);
  assert.equal(feedSentence(entries.find(entry => entry.kind === 'help_completed')!), `${helper.email} completed help for ${f.author.email}: ${need.title}.`);
});

test('a conflicting completion account enters the shared Dispute and blocks awards', async () => {
  const f = await helpFixture('completion-dispute', 1);
  const [helper] = f.members;
  const listing = await createHelpPost(helper, f.community.id, 'listing', helpListingFields());
  const exchange = await acceptHelp(helper, await commitHelp(f.author, 'listing', listing.id));
  assert.equal((await schedule(f.author, exchange.id)).error, null);
  assert.equal((await confirm(f.author, exchange.id, 0)).error, null);
  const conflict = await confirm(helper, exchange.id, 1, 'dispute', 'The agreed help did not happen.');
  assert.equal(conflict.error, null);
  assert.equal((await admin.from('exchanges').select('state').eq('id', exchange.id).single()).data?.state, 'completion_pending');
  assert.equal((await admin.from('disputes').select('id').eq('exchange_id', exchange.id).is('closed_at', null)).data?.length, 1);
  assert.equal((await admin.from('reputation_events').select('id').eq('exchange_id', exchange.id)).data?.length, 0);
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', exchange.id)).data?.length, 0);
});

test('completion confirmation retries return one result and another accepted helper cannot read it', async () => {
  const f = await helpFixture('completion-replay-scope', 2);
  const [helper, otherHelper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  const otherExchange = await acceptHelp(f.author, await commitHelp(otherHelper, 'need_post', need.id));
  assert.equal((await schedule(helper, exchange.id)).error, null);
  const intent = randomUUID();
  const command = () => helper.client.rpc('command_help_completion', {
    p_intent_id: intent, p_exchange_id: exchange.id, p_expected_revision: 0, p_action: 'confirm', p_disagreement: null,
  });
  const [first, replay] = await Promise.all([command(), command()]);
  assert.equal(first.error, null);
  assert.deepEqual(replay.data, first.data);
  assert.equal(replay.error, null);
  assert.equal(first.data.state, 'completion_pending');
  assert.equal((await otherHelper.client.rpc('read_help_completion', { p_exchange_id: exchange.id })).error?.code, '42501');
  assert.equal((await otherHelper.client.rpc('read_help_completion', { p_exchange_id: otherExchange.id })).error, null);
});

test('a silent Help Exchange is reminded and queued for review once without completion', async () => {
  const f = await helpFixture('completion-deadlines', 1);
  const [helper] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(1));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  assert.equal((await schedule(helper, exchange.id)).error, null);
  assert.equal((await confirm(helper, exchange.id, 0)).error, null);
  const overdue = new Date(Date.now() - 1000).toISOString();
  assert.equal((await admin.from('help_completions').update({ reminder_due_at: overdue, review_due_at: overdue }).eq('exchange_id', exchange.id)).error, null);
  assert.deepEqual((await admin.rpc('process_due_help_completions')).data, { reminded: 1, queued: 1 });
  assert.deepEqual((await admin.rpc('process_due_help_completions')).data, { reminded: 0, queued: 0 });
  assert.equal((await admin.from('exchanges').select('state').eq('id', exchange.id).single()).data?.state, 'completion_pending');
  assert.equal((await admin.from('qualifying_interactions').select('id').eq('exchange_id', exchange.id)).data?.length, 0);
  assert.equal((await admin.from('reputation_events').select('id').eq('exchange_id', exchange.id)).data?.length, 0);
  assert.equal((await admin.from('exchange_review_items').select('id').eq('exchange_id', exchange.id).eq('reason', 'missing_help_confirmation')).data?.length, 1);
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', exchange.id).eq('kind', 'help_confirmation_due')).data?.length, 1);
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', exchange.id).eq('kind', 'help_completion_review_queued')).data?.length, 1);
});
