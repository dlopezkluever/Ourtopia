import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { actor, admin, drillDetails, listingFixture, listingImageBytes, password, publishDrill, seedReputationEvent, uploadListingImage } from '../../scripts/verify/backend';

const base = 'e246904e579ef4231dd90e62be01f5c6f9abfd65';
async function signIn(page: Page, email: string) {
  await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click(); await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable receipt', { body: JSON.stringify({ lane, project: info.project.name, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data }), contentType: 'application/json' });
}
async function openFeed(page: Page, f: Awaited<ReturnType<typeof listingFixture>>, email = f.alice.email) {
  await signIn(page, email); await page.goto(`/communities/${f.community.id}/listings`); await expect(page.getByRole('heading', { name: 'Community Listings', exact: true })).toBeVisible();
}
async function fillDrill(page: Page, open = true) {
  if (open) await page.getByRole('button', { name: 'Share an item', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(drillDetails.title); await page.getByLabel('Description', { exact: true }).fill(drillDetails.description);
  await page.getByLabel('Category', { exact: true }).selectOption('tools'); await page.getByLabel('Condition', { exact: true }).fill(drillDetails.condition);
  await page.getByLabel('Estimated replacement value ($)').fill('180'); await page.getByLabel('Pickup notes').fill(drillDetails.pickup_notes);
  await page.getByLabel('Lending conditions').fill(drillDetails.lending_conditions); await page.getByLabel('Minimum Community Solidarity Score', { exact: true }).fill('45');
  await page.getByLabel('Available from 1').fill('2027-01-10'); await page.getByLabel('Available through 1').fill('2027-01-20');
  await page.getByLabel('Optional gratitude or maintenance suggestion').fill(drillDetails.gratitude);
}
async function saveDrill(page: Page) {
  await page.getByRole('button', { name: 'Save Listing', exact: true }).click(); await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
}
async function openDrill(page: Page, f: Awaited<ReturnType<typeof listingFixture>>, listingId: string, email = f.alice.email) {
  await signIn(page, email); await page.goto(`/communities/${f.community.id}/listings/${listingId}`); await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
}

test('lane 1 actual trunk absence and persisted head publication', async ({ page, browser }, info) => {
  const f = await listingFixture('listing-trunk'); const root = `.pilot-evidence/issue-5-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) { const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`])); }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 5173) + 8;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(result => result.status, () => 0), { timeout: 30000 }).toBe(200);
    const trunk = await context.newPage(); await signIn(trunk, f.alice.email);
    await expect(trunk.getByRole('heading', { name: `Welcome to ${f.community.name}.` })).toBeVisible();
    await expect(trunk.getByRole('link', { name: 'Community Listings' })).toHaveCount(0);
    await trunk.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await openFeed(page, f); await fillDrill(page); await saveDrill(page);
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
  const persisted = await f.bob.client.from('listings').select('*').eq('community_id', f.community.id); expect(persisted.data).toHaveLength(1);
  await capture(page, info, 1, { trunk: 'Listing feature absent', rows: persisted.data });
});

