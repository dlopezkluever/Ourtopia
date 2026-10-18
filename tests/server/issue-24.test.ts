import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { admin, membershipFixture, activeMember, drillDetails, helpListingFields, helpNeedFields, receipt, handoffFixture, advanceHandoff, listingImageBytes } from '../../scripts/verify/backend';
import { resultSchema } from '../../src/features/drafts/model';
import { recoverEvidence } from '../../src/features/evidence/recovery';
import { clearProtectedClientStorage, clearRevokedProtectedStorage, protectedStorage } from '../../src/features/pwa/privacy';

test('Draft saves serialize revisions, replay identical intents, and reject changed payloads without effects', async () => {
  const { owner, community } = await membershipFixture('draft-command');
  const args = { p_intent_id: randomUUID(), p_owner_id: owner.id, p_community_id: community.id, p_kind: 'item', p_expected_revision: 0, p_action: 'save', p_fields: { title: 'A practical unfinished item', condition: 'Small mark' } };
  const first = await owner.client.rpc('command_contribution_draft', args); assert.equal(first.error, null);
  assert.equal(resultSchema.parse(first.data).draft.revision, 1);
  assert.deepEqual((await owner.client.rpc('command_contribution_draft', args)).data, first.data);
  assert.equal((await owner.client.rpc('command_contribution_draft', { ...args, p_fields: { title: 'Changed' } })).error?.code, '23505');
  const concurrent = await Promise.all(['Window one', 'Window two'].map(title => owner.client.rpc('command_contribution_draft', { ...args, p_intent_id: randomUUID(), p_expected_revision: 1, p_fields: { title } })));
  assert.deepEqual(concurrent.map(result => result.error?.code ?? 'ok').sort(), ['40001', 'ok']);
  const rows = await owner.client.from('contribution_drafts').select('*'); assert.equal(rows.data?.length, 1); assert.equal(rows.data?.[0].revision, 2);
  const audit = await admin.from('community_events').select('id').eq('community_id', community.id).eq('kind', 'contribution_draft_save'); assert.equal(audit.data?.length, 2);
  receipt('issue-24-draft-idempotency', { identical: first.data, changed: '23505', concurrent: ['40001', 'ok'], events: audit.data?.length });
});

test('Publication is atomic with existing item and Help commands; failed publication keeps the saved draft', async () => {
  const { owner, community } = await membershipFixture('draft-publish');
  for (const [kind, fields] of [['item', drillDetails], ['help_offer', helpListingFields()], ['help_need', helpNeedFields()]] as const) {
    const base = { p_owner_id: owner.id, p_community_id: community.id, p_kind: kind, p_fields: fields };
    assert.equal((await owner.client.rpc('command_contribution_draft', { ...base, p_intent_id: randomUUID(), p_expected_revision: 0, p_action: 'save' })).error, null);
    const args = { ...base, p_intent_id: randomUUID(), p_expected_revision: 1, p_action: 'publish' };
    const published = await owner.client.rpc('command_contribution_draft', args); assert.equal(published.error, null);
    const result = resultSchema.parse(published.data); assert.equal(result.draft.status, 'published'); assert.deepEqual(result.draft.fields, {}); assert.ok(result.published?.id);
    assert.deepEqual((await owner.client.rpc('command_contribution_draft', args)).data, published.data);
    const table = kind === 'item' ? 'listings' : kind === 'help_offer' ? 'help_listings' : 'help_need_posts';
    const durable = await owner.client.from(table).select('id,title').eq('id', result.published!.id); assert.equal(durable.data?.length, 1); assert.equal(durable.data?.[0].title, fields.title);
    receipt(`issue-24-publish-${kind}`, { result, durable: durable.data });
  }
  const member = await activeMember(owner, community.id, 'invalid-draft');
  const base = { p_owner_id: member.id, p_community_id: community.id, p_kind: 'item', p_fields: { title: 'Not enough to publish' } };
  assert.equal((await member.client.rpc('command_contribution_draft', { ...base, p_intent_id: randomUUID(), p_expected_revision: 0, p_action: 'save' })).error, null);
  const intent = randomUUID();
  assert.ok((await member.client.rpc('command_contribution_draft', { ...base, p_intent_id: intent, p_expected_revision: 1, p_action: 'publish' })).error);
  const draft = await member.client.from('contribution_drafts').select('revision,status,fields'); assert.deepEqual(draft.data, [{ revision: 1, status: 'editing', fields: base.p_fields }]);
  assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', member.id).eq('intent_id', intent)).data, []);
  assert.deepEqual((await admin.from('listings').select('id').eq('owner_id', member.id)).data, []);
  assert.deepEqual((await admin.from('community_events').select('id').eq('actor_id', member.id).eq('kind', 'contribution_draft_publish')).data, []);
});

