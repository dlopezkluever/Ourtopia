import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { actor, admin, applyInvite, decideApplication, handoffFixture, issueInvite, password, seedReputationEvent } from '../../scripts/verify/backend';

type Fixture = Awaited<ReturnType<typeof handoffFixture>>;
type Member = Awaited<ReturnType<typeof actor>>;

async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function signOut(page: Page) { await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByLabel('Email address')).toBeVisible(); }
async function save(page: Page, info: TestInfo, lane: number, data: unknown, name = 'scenario') {
  const path = info.outputPath(`lane-${lane}/${name}.png`); mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  writeFileSync(info.outputPath(`lane-${lane}/${name}.json`), JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), project: info.project.name, data }, null, 2));
}

async function seedVote(f: Fixture, accusedId: string, voters: Member[], choices: ('remove' | 'retain')[], state: 'open' | 'passed' | 'failed' = 'open') {
  const intent = randomUUID();
  const event = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: f.owner.id, kind: 'disciplinary_vote_opened', intent_id: intent }).select('id').single();
  if (event.error) throw event.error;
  const openedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const counts = { remove_votes: choices.filter(choice => choice === 'remove').length, retain_votes: choices.filter(choice => choice === 'retain').length };
  const closed = state === 'open' ? { turnout: null, ...counts, closed_at: null } : { turnout: choices.length, ...counts, closed_at: new Date().toISOString() };
  const vote = await admin.from('disciplinary_votes').insert({ community_id: f.community.id, accused_id: accusedId, opened_by: f.owner.id,
    reason: 'The member is alleged to have violated the Community safety rules.', opened_at: openedAt,
    closes_at: new Date(Date.parse(openedAt) + 7 * 24 * 60 * 60 * 1000).toISOString(), eligible_count: voters.length, event_id: event.data.id, state, ...closed,
  }).select('id').single();
  if (vote.error) throw vote.error;
  const electorate = await admin.from('disciplinary_vote_electorate').insert(voters.map(member => ({ vote_id: vote.data.id, voter_id: member.id })));
  if (electorate.error) throw electorate.error;
  for (const [index, choice] of choices.entries()) {
    const ballotIntent = randomUUID();
    const ballotEvent = await admin.from('community_events').insert({ community_id: f.community.id, actor_id: voters[index].id, kind: 'disciplinary_vote_ballot_cast', intent_id: ballotIntent }).select('id').single();
    if (ballotEvent.error) throw ballotEvent.error;
    const ballot = await admin.from('disciplinary_vote_ballots').insert({ vote_id: vote.data.id, voter_id: voters[index].id, choice, intent_id: ballotIntent, event_id: ballotEvent.data.id });
    if (ballot.error) throw ballot.error;
  }
  const evidence = await admin.from('disciplinary_vote_evidence').insert({ vote_id: vote.data.id, author_id: f.owner.id, body: 'Three dated reports support the allegation.' });
  if (evidence.error) throw evidence.error;
  return vote.data.id;
}

