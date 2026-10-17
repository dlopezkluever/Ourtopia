import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptHelp, actor, commitHelp, createHelpPost, helpFixture, helpNeedFields, helpScheduleFields } from '../../scripts/verify/backend';

test('only the exact Exchange participants can read completion facts or confirm them', async () => {
  const f = await helpFixture('completion-privacy', 2);
  const [helper, unrelated] = f.members;
  const need = await createHelpPost(f.author, f.community.id, 'need_post', helpNeedFields(2));
  const exchange = await acceptHelp(f.author, await commitHelp(helper, 'need_post', need.id));
  assert.equal((await helper.client.rpc('schedule_help_exchange', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_fields: helpScheduleFields() })).error, null);
  const confirmed = await helper.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_expected_revision: 0, p_action: 'confirm', p_disagreement: null });
  assert.equal(confirmed.error, null);
  assert.equal((await unrelated.client.from('help_completions').select('exchange_id').eq('exchange_id', exchange.id)).data?.length, 0);
  assert.equal((await f.owner.client.from('help_completions').select('exchange_id').eq('exchange_id', exchange.id)).data?.length, 0, 'a Community administrator who is not a participant has no completion access');
  const foreign = await actor({ label: 'completion-foreign' });
  assert.equal((await foreign.client.rpc('read_help_completion', { p_exchange_id: exchange.id })).error?.code, '42501');
  assert.equal((await unrelated.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_expected_revision: 1, p_action: 'confirm', p_disagreement: null })).error?.code, '42501');
  const disagreement = await f.author.client.rpc('command_help_completion', { p_intent_id: randomUUID(), p_exchange_id: exchange.id, p_expected_revision: 1, p_action: 'dispute', p_disagreement: 'The help did not happen.' });
  assert.equal(disagreement.error, null);
  assert.equal((await unrelated.client.from('exchange_events').select('kind').eq('exchange_id', exchange.id).eq('kind', 'help_completion_disputed')).data?.length, 0);
  assert.equal((await unrelated.client.from('community_events').select('kind').eq('community_id', f.community.id).eq('kind', 'item_dispute_opened')).data?.length, 0);
});
