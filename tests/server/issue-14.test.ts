import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { actor, admin, configureVouch, createCommunity, decideApplication, pendingVouchApplicant, receipt, submitVouch, vouchFixture } from '../../scripts/verify/backend';

test('administrator configuration defaults to three, replays exactly, and requires current same-Community authority', async () => {
  const f = await vouchFixture('configuration');
  assert.equal((await f.sponsor.client.rpc('vouch_workspace', { p_community_id: f.community.id })).data.annualLimit, 3);
  const intent = randomUUID();
  const result = await configureVouch(f.owner, f.community.id, f.sponsor.id, 2, true, intent);
  assert.equal(result.error, null);
  assert.deepEqual((await configureVouch(f.owner, f.community.id, f.sponsor.id, 2, true, intent)).data, result.data);
  assert.equal((await configureVouch(f.owner, f.community.id, f.sponsor.id, 3, true, intent)).error?.code, '23505');
  assert.equal((await configureVouch(f.sponsor, f.community.id, f.sponsor.id)).error?.code, '42501');
  const foreign = await actor({ label: 'foreign-vouch-admin' }); await createCommunity(foreign.client);
  assert.equal((await configureVouch(foreign, f.community.id, f.sponsor.id)).error?.code, '42501');
  assert.equal((await configureVouch(f.owner, f.community.id, f.sponsor.id, -1)).error?.code, '22023');
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.owner.id).throwOnError();
  assert.equal((await configureVouch(f.owner, f.community.id, f.sponsor.id, 2, true, intent)).error?.code, '42501');
  receipt('issue-14-configuration', { replay: result.data, revokedRetry: '42501' });
});

test('request and statement use durable in-app outbox, preserve pending membership and all standing, and replay once', async () => {
  const f = await vouchFixture('primary');
  assert.equal((await configureVouch(f.owner, f.community.id, f.sponsor.id)).error, null);
  const before = (await f.sponsor.client.rpc('my_reputation')).data;
  const requestIntent = randomUUID();
  const requestArgs = { p_intent_id: requestIntent, p_application_id: f.application.id, p_sponsor_email: f.sponsor.email };
  const request = await f.applicant.client.rpc('request_vouch', requestArgs);
  assert.equal(request.error, null);
  assert.deepEqual((await f.applicant.client.rpc('request_vouch', requestArgs)).data, request.data);
  assert.equal((await f.applicant.client.rpc('request_vouch', { ...requestArgs, p_sponsor_email: f.owner.email })).error?.code, '23505');
  const intent = randomUUID();
  const result = await submitVouch(f.sponsor, f.application.id, 'A dependable neighbor.', intent);
  assert.equal(result.error, null);
  assert.deepEqual((await submitVouch(f.sponsor, f.application.id, 'A dependable neighbor.', intent)).data, result.data);
  assert.equal((await submitVouch(f.sponsor, f.application.id, 'Different.', intent)).error?.code, '23505');
  assert.equal((await submitVouch(f.sponsor, f.application.id)).error?.code, '23505');
  assert.deepEqual((await f.sponsor.client.rpc('my_reputation')).data, before);
  assert.deepEqual((await f.applicant.client.from('memberships').select('status').eq('community_id', f.community.id)).data, [{ status: 'pending' }]);
  assert.deepEqual((await f.applicant.client.from('communities').select('*')).data, []);
  assert.deepEqual((await admin.from('qualifying_interactions').select('id').eq('community_id', f.community.id)).data, []);
  assert.deepEqual((await admin.from('reputation_events').select('id').eq('community_id', f.community.id)).data, []);
  const outbox = await admin.from('notification_outbox').select('*').eq('community_id', f.community.id).in('kind', ['vouch_requested', 'vouch_submitted']);
  assert.equal(outbox.data?.length, 3);
  assert.ok(outbox.data?.every(item => item.channel === 'in_app'));
  for (const item of outbox.data ?? []) {
    if (item.kind === 'vouch_requested') {
      const failed = await admin.rpc('claim_notification', { p_outbox_id: item.id }); assert.equal(failed.error, null);
      assert.equal((await admin.rpc('finish_notification', { p_outbox_id: item.id, p_claim_token: failed.data.claim_token, p_error: 'Forced delivery failure.' })).error, null);
      const retry = await f.owner.client.rpc('retry_notification', { p_intent_id: randomUUID(), p_outbox_id: item.id }); assert.equal(retry.error, null);
      assert.equal((await admin.from('vouches').select('id').eq('community_id', f.community.id)).data?.length, 1);
    }
    const claim = await admin.rpc('claim_notification', { p_outbox_id: item.id }); assert.equal(claim.error, null);
    const delivered = await admin.rpc('finish_notification', { p_outbox_id: item.id, p_claim_token: claim.data.claim_token }); assert.equal(delivered.error, null);
    assert.equal((await admin.rpc('finish_notification', { p_outbox_id: item.id, p_claim_token: claim.data.claim_token })).error, null);
  }
  assert.equal((await f.applicant.client.from('notifications').select('id').eq('kind', 'vouch_submitted')).data?.length, 1);
  assert.equal((await f.sponsor.client.from('notifications').select('id').eq('kind', 'vouch_requested')).data?.length, 1);
  receipt('issue-14-primary', { result: result.data, standing: before, outbox: outbox.data, pending: true, noPointsOrWeight: true });
});

