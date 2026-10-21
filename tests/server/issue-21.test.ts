import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actor, admin, applyInvite, decideApplication, handoffFixture, issueInvite, receipt, seedReputationEvent } from '../../scripts/verify/backend';

type Actor = Awaited<ReturnType<typeof actor>>;
const openVote = (owner: Actor, communityId: string, accusedId: string, reason: string, evidence: string, intent = randomUUID()) =>
  owner.client.rpc('open_disciplinary_vote', { p_intent_id: intent, p_community_id: communityId, p_accused_id: accusedId, p_reason: reason, p_evidence: evidence });

async function dueVote(f: Awaited<ReturnType<typeof handoffFixture>>, accusedId: string, voters: Actor[], choices: ('remove' | 'retain')[]) {
  const openIntent = randomUUID();
  const event = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, kind: 'disciplinary_vote_opened', intent_id: openIntent }).select('id').single();
  assert.equal(event.error, null);
  const openedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const vote = await admin.from('disciplinary_votes').insert({ community_id: f.community.id, accused_id: accusedId, opened_by: f.owner.id, reason: 'Recorded fixture allegation.', opened_at: openedAt, closes_at: new Date(Date.parse(openedAt) + 7 * 24 * 60 * 60 * 1000).toISOString(), eligible_count: voters.length, event_id: event.data.id }).select('id').single();
  assert.equal(vote.error, null);
  assert.equal((await admin.from('disciplinary_vote_electorate').insert(voters.map(voter => ({ vote_id: vote.data.id, voter_id: voter.id }))).select()).error, null);
  for (const [index, choice] of choices.entries()) {
    const ballotEvent = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: voters[index].id, kind: 'disciplinary_vote_ballot_cast', intent_id: randomUUID() }).select('id').single();
    assert.equal(ballotEvent.error, null);
    assert.equal((await admin.from('disciplinary_vote_ballots').insert({ vote_id: vote.data.id, voter_id: voters[index].id, choice, intent_id: randomUUID(), event_id: ballotEvent.data.id })).error, null);
  }
  return vote.data.id;
}

