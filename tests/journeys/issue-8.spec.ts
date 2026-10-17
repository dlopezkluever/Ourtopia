import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { activeMember, admin, adminReturned, advanceHandoff, completedItemFixture, createCommunity, disputeFixture, disputeView, handoffFixture, reportingBoundaryFixture, listingImageBytes, password, reportIssue } from '../../scripts/verify/backend';

const base = '91cc7b00d9edd075c205464ef90235507e6a7b3b';
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function open(page: Page, email: string, exchangeId: string) {
  await signIn(page, email); await page.goto(`/disputes/${exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Exchange issues', exact: true })).toBeVisible();
}
async function report(page: Page, body = 'The drill case is damaged.') {
  await page.getByLabel('What happened?').fill(body); await page.getByRole('button', { name: 'Report issue', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Structured case' })).toContainText(body);
}
async function upload(page: Page) {
  await page.getByLabel('Camera or photo').setInputFiles({ name: 'case.png', mimeType: 'image/png', buffer: listingImageBytes });
  await page.getByRole('button', { name: 'Upload or retry photo' }).click();
  await expect(page.getByAltText('Submitted case evidence')).toBeVisible();
}
async function save(page: Page, info: TestInfo, lane: number, data: unknown, name = 'scenario') {
  const path = info.outputPath(`lane-${lane}/${name}.png`); mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true }); writeFileSync(info.outputPath(`lane-${lane}/${name}.json`), JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), project: info.project.name, data }, null, 2));
}

test('lane 1 trunk has Handoff but no case controls; head persists the structured issue and completion block', async ({ page, browser }, info) => {
  test.setTimeout(150000); const f = await handoffFixture('case-trunk'); await advanceHandoff(f);
  const root = `.pilot-evidence/issue-8-trunk-${info.project.name}`;
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n');
  expect(tree.some(path => path.startsWith('src/features/disputes/'))).toBe(false);
  for (const file of tree.filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path))) {
    const target = `${root}/${file}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${file}`]));
  }
  copyFileSync('.env.local', `${root}/.env.local`); const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ ...info.project.use, baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false), { timeout: 60000 }).toBe(true);
    const trunk = await context.newPage(); await signIn(trunk, f.bob.email); await trunk.goto(`/handoffs/${f.exchangeId}`);
    await expect(trunk.getByRole('heading', { name: 'Handoff recorded', exact: true })).toBeVisible();
    await expect(trunk.getByRole('button', { name: 'Report issue', exact: true })).toHaveCount(0); await save(trunk, info, 1, { base, addedFeatureAbsent: true }, 'trunk');
  } finally { await context.close(); server.kill(); await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); }); }
  await open(page, f.bob.email, f.exchangeId); await report(page); await upload(page);
  await page.reload(); await expect(page.getByRole('note')).toContainText('Ordinary completion is blocked');
  await save(page, info, 1, await disputeView(f.alice, f.exchangeId), 'head');
});

test('lane 2 participant reports, uploads evidence and the counterparty responds in one private case', async ({ page, browser }, info) => {
  const f = await handoffFixture('case-browser-primary'); await advanceHandoff(f);
  await open(page, f.bob.email, f.exchangeId); await report(page); await upload(page);
  const context = await browser.newContext({ ...info.project.use, baseURL: process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}` });
  try {
    const other = await context.newPage(); await open(other, f.alice.email, f.exchangeId);
    await expect(other.getByAltText('Submitted case evidence')).toBeVisible();
    await other.getByLabel('Your response').fill('I agree the case needs repair.'); await other.getByRole('button', { name: 'Send response', exact: true }).click();
    await expect(other.getByRole('article', { name: 'Structured case' })).toContainText('I agree the case needs repair.');
  } finally { await context.close(); }
  await page.getByRole('button', { name: 'Refresh cases' }).click(); await expect(page.getByRole('article', { name: 'Structured case' })).toContainText('I agree the case needs repair.');
  const view = await disputeView(f.bob, f.exchangeId); expect(view.cases).toHaveLength(1); expect(view.cases[0].responses).toHaveLength(2); expect(view.cases[0].evidence[0].state).toBe('ready'); expect(view.state).toBe('checked_out');
  await save(page, info, 2, view);
});