test('rolling quota and duplicate races serialize atomically with no partial events or intents', async () => {
  const f = await vouchFixture('quota-race');
  await configureVouch(f.owner, f.community.id, f.sponsor.id, 1);
  const other = await pendingVouchApplicant(f.owner, f.community.id);
  const results = await Promise.all([submitVouch(f.sponsor, f.application.id), submitVouch(f.sponsor, other.application.id)]);
  assert.equal(results.filter(result => !result.error).length, 1);
  assert.equal(results.find(result => result.error)?.error?.code, '54000');
  assert.equal((await admin.from('vouches').select('id').eq('community_id', f.community.id)).data?.length, 1);
  assert.equal((await admin.from('community_events').select('id').eq('community_id', f.community.id).eq('kind', 'vouch_submitted')).data?.length, 1);
  await configureVouch(f.owner, f.community.id, f.sponsor.id, 3);
  const next = await pendingVouchApplicant(f.owner, f.community.id);
  const duplicates = await Promise.all([submitVouch(f.sponsor, next.application.id), submitVouch(f.sponsor, next.application.id)]);
  assert.equal(duplicates.filter(result => !result.error).length, 1);
  assert.equal(duplicates.find(result => result.error)?.error?.code, '23505');
  receipt('issue-14-races', { quota: results, duplicates });
});

test('rolling calendar-year boundary excludes the exact anniversary and includes a later microsecond', async () => {
  const f = await vouchFixture('year-boundary');
  await configureVouch(f.owner, f.community.id, f.sponsor.id, 1);
  const historical = await pendingVouchApplicant(f.owner, f.community.id);
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1];
  assert.match(project ?? '', /^ourtopia-issue-\d+$/);
  const run = (offset: string) => execFileSync('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { encoding: 'utf8', input: `begin;
    do $$ declare event uuid := gen_random_uuid(); begin
    insert into public.community_events(id,community_id,actor_id,kind,intent_id) values(event,'${f.community.id}','${f.sponsor.id}','fixture',gen_random_uuid());
    insert into public.vouches(community_id,application_id,applicant_id,sponsor_id,statement,event_id,created_at) values('${f.community.id}','${historical.application.id}','${historical.applicant.id}','${f.sponsor.id}','Historical',event,statement_timestamp()-interval '1 year' ${offset});
    perform set_config('request.jwt.claim.sub','${f.sponsor.id}',true);
    perform public.submit_vouch(gen_random_uuid(),'${f.application.id}','Boundary statement');
    end $$;
    rollback;` });
  assert.doesNotThrow(() => run(''));
  assert.throws(() => run("+ interval '1 microsecond'"), /rolling-year Vouch limit/);
  receipt('issue-14-boundary', { exactAnniversaryExcluded: true, microsecondAfterIncluded: true, clock: 'statement_timestamp, calendar year, transaction-local' });
});

test('ineligible, foreign, removed, suspended and terminal applicants cannot receive new statements', async () => {
  const f = await vouchFixture('guards');
  assert.equal((await submitVouch(f.sponsor, f.application.id)).error?.code, '42501');
  await configureVouch(f.owner, f.community.id, f.sponsor.id);
  assert.equal((await submitVouch(f.sponsor, f.application.id, ' ')).error?.code, '22023');
  const other = await vouchFixture('foreign-applicant');
  assert.equal((await submitVouch(f.sponsor, other.application.id)).error?.code, '42501');
  for (const status of ['removed', 'suspended']) {
    await admin.from('memberships').update({ status }).eq('community_id', f.community.id).eq('user_id', f.sponsor.id).throwOnError();
    assert.equal((await submitVouch(f.sponsor, f.application.id)).error?.code, '42501');
  }
  await admin.from('memberships').update({ status: 'active' }).eq('community_id', f.community.id).eq('user_id', f.sponsor.id).throwOnError();
  assert.equal((await decideApplication(f.owner, f.application.id, 'rejected', 'Not this time.')).error, null);
  assert.equal((await submitVouch(f.sponsor, f.application.id)).error?.code, '55000');
  assert.equal((await f.applicant.client.rpc('request_vouch', { p_intent_id: randomUUID(), p_application_id: f.application.id, p_sponsor_email: f.sponsor.email })).error?.code, '55000');
  const removed = await pendingVouchApplicant(f.owner, f.community.id);
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', removed.applicant.id).throwOnError();
  assert.equal((await submitVouch(f.sponsor, removed.application.id)).error?.code, '55000');
  const approved = await pendingVouchApplicant(f.owner, f.community.id); await decideApplication(f.owner, approved.application.id);
  assert.equal((await submitVouch(f.sponsor, approved.application.id)).error?.code, '55000');
  assert.equal((await admin.from('vouches').select('id').eq('community_id', f.community.id)).data?.length, 0);
  receipt('issue-14-guards', { invalidStatements: 0, unchangedMembershipDecisions: true });
});
