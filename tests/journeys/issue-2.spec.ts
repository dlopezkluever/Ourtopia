import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { actor, admin, createCommunity, mailboxLink, password, publicClient, receipt } from '../../scripts/verify/backend';
import { communitySchema } from '../../src/features/communities/model';

async function capture(page: Page, info: TestInfo, lane: number) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}-scenario.png`), fullPage: true });
  await info.attach('runtime', { body: JSON.stringify({ utc: new Date().toISOString(), viewport: page.viewportSize(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), lane }), contentType: 'application/json' });
}

async function signIn(page: Page, email: string, pass = password) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function register(page: Page) {
  const email = `journey-${randomUUID()}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  const link = await mailboxLink(email, 'signup');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Plant the first seed.' })).toBeVisible();
  return email;
}

async function createInBrowser(page: Page, name: string) {
  await page.getByLabel('Community name').fill(name);
  await page.getByLabel('A little about your Community').fill('A place to lend a hand.');
  await page.getByRole('button', { name: 'Create Community', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Welcome to ${name}.` })).toBeVisible();
  return page.url().split('/').pop();
}

test('lane 1 regression records absent trunk runtime and added durable behavior', async ({ page }, info) => {
  const base = '2af28e7a06db971e8e5fbbf01b0b8bda07f81c76';
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' });
  expect(tree.split('\n')).not.toContain('package.json');
  mkdirSync('.pilot-evidence/baseline', { recursive: true });
  writeFileSync('.pilot-evidence/baseline/runtime-absence.json', JSON.stringify({ base, tree: tree.split('\n'), runtime: 'absent', comparativeClaim: 'none' }, null, 2));
  await register(page);
  const id = await createInBrowser(page, 'A Shared Beginning');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome to A Shared Beginning.' })).toBeVisible();
  expect(page.url()).toContain(id ?? 'missing-id');
  await capture(page, info, 1);
});

test('lane 2 registration verification creates exactly one active first administrator', async ({ page }, info) => {
  const email = await register(page);
  const id = await createInBrowser(page, 'Maple Street Neighbors');
  const rows = await admin.from('memberships').select('role,status,user_id').eq('community_id', id);
  expect(rows.error).toBeNull();
  expect(rows.data).toHaveLength(1);
  expect(rows.data?.[0]).toMatchObject({ role: 'administrator', status: 'active' });
  await expect(page.getByText(email, { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Administrator · Active member')).toBeVisible();
  await capture(page, info, 2);
  receipt(`lane-2-${info.project.name}`, { communityId: id, membership: rows.data });
});

test('lane 3 sign-out sign-in and real mailbox password recovery retain existing Community', async ({ page }, info) => {
  const email = await register(page);
  const id = await createInBrowser(page, 'Our Little Circle');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Good to have you here.' })).toBeVisible();
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome to Our Little Circle.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send recovery link' }).click();
  await expect(page.getByRole('status')).toContainText('recovery link');
  await page.goto(await mailboxLink(email, 'recovery'));
  await expect(page.getByRole('heading', { name: 'Choose a fresh start.' })).toBeVisible();
  const newPassword = `${password}-recovered`;
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Our Little Circle.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email, newPassword);
  await expect(page.getByRole('heading', { name: 'Welcome to Our Little Circle.' })).toBeVisible();
  const rows = await admin.from('memberships').select('role,status').eq('community_id', id);
  expect(rows.data).toEqual([{ role: 'administrator', status: 'active' }]);
  await capture(page, info, 3);
});

test('lane 4 anonymous and unverified actors cannot create or start membership', async ({ page }, info) => {
  const unverified = await actor({ verified: false });
  const forbidden = await createCommunity(unverified.client);
  expect(forbidden.error?.code).toBe('42501');
  expect((await createCommunity(publicClient())).error?.code).toBe('42501');
  await page.goto('/');
  await expect(page.getByLabel('Community name')).toHaveCount(0);
  await page.getByLabel('Email address').fill(unverified.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('Email not confirmed');
  expect((await admin.from('communities').select('id').eq('created_by', unverified.id)).data).toEqual([]);
  expect((await admin.from('memberships').select('community_id').eq('user_id', unverified.id)).data).toEqual([]);
  await capture(page, info, 4);
});

test('lane 5 reload and same intent retry preserve identity and membership', async ({ page }, info) => {
  const owner = await actor();
  const intent = randomUUID();
  const original = communitySchema.parse((await createCommunity(owner.client, intent)).data);
  await signIn(page, owner.email);
  await page.reload();
  const retry = communitySchema.parse((await createCommunity(owner.client, intent)).data);
  expect(retry).toEqual(original);
  expect((await owner.client.from('memberships').select('role,status')).data).toEqual([{ role: 'administrator', status: 'active' }]);
  await expect(page.getByRole('heading', { name: 'Welcome to Maple Street Neighbors.' })).toBeVisible();
  await capture(page, info, 5);
});

test('lane 6 identical and changed payload races commit one coherent result', async ({ page }, info) => {
  const owner = await actor();
  const intent = randomUUID();
  const results = await Promise.all([createCommunity(owner.client, intent, 'One private home'), createCommunity(owner.client, intent, 'One private home'), createCommunity(owner.client, intent, 'Changed home')]);
  const successes = results.filter(result => !result.error);
  expect(successes.length).toBeGreaterThanOrEqual(1);
  expect(new Set(successes.map(result => communitySchema.parse(result.data).id)).size).toBe(1);
  expect(results.some(result => result.error?.code === '23505')).toBe(true);
  expect((await owner.client.from('communities').select('id')).data).toHaveLength(1);
  await signIn(page, owner.email);
  await expect(page.getByText('Administrator · Active member')).toBeVisible();
  await capture(page, info, 6);
});

test('lane 7 unrelated direct URL and REST queries disclose no private Community', async ({ page }, info) => {
  const owner = await actor(); const outsider = await actor();
  const home = communitySchema.parse((await createCommunity(owner.client)).data);
  await signIn(page, outsider.email);
  await page.goto(`/communities/${home.id}`);
  await expect(page.getByRole('heading', { name: 'Community unavailable.' })).toBeVisible();
  await expect(page.getByText(home.name, { exact: true })).toHaveCount(0);
  expect((await outsider.client.from('communities').select('*').eq('id', home.id)).data).toEqual([]);
  expect((await outsider.client.from('memberships').select('*').eq('community_id', home.id)).data).toEqual([]);
  expect((await outsider.client.from('community_events').select('*').eq('community_id', home.id)).data).toEqual([]);
  await capture(page, info, 7);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, owner.email);
  await expect(page.getByRole('heading', { name: `Welcome to ${home.name}.` })).toBeVisible();
  const revoked = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', home.id).eq('user_id', owner.id);
  expect(revoked.error).toBeNull();
  await expect(page.getByRole('heading', { name: `Welcome to ${home.name}.` })).toHaveCount(0);
  await expect(page.getByText(home.name, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Community name')).toBeVisible();
  await page.screenshot({ path: info.outputPath('lane-7-revoked.png'), fullPage: true });
});

test('lane 8 ordinary clients cannot forge roles memberships or Community identity', async ({ page }, info) => {
  const owner = await actor(); const outsider = await actor();
  const home = communitySchema.parse((await createCommunity(owner.client)).data);
  expect((await outsider.client.from('memberships').insert({ community_id: home.id, user_id: outsider.id, role: 'administrator', status: 'active' })).error?.code).toBe('42501');
  expect((await owner.client.from('communities').update({ id: randomUUID(), created_by: outsider.id }).eq('id', home.id)).error?.code).toBe('42501');
  expect((await owner.client.from('memberships').update({ role: 'administrator', user_id: outsider.id }).eq('community_id', home.id)).error?.code).toBe('42501');
  expect((await owner.client.from('communities').select('*')).data).toEqual([home]);
  await signIn(page, owner.email);
  await expect(page.getByText('Administrator · Active member')).toBeVisible();
  await capture(page, info, 8);
});

test('lane 9 lost creation response recovers committed result by retry', async ({ page }, info) => {
  const owner = await actor();
  await signIn(page, owner.email);
  await page.route('**/rest/v1/rpc/create_community', async route => { await route.fetch(); await route.abort('failed'); });
  await page.getByLabel('Community name').fill('Resilient Neighbors');
  await page.getByRole('button', { name: 'Create Community', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const before = await owner.client.from('communities').select('id');
  expect(before.data).toHaveLength(1);
  await page.unroute('**/rest/v1/rpc/create_community');
  await page.getByRole('button', { name: 'Create Community', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Resilient Neighbors.' })).toBeVisible();
  expect((await owner.client.from('communities').select('id')).data).toEqual(before.data);
  expect((await owner.client.from('memberships').select('role,status')).data).toEqual([{ role: 'administrator', status: 'active' }]);
  await capture(page, info, 9);
});

test('lane 10 mobile touch and desktop keyboard registration and home are usable', async ({ page }, info) => {
  const email = `accessible-${randomUUID()}@example.test`;
  await page.goto('/');
  if (info.project.name === 'mobile') await page.getByRole('button', { name: 'Create account', exact: true }).first().tap();
  else { await page.getByRole('button', { name: 'Create account', exact: true }).first().focus(); await page.keyboard.press('Enter'); }
  await page.getByLabel('Email address').focus();
  await expect(page.getByLabel('Email address')).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  await page.goto(await mailboxLink(email, 'signup'));
  await expect(page.getByLabel('Community name')).toBeVisible();
  await page.getByLabel('Community name').focus();
  await page.keyboard.type('Accessible Together');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('Community name')).toHaveValue('Accessible Together');
  await page.getByLabel('Community name').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('A little about your Community')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create Community', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Welcome to Accessible Together.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await page.locator('main').ariaSnapshot();
  expect(accessibility).toContain('Administrator · Active member');
  await capture(page, info, 10);
});
