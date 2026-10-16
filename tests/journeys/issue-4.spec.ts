import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { activeMember, actor, admin, completedExchanges, createCommunity, membershipFixture, password, seedIncident, seedReputationEvent } from '../../scripts/verify/backend';
import { standingSchema, trustSchema } from '../../src/features/reputation/model';

const base = '3f5f3fd0293421cc2688576acfc8d742e676dc4c';
const ownSchema = z.object({ global: standingSchema, communities: z.array(z.object({ communityId: z.string(), local: standingSchema, history: z.array(z.unknown()) })) });
async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }), contentType: 'application/json' });
}
async function fixture(label: string) {
  const f = await membershipFixture(label);
  const subject = await activeMember(f.owner, f.community.id, `${label}-member`);
  return { ...f, subject, path: `/communities/${f.community.id}/members/${subject.id}` };
}
async function openProfile(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await signIn(page, f.owner.email);
  await page.goto(`/communities/${f.community.id}/members`);
  await expect(page.getByRole('heading', { name: `Members of ${f.community.name}` })).toBeVisible();
  await page.getByRole('link', { name: f.subject.email, exact: true }).click();
  await expect(page.getByRole('heading', { name: f.subject.email, exact: true })).toBeVisible();
}
function card(page: Page, name: string) { return page.getByRole('region', { name, exact: true }); }

test('lane 1 trunk absence and head baseline standing preserve authorized home', async ({ page, browser }, info) => {
  const f = await fixture('profile-trunk');
  const root = `.pilot-evidence/issue-4-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) {
    const target = `${root}/${path}`;
    mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`).then(r => r.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage();
    await signIn(trunk, f.owner.email);
    await expect(trunk.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(trunk.getByRole('link', { name: 'Member directory' })).toHaveCount(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await openProfile(page, f);
  await expect(card(page, 'Community Solidarity Score')).toContainText('50');
  await expect(card(page, 'Global Solidarity Score')).toContainText('Unproven');
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { trunkDirectory: 'absent', profile: (await f.owner.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.subject.id })).data });
});

test('lane 2 approved member directory local and global start at 50 Unproven with zero completions', async ({ page }, info) => {
  const f = await fixture('profile-baseline');
  await openProfile(page, f);
  for (const label of ['Community Solidarity Score', 'Global Solidarity Score']) {
    await expect(card(page, label)).toContainText('50');
    await expect(card(page, label)).toContainText('Unproven');
    await expect(card(page, label)).toContainText('0 completed Exchanges');
  }
  const own = await f.subject.client.rpc('my_reputation');
  expect(ownSchema.parse(own.data).global).toEqual({ score: 50, title: 'Unproven', completedInteractions: 0 });
  await capture(page, info, 2, own.data);
});

test('lane 3 two Communities keep local histories and use 20 to 1 global weighting', async ({ page }, info) => {
  const f = await fixture('weighted-profile');
  const other = await createCommunity(f.subject.client, randomUUID(), 'Second weighted circle');
  expect(other.error).toBeNull();
  const otherId = String(other.data.id);
  await completedExchanges(f.community.id, f.owner.id, f.subject.id, 400);
  await completedExchanges(otherId, f.owner.id, f.subject.id, 20);
  await seedReputationEvent(f.community.id, f.subject.id, 10);
  await seedReputationEvent(otherId, f.subject.id, 31);
  await openProfile(page, f);
  await expect(card(page, 'Community Solidarity Score')).toContainText('60');
  await expect(card(page, 'Community Solidarity Score')).toContainText('400 completed Exchanges');
  await expect(card(page, 'Global Solidarity Score')).toContainText('61');
  await expect(page.getByRole('region', { name: 'Shared Communities' })).not.toContainText('Second weighted circle');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, f.subject.email);
  await page.goto('/standing');
  await expect(card(page, 'Community Solidarity Score in Second weighted circle')).toContainText('81');
  const own = ownSchema.parse((await f.subject.client.rpc('my_reputation')).data);
  expect(own.global).toEqual({ score: 61, title: 'Comrade', completedInteractions: 420 });
  expect(own.communities.map(row => row.history.length)).toEqual([1, 1]);
  await capture(page, info, 3, own);
});

