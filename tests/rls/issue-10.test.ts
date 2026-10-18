import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actor, completedItemFixture, publicClient, receipt } from '../../scripts/verify/backend';

test('Thank-yous are readable inside their Community and writes remain command-owned', async () => {
  const f = await completedItemFixture('thanks-rls');
  const saved = await f.bob.client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'Thanks for sharing your drill.' });
  assert.equal(saved.error, null);
  const outsider = await actor({ label: 'thanks-rls-outsider' });
  const otherCommunity = await actor({ label: 'thanks-rls-foreign' });
  assert.equal((await otherCommunity.client.rpc('create_community', { p_intent_id: randomUUID(), p_name: 'Elsewhere circle', p_description: '' })).error, null);

  const communityView = await f.carol.client.from('exchange_thank_yous').select('message').eq('exchange_id', f.exchangeId);
  assert.deepEqual(communityView.data, [{ message: 'Thanks for sharing your drill.' }]);
  for (const client of [outsider.client, otherCommunity.client, publicClient()]) {
    assert.deepEqual((await client.from('exchange_thank_yous').select('*').eq('exchange_id', f.exchangeId)).data ?? [], []);
    assert.equal((await client.rpc('read_community_feed', { p_community_id: f.community.id })).error?.code, '42501');
    assert.equal((await client.rpc('thank_exchange', { p_intent_id: randomUUID(), p_exchange_id: f.exchangeId, p_message: 'Spoofed thanks.' })).error?.code, '42501');
  }
  assert.equal((await f.bob.client.from('exchange_thank_yous').insert({ community_id: f.community.id, exchange_id: f.exchangeId,
    author_id: f.bob.id, recipient_id: f.alice.id, event_id: randomUUID(), message: 'Direct write.' })).error?.code, '42501');
  const id = (saved.data as { id: string }).id;
  assert.equal((await f.bob.client.from('exchange_thank_yous').update({ message: 'Changed.' }).eq('id', id)).error?.code, '42501');
  assert.equal((await f.bob.client.from('exchange_thank_yous').delete().eq('id', id)).error?.code, '42501');
  receipt('issue-10-thank-you-privacy', { activeMemberRows: communityView.data?.length, outsiderRows: 0, directWrites: 'denied' });
});