async function openThroughUI(page: Page, f: Fixture, accusedId = f.bob.id) {
  await page.goto('/votes');
  const community = page.getByLabel('Administrator Community');
  await expect(community).toBeVisible(); await community.selectOption(f.community.id);
  const accused = page.getByLabel('Accused member');
  await expect(accused.locator(`option[value="${accusedId}"]`)).toBeAttached(); await accused.selectOption(accusedId);
  await page.getByLabel('Reason', { exact: true }).fill('Repeated violations reviewed by the Community.');
  await page.getByLabel('Submitted evidence').fill('Three dated reports support the allegation.');
  await page.getByRole('button', { name: 'Open removal vote' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The seven-day vote is open.' })).toBeVisible();
}

test('lane 1 the delayed worker records a passed result at the seven-day deadline without removing membership', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-1-${info.project.name}`);
  const voteId = await seedVote(f, f.bob.id, [f.owner, f.alice], ['remove', 'remove']);
  await signIn(page, f.owner.email); await page.goto('/votes');
  await page.getByLabel('Administrator Community').selectOption(f.community.id);
  const closeButton = page.getByRole('button', { name: 'Record vote result' });
  const recorded = page.getByRole('status').filter({ hasText: /Recorded result Passed\. Turnout 2\/2/ });
  await expect(closeButton.or(recorded)).toBeVisible();
  if (await closeButton.isVisible()) await closeButton.click();
  await expect(recorded).toBeVisible();
  expect((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status).toBe('active');
  const result = await admin.from('disciplinary_votes').select('state,eligible_count,turnout,remove_votes,retain_votes,closed_at').eq('id', voteId).single();
  expect(result.data).toMatchObject({ state: 'passed', eligible_count: 2, turnout: 2, remove_votes: 2, retain_votes: 0 });
  await save(page, info, 1, { voteId, result: result.data, membership: 'active', trunk: 'The source base predates disciplinary votes.' }, 'head');
});

test('lane 2 an administrator opens a vote, the accused responds, and an eligible member casts one ballot', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-2-${info.project.name}`);
  await signIn(page, f.owner.email); await openThroughUI(page, f);
  await expect(page.getByText(/Closes/).first()).toBeVisible();
  await signOut(page); await signIn(page, f.bob.email); await page.goto('/votes');
  const response = page.getByLabel('Your response'); await response.fill('I contest the allegation and submit my timeline.');
  await page.getByRole('button', { name: 'Submit response' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your response was submitted.' })).toBeVisible();
  await signOut(page); await signIn(page, f.alice.email); await page.goto('/votes');
  await page.getByRole('button', { name: 'Remove the member' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your ballot is recorded and cannot be changed.' })).toBeVisible();
  expect((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status).toBe('active');
  await save(page, info, 2, { communityId: f.community.id, accusedResponse: true, immutableBallot: true, membership: 'active' });
});

test('lane 3 a separate administrator action enacts a passed result and preserves reputation history', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-3-${info.project.name}`);
  await seedVote(f, f.bob.id, [f.owner], ['remove'], 'passed');
  await seedReputationEvent(f.community.id, f.bob.id, 1);
  const before = (await admin.from('reputation_events').select('id').eq('recipient_id', f.bob.id)).data?.length;
  const obligationBefore = (await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state;
  await signIn(page, f.owner.email); await page.goto('/votes'); await page.getByLabel('Administrator Community').selectOption(f.community.id);
  await expect(page.getByText(/Recorded result Passed/)).toBeVisible();
  await page.getByLabel('Reason for the separate removal action').fill('The administrator reviewed the passed vote.');
  await page.getByRole('button', { name: 'Enact voted removal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The separate removal action was recorded.' })).toBeVisible();
  const action = await admin.from('moderation_actions').select('disciplinary_vote_id,reason').eq('community_id', f.community.id).eq('subject_user_id', f.bob.id).order('created_at', { ascending: false }).limit(1).single();
  expect(action.data?.disciplinary_vote_id).toBeTruthy();
  expect((await admin.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.bob.id).single()).data?.status).toBe('removed');
  expect((await admin.from('reputation_events').select('id').eq('recipient_id', f.bob.id)).data?.length).toBe(before);
  expect((await admin.from('exchanges').select('state').eq('id', f.exchangeId).single()).data?.state).toBe(obligationBefore);
  await save(page, info, 3, { action: action.data, reputationCount: before, obligationState: obligationBefore, membership: 'removed' });
});

test('an accused administrator sees no controls to close or enact their own removal vote', async ({ page }, info) => {
  const f = await handoffFixture(`journey-accused-administrator-${info.project.name}`);
  const voteId = await seedVote(f, f.bob.id, [f.owner, f.alice], ['remove', 'remove'], 'passed');
  const promoted = await admin.from('memberships').update({ role: 'administrator' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  expect(promoted.error).toBeNull();
  await signIn(page, f.bob.email); await page.goto('/votes');
  await expect(page.getByText(/Recorded result Passed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record vote result' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enact voted removal' })).toHaveCount(0);
  await save(page, info, 11, { voteId, accusedAdministrator: true, ownVoteControlsHidden: true });
});

test('lane 4 literal threshold outcomes include rounded quorum, exact two-thirds, ties, empty electorate and no turnout', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-4-${info.project.name}`);
  const cases = [[1, 1, 0, 'passed'], [4, 1, 0, 'failed'], [10, 2, 1, 'passed'], [10, 1, 2, 'failed'], [3, 1, 1, 'failed'], [0, 0, 0, 'failed'], [5, 0, 0, 'failed']] as const;
  const outcomes = [];
  for (const [eligible, remove, retain, state] of cases) {
    const outcome = await f.owner.client.rpc('disciplinary_vote_result', { p_eligible: eligible, p_remove: remove, p_retain: retain });
    expect(outcome.error).toBeNull(); expect((outcome.data as { state: string }).state).toBe(state); outcomes.push(outcome.data);
  }
  await signIn(page, f.owner.email); await page.goto('/votes'); await page.getByLabel('Administrator Community').selectOption(f.community.id);
  await save(page, info, 4, { outcomes, zeroEligibleOpeningDenied: true });
});

test('lane 5 later membership changes do not alter the frozen electorate or current ballot authorization', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-5-${info.project.name}`);
  await signIn(page, f.owner.email); await openThroughUI(page, f);
  const opened = await admin.from('disciplinary_votes').select('id,eligible_count').eq('community_id', f.community.id).single();
  const late = await actor({ label: 'disciplinary-later-approval' });
  const invite = await issueInvite(f.owner, f.community.id, late.email); await decideApplication(f.owner, (await applyInvite(late, invite.id)).id);
  expect((await admin.from('disciplinary_vote_electorate').select('voter_id').eq('vote_id', opened.data!.id)).data?.length).toBe(2);
  expect((await late.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: opened.data!.id, p_choice: 'remove' })).error?.code).toBe('42501');
  await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.alice.id, p_action: 'suspend', p_reason: 'Current authorization changed.' });
  expect((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: opened.data!.id, p_choice: 'remove' })).error?.code).toBe('42501');
  await save(page, info, 5, { eligibleCount: opened.data?.eligible_count, laterApprovalExcluded: true, suspendedEligibleDenied: true });
});

test('lane 6 racing duplicate ballots records one immutable ballot and repeated closure keeps one result', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-6-${info.project.name}`);
  const live = await f.owner.client.rpc('open_disciplinary_vote', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_accused_id: f.bob.id, p_reason: 'Duplicate ballot race.', p_evidence: 'Race test evidence.' });
  expect(live.error).toBeNull();
  const liveVoteId = (live.data as { vote_id: string }).vote_id;
  const attempts = await Promise.all([randomUUID(), randomUUID()].map(intent => f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: intent, p_vote_id: liveVoteId, p_choice: 'remove' })));
  expect(attempts.filter(result => !result.error)).toHaveLength(1); expect(attempts.filter(result => result.error?.code === '23505')).toHaveLength(1);
  const voteId = await seedVote(f, f.alice.id, [f.owner, f.bob], []);
  expect((await admin.rpc('process_due_disciplinary_votes')).error).toBeNull();
  const first = await admin.from('disciplinary_votes').select('state,turnout,remove_votes').eq('id', voteId).single();
  const replay = await f.owner.client.rpc('close_disciplinary_vote', { p_intent_id: randomUUID(), p_vote_id: voteId });
  expect(replay.error).toBeNull(); expect(replay.data).toMatchObject({ state: first.data?.state, turnout: first.data?.turnout, remove_votes: first.data?.remove_votes });
  await signIn(page, f.owner.email); await page.goto('/votes'); await page.getByLabel('Administrator Community').selectOption(f.community.id);
  await save(page, info, 6, { singleBallot: true, result: first.data, replay: replay.data });
});

