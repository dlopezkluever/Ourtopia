import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test } from 'node:test';
import { actor, admin, handoffFixture, realtimeReady, receipt } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

async function subscribe(member: Awaited<ReturnType<typeof actor>>, communityId: string, kind: string, events: unknown[]) {
  const session = await member.client.auth.getSession();
  if (session.data.session) await member.client.realtime.setAuth(session.data.session.access_token);
  const channel = member.client.channel(`${kind}-${randomUUID()}`).on('postgres_changes', {
    event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${communityId}`,
  }, change => events.push(change.new));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime subscription timed out')), 15000);
    channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } });
  });
  return channel;
}

test('Vote evidence follows the active Community and accused defense boundary in direct RLS reads', async () => {
  const f = await handoffFixture('disciplinary-rls-private');
  const outsider = await actor({ label: 'disciplinary-rls-outsider' });
  const opened = await f.owner.client.rpc('open_disciplinary_vote', {
    p_intent_id: randomUUID(), p_community_id: f.community.id, p_accused_id: f.bob.id,
    p_reason: 'Repeated unsafe behavior.', p_evidence: 'Private report details.',
  });
  assert.equal(opened.error, null);
  const voteId = (opened.data as { vote_id: string }).vote_id;
  assert.equal((await f.alice.client.from('disciplinary_votes').select('reason').eq('id', voteId)).data?.[0].reason, 'Repeated unsafe behavior.');
  assert.deepEqual((await f.alice.client.from('disciplinary_vote_evidence').select('body').eq('vote_id', voteId)).data, [{ body: 'Private report details.' }]);
  assert.equal((await f.bob.client.rpc('read_disciplinary_vote', { p_vote_id: voteId })).error, null);
  assert.deepEqual((await outsider.client.from('disciplinary_votes').select('id').eq('id', voteId)).data, []);
  assert.deepEqual((await outsider.client.from('disciplinary_vote_evidence').select('body').eq('vote_id', voteId)).data, []);
  assert.equal((await outsider.client.rpc('read_disciplinary_vote', { p_vote_id: voteId })).error?.code, '42501');
  assert.equal((await outsider.client.rpc('list_disciplinary_votes', { p_community_id: f.community.id })).error?.code, '42501');
  assert.ok((await f.alice.client.from('disciplinary_vote_responses').insert({ vote_id: voteId, author_id: f.alice.id, body: 'Forged response.' })).error);
  assert.ok((await f.alice.client.from('disciplinary_votes').update({ state: 'passed' }).eq('id', voteId)).error);
  assert.deepEqual((await admin.from('disciplinary_vote_responses').select('id').eq('vote_id', voteId)).data, []);

  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.bob.id, p_action: 'suspend', p_reason: 'Under review.' })).error, null);
  assert.equal((await f.bob.client.rpc('read_disciplinary_vote', { p_vote_id: voteId })).error, null);
  assert.equal((await f.bob.client.rpc('submit_disciplinary_response', { p_intent_id: randomUUID(), p_vote_id: voteId, p_body: 'My account of the events.' })).error, null);
  assert.deepEqual((await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data, []);
  assert.equal((await f.bob.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'retain' })).error?.code, '42501');
  const response = await f.bob.client.from('disciplinary_vote_responses').select('body').eq('vote_id', voteId);
  assert.deepEqual(response.data, [{ body: 'My account of the events.' }]);
  receipt('issue-21-rls-private', { activeMemberEvidence: 1, outsiderRows: 0, suspendedAccusedResponse: 1, ordinaryBrowsingDenied: true, ballotDenied: true });
});

test('Realtime exposes only Community event hints to current members and never vote evidence bodies', async () => {
  const f = await handoffFixture('disciplinary-rls-realtime');
  const outsider = await actor({ label: 'disciplinary-realtime-outsider' });
  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.bob.id, p_action: 'suspend', p_reason: 'Realtime boundary fixture.' })).error, null);
  const recipients = [f.owner, f.alice, f.bob, outsider];
  const deliveries: unknown[][] = recipients.map(() => []);
  const channels = await Promise.all(recipients.map((member, index) => subscribe(member, f.community.id, `disciplinary-event-${index}`, deliveries[index])));
  try {
    const opened = await f.owner.client.rpc('open_disciplinary_vote', {
      p_intent_id: randomUUID(), p_community_id: f.community.id, p_accused_id: f.bob.id,
      p_reason: 'Realtime privacy probe.', p_evidence: 'Do not broadcast this sentence.',
    });
    assert.equal(opened.error, null);
    const deadline = Date.now() + 10000;
    while (!deliveries[0].length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(deliveries[0].length > 0);
    assert.ok(deliveries[1].length > 0);
    assert.equal(deliveries[2].length, 0);
    assert.equal(deliveries[3].length, 0);
    assert.equal(JSON.stringify(deliveries[0]).includes('Do not broadcast this sentence.'), false);
    receipt('issue-21-realtime-hints', { membersReceivedEventHint: true, suspendedAccusedAndForeignActorReceivedNothing: true, evidenceBodyBroadcast: false });
  } finally {
    await Promise.all(channels.map((channel, index) => recipients[index].client.removeChannel(channel)));
    recipients.forEach(member => member.client.realtime.disconnect());
  }
});