test('Opening freezes active voters, records evidence and deadline, and supports the accused response exception', async () => {
  const f = await handoffFixture('disciplinary-open');
  const intent = randomUUID();
  const opened = await openVote(f.owner, f.community.id, f.bob.id, 'Repeated harassment.', 'Three dated reports were reviewed.', intent);
  assert.equal(opened.error, null);
  const result = opened.data as { vote_id: string; opened_at: string; closes_at: string; eligible_count: number };
  assert.equal(Date.parse(result.closes_at) - Date.parse(result.opened_at), 7 * 24 * 60 * 60 * 1000);
  assert.equal(result.eligible_count, 3);
  assert.deepEqual((await openVote(f.owner, f.community.id, f.bob.id, 'Repeated harassment.', 'Three dated reports were reviewed.', intent)).data, opened.data);
  assert.equal((await openVote(f.owner, f.community.id, f.bob.id, 'Changed reason.', 'Three dated reports were reviewed.', intent)).error?.code, '23505');
  const electorate = await admin.from('disciplinary_vote_electorate').select('voter_id').eq('vote_id', result.vote_id).order('voter_id');
  assert.equal(electorate.error, null);
  assert.deepEqual(electorate.data?.map(row => row.voter_id).sort(), [f.alice.id, f.carol.id, f.owner.id].sort());
  const evidence = await f.alice.client.from('disciplinary_vote_evidence').select('body').eq('vote_id', result.vote_id);
  assert.deepEqual(evidence.data, [{ body: 'Three dated reports were reviewed.' }]);

  const lateApplicant = await actor({ label: 'disciplinary-later-member' });
  const invite = await issueInvite(f.owner, f.community.id, lateApplicant.email);
  const application = await applyInvite(lateApplicant, invite.id);
  assert.equal((await decideApplication(f.owner, application.id)).error, null);
  assert.equal((await admin.from('disciplinary_vote_electorate').select('voter_id').eq('vote_id', result.vote_id).eq('voter_id', lateApplicant.id)).data?.length, 0);
  assert.equal((await lateApplicant.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: result.vote_id, p_choice: 'retain' })).error?.code, '42501');

  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.bob.id, p_action: 'suspend', p_reason: 'Temporary review.' })).error, null);
  const response = await f.bob.client.rpc('submit_disciplinary_response', { p_intent_id: randomUUID(), p_vote_id: result.vote_id, p_body: 'I dispute the allegation and provide my timeline.' });
  assert.equal(response.error, null, 'a suspended accused member retains the defense response right');
  assert.ok((response.data as { response_id: string }).response_id, 'the accused response command records a response');
  const view = await f.bob.client.rpc('read_disciplinary_vote', { p_vote_id: result.vote_id });
  assert.equal((view.data as { can_respond: boolean }).can_respond, true);
  assert.equal((await f.bob.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: result.vote_id, p_choice: 'retain' })).error?.code, '42501');
  const ballotIntent = randomUUID();
  const ballot = await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: ballotIntent, p_vote_id: result.vote_id, p_choice: 'remove' });
  assert.equal(ballot.error, null);
  assert.deepEqual((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: ballotIntent, p_vote_id: result.vote_id, p_choice: 'remove' })).data, ballot.data);
  assert.equal((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: ballotIntent, p_vote_id: result.vote_id, p_choice: 'retain' })).error?.code, '23505');
  const duplicate = randomUUID();
  assert.equal((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: duplicate, p_vote_id: result.vote_id, p_choice: 'retain' })).error?.code, '23505');
  const earlyClose = await f.owner.client.rpc('close_disciplinary_vote', { p_intent_id: randomUUID(), p_vote_id: result.vote_id });
  assert.equal(earlyClose.error?.code, '55000');
  assert.equal((await f.owner.client.rpc('enact_disciplinary_removal', { p_intent_id: randomUUID(), p_vote_id: result.vote_id, p_reason: 'Vote result.' })).error?.code, '55000');
  receipt('issue-21-open-frozen-defense', { vote: result, laterMemberExcluded: true, suspendedAccusedResponded: response.data, suspendedBallotDenied: true, earlyClosureDenied: earlyClose.error?.code });
});