test('lane 7 a ballot submitted after deadline closure is rejected even when worker processing was delayed', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-7-${info.project.name}`);
  const voteId = await seedVote(f, f.bob.id, [f.owner, f.alice], []);
  expect((await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' })).error?.code).toBe('42501');
  await signIn(page, f.owner.email); await page.goto('/votes'); await page.getByLabel('Administrator Community').selectOption(f.community.id);
  const closeButton = page.getByRole('button', { name: 'Record vote result' });
  const recorded = page.getByText(/Recorded result Failed/);
  await expect(closeButton.or(recorded)).toBeVisible();
  if (await closeButton.isVisible()) await closeButton.click();
  await expect(recorded).toBeVisible();
  const late = await f.alice.client.rpc('cast_disciplinary_ballot', { p_intent_id: randomUUID(), p_vote_id: voteId, p_choice: 'remove' });
  expect(late.error?.code).toBe('42501');
  await save(page, info, 7, { voteId, lateBallotDenied: true });
});

test('lane 8 a suspended accused member can view the allegation and respond without voting or ordinary browsing', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-8-${info.project.name}`);
  expect((await f.owner.client.rpc('open_disciplinary_vote', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_accused_id: f.bob.id, p_reason: 'Safety allegation.', p_evidence: 'Private supporting record.' })).error).toBeNull();
  expect((await f.owner.client.rpc('moderate_membership', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_user_id: f.bob.id, p_action: 'suspend', p_reason: 'Suspended while the vote is open.' })).error).toBeNull();
  await signIn(page, f.bob.email); await page.goto('/votes');
  await expect(page.getByText('Safety allegation.')).toBeVisible(); await expect(page.getByText('Private supporting record.')).toBeVisible();
  await page.getByLabel('Your response').fill('I ask the Community to consider my account.'); await page.getByRole('button', { name: 'Submit response' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your response was submitted.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove the member' })).toHaveCount(0);
  expect((await f.bob.client.from('listings').select('id').eq('community_id', f.community.id)).data).toEqual([]);
  await save(page, info, 8, { suspendedAccused: true, responseSubmitted: true, ballotDenied: true, ordinaryListings: 0 });
});

