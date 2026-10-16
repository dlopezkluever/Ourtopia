import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { admin, configureVouch, decideApplication, password, pendingVouchApplicant, submitVouch, vouchFixture } from '../../scripts/verify/backend';

const base = process.env.P14_BASE_SHA ?? 'e246904e579ef4231dd90e62be01f5c6f9abfd65';
const statement = 'I have known this neighbor for years and trust their care for our circle.';
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function open(page: Page, email: string, community?: string) {
  await signIn(page, email); await page.goto(community ? `/vouches?community=${community}` : '/vouches');
  await expect(page.getByRole('heading', { name: 'Vouches', exact: true })).toBeVisible();
  if (community) await expect(page.getByRole('heading', { name: 'Pending applicants', exact: true }).or(page.getByText('Sponsorship eligibility is granted by your administrator.', { exact: true }))).toBeVisible();
  else await expect(page.getByRole('heading', { name: 'Your applications and statements', exact: true })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, viewport: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }), contentType: 'application/json' });
}
async function grant(page: Page, f: Awaited<ReturnType<typeof vouchFixture>>) {
  await open(page, f.owner.email, f.community.id);
  await page.getByLabel('Member', { exact: true }).selectOption(f.sponsor.id);
  await page.getByRole('button', { name: 'Save sponsorship settings', exact: true }).click();
  await expect(page.getByLabel('Member', { exact: true }).locator(`option[value="${f.sponsor.id}"]`)).toHaveText(`${f.sponsor.email} (eligible)`);
}
async function vouch(page: Page, f: Awaited<ReturnType<typeof vouchFixture>>) {
  await open(page, f.sponsor.email, f.community.id);
  await page.getByLabel(`Trust statement for ${f.applicant.email}`, { exact: true }).fill(statement);
  await page.getByRole('button', { name: `Vouch for ${f.applicant.email}`, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sponsor history', exact: true })).toContainText(statement);
}
async function invariant(f: Awaited<ReturnType<typeof vouchFixture>>) {
  const membership = await f.applicant.client.from('memberships').select('status').eq('community_id', f.community.id);
  expect(membership.data).toEqual([{ status: 'pending' }]);
  expect((await f.applicant.client.from('communities').select('*')).data).toEqual([]);
  expect((await admin.from('reputation_events').select('id').eq('community_id', f.community.id)).data).toEqual([]);
  expect((await admin.from('qualifying_interactions').select('id').eq('community_id', f.community.id)).data).toEqual([]);
  const reputation = (await f.sponsor.client.rpc('my_reputation')).data;
  expect(reputation.global).toEqual({ score: 50, title: 'Unproven', completedInteractions: 0 });
  return { membership: membership.data, reputation, reputationEvents: 0, qualifyingInteractions: 0 };
}
async function deliver(recipient: string, kind: string) {
  const result = await admin.from('notification_outbox').select('id').eq('recipient_id', recipient).eq('kind', kind);
  expect(result.error).toBeNull(); expect(result.data!.length).toBeGreaterThan(0);
  for (const item of result.data ?? []) {
    const claim = await admin.rpc('claim_notification', { p_outbox_id: item.id }); expect(claim.error).toBeNull();
    expect((await admin.rpc('finish_notification', { p_outbox_id: item.id, p_claim_token: claim.data.claim_token })).error).toBeNull();
  }
}

test('lane 1 trunk absence and head durable statement preserve pending access and standing', async ({ page, browser }, info) => {
  const f = await vouchFixture('vouch-trunk');
  const root = `.pilot-evidence/issue-14-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) {
    const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`).then(r => r.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.owner.email);
    await expect(trunk.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(trunk.getByRole('link', { name: 'Vouches', exact: true })).toHaveCount(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await grant(page, f); await page.getByRole('button', { name: 'Sign out' }).click(); await vouch(page, f);
  await page.getByRole('button', { name: 'Sign out' }).click(); await open(page, f.applicant.email);
  await expect(page.getByText(statement, { exact: true })).toBeVisible();
  await expect(page.getByText('Pending administrator approval', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { trunkVouches: 'absent', ...await invariant(f) });
});

test('lane 2 administrator grants sponsor Vouch applicant reads while pending until ordinary approval', async ({ page }, info) => {
  const f = await vouchFixture('vouch-primary'); await grant(page, f);
  await page.getByRole('button', { name: 'Sign out' }).click(); await vouch(page, f);
  await page.reload(); await expect(page.getByRole('region', { name: 'Sponsor history' })).toContainText(statement);
  await page.getByRole('button', { name: 'Sign out' }).click(); await open(page, f.owner.email, f.community.id);
  await expect(page.getByRole('region', { name: 'Sponsor history' })).toContainText(statement);
  await page.getByRole('button', { name: 'Sign out' }).click(); await open(page, f.applicant.email);
  await expect(page.getByText(statement, { exact: true })).toBeVisible();
  const receipt = await invariant(f); await capture(page, info, 2, receipt);
  expect((await decideApplication(f.owner, f.application.id)).error).toBeNull();
  await page.goto('/membership'); await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open Community', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
});

test('lane 3 applicant requests a Vouch sponsor reads notice and permitted history remains scoped', async ({ page }, info) => {
  const f = await vouchFixture('vouch-request'); await configureVouch(f.owner, f.community.id, f.sponsor.id);
  await open(page, f.applicant.email);
  await page.getByLabel(`Sponsor email for ${f.community.name}`).fill(f.sponsor.email);
  await page.getByRole('button', { name: 'Request a Vouch', exact: true }).click();
  await expect(page.getByText('Vouch requested. Your application still needs administrator approval.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await f.applicant.client.from('vouch_requests').select('id')).data?.length).toBe(1);
  await deliver(f.sponsor.id, 'vouch_requested');
  await page.getByRole('button', { name: 'Sign out' }).click(); await vouch(page, f);
  await expect(page.getByRole('region', { name: 'Vouch requests', exact: true })).toContainText(f.applicant.email);
  await expect(page.getByRole('region', { name: 'Vouch notices', exact: true })).toContainText('An applicant requested your Vouch.');
  const other = await vouchFixture('hidden-vouch-history'); await configureVouch(other.owner, other.community.id, other.sponsor.id); await submitVouch(other.sponsor, other.application.id, 'Foreign history stays hidden.');
  await page.reload(); await expect(page.getByText('Foreign history stays hidden.', { exact: true })).toHaveCount(0);
  await deliver(f.applicant.id, 'vouch_submitted');
  await page.getByRole('button', { name: 'Sign out' }).click(); await open(page, f.applicant.email);
  await expect(page.getByRole('region', { name: 'Vouch notices', exact: true })).toContainText('A Vouch statement is ready to read.');
  await capture(page, info, 3, { requests: (await f.applicant.client.from('vouch_requests').select('*')).data, statements: (await f.applicant.client.from('vouches').select('*')).data, foreignHidden: true });
});

test('lane 4 three rolling-year Vouches exhaust quota and prior-year history releases capacity', async ({ page }, info) => {
  const f = await vouchFixture('vouch-quota'); await configureVouch(f.owner, f.community.id, f.sponsor.id);
  const applications = [f.application];
  for (let index = 0; index < 3; index++) applications.push((await pendingVouchApplicant(f.owner, f.community.id)).application);
  for (const application of applications.slice(0, 3)) expect((await submitVouch(f.sponsor, application.id)).error).toBeNull();
  expect((await submitVouch(f.sponsor, applications[3].id)).error?.code).toBe('54000');
  await open(page, f.sponsor.email, f.community.id); await expect(page.getByText('Eligible sponsor. 3 of 3 Vouches used in the rolling year.', { exact: true })).toBeVisible();
  const old = await vouchFixture('vouch-expired-quota'); await configureVouch(old.owner, old.community.id, old.sponsor.id, 1);
  const eventId = randomUUID();
  expect((await admin.from('community_events').insert({ id: eventId, community_id: old.community.id, actor_id: old.sponsor.id, kind: 'fixture', intent_id: randomUUID() })).error).toBeNull();
  const historical = await pendingVouchApplicant(old.owner, old.community.id);
  const anniversary = new Date(); anniversary.setUTCFullYear(anniversary.getUTCFullYear() - 1); anniversary.setUTCSeconds(anniversary.getUTCSeconds() - 10);
  expect((await admin.from('vouches').insert({ community_id: old.community.id, application_id: historical.application.id, applicant_id: historical.applicant.id, sponsor_id: old.sponsor.id, statement: 'Prior-year history.', event_id: eventId, created_at: anniversary.toISOString() })).error).toBeNull();
  expect((await submitVouch(old.sponsor, old.application.id)).error).toBeNull();
  await capture(page, info, 4, { quota: 3, fourthError: '54000', expiredHistoryReleasesCapacity: true, exactMicrosecondBoundary: 'tests/server/issue-14.test.ts' });
});

test('lane 5 concurrent quota consumption and duplicate submissions leave one record each', async ({ page }, info) => {
  const f = await vouchFixture('vouch-browser-race'); await configureVouch(f.owner, f.community.id, f.sponsor.id, 1);
  const next = await pendingVouchApplicant(f.owner, f.community.id);
  const quota = await Promise.all([submitVouch(f.sponsor, f.application.id), submitVouch(f.sponsor, next.application.id)]);
  expect(quota.filter(result => !result.error)).toHaveLength(1); expect(quota.find(result => result.error)?.error?.code).toBe('54000');
  await configureVouch(f.owner, f.community.id, f.sponsor.id, 3);
  const duplicateApplicant = await pendingVouchApplicant(f.owner, f.community.id);
  const duplicates = await Promise.all([submitVouch(f.sponsor, duplicateApplicant.application.id), submitVouch(f.sponsor, duplicateApplicant.application.id)]);
  expect(duplicates.filter(result => !result.error)).toHaveLength(1); expect(duplicates.find(result => result.error)?.error?.code).toBe('23505');
  await open(page, f.sponsor.email, f.community.id); await expect(page.getByRole('region', { name: 'Sponsor history' }).getByRole('article')).toHaveCount(2);
  await capture(page, info, 5, { quota, duplicates, ...await invariant(f) });
});

test('lane 6 valid intent replay keeps one statement and unchanged access points and weight', async ({ page }, info) => {
  const f = await vouchFixture('vouch-replay'); await configureVouch(f.owner, f.community.id, f.sponsor.id);
  const intent = randomUUID(); const first = await submitVouch(f.sponsor, f.application.id, statement, intent); expect(first.error).toBeNull();
  for (let index = 0; index < 3; index++) expect((await submitVouch(f.sponsor, f.application.id, statement, intent)).data).toEqual(first.data);
  expect((await submitVouch(f.sponsor, f.application.id, 'Changed statement', intent)).error?.code).toBe('23505');
  await open(page, f.applicant.email); await expect(page.getByText(statement, { exact: true })).toHaveCount(1);
  await capture(page, info, 6, { first: first.data, changedPayload: '23505', ...await invariant(f) });
});

test('lane 7 ineligible sponsors and rejected or removed applicants reject new statements', async ({ page }, info) => {
  const f = await vouchFixture('vouch-terminal'); expect((await submitVouch(f.sponsor, f.application.id)).error?.code).toBe('42501');
  await configureVouch(f.owner, f.community.id, f.sponsor.id); await decideApplication(f.owner, f.application.id, 'rejected', 'Application declined.');
  expect((await submitVouch(f.sponsor, f.application.id)).error?.code).toBe('55000');
  const removed = await pendingVouchApplicant(f.owner, f.community.id);
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', removed.applicant.id).throwOnError();
  expect((await submitVouch(f.sponsor, removed.application.id)).error?.code).toBe('55000');
  await open(page, f.applicant.email); await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request a Vouch', exact: true })).toHaveCount(0);
  await capture(page, info, 7, { ineligible: '42501', rejected: '55000', removedApplicant: '55000', statements: (await admin.from('vouches').select('id').eq('community_id', f.community.id)).data });
});

test('lane 8 ordinary member and foreign administrator cannot change eligibility', async ({ page }, info) => {
  const f = await vouchFixture('vouch-roles'); const foreign = await vouchFixture('foreign-vouch-roles');
  expect((await configureVouch(f.sponsor, f.community.id, f.sponsor.id)).error?.code).toBe('42501');
  expect((await configureVouch(foreign.owner, f.community.id, f.sponsor.id)).error?.code).toBe('42501');
  await open(page, f.sponsor.email, f.community.id); await expect(page.getByRole('heading', { name: 'Sponsorship settings' })).toHaveCount(0);
  await page.goto(`/vouches?community=${foreign.community.id}`); await expect(page.getByRole('alert')).toContainText('Current active Community membership');
  await capture(page, info, 8, { member: '42501', foreignAdministrator: '42501' });
});

test('lane 9 pending applicant sees own statement but no member directory or other private content', async ({ page }, info) => {
  const f = await vouchFixture('vouch-pending-privacy'); await configureVouch(f.owner, f.community.id, f.sponsor.id); await submitVouch(f.sponsor, f.application.id, statement);
  await open(page, f.applicant.email); await expect(page.getByText(statement, { exact: true })).toBeVisible();
  await page.goto(`/communities/${f.community.id}/members`); await expect(page.getByRole('heading', { name: 'Profile unavailable.' })).toBeVisible();
  await expect(page.getByText(f.sponsor.email, { exact: true })).toHaveCount(0);
  expect((await f.applicant.client.rpc('member_directory', { p_community_id: f.community.id })).error?.code).toBe('42501');
  expect((await f.applicant.client.from('communities').select('*')).data).toEqual([]);
  expect((await f.applicant.client.from('vouch_eligibility').select('*')).data).toEqual([]);
  await capture(page, info, 9, { directory: '42501', communityRows: 0, eligibilityRows: 0 });
});

test('lane 10 keyboard settings statement and current-access clearing work at both viewports', async ({ page }, info) => {
  const f = await vouchFixture('vouch-keyboard'); await open(page, f.owner.email, f.community.id);
  await page.getByLabel('Member', { exact: true }).selectOption(f.sponsor.id);
  await page.getByLabel('Community annual limit per sponsor').fill('4');
  const save = page.getByRole('button', { name: 'Save sponsorship settings', exact: true }); await save.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Member', { exact: true }).locator(`option[value="${f.sponsor.id}"]`)).toHaveText(`${f.sponsor.email} (eligible)`);
  await page.getByRole('button', { name: 'Sign out' }).click(); await vouch(page, f);
  await expect(page.getByText('A Vouch is a trust statement.', { exact: false })).toContainText('separate administrator approval');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, info, 10, { accessibility: await page.getByRole('main').ariaSnapshot(), annualLimit: 4, ...await invariant(f) });
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.sponsor.id).throwOnError();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Current active Community membership');
  await expect(page.getByRole('region', { name: 'Sponsor history' })).toHaveCount(0);
});