test('lane 3 post-completion report preserves completed fulfillment and interaction counts', async ({ page }, info) => {
  const f = await completedItemFixture('case-browser-completed', 29);
  const before = await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId).order('id'); expect(before.data).toHaveLength(2);
  await open(page, f.bob.email, f.exchangeId); await report(page, 'Damage noticed after completion.');
  await expect(page.getByRole('status').filter({ hasText: 'Fulfillment remains completed' })).toBeVisible();
  expect((await admin.from('qualifying_interactions').select('id').eq('exchange_id', f.exchangeId).order('id')).data).toEqual(before.data);
  await save(page, info, 3, { view: await disputeView(f.bob, f.exchangeId), interactions: before.data });
});

test('lane 4 original deadline is enforced before, exactly at and after its boundary with delayed Cron', async ({ page }, info) => {
  const boundary = reportingBoundaryFixture(); expect(boundary).toBe('t\nt\nf');
  const inside = await completedItemFixture('case-browser-inside', 29.999); expect((await reportIssue(inside.bob, inside.exchangeId)).error).toBeNull();
  const f = await completedItemFixture('case-browser-expired', 30.001); await open(page, f.bob.email, f.exchangeId);
  await expect(page.getByText('The reporting window has ended.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Report issue', exact: true })).toHaveCount(0);
  expect((await reportIssue(f.bob, f.exchangeId)).error?.code).toBe('22023'); await save(page, info, 4, { boundary, expiredCommand: '22023' });
});

test('lane 5 repeat reports append to one case and retain response and evidence history after reload', async ({ page }, info) => {
  const f = await disputeFixture('case-browser-repeat'); await open(page, f.bob.email, f.exchangeId);
  await report(page, 'The hinge is also cracked.'); await upload(page);
  await page.getByLabel('Your response').fill('Adding the close-up photo.'); await page.getByRole('button', { name: 'Send response', exact: true }).click();
  await page.reload(); await expect(page.getByRole('article', { name: 'Structured case' })).toHaveCount(1); await expect(page.getByRole('article', { name: 'Structured case' })).toContainText('Adding the close-up photo.');
  const view = await disputeView(f.bob, f.exchangeId); expect(view.cases[0].responses).toHaveLength(3); expect(view.cases[0].evidence).toHaveLength(1); await save(page, info, 5, view);
});

test('lane 6 racing reports and ordinary finalization cannot bypass the open-case guard', async ({ page }, info) => {
  const f = await handoffFixture('case-browser-race'); await advanceHandoff(f);
  expect((await adminReturned(f)).error).toBeNull();
  const [first, second, finalize] = await Promise.all([reportIssue(f.bob, f.exchangeId), reportIssue(f.alice, f.exchangeId), admin.from('exchanges').update({ state: 'completed' }).eq('id', f.exchangeId)]);
  expect(first.error).toBeNull(); expect(second.error).toBeNull(); expect([null, '55000']).toContain(finalize.error?.code ?? null);
  await open(page, f.bob.email, f.exchangeId); await expect(page.getByRole('note')).toContainText('Ordinary completion is blocked');
  const view = await disputeView(f.bob, f.exchangeId); expect(view.cases).toHaveLength(1); expect(view.state).toBe(finalize.error ? 'returned' : 'completed'); await save(page, info, 6, { view, completion: finalize.error?.code ?? 'committed before the report' });
});