test('lane 4 literal title boundaries clamps zero weights and half-up ties render server arithmetic', async ({ page }, info) => {
  test.setTimeout(120000);
  const subject = await actor({ label: 'arithmetic-subject' });
  const helper = await actor({ label: 'arithmetic-helper' });
  const boundaries = [[0, 'Lumpen'], [39, 'Lumpen'], [40, 'Petty Bourgeoisie'], [54, 'Petty Bourgeoisie'], [55, 'Comrade'], [69, 'Comrade'], [70, 'Revolutionary'], [84, 'Revolutionary'], [85, 'General'], [94, 'General'], [95, 'Dictator'], [100, 'Dictator']] as const;
  for (const [score] of boundaries) {
    const community = await createCommunity(subject.client, randomUUID(), `Boundary ${score}`);
    const id = String(community.data.id);
    await completedExchanges(id, helper.id, subject.id, 1);
    await seedReputationEvent(id, subject.id, score - 50);
    if (score === 0) await seedReputationEvent(id, subject.id, -100);
    if (score === 100) await seedReputationEvent(id, subject.id, 100);
  }
  await signIn(page, subject.email);
  await page.goto('/standing');
  for (const [score, title] of boundaries) {
    const region = card(page, `Community Solidarity Score in Boundary ${score}`);
    await expect(region).toContainText(String(score));
    await expect(region).toContainText(title);
  }
  const tie = await actor({ label: 'tie-subject' });
  for (const [score, count] of [[50, 1], [51, 1], [100, 0]]) {
    const community = await createCommunity(tie.client, randomUUID(), `Tie ${score}`);
    const id = String(community.data.id);
    await completedExchanges(id, helper.id, tie.id, count);
    await seedReputationEvent(id, tie.id, score - 50);
  }
  const tieResult = ownSchema.parse((await tie.client.rpc('my_reputation')).data);
  expect(tieResult.global).toEqual({ score: 51, title: 'Petty Bourgeoisie', completedInteractions: 2 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, tie.email);
  await page.goto('/standing');
  await expect(card(page, 'Global Solidarity Score')).toContainText('51');
  await expect(card(page, 'Community Solidarity Score in Tie 100')).toContainText('Unproven');
  await capture(page, info, 4, { boundaries, tieResult });
});

test('lane 5 own past membership history survives while other member detail is denied', async ({ page }, info) => {
  const f = await fixture('past-profile');
  await completedExchanges(f.community.id, f.owner.id, f.subject.id, 1, 'item');
  await signIn(page, f.subject.email);
  await page.goto(`/communities/${f.community.id}/members/${f.owner.id}`);
  await expect(page.getByRole('heading', { name: f.owner.email, exact: true })).toBeVisible();
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.subject.id).throwOnError();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Profile unavailable.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: f.owner.email, exact: true })).toHaveCount(0);
  await page.goto('/standing');
  await expect(page.getByText('Former member', { exact: true })).toBeVisible();
  await expect(page.getByText('Returned a borrowed item', { exact: false })).toBeVisible();
  await page.goto(`/communities/${f.community.id}/members/${f.owner.id}`);
  await expect(page.getByRole('heading', { name: 'Profile unavailable.' })).toBeVisible();
  expect((await f.subject.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.owner.id })).error?.code).toBe('42501');
  await page.goto('/standing');
  await capture(page, info, 5, (await f.subject.client.rpc('my_reputation')).data);
});

test('lane 6 shared viewer sees type and status while unrelated viewer receives no trust', async ({ page }, info) => {
  const f = await fixture('redacted-profile');
  const foreign = await actor({ label: 'private-source' });
  const community = await createCommunity(foreign.client, randomUUID(), 'Hidden source Community');
  const id = String(community.data.id);
  await seedIncident(id, f.subject.id, 'serious_violation', 'confirmed');
  await openProfile(page, f);
  await expect(page.getByRole('region', { name: 'Trust indicators' })).toContainText('Serious violation');
  await expect(page.getByRole('region', { name: 'Trust indicators' })).toContainText('confirmed');
  await expect(page.getByText('Hidden source Community', { exact: true })).toHaveCount(0);
  const result = await f.owner.client.rpc('global_trust', { p_subject: f.subject.id });
  expect(trustSchema.parse(result.data)).toEqual({ globalScore: 50, completedInteractions: 0, incidents: [{ type: 'serious_violation', status: 'confirmed' }] });
  expect((await foreign.client.rpc('global_trust', { p_subject: f.subject.id })).error?.code).toBe('42501');
  await capture(page, info, 6, result.data);
});

