import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { actor, admin, applyInvite, borrowingFixture, decideApplication, drillDetails, issueInvite, listingImageBytes, membershipFixture, prepareListingImage, publishDrill, publicClient, receipt } from '../../scripts/verify/backend';

test('private Community records stay scoped to the caller current membership', async () => {
  const fixture = await borrowingFixture('pilot-boundary');
  const foreign = await membershipFixture('pilot-boundary-foreign');
  const unverified = await actor({ verified: false, label: 'pilot-boundary-unverified' });
  const rejected = await actor({ label: 'pilot-boundary-rejected' });
  const rejectedInvite = await issueInvite(fixture.owner, fixture.community.id, rejected.email);
  const rejectedApplication = await applyInvite(rejected, rejectedInvite.id);
  assert.equal((await decideApplication(fixture.owner, rejectedApplication.id, 'rejected', 'Pilot boundary fixture.')).error, null);
  const pendingInvite = await issueInvite(fixture.owner, fixture.community.id, fixture.applicant.email);
  await applyInvite(fixture.applicant, pendingInvite.id);
  const statuses = await admin.from('memberships').update({ status: 'suspended' }).eq('community_id', fixture.community.id).eq('user_id', fixture.alice.id);
  assert.equal(statuses.error, null);
  const remove = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', fixture.community.id).eq('user_id', fixture.bob.id);
  assert.equal(remove.error, null);
  const listing = await publishDrill(fixture.owner, fixture.community.id);
  const image = await prepareListingImage(fixture.owner, listing.id);
  const upload = await fixture.owner.client.storage.from('listing-images').upload(image.object_path, listingImageBytes, { contentType: 'image/png' });
  assert.equal(upload.error, null);
  const cases = [
    ['unverified', unverified.client],
    ['pending', fixture.applicant.client],
    ['rejected', rejected.client],
    ['suspended', fixture.alice.client],
    ['removed', fixture.bob.client],
    ['unrelated active account', foreign.owner.client],
    ['anonymous account', publicClient()],
  ] as const;

  const ownerCommunity = await fixture.owner.client.from('communities').select('id').eq('id', fixture.community.id);
  assert.deepEqual(ownerCommunity.data, [{ id: fixture.community.id }]);
  assert.deepEqual((await fixture.carol.client.from('communities').select('id').eq('id', fixture.community.id)).data, [{ id: fixture.community.id }]);

  for (const [label, client] of cases) {
    assert.deepEqual((await client.from('communities').select('id').eq('id', fixture.community.id)).data ?? [], [], `${label} cannot read the private Community`);
    assert.deepEqual((await client.from('memberships').select('user_id').eq('community_id', fixture.community.id)).data ?? [], [], `${label} cannot enumerate its members`);
    assert.deepEqual((await client.from('community_events').select('id').eq('community_id', fixture.community.id)).data ?? [], [], `${label} cannot read its activity`);
    assert.ok((await client.from('memberships').insert({ community_id: fixture.community.id, user_id: foreign.owner.id, role: 'member', status: 'active' })).error, `${label} cannot grant membership`);
    assert.ok((await client.storage.from('listing-images').download(image.object_path)).error, `${label} cannot read a private object`);
    const command = await client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: fixture.community.id, p_listing_id: null, p_expected_version: 0, p_details: drillDetails });
    assert.equal(command.error?.code, '42501', `${label} cannot start new Community activity`);
  }
  assert.deepEqual((await fixture.carol.client.from('communities').select('id').eq('id', fixture.community.id)).data, [{ id: fixture.community.id }]);
  receipt('issue-26-rls', { activeSameCommunity: 'read allowed', deniedActors: cases.map(([label]) => label), commandAndDirectWrites: 'denied', privateStorage: 'read denied for every denied actor' });
});