test('lane 7 another shared Community sees only incident type and status', async ({ page }, info) => {
  const f = await disputeFixture('case-browser-global'); const other = await createCommunity(f.alice.client, randomUUID(), 'Another shared Community'); expect(other.error).toBeNull();
  const communityId = (other.data as { id: string }).id; const viewer = await activeMember(f.alice, communityId, 'case-browser-global-viewer');
  await signIn(page, viewer.email); await page.goto(`/communities/${communityId}/members/${f.alice.id}`);
  await expect(page.getByText('Unresolved Dispute', { exact: false })).toBeVisible();
  expect((await viewer.client.rpc('global_trust', { p_subject: f.alice.id })).data).toMatchObject({ incidents: [{ type: 'unresolved_dispute', status: 'open' }] });
  await expect(page.locator('main')).not.toContainText('The drill case is damaged.'); await expect(page.locator('main')).not.toContainText(f.disputeId); await expect(page.locator('main')).not.toContainText(f.community.name);
  await save(page, info, 7, (await viewer.client.rpc('global_trust', { p_subject: f.alice.id })).data);
});

test('lane 8 submitted case rows and Storage permit participant and same administrator and deny unrelated readers', async ({ page }, info) => {
  const f = await disputeFixture('case-browser-privacy'); await open(page, f.bob.email, f.exchangeId); await upload(page);
  const view = await disputeView(f.bob, f.exchangeId); const photo = view.cases[0].evidence[0];
  await page.getByRole('button', { name: 'Sign out' }).click(); await open(page, f.owner.email, f.exchangeId);
  await expect(page.getByAltText('Submitted case evidence')).toBeVisible(); await expect(page.getByLabel('Your response')).toHaveCount(0);
  expect((await f.owner.client.storage.from('exchange-evidence').download(photo.object_path)).data?.size).toBe(listingImageBytes.length);
  await save(page, info, 8, { sameAdministrator: 'submitted case evidence only', evidence: photo.id });
  await page.getByRole('button', { name: 'Sign out' }).click(); await signIn(page, f.carol.email); await page.goto(`/disputes/${f.exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Case unavailable' })).toBeVisible(); expect((await f.carol.client.storage.from('exchange-evidence').createSignedUrl(photo.object_path, 30)).error).not.toBeNull();
});

test('lane 9 removed participant reports within the original window and is denied outside it', async ({ page }, info) => {
  const f = await completedItemFixture('case-browser-removed', 29); expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id)).error).toBeNull();
  await open(page, f.bob.email, f.exchangeId); await report(page, 'Reporting my prior Exchange after removal.'); await upload(page);
  expect((await f.bob.client.from('listings').select('id').eq('id', f.listing.id)).data).toEqual([]);
  await save(page, info, 9, await disputeView(f.bob, f.exchangeId));
  const late = await completedItemFixture('case-browser-removed-late', 31); expect((await admin.from('memberships').update({ status: 'removed' }).eq('community_id', late.community.id).eq('user_id', late.bob.id)).error).toBeNull();
  expect((await reportIssue(late.bob, late.exchangeId)).error?.code).toBe('42501');
});

test('lane 10 report, photo and reply controls work with keyboard and fit the viewport', async ({ page }, info) => {
  const f = await handoffFixture('case-browser-keyboard'); await advanceHandoff(f); await open(page, f.bob.email, f.exchangeId);
  await page.getByLabel('Issue type').focus(); await expect(page.getByLabel('Issue type')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('What happened?')).toBeFocused(); await page.keyboard.type('Keyboard report of damage.');
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Report issue', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'Structured case' })).toContainText('Keyboard report of damage.');
  await page.getByLabel('Camera or photo').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
  await page.getByRole('button', { name: 'Upload or retry photo' }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose a JPEG, PNG, or WebP photo up to 5 MB.');
  await upload(page);
  await page.getByLabel('Your response').focus(); await page.keyboard.type('Additional accessible response.'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'Structured case' })).toContainText('Additional accessible response.'); await expect(page.getByRole('note')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const denied = await f.carol.client.rpc('respond_to_dispute', { p_intent_id: randomUUID(), p_dispute_id: (await disputeView(f.bob, f.exchangeId)).cases[0].id, p_body: 'forged' }); expect(denied.error?.code).toBe('42501');
  await save(page, info, 10, { keyboard: 'report, upload, reply', noHorizontalOverflow: true, deniedReply: '42501' });
});