test('lane 7 replayed profile reads preserve scores counts and ledger identity', async ({ page }, info) => {
  const f = await fixture('replay-profile');
  await completedExchanges(f.community.id, f.owner.id, f.subject.id, 2, 'item');
  const read = () => f.owner.client.rpc('member_profile', { p_community_id: f.community.id, p_subject: f.subject.id });
  const before = await read();
  const facts = await admin.from('reputation_events').select('id').eq('community_id', f.community.id).order('id');
  await openProfile(page, f);
  for (let index = 0; index < 3; index++) {
    await page.reload();
    await expect(card(page, 'Community Solidarity Score')).toContainText('52');
    expect((await read()).data).toEqual(before.data);
  }
  expect((await admin.from('reputation_events').select('id').eq('community_id', f.community.id).order('id')).data).toEqual(facts.data);
  await capture(page, info, 7, { profile: before.data, facts: facts.data });
});

test('lane 8 direct client score ledger completion and audit writes fail without changing standing', async ({ page }, info) => {
  const f = await fixture('forged-profile');
  const results = await Promise.all([
    f.subject.client.from('reputation_events').insert({ community_id: f.community.id, recipient_id: f.subject.id, rule: 'forged', points: 100, source_kind: 'fixture', source_id: randomUUID(), verified_by_command: 'client' }),
    f.subject.client.from('qualifying_interactions').insert({ community_id: f.community.id, participant_id: f.subject.id, exchange_id: randomUUID() }),
    f.subject.client.from('community_events').insert({ community_id: f.community.id, actor_id: f.subject.id, intent_id: randomUUID(), kind: 'forged' }),
    f.subject.client.from('reputation_rules').update({ points: 100 }).eq('rule', 'item_borrower_return'),
  ]);
  expect(results.map(result => result.error?.code)).toEqual(['42501', '42501', '42501', '42501']);
  await openProfile(page, f);
  await expect(card(page, 'Community Solidarity Score')).toContainText('50');
  await expect(card(page, 'Global Solidarity Score')).toContainText('0 completed Exchanges');
  await capture(page, info, 8, { errors: results.map(result => result.error?.code), standing: (await f.subject.client.rpc('my_reputation')).data });
});

test('lane 9 genuinely empty history and indicators have honest Exchange language', async ({ page }, info) => {
  const f = await fixture('empty-profile');
  await openProfile(page, f);
  await expect(page.getByText('No completed Exchanges yet.', { exact: false })).toBeVisible();
  await expect(page.getByText('No unresolved Disputes or serious violations', { exact: true })).toBeVisible();
  expect((await f.subject.client.from('reputation_events').select('id').eq('recipient_id', f.subject.id)).data).toEqual([]);
  expect((await f.subject.client.from('qualifying_interactions').select('id').eq('participant_id', f.subject.id)).data).toEqual([]);
  await capture(page, info, 9, { reputationEvents: [], qualifyingInteractions: [] });
});

test('lane 10 keyboard directory profile score explanations and counts are accessible', async ({ page }, info) => {
  const f = await fixture('accessible-profile');
  await signIn(page, f.owner.email);
  await page.goto(`/communities/${f.community.id}/members`);
  const link = page.getByRole('link', { name: f.subject.email, exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: f.subject.email, exact: true })).toBeVisible();
  for (const label of ['Community Solidarity Score', 'Global Solidarity Score']) {
    const summary = page.getByText(`How ${label} is calculated`, { exact: true });
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(card(page, label)).toContainText('completed');
    expect(await card(page, label).ariaSnapshot()).toContain('0 completed Exchanges');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, info, 10, { accessibility: await page.getByRole('main').ariaSnapshot(), viewport: page.viewportSize() });
});