test('lane 2 Alice publishes drill and Bob discovers saved detail in Community feed', async ({ page }, info) => {
  const f = await listingFixture('listing-primary'); await openFeed(page, f); await fillDrill(page);
  let lostResponse = false;
  await page.route('**/rpc/save_listing', async route => {
    if (!lostResponse) { await route.fetch(); lostResponse = true; await route.abort('failed'); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save Listing', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await saveDrill(page);
  await page.getByRole('button', { name: 'Sign out' }).click(); await openFeed(page, f, f.bob.email);
  await page.getByRole('link', { name: drillDetails.title, exact: true }).click(); await expect(page.getByText('$180.00', { exact: true })).toBeVisible();
  const rows = await f.bob.client.from('listings').select('owner_id,replacement_value,minimum_score').eq('community_id', f.community.id);
  expect(rows.data).toEqual([{ owner_id: f.alice.id, replacement_value: 180, minimum_score: 45 }]); await capture(page, info, 2, rows.data);
});

test('lane 3 owner edits and withdraws retained Listing', async ({ page }, info) => {
  const f = await listingFixture('listing-withdraw'); const listing = await publishDrill(f.alice, f.community.id); await openDrill(page, f, listing.id);
  await page.getByRole('button', { name: 'Edit Listing', exact: true }).click(); await page.getByLabel('Title', { exact: true }).fill('Makita drill and bits');
  await page.getByRole('button', { name: 'Save Listing', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Makita drill and bits', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw Listing', exact: true }).click(); await expect(page.getByText('This Listing has been withdrawn. Its history is retained.')).toBeVisible();
  const rows = await f.bob.client.from('listings').select('title,status,version').eq('id', listing.id); expect(rows.data).toEqual([{ title: 'Makita drill and bits', status: 'withdrawn', version: 3 }]);
  await capture(page, info, 3, rows.data); await page.getByRole('link', { name: `Back to Listings in ${f.community.name}` }).click(); await expect(page.getByRole('link', { name: 'Makita drill and bits' })).toHaveCount(0);
});

test('lane 4 keyword category type dates member and score filters obey persisted fields', async ({ page }, info) => {
  const f = await listingFixture('listing-filters'); await publishDrill(f.alice, f.community.id);
  await publishDrill(f.bob, f.community.id, { ...drillDetails, title: 'Kitchen mixer', description: 'Stand mixer with dough hook.', category: 'kitchen', minimum_score: 80 });
  await openFeed(page, f); await expect(page.getByRole('status')).toHaveText('2 Listings');
  await page.getByLabel('Search Listings').fill('Makita'); await expect(page.getByRole('status')).toHaveText('1 Listing');
  await page.getByLabel('Filter category').selectOption('kitchen'); await expect(page.getByRole('status')).toHaveText('0 Listings');
  await page.getByLabel('Search Listings').fill(''); await page.getByLabel('Filter category').selectOption('');
  await page.getByLabel('Listing type', { exact: true }).selectOption('item'); await page.getByLabel('Only Listings I meet the minimum score for').check(); await expect(page.getByRole('status')).toHaveText('1 Listing');
  await page.getByLabel('Member', { exact: true }).selectOption(f.bob.id); await expect(page.getByRole('status')).toHaveText('0 Listings');
  await page.getByLabel('Member', { exact: true }).selectOption(f.alice.id); await page.getByLabel('Needed from').fill('2027-01-12'); await page.getByLabel('Needed through').fill('2027-01-15'); await expect(page.getByRole('status')).toHaveText('1 Listing');
  await page.getByLabel('Needed through').fill('2027-01-25'); await expect(page.getByRole('status')).toHaveText('0 Listings');
  await capture(page, info, 4, { expected: 0, rangeOutsideAvailability: true });
});

test('lane 5 explicit date ranges and optional gratitude grant no paid priority', async ({ page }, info) => {
  const f = await listingFixture('listing-gratitude'); const listing = await publishDrill(f.alice, f.community.id); await openDrill(page, f, listing.id);
  await expect(page.getByRole('region', { name: 'Availability', exact: true })).toContainText('No recurrence.');
  await expect(page.getByRole('heading', { name: 'Optional gratitude' })).toBeVisible(); await expect(page.getByText('Borrowing is free. No payment, priority benefit, or guaranteed approval.')).toBeVisible();
  await expect(page.getByRole('button', { name: /pay|checkout/i })).toHaveCount(0);
  const dates = await f.alice.client.from('listing_availability').select('starts_on,ends_on,dates').eq('listing_id', listing.id); expect(dates.data).toHaveLength(2); await capture(page, info, 5, dates.data);
});

test('lane 6 invalid and interrupted private image upload retries the same object', async ({ page }, info) => {
  const f = await listingFixture('listing-upload'); const listing = await publishDrill(f.alice, f.community.id); await openDrill(page, f, listing.id);
  const input = page.getByLabel('Private image (JPEG, PNG, WebP, up to 5 MB)');
  await input.setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') }); await page.getByRole('button', { name: 'Upload or retry image' }).click(); await expect(page.getByRole('alert')).toContainText('Choose a JPEG');
  let interrupted = false;
  let completionInterrupted = false;
  await page.route('**/storage/v1/object/listing-images/**', async route => { if (route.request().method() === 'POST' && !interrupted) { interrupted = true; await route.abort('failed'); } else await route.continue(); });
  await page.route('**/rpc/complete_listing_image', async route => { if (!completionInterrupted) { completionInterrupted = true; await route.abort('failed'); } else await route.continue(); });
  await input.setInputFiles({ name: 'drill.png', mimeType: 'image/png', buffer: listingImageBytes }); await page.getByRole('button', { name: 'Upload or retry image' }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Upload or retry image' })).toBeEnabled();
  await page.getByRole('button', { name: 'Upload or retry image' }).click(); await expect.poll(() => completionInterrupted).toBe(true); await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Upload or retry image' }).click(); await expect(page.getByRole('img', { name: 'Shared item' })).toBeVisible();
  expect(await page.getByRole('img', { name: 'Shared item' }).getAttribute('src')).toMatch(/^blob:/);
  const images = await f.alice.client.from('listing_images').select('*').eq('listing_id', listing.id); expect(images.data).toHaveLength(1); expect(images.data?.[0].state).toBe('ready');
  expect(interrupted).toBe(true); await capture(page, info, 6, images.data);
});

test('lane 7 other member sees no edit and direct forged ownership fails', async ({ page }, info) => {
  const f = await listingFixture('listing-forged'); const listing = await publishDrill(f.alice, f.community.id); await openDrill(page, f, listing.id, f.bob.email);
  await expect(page.getByRole('button', { name: 'Edit Listing', exact: true })).toHaveCount(0);
  const edit = await f.bob.client.rpc('save_listing', { p_intent_id: randomUUID(), p_community_id: f.community.id, p_listing_id: listing.id, p_expected_version: 1, p_details: { ...drillDetails, owner_id: f.bob.id } }); expect(edit.error?.code).toBe('42501');
  const forged = await f.bob.client.from('listings').update({ owner_id: f.bob.id }).eq('id', listing.id); expect(forged.error?.code).toBe('42501'); await capture(page, info, 7, { command: edit.error?.code, directWrite: forged.error?.code });
});

test('lane 8 outsider and revoked member lose rows images and cached browser detail', async ({ page }, info) => {
  const f = await listingFixture('listing-revoked'); const listing = await publishDrill(f.alice, f.community.id); const image = await uploadListingImage(f.alice, listing.id);
  await openDrill(page, f, listing.id, f.bob.email); await expect(page.getByRole('img', { name: 'Shared item' })).toBeVisible();
  await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('heading', { name: 'Listings unavailable.' })).toBeVisible(); await expect(page.getByRole('img')).toHaveCount(0);
  const outsider = await actor({ label: 'listing-browser-outsider' });
  for (const member of [f.bob, outsider]) { expect((await member.client.from('listings').select('*').eq('id', listing.id)).data).toEqual([]); expect((await member.client.storage.from('listing-images').download(image.object_path)).error).toBeTruthy(); }
  const notices = await admin.from('notification_outbox').select('*').eq('community_id', f.community.id); expect(JSON.stringify(notices.data)).not.toContain('/storage/');
  await capture(page, info, 8, { removed: 'denied', outsider: 'denied', noticeURLs: false });
});

test('lane 9 owner profile and honest Borrow Request entry are reachable', async ({ page }, info) => {
  const f = await listingFixture('listing-profile'); const listing = await publishDrill(f.alice, f.community.id); await seedReputationEvent(f.community.id, f.bob.id, -10);
  await openDrill(page, f, listing.id, f.bob.email); await page.getByRole('button', { name: 'Borrow Request', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Borrow Request', exact: true })).toContainText('No request has been sent.'); await expect(page.getByRole('region', { name: 'Borrow Request', exact: true })).toContainText('below');
  await page.getByRole('link', { name: 'View owner profile' }).click(); await expect(page.getByRole('heading', { name: f.alice.email, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Member Listings', exact: true }).getByRole('link', { name: drillDetails.title, exact: true })).toBeVisible();
  await capture(page, info, 9, { profile: f.alice.id, submission: 'deferred to issue 6', score: 40 });
});

test('lane 10 keyboard and touch creation discovery image errors and detail actions', async ({ page }, info) => {
  const f = await listingFixture('listing-keyboard'); await openFeed(page, f);
  await page.getByRole('button', { name: 'Share an item', exact: true }).click(); await page.getByLabel('Title', { exact: true }).fill(drillDetails.title);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByLabel('Title', { exact: true })).toHaveValue(drillDetails.title);
  await fillDrill(page, false);
  await page.getByLabel('Optional gratitude or maintenance suggestion').focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Save Listing', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: drillDetails.title, exact: true })).toBeVisible();
  await page.getByLabel('Private image (JPEG, PNG, WebP, up to 5 MB)').setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }); await page.getByRole('button', { name: 'Upload or retry image' }).click(); await expect(page.getByRole('alert')).toContainText('Choose a JPEG');
  await page.getByRole('link', { name: `Back to Listings in ${f.community.name}` }).click(); await page.getByLabel('Search Listings').fill('Makita'); await page.getByRole('link', { name: drillDetails.title, exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Borrow Request', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await capture(page, info, 10, (await f.bob.client.from('listings').select('title,replacement_value,minimum_score').eq('community_id', f.community.id)).data);
});