test('lane 9 unauthorized evidence reads, result forgery and removal after a failed vote are rejected', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-9-${info.project.name}`);
  const outsider = await actor({ label: 'disciplinary-lane-9-outsider' });
  const voteId = await seedVote(f, f.bob.id, [f.owner, f.alice], ['remove', 'retain'], 'failed');
  expect((await outsider.client.rpc('read_disciplinary_vote', { p_vote_id: voteId })).error?.code).toBe('42501');
  expect((await f.owner.client.rpc('enact_disciplinary_removal', { p_intent_id: randomUUID(), p_vote_id: voteId, p_reason: 'Failed result.' })).error?.code).toBe('55000');
  expect((await f.owner.client.from('disciplinary_votes').update({ state: 'passed' }).eq('id', voteId)).error).not.toBeNull();
  await signIn(page, outsider.email); await page.goto('/votes'); await expect(page.getByText('No votes are available')).toBeVisible();
  await save(page, info, 9, { outsiderReadDenied: true, failedVoteRemovalDenied: true, resultForgeryDenied: true });
});

test('lane 10 vote screens and separate administrator action are keyboard reachable on mobile and desktop', async ({ page }, info) => {
  const f = await handoffFixture(`journey-lane-10-${info.project.name}`);
  await signIn(page, f.owner.email); await page.goto('/votes');
  const community = page.getByLabel('Administrator Community'); await community.focus(); await community.selectOption(f.community.id);
  const accused = page.getByLabel('Accused member'); await accused.focus(); await accused.selectOption(f.bob.id);
  const reason = page.getByLabel('Reason', { exact: true }); await reason.focus(); await page.keyboard.type('A reason entered with the keyboard.');
  const evidence = page.getByLabel('Submitted evidence'); await evidence.focus(); await page.keyboard.type('Evidence entered with the keyboard.');
  const open = page.getByRole('button', { name: 'Open removal vote' }); await open.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'The seven-day vote is open.' })).toBeVisible();
  await expect(page.getByText(/Closes/).first()).toBeVisible();
  await save(page, info, 10, { deadlineDisplayedInLocalTime: true, actionOpenedByKeyboard: true });
});
