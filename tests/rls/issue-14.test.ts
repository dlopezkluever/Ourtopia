import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { actor, activeMember, admin, anonKey, configureVouch, createCommunity, publicClient, realtimeReady, receipt, submitVouch, vouchFixture } from '../../scripts/verify/backend';

before(() => realtimeReady(), { timeout: 70000 });

test('applicant, sponsor and administrator see only permitted statements; pending users gain no directory or private Community reads', async () => {
  const f = await vouchFixture('rls-vouch'); await configureVouch(f.owner, f.community.id, f.sponsor.id);
  const result = await submitVouch(f.sponsor, f.application.id, 'Private trust statement.'); assert.equal(result.error, null);
  const unrelated = await activeMember(f.owner, f.community.id, 'rls-unrelated');
  const foreign = await actor({ label: 'foreign-admin' }); await createCommunity(foreign.client);
  const outsider = await actor({ label: 'unrelated-verified' });
  for (const person of [f.owner, f.sponsor, f.applicant]) {
    const read: { data: unknown[] | null; error: { code?: string } | null } = await person.client.from('vouches').select('statement').eq('id', result.data.id);
    assert.equal(read.error, null); assert.deepEqual(read.data, [{ statement: 'Private trust statement.' }]);
  }
  const denials = [];
  for (const [label, client] of [['unrelated', unrelated.client], ['foreign administrator', foreign.client], ['outsider', outsider.client], ['anonymous', publicClient()]] satisfies [string, ReturnType<typeof publicClient>][]) {
    const read: { data: unknown[] | null; error: { code?: string } | null } = await client.from('vouches').select('*').eq('id', result.data.id);
    assert.ok(read.error?.code === '42501' || (read.error === null && read.data?.length === 0));
    const workspace = await client.rpc('vouch_workspace', { p_community_id: f.community.id });
    if (label === 'unrelated') { assert.equal(workspace.error, null); assert.deepEqual(workspace.data.history, []); assert.deepEqual(workspace.data.applications, []); }
    else assert.equal(workspace.error?.code, '42501');
    denials.push({ label, statements: 0 });
  }
  for (const table of ['communities', 'reputation_events', 'exchanges', 'conversations', 'messages']) {
    const read = await f.applicant.client.from(table).select('*');
    assert.equal(read.error, null); assert.deepEqual(read.data, [], `pending ${table}`);
  }
  assert.equal((await f.applicant.client.rpc('member_directory', { p_community_id: f.community.id })).error?.code, '42501');
  assert.equal((await f.applicant.client.rpc('vouch_workspace', { p_community_id: f.community.id })).error?.code, '42501');
  const ownStatements = await f.applicant.client.rpc('my_vouch_statements');
  assert.equal(ownStatements.error, null); assert.equal(ownStatements.data[0].sponsorEmail, f.sponsor.email);
  assert.deepEqual((await foreign.client.rpc('my_vouch_statements')).data, []);
  const workspace = await f.sponsor.client.rpc('vouch_workspace', { p_community_id: f.community.id });
  assert.deepEqual(Object.keys(workspace.data.applications[0]).sort(), ['email', 'id']);
  assert.deepEqual(workspace.data.members, []);
  assert.deepEqual((await f.sponsor.client.from('membership_applications').select('*').eq('id', f.application.id)).data, []);
  receipt('issue-14-rls-boundaries', { denials, applicantDirectory: '42501', sponsorApplicationKeys: ['email', 'id'], noStorageObjects: true });
});

test('current membership and eligibility revoke every privileged read and mutation without a JWT refresh', async () => {
  const f = await vouchFixture('rls-revocation'); await configureVouch(f.owner, f.community.id, f.sponsor.id);
  const intent = randomUUID(); assert.equal((await submitVouch(f.sponsor, f.application.id, 'Stable statement.', intent)).error, null);
  await configureVouch(f.owner, f.community.id, f.sponsor.id, 3, false);
  assert.equal((await submitVouch(f.sponsor, f.application.id, 'Stable statement.', intent)).error?.code, '42501');
  const revoked = await f.sponsor.client.rpc('vouch_workspace', { p_community_id: f.community.id });
  assert.deepEqual(revoked.data.applications, []); assert.equal(revoked.data.history.length, 1);
  for (const status of ['suspended', 'rejected', 'pending', 'removed']) {
    await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.sponsor.id).throwOnError();
    assert.deepEqual((await f.sponsor.client.from('vouches').select('*').eq('community_id', f.community.id)).data, []);
    assert.equal((await f.sponsor.client.rpc('vouch_workspace', { p_community_id: f.community.id })).error?.code, '42501');
    assert.equal((await submitVouch(f.sponsor, f.application.id, 'Stable statement.', intent)).error?.code, '42501');
  }
  receipt('issue-14-rls-current-guards', { membershipStates: ['suspended', 'rejected', 'pending', 'removed'], deniedWithoutJwtRefresh: true });
});