test('Draft validation, discard, and revoked membership are authoritative on every retry', async () => {
  const { owner, community } = await membershipFixture('draft-revoked');
  const member = await activeMember(owner, community.id);
  const args = { p_intent_id: randomUUID(), p_owner_id: member.id, p_community_id: community.id, p_kind: 'help_offer', p_expected_revision: 0, p_action: 'save', p_fields: { title: 'Unfinished help' } };
  for (const invalid of [{ p_kind: 'unknown' }, { p_action: 'unknown' }, { p_fields: { title: 'x'.repeat(25000) } }, { p_expected_revision: -1 }]) assert.equal((await member.client.rpc('command_contribution_draft', { ...args, ...invalid })).error?.code, '22023');
  assert.equal((await member.client.rpc('command_contribution_draft', args)).error, null);
  for (const status of ['suspended', 'removed']) {
    assert.equal((await admin.from('memberships').update({ status }).eq('user_id', member.id).eq('community_id', community.id)).error, null);
    assert.equal((await member.client.rpc('command_contribution_draft', args)).error?.code, '42501');
    assert.equal((await member.client.rpc('command_contribution_draft', { ...args, p_intent_id: randomUUID(), p_expected_revision: 1, p_action: 'publish' })).error?.code, '42501');
    assert.deepEqual((await member.client.from('contribution_drafts').select('*')).data, []);
  }
  assert.equal((await admin.from('memberships').update({ status: 'active' }).eq('user_id', member.id).eq('community_id', community.id)).error, null);
  const discarded = await member.client.rpc('command_contribution_draft', { ...args, p_intent_id: randomUUID(), p_expected_revision: 1, p_action: 'discard', p_fields: {} });
  assert.equal(discarded.error, null); assert.equal(resultSchema.parse(discarded.data).draft.status, 'discarded'); assert.deepEqual(resultSchema.parse(discarded.data).draft.fields, {});
});

test('A failure after nested publication rolls back the post, draft, child intent and audit together', async () => {
  const { owner, community } = await membershipFixture('draft-late-rollback');
  const base = { p_owner_id: owner.id, p_community_id: community.id, p_kind: 'item', p_fields: drillDetails };
  assert.equal((await owner.client.rpc('command_contribution_draft', { ...base, p_intent_id: randomUUID(), p_expected_revision: 0, p_action: 'save' })).error, null);
  const intent = randomUUID();
  assert.equal((await admin.from('community_events').insert({ community_id: community.id, actor_id: owner.id, intent_id: intent, kind: 'contribution_draft_publish' })).error, null);
  const failed = await owner.client.rpc('command_contribution_draft', { ...base, p_intent_id: intent, p_expected_revision: 1, p_action: 'publish' }); assert.equal(failed.error?.code, '23505');
  assert.deepEqual((await admin.from('listings').select('id').eq('community_id', community.id)).data, []);
  assert.deepEqual((await owner.client.from('contribution_drafts').select('revision,status').eq('community_id', community.id)).data, [{ revision: 1, status: 'editing' }]);
  assert.deepEqual((await admin.from('command_intents').select('intent_id').eq('actor_id', owner.id).eq('command', 'save_listing')).data, []);
  assert.deepEqual((await admin.from('community_events').select('id').eq('community_id', community.id).eq('kind', 'listing_created')).data, []);
  assert.equal((await owner.client.rpc('command_contribution_draft', { ...base, p_intent_id: randomUUID(), p_expected_revision: 1, p_action: 'publish' })).error, null);
  assert.equal((await admin.from('listings').select('id').eq('community_id', community.id)).data?.length, 1);
  receipt('issue-24-late-rollback', { injected: 'Final outer audit unique violation', failed: '23505', afterFailure: { listings: 0, revision: 1, childIntents: 0 }, subsequentPublishCount: 1 });
});

