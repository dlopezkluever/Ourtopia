import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admin, completedExchanges, completedItemFixture, createHelpPost, decideBorrow, helpFixture, helpListingFields, helpNeedFields, requestItem, receipt } from '../../scripts/verify/backend';
import { pilotMetricsCsv, pilotMetricsSchema } from '../../src/features/pilot-metrics/model';

test('pilot totals use persisted records and only verified completion facts', async () => {
  const fixture = await completedItemFixture('pilot-metrics-completion');
  const request = await requestItem(fixture.bob, fixture.listing.id);
  const approved = await decideBorrow(fixture.alice, request);
  assert.equal(approved.error, null);
  const decoyStates = ['approved', 'cancelled', 'expired', 'closed_without_completion'] as const;
  const decoys = await admin.from('exchanges').insert(decoyStates.map(state => ({
    community_id: fixture.community.id,
    kind: 'item',
    provider_id: fixture.alice.id,
    receiver_id: fixture.bob.id,
    source_kind: 'listing',
    source_id: fixture.listing.id,
    state,
  }))).select('id');
  assert.equal(decoys.error, null);

  const replay = await admin.rpc('settle_exchange_completions', { p_exchange_ids: [fixture.exchangeId] });
  assert.equal(replay.error, null);
  const first = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(first.error, null);
  const metrics = pilotMetricsSchema.parse(first.data);
  assert.equal(metrics.counts.exchangesStarted, 6);
  assert.equal(metrics.counts.exchangesCompleted, 1);
  assert.equal(metrics.counts.completedContributions, 1);
  assert.equal(metrics.sources.completedExchanges.length, 1);
  assert.equal(metrics.sources.exchanges.length, 6);
  assert.equal(metrics.sources.activeMembers.length, metrics.counts.activeMembers);
  assert.ok(metrics.sources.activeMembers.every(row => !('id' in row)), 'active member sources carry only a pseudonymous key');
  for (const member of [fixture.owner, fixture.alice, fixture.bob, fixture.carol]) assert.ok(!JSON.stringify(first.data).includes(member.id), 'raw member user ids are not exported');
  assert.equal(metrics.sources.testSubscriptions.length, metrics.counts.testSubscriptions);
  assert.equal(metrics.counts.itemListings, 1);
  assert.equal(metrics.counts.borrowRequestsApproved, 1);

  const csv = pilotMetricsCsv(metrics);
  assert.match(csv, /Simulated Stripe test billing/);
  assert.match(csv, new RegExp(fixture.exchangeId));
  assert.doesNotMatch(csv, /private message|signed.?url|evidence body/i);
  receipt('issue-25-completion-totals', {
    sourceExchanges: metrics.sources.exchanges,
    completedExchanges: metrics.sources.completedExchanges,
    completionRetry: 'one persisted completion fact',
    csvHasRecordId: csv.includes(fixture.exchangeId),
  });
});

test('pilot metrics use current Community scope on every administrator read', async () => {
  const fixture = await completedItemFixture('pilot-metrics-current-admin');
  const first = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(first.error, null);
  assert.equal(pilotMetricsSchema.parse(first.data).communityId, fixture.community.id);

  const revoked = await admin.from('memberships').update({ status: 'removed' })
    .eq('community_id', fixture.community.id).eq('user_id', fixture.owner.id);
  assert.equal(revoked.error, null);
  const retryAfterRemoval = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(retryAfterRemoval.error?.code, '42501');
  receipt('issue-25-removed-admin-denied', { priorRead: 'allowed', afterRemoval: retryAfterRemoval.error?.code });
});

test('pilot metrics count each completed Exchange and repeated participant once per person', async () => {
  const fixture = await completedItemFixture('pilot-metrics-repeat');
  const completed = await completedExchanges(fixture.community.id, fixture.alice.id, fixture.bob.id, 2);
  const read = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(read.error, null);
  const metrics = pilotMetricsSchema.parse(read.data);
  assert.equal(metrics.counts.exchangesCompleted, 3);
  assert.equal(metrics.counts.completedContributions, 3);
  assert.equal(metrics.counts.repeatParticipants, 2);
  assert.equal(metrics.sources.completedExchanges.length, 3);
  const perPerson = new Map<string, Set<string>>();
  for (const row of metrics.sources.completedParticipation) perPerson.set(row.participantKey, (perPerson.get(row.participantKey) ?? new Set()).add(row.id));
  assert.equal([...perPerson.values()].filter(exchanges => exchanges.size > 1).length, metrics.counts.repeatParticipants);
  assert.equal(metrics.sources.completedParticipation.filter(row => row.status === 'contributor').length, metrics.counts.completedContributions);
  receipt('issue-25-repeat-participation', { addedExchanges: completed, completed: metrics.counts.exchangesCompleted, repeatParticipants: metrics.counts.repeatParticipants });
});

test('pilot metrics include persisted Help offers and Need Posts', async () => {
  const fixture = await helpFixture('pilot-metrics-help', 2);
  const offer = await createHelpPost(fixture.author, fixture.community.id, 'listing', helpListingFields());
  const need = await createHelpPost(fixture.author, fixture.community.id, 'need_post', helpNeedFields());
  const read = await fixture.owner.client.rpc('read_pilot_metrics', { p_community_id: fixture.community.id });
  assert.equal(read.error, null);
  const metrics = pilotMetricsSchema.parse(read.data);
  assert.equal(metrics.counts.helpOffers, 1);
  assert.equal(metrics.counts.helpNeedPosts, 1);
  assert.equal(metrics.sources.helpOffers[0]?.id, offer.id);
  assert.equal(metrics.sources.helpNeedPosts[0]?.id, need.id);
  receipt('issue-25-help-sources', { offer: metrics.sources.helpOffers[0], need: metrics.sources.helpNeedPosts[0] });
});