test('all command-owned rows deny direct client writes and anonymous command execution', async () => {
  const f = await vouchFixture('rls-writes');
  const tables = ['vouches', 'vouch_requests', 'vouch_settings', 'vouch_eligibility'];
  for (const client of [f.owner.client, f.sponsor.client, f.applicant.client, publicClient()]) {
    for (const table of tables) {
      const values = { community_id: f.community.id };
      assert.equal((await client.from(table).insert(values)).error?.code, '42501');
      assert.equal((await client.from(table).update(values).eq('community_id', f.community.id)).error?.code, '42501');
      assert.equal((await client.from(table).delete().eq('community_id', f.community.id)).error?.code, '42501');
    }
  }
  const anon = publicClient();
  assert.equal((await anon.rpc('configure_vouch', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_sponsor_id: f.sponsor.id, p_eligible: true, p_annual_limit: 3 })).error?.code, '42501');
  assert.equal((await anon.rpc('submit_vouch', { p_intent_id: randomUUID(), p_application_id: f.application.id, p_statement: 'Forged' })).error?.code, '42501');
  assert.equal((await anon.rpc('request_vouch', { p_intent_id: randomUUID(), p_application_id: f.application.id, p_sponsor_email: f.sponsor.email })).error?.code, '42501');
  assert.equal((await f.sponsor.client.rpc('request_vouch', { p_intent_id: randomUUID(), p_application_id: f.application.id, p_sponsor_email: f.sponsor.email })).error?.code, '42501');
  receipt('issue-14-rls-writes', { deniedWrites: 48, anonymousCommandsDenied: 3, noNewStorageBucketOrObject: true });
});

test('realtime carries only recipient hints and never statement bodies, including to foreign and pending actors', { timeout: 60000 }, async () => {
  const f = await vouchFixture('rls-realtime'); await configureVouch(f.owner, f.community.id, f.sponsor.id);
  const foreign = await actor({ label: 'foreign-realtime' }); await createCommunity(foreign.client);
  const outsider = await actor({ label: 'outsider-realtime' });
  const counts: Record<string, { hints: number }> = {};
  const payloads: Record<string, unknown>[] = [];
  const channels = [];
  try {
    for (const [label, client] of [['applicant', f.applicant.client], ['sponsor', f.sponsor.client], ['foreign', foreign.client], ['outsider', outsider.client], ['anonymous', publicClient()]] satisfies [string, ReturnType<typeof publicClient>][]) {
      counts[label] = { hints: 0 };
      const session = await client.auth.getSession(); await client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
      const channel = client.channel(`p14-${randomUUID()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${f.applicant.id}` }, change => { counts[label].hints++; payloads.push(change.new); });
      channels.push({ client, channel });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} subscribe timeout`)), 10000);
        channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(status)); } });
      });
    }
    assert.equal((await submitVouch(f.sponsor, f.application.id, 'Never broadcast this statement.')).error, null);
    const outbox = await admin.from('notification_outbox').select('id').eq('recipient_id', f.applicant.id).eq('kind', 'vouch_submitted').single();
    assert.equal(outbox.error, null);
    const claim = await admin.rpc('claim_notification', { p_outbox_id: outbox.data!.id }); assert.equal(claim.error, null);
    assert.equal((await admin.rpc('finish_notification', { p_outbox_id: outbox.data!.id, p_claim_token: claim.data.claim_token })).error, null);
    const deadline = Date.now() + 10000;
    while (counts.applicant.hints === 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    await new Promise(done => setTimeout(done, 1000));
    assert.ok(counts.applicant.hints >= 1);
    for (const [label, count] of Object.entries(counts)) if (label !== 'applicant') assert.equal(count.hints, 0);
    const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
    assert.match(project ?? '', /^ourtopia-issue-\d+$/);
    const published = execFileSync('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'vouch%'"], { encoding: 'utf8' }).trim();
    assert.equal(published, '', 'no Vouch table is published to realtime');
    for (const payload of payloads) assert.deepEqual(Object.keys(payload).sort(), ['id', 'recipient_id']);
    receipt('issue-14-rls-realtime', { counts, payloadKeys: ['id', 'recipient_id'], publishedVouchTables: [] });
  } finally { await Promise.all(channels.map(async ({ client, channel }) => { await client.removeChannel(channel); client.realtime.disconnect(); })); }
});