test('Kind-independent evidence recovery completes a real interrupted object once without changing Exchange state', async () => {
  const f = await handoffFixture('draft-recovery'); await advanceHandoff(f, 'schedule');
  const file = new File([listingImageBytes], 'camera.png', { type: 'image/png' });
  const attempt = { id: randomUUID(), prepare: randomUUID(), complete: randomUUID() };
  let interrupt = true;
  const adapter = {
    authorize: async () => { const result = await f.bob.client.rpc('read_item_handoff', { p_exchange_id: f.exchangeId }); if (result.error) throw result.error; },
    prepare: async () => { const result = await f.bob.client.rpc('prepare_exchange_evidence', { p_intent_id: attempt.prepare, p_exchange_id: f.exchangeId, p_evidence_id: attempt.id, p_mime_type: file.type, p_byte_size: file.size }); if (result.error) throw result.error; return result.data; },
    upload: async (path: string, blob: File) => { const result = await f.bob.client.storage.from('exchange-evidence').upload(path, blob, { contentType: blob.type }); if (interrupt) { interrupt = false; throw new Error('Connection interrupted after object commit'); } return result; },
    download: async (path: string) => (await f.bob.client.storage.from('exchange-evidence').download(path)).data,
    complete: async () => { const result = await f.bob.client.rpc('complete_exchange_evidence', { p_intent_id: attempt.complete, p_evidence_id: attempt.id }); if (result.error) throw result.error; return result.data; },
  };
  await assert.rejects(recoverEvidence(file, attempt, adapter), /Connection interrupted/);
  const ready = await recoverEvidence(file, attempt, adapter); assert.equal(ready.id, attempt.id); assert.equal(ready.state, 'ready');
  assert.equal((await recoverEvidence(file, attempt, adapter)).id, ready.id);
  const rows = await f.bob.client.from('exchange_evidence').select('id,state').eq('exchange_id', f.exchangeId); assert.deepEqual(rows.data, [{ id: attempt.id, state: 'ready' }]);
  const objects = await admin.storage.from('exchange-evidence').list(f.exchangeId); assert.equal(objects.data?.length, 1);
  assert.deepEqual((await admin.from('exchanges').select('state').eq('id', f.exchangeId)).data, [{ state: 'handoff_pending' }]);
  assert.equal((await admin.from('exchange_events').select('id').eq('exchange_id', f.exchangeId).eq('kind', 'item_evidence_completed')).data?.length, 1);
  receipt('issue-24-evidence-recovery', { evidence: rows.data, objectCount: objects.data?.length, state: 'handoff_pending', adapter: 'shared Handoff/Return contract' });
});

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  keys() { return [...this.map.keys()].sort(); }
}
function protectedFixture() {
  const user = randomUUID(); const other = randomUUID(); const kept = randomUUID(); const lost = randomUUID(); const exchange = randomUUID();
  const session = new MemoryStorage(); const local = new MemoryStorage();
  const keys = {
    listingKept: `listing-draft-${user}-${kept}-new`, listingKeptIntent: `listing-draft-${user}-${kept}-new-intent`,
    listingLost: `listing-draft-${user}-${lost}-new`, needKept: `item-need-draft-${user}-${kept}-new`, needLost: `item-need-draft-${user}-${lost}-new`,
    otherAccount: `listing-draft-${other}-${kept}-new`, startKept: `message-start-${kept}-${other}`, startLost: `message-start-${lost}-${other}`,
    message: `message-draft-${user}-${randomUUID()}`, handoff: `handoff-command-${user}-${exchange}-1-schedule-{}`,
    upload: `handoff-upload-${user}-${exchange}-image/png-3-abc`, dispute: `dispute-command-${user}-{"text":"private"}`,
    unrelated: `billing-intent-${user}-${kept}-checkout`,
  };
  for (const key of Object.values(keys)) session.setItem(key, 'private');
  local.setItem(keys.needLost, 'private');
  return { user, kept, lost, session, local, keys };
}

test('Protected storage: every Community-scoped draft and intent prefix is in the one shared list', () => {
  assert.deepEqual(protectedStorage.map(entry => entry.prefix), ['listing-draft-', 'item-need-draft-', 'message-start-', 'message-draft-', 'handoff-command-', 'handoff-upload-', 'dispute-command-', 'membership-intent-']);
});

test('Protected storage: sign-out and account change clear item-need drafts with every other protected prefix', () => {
  const { session, local, keys } = protectedFixture();
  clearProtectedClientStorage([session, local]);
  assert.deepEqual(session.keys(), [keys.unrelated]);
  assert.deepEqual(local.keys(), []);
});

test('Protected storage: a refresh that confirms current access keeps drafts and request ids', () => {
  const { user, kept, lost, session, local, keys } = protectedFixture();
  const before = session.keys().filter(key => key !== keys.otherAccount);
  clearRevokedProtectedStorage(user, new Set([kept, lost]), false, [session, local]);
  assert.deepEqual(session.keys(), before);
  assert.deepEqual(local.keys(), [keys.needLost]);
});

test('Protected storage: a refresh that shows lost access clears only the revoked Community and other accounts', () => {
  const { user, kept, session, local, keys } = protectedFixture();
  clearRevokedProtectedStorage(user, new Set([kept]), true, [session, local]);
  assert.deepEqual(session.keys(), [keys.dispute, keys.upload, keys.handoff, keys.listingKept, keys.listingKeptIntent, keys.needKept, keys.startKept, keys.unrelated].sort());
  assert.deepEqual(local.keys(), []);
});