test('A delayed worker closes an expired vote once and records immutable counts without removing membership', async () => {
  const f = await handoffFixture('disciplinary-worker-close');
  const voteId = await dueVote(f, f.bob.id, [f.owner, f.alice], ['remove', 'retain']);
  assert.equal((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' })).error?.code, '42501', 'the deadline guard rejects a late ballot before worker closure');
  const first = await admin.rpc('process_due_disciplinary_votes');
  assert.equal(first.error, null);
  const recorded = await admin.from('disciplinary_votes').select('state,eligible_count,turnout,remove_votes,retain_votes,closed_at').eq('id', voteId).single();
  assert.equal(recorded.data?.state, 'failed');
  assert.equal(recorded.data?.eligible_count, 2);
  assert.equal(recorded.data?.turnout, 2);
  assert.equal(recorded.data?.remove_votes, 1);
  assert.equal(recorded.data?.retain_votes, 1);
  assert.ok(recorded.data?.closed_at && Date.parse(recorded.data.closed_at) <= Date.now());
  const closeIntent = randomUUID();
  const replay = await f.owner.client.rpc('close_disciplinary_vote', { p_intent_id: closeIntent, p_vote_id: voteId });
  assert.equal(replay.error, null);
  assert.deepEqual(replay.data, { vote_id: voteId, state: 'failed', eligible_count: 2, turnout: 2, remove_votes: 1, retain_votes: 1,
    required_turnout: 1, closed_at: recorded.data?.closed_at, event_id: (replay.data as { event_id: string }).event_id });
  assert.deepEqual((await f.owner.client.rpc('close_disciplinary_vote', { p_intent_id: closeIntent, p_vote_id: voteId })).data, replay.data);
  const anotherVote = await dueVote(f, f.alice.id, [f.owner, f.bob], []);
  assert.equal((await admin.rpc('process_due_disciplinary_votes')).error, null);
  assert.equal((await f.owner.client.rpc('close_disciplinary_vote', { p_intent_id: closeIntent, p_vote_id: anotherVote })).error?.code, '23505');
  assert.equal((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status, 'active');
  assert.equal((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' })).error?.code, '42501');
  assert.equal((await f.owner.client.rpc('enact_disciplinary_removal', { p_intent_id: randomUUID(), p_vote_id: voteId, p_reason: 'Failed vote.' })).error?.code, '55000');
  receipt('issue-21-delayed-worker', { voteId, close: recorded.data, replay: replay.data, memberStatus: 'active' });
});

test('A passing recorded vote permits only a separate audited removal action', async () => {
  const f = await handoffFixture('disciplinary-enact-removal');
  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.alice.id, p_action: 'suspend', p_reason: 'Snapshot fixture.' })).error, null);
  const voteId = await dueVote(f, f.bob.id, [f.owner], ['remove']);
  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.alice.id, p_action: 'reinstate', p_reason: 'Snapshot fixture complete.' })).error, null);
  assert.equal((await admin.rpc('process_due_disciplinary_votes')).error, null);
  await seedReputationEvent(f.community.id, f.bob.id, 1);
  const reputationBefore = (await f.bob.client.from('reputation_events').select('id')).data?.length;
  const obligationBefore = {
    exchange: (await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state,
    reservation: (await admin.from('item_reservations').select('exchange_id').eq('exchange_id', f.exchangeId)).data?.length,
  };
  const result = await f.owner.client.rpc('enact_disciplinary_removal', { p_intent_id: randomUUID(), p_vote_id: voteId, p_reason: 'Passing vote reviewed by the administrator.' });
  assert.equal(result.error, null);
  const action = await admin.from('moderation_actions').select('action,reason,disciplinary_vote_id').eq('disciplinary_vote_id', voteId).single();
  assert.deepEqual(action.data, { action: 'remove', reason: 'Passing vote reviewed by the administrator.', disciplinary_vote_id: voteId });
  assert.equal((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status, 'removed');
  assert.equal((await f.bob.client.from('reputation_events').select('id')).data?.length, reputationBefore);
  assert.deepEqual({
    exchange: (await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state,
    reservation: (await admin.from('item_reservations').select('exchange_id').eq('exchange_id', f.exchangeId)).data?.length,
  }, obligationBefore);
  receipt('issue-21-enact-removal', { result: result.data, action: action.data, reputationBefore: reputationBefore ?? 0, obligationsUnchanged: obligationBefore });
});

test('An accused administrator cannot close or enact their own removal vote', async () => {
  const f = await handoffFixture('disciplinary-accused-administrator');
  assert.equal((await admin.from('memberships').update({ role: 'administrator' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error, null);
  const voteId = await dueVote(f, f.bob.id, [f.owner, f.alice], ['remove', 'remove']);
  const deniedClose = await f.bob.client.rpc('close_disciplinary_vote', { p_intent_id: randomUUID(), p_vote_id: voteId });
  assert.equal(deniedClose.error?.code, '42501');
  assert.equal((await admin.rpc('process_due_disciplinary_votes')).error, null);
  const deniedEnact = await f.bob.client.rpc('enact_disciplinary_removal', { p_intent_id: randomUUID(), p_vote_id: voteId, p_reason: 'Self removal attempt.' });
  assert.equal(deniedEnact.error?.code, '42501');
  assert.equal((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status, 'active');
});

test('The persisted threshold policy handles rounded quorum, exact two-thirds, ties, zero electorate and no turnout', async () => {
  const f = await handoffFixture('disciplinary-thresholds');
  const cases = [
    { input: [1, 1, 0], state: 'passed', required: 1 },
    { input: [4, 1, 0], state: 'failed', required: 2 },
    { input: [10, 2, 1], state: 'passed', required: 3 },
    { input: [10, 1, 2], state: 'failed', required: 3 },
    { input: [3, 1, 1], state: 'failed', required: 1 },
    { input: [0, 0, 0], state: 'failed', required: 0 },
    { input: [5, 0, 0], state: 'failed', required: 2 },
  ] as const;
  for (const item of cases) {
    const [eligible, remove, retain] = item.input;
    const result = await f.owner.client.rpc('disciplinary_vote_result', { p_eligible: eligible, p_remove: remove, p_retain: retain });
    assert.equal(result.error, null);
    assert.equal((result.data as { state: string }).state, item.state);
    assert.equal((result.data as { required_turnout: number }).required_turnout, item.required);
  }
  receipt('issue-21-thresholds', cases);
});

test('A frozen voter who is later suspended or removed cannot cast a ballot', async () => {
  const f = await handoffFixture('disciplinary-current-voter');
  const opened = await openVote(f.owner, f.community.id, f.bob.id, 'Current authorization test.', 'Vote fixture evidence.');
  assert.equal(opened.error, null);
  const voteId = (opened.data as { vote_id: string }).vote_id;
  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.alice.id, p_action: 'suspend', p_reason: 'Authorization changed.' })).error, null);
  assert.equal((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' })).error?.code, '42501');
  assert.equal((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.alice.id, p_action: 'remove', p_reason: 'Authorization changed.' })).error, null);
  assert.equal((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' })).error?.code, '42501');
  assert.equal((await admin.from('disciplinary_vote_electorate').select('voter_id').eq('vote_id', voteId).eq('voter_id', f.alice.id)).data?.length, 1);
  receipt('issue-21-current-voter-auth', { frozenVoterRemainsInSnapshot: true, suspendedDenied: true, removedDenied: true });
});

test('Foreign, accused and ineligible actors cannot cast, enact or forge vote results', async () => {
  const f = await handoffFixture('disciplinary-boundary');
  const outsider = await actor({ label: 'disciplinary-outsider' });
  const opened = await openVote(f.owner, f.community.id, f.bob.id, 'Safety concern.', 'Private supporting account.');
  assert.equal(opened.error, null);
  const voteId = (opened.data as { vote_id: string }).vote_id;
  assert.deepEqual((await outsider.client.from('disciplinary_votes').select('id').eq('id', voteId)).data, []);
  assert.deepEqual((await outsider.client.from('disciplinary_vote_evidence').select('body').eq('vote_id', voteId)).data, []);
  assert.equal((await outsider.client.rpc('read_disciplinary_vote', { p_vote_id: voteId })).error?.code, '42501');
  assert.equal((await f.bob.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' })).error?.code, '42501');
  assert.equal((await outsider.client.rpc('submit_disciplinary_response', { p_intent_id: randomUUID(), p_vote_id: voteId, p_body: 'Not authorized.' })).error?.code, '42501');
  assert.ok((await outsider.client.from('disciplinary_vote_ballots').insert({ vote_id: voteId, voter_id: outsider.id, choice: 'remove', intent_id: randomUUID(), event_id: randomUUID() })).error);
  assert.ok((await f.alice.client.from('disciplinary_votes').update({ state: 'passed', turnout: 1, remove_votes: 1, retain_votes: 0, closed_at: new Date().toISOString() }).eq('id', voteId)).error);
  assert.equal((await f.owner.client.rpc('enact_disciplinary_removal', { p_intent_id: randomUUID(), p_vote_id: voteId, p_reason: 'Forged result.' })).error?.code, '55000');
  assert.equal((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status, 'active');
  receipt('issue-21-command-boundaries', { outsiderReadDenied: true, accusedBallotDenied: true, forgedResultDenied: true, failedAndOpenRemovalDenied: true });
});
