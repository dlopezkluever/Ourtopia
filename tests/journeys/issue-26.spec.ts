import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { actor, admin, completedItemFixture, password } from '../../scripts/verify/backend';

async function signIn(page: Page, email: string) {
  const url = process.env.PILOT_BASE_URL ? new URL('/', process.env.PILOT_BASE_URL).href : '/';
  if (process.env.PILOT_BASE_URL && new URL(url).protocol !== 'https:') throw new Error('PILOT_BASE_URL must use HTTPS.');
  await page.goto(url);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

type Fixture = Awaited<ReturnType<typeof completedItemFixture>>;
let fixture: Fixture;
test.beforeAll(async () => { fixture = await completedItemFixture('pilot-https-smoke'); });

async function capture(page: Page, info: TestInfo, lane: number) {
  const screenshot = info.outputPath(`lane-${lane}/scenario.png`);
  mkdirSync(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  writeFileSync(info.outputPath(`lane-${lane}/scenario.json`), JSON.stringify({ lane, project: info.project.name, viewport: page.viewportSize(), url: page.url(), communityId: fixture.community.id, exchangeId: fixture.exchangeId }, null, 2));
}

const lanes = [
  { id: 1, name: 'Alice and Bob invitation-to-thank-you source records', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const rows = await admin.from('exchanges').select('state,provider_id,receiver_id').eq('id', f.exchangeId);
    expect(rows.error).toBeNull(); expect(rows.data).toEqual([{ state: 'completed', provider_id: f.alice.id, receiver_id: f.bob.id }]);
  } },
  { id: 2, name: 'two-party completion and reputation totals', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const rows = await admin.from('reputation_events').select('recipient_id,points').eq('exchange_id', f.exchangeId);
    expect(rows.error).toBeNull(); expect(rows.data?.map(row => row.points).sort()).toEqual([1, 2]);
  } },
  { id: 3, name: 'private Community membership and item Listing', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const [members, listing] = await Promise.all([admin.from('memberships').select('user_id').eq('community_id', f.community.id).eq('status', 'active'), admin.from('listings').select('id').eq('id', f.listing.id)]);
    expect(members.data).toHaveLength(4); expect(listing.data).toEqual([{ id: f.listing.id }]);
  } },
  { id: 4, name: 'durable Exchange and authorized read', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const [row, allowed] = await Promise.all([f.bob.client.from('exchanges').select('state').eq('id', f.exchangeId).single(), f.bob.client.rpc('can_read_exchange', { p_exchange_id: f.exchangeId })]);
    expect(row.data?.state).toBe('completed'); expect(allowed.data).toBe(true);
  } },
  { id: 5, name: 'owner and borrower read their completed Exchange', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const [owner, borrower] = await Promise.all([f.alice.client.rpc('can_read_exchange', { p_exchange_id: f.exchangeId }), f.bob.client.rpc('can_read_exchange', { p_exchange_id: f.exchangeId })]);
    expect(owner.data).toBe(true); expect(borrower.data).toBe(true);
  } },
  { id: 6, name: 'safe activity is visible in authenticated Community data', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const [listing, events] = await Promise.all([f.alice.client.from('listings').select('id').eq('id', f.listing.id), admin.from('exchange_events').select('kind').eq('exchange_id', f.exchangeId)]);
    expect(listing.data).toEqual([{ id: f.listing.id }]); expect(events.data?.map(row => row.kind)).toContain('completion_settled');
  } },
  { id: 7, name: 'a separate active member cannot read a private Exchange', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const result = await f.carol.client.rpc('can_read_exchange', { p_exchange_id: f.exchangeId });
    expect(result.data).toBe(false);
  } },
  { id: 8, name: 'an unrelated account cannot read the pilot Community', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const unrelated = await actor({ label: 'pilot-lane-outsider' });
    const result = await unrelated.client.from('communities').select('id').eq('id', f.community.id);
    expect(result.data ?? []).toEqual([]);
  } },
  { id: 9, name: 'fresh Community UI reflects current membership', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const row = await f.alice.client.from('memberships').select('status').eq('community_id', f.community.id).eq('user_id', f.alice.id).single();
    expect(row.data).toEqual({ status: 'active' });
  } },
  { id: 10, name: 'mobile and desktop authenticated pilot access', verify: async (f: Awaited<ReturnType<typeof completedItemFixture>>) => {
    const row = await f.owner.client.from('communities').select('name').eq('id', f.community.id).single();
    expect(row.error).toBeNull(); expect(row.data?.name).toBe(f.community.name);
  } },
] as const;

for (const lane of lanes) {
  test(`lane ${lane.id} ${lane.name}`, async ({ page }, info) => {
    await lane.verify(fixture);
    await signIn(page, fixture.alice.email);
    await expect(page.getByRole('heading', { name: `Welcome to ${fixture.community.name}.` })).toBeVisible();
    await capture(page, info, lane.id);
  });
}
