import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { admin, actor, password, stripeWorker } from '../../scripts/verify/backend';
import { billingFixture, currentSubscriptionFixture, deliverTestReceipt, persistedStatus, realBillingConfig, stripeTestApi } from '../../supabase/functions/stripe-checkout/verification';
import { processReceipt } from '../../supabase/functions/stripe-checkout/worker';
import { TestStripe } from '../../supabase/functions/stripe-checkout/provider';

test.beforeAll(() => { realBillingConfig(); });
test.setTimeout(180000);

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('link', { name: 'Test billing', exact: true }).click();
  await expect(page.getByTestId('billing-status')).toBeVisible();
}

async function capture(page: Page, info: TestInfo, lane: number, data: unknown) {
  await page.screenshot({ path: info.outputPath(`lane-${lane}/scenario.png`), fullPage: true });
  await info.attach('durable billing receipt', { body: JSON.stringify({ utc: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewport: info.project.name, lane, data,
  }), contentType: 'application/json' });
}

async function fillCard(page: Page, number = '4242424242424242') {
  const fields = [
    { selectors: ['input[name="cardNumber"]', 'input[autocomplete="cc-number"]'], value: number },
    { selectors: ['input[name="cardExpiry"]', 'input[autocomplete="cc-exp"]'], value: '1230' },
    { selectors: ['input[name="cardCvc"]', 'input[autocomplete="cc-csc"]'], value: '123' },
  ];
  for (const field of fields) {
    let filled = false;
    for (const frame of page.frames()) {
      const input = frame.locator(field.selectors.join(',')).first();
      if (await input.isVisible()) { await input.fill(field.value); filled = true; break; }
    }
    expect(filled, `Stripe test card field ${field.selectors[0]} is visible`).toBe(true);
  }
  for (const frame of page.frames()) {
    const name = frame.locator('input[name="billingName"]').first();
    if (await name.isVisible()) await name.fill('Ourtopia Test Member');
    const zip = frame.locator('input[name="billingPostalCode"], input[autocomplete="postal-code"]').first();
    if (await zip.isVisible()) await zip.fill('60601');
  }
}

async function startCheckout(page: Page, email: string) {
  await page.getByRole('button', { name: /Start test checkout|Retry test checkout/ }).click();
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 30000 });
  const emailInput = page.locator('input[type="email"]').first();
  if (await emailInput.isVisible()) await emailInput.fill(email);
  await fillCard(page);
}

async function submitCheckout(page: Page) {
  await page.getByRole('button', { name: /Subscribe|Pay|Start subscription/i }).last().click();
  await expect(page).toHaveURL(/\/billing\?checkout=returned/, { timeout: 90000 });
  await expect(page.getByTestId('billing-status')).toContainText('active', { timeout: 60000 });
}

async function cancelProviderSubscription(id: string) {
  const value = z.object({ status: z.string() }).parse(await stripeTestApi(`subscriptions/${id}`));
  if (value.status !== 'canceled') await stripeTestApi(`subscriptions/${id}`, 'DELETE');
}

test('lane 1 trunk absence and real test Checkout durable end state', async ({ page, browser }, info) => {
  const fixture = await billingFixture('billing-trunk');
  const base = '3f5f3fd0293421cc2688576acfc8d742e676dc4c';
  const root = `.pilot-evidence/billing-trunk-${info.project.name}`;
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(path => /^(src\/|vite.config.ts$|index.html$|package.json$)/.test(path));
  for (const path of paths) { const target = `${root}/${path}`; mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, execFileSync('git', ['show', `${base}:${path}`])); }
  copyFileSync('.env.local', `${root}/.env.local`);
  const port = Number(process.env.APP_PORT ?? 56225) + 1;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', root, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore', windowsHide: true });
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
  try {
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}`)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    const baseline = await context.newPage();
    await baseline.goto('/'); await baseline.getByLabel('Email address').fill(fixture.member.email); await baseline.getByLabel('Password', { exact: true }).fill(password);
    await baseline.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(baseline.getByRole('heading', { name: `Welcome to ${fixture.community.name}.` })).toBeVisible();
    await expect(baseline.getByRole('link', { name: 'Test billing', exact: true })).toHaveCount(0);
    await baseline.screenshot({ path: info.outputPath('lane-1/trunk.png'), fullPage: true });
  } finally { await context.close(); server.kill(); }
  await signIn(page, fixture.member.email); await startCheckout(page, fixture.member.email); await submitCheckout(page);
  const rows = await persistedStatus(fixture.member.id);
  expect(rows[0]?.status).toBe('active');
  await page.screenshot({ path: info.outputPath('lane-1/head.png'), fullPage: true });
  await capture(page, info, 1, { base, trunkBilling: 'absent', rows });
  await cancelProviderSubscription(rows[0].subscription_id);
});

test('lane 2 complete real Stripe test Checkout linked to the account', async ({ page }, info) => {
  const fixture = await billingFixture('billing-checkout');
  await signIn(page, fixture.member.email); await startCheckout(page, fixture.member.email); await submitCheckout(page);
  const rows = await persistedStatus(fixture.member.id);
  expect(rows).toHaveLength(1); expect(rows[0].status).toBe('active');
  const current = await new TestStripe(realBillingConfig().key).subscription(rows[0].subscription_id);
  expect(current.metadata.account_id).toBe(fixture.member.id); expect(current.customer).toBe(rows[0].customer_id);
  await capture(page, info, 2, { rows, currentStatus: current.status, livemode: current.livemode });
  await cancelProviderSubscription(rows[0].subscription_id);
});

test('lane 3 real test payment failure retry and subscription cancellation preserve membership', async ({ page }, info) => {
  const fixture = await billingFixture('billing-retry');
  await signIn(page, fixture.member.email); await startCheckout(page, fixture.member.email);
  await fillCard(page, '4000000000000002');
  await page.getByRole('button', { name: /Subscribe|Pay|Start subscription/i }).last().click();
  await expect(page.getByText(/card was declined|card has been declined/i).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: info.outputPath('lane-3/failure.png'), fullPage: true });
  await fillCard(page); await submitCheckout(page);
  await page.getByRole('button', { name: 'Cancel test subscription', exact: true }).click();
  await expect(page.getByTestId('billing-status')).toContainText('canceled', { timeout: 60000 });
  expect((await fixture.member.client.from('memberships').select('role,status').eq('community_id', fixture.community.id)).data).toEqual([{ role: 'administrator', status: 'active' }, { role: 'member', status: 'active' }]);
  await capture(page, info, 3, { rows: await persistedStatus(fixture.member.id), failedThenRetriedRealCard: true, membershipUnchanged: true });
});

test('lane 4 approved unpaid member retains ordinary Community access', async ({ page }, info) => {
  const fixture = await billingFixture('billing-unpaid');
  await signIn(page, fixture.member.email);
  await expect(page.getByTestId('billing-status')).toContainText('No test subscription');
  await page.getByRole('link', { name: 'Back to your Communities' }).click();
  await expect(page.getByRole('heading', { name: `Welcome to ${fixture.community.name}.` })).toBeVisible();
  expect((await fixture.member.client.from('communities').select('id').eq('id', fixture.community.id)).data).toEqual([{ id: fixture.community.id }]);
  expect(await persistedStatus(fixture.member.id)).toEqual([]);
  await capture(page, info, 4, { approvedUnpaidAccess: true, activityScope: 'all ordinary activity available at this base is Community home and membership reads' });
});

test('lane 5 invalid and changed raw signatures and forged redirects cannot set status', async ({ page }, info) => {
  const fixture = await billingFixture('billing-forged');
  for (const options of [{ invalid: true }, { mutateBody: true }]) {
    const result = await deliverTestReceipt('sub_unverified_fixture', 'cus_unverified_fixture', options);
    expect(result.response.ok).toBe(false);
    expect((await admin.from('stripe_receipts').select('*').eq('event_id', result.eventId)).data).toEqual([]);
  }
  await signIn(page, fixture.member.email); await page.goto('/billing?checkout=returned&status=active&subscription_id=sub_forged');
  await expect(page.getByTestId('billing-status')).toContainText('No test subscription');
  expect(await persistedStatus(fixture.member.id)).toEqual([]);
  await capture(page, info, 5, { unverifiedReceipts: 0, forgedReturnChangedStatus: false });
});

test('lane 6 processed duplicate and failed receipt retry retain coherent durable state', async ({ page }, info) => {
  const fixture = await currentSubscriptionFixture('billing-duplicate');
  try {
    const eventId = `evt_fixture_${randomUUID().replaceAll('-', '')}`;
    const first = await deliverTestReceipt(fixture.subscriptionId, fixture.customer, { eventId }); expect(first.response.ok).toBe(true);
    const prior = await first.response.json();
    const second = await deliverTestReceipt(fixture.subscriptionId, fixture.customer, { eventId }); expect(second.response.ok).toBe(true); expect(await second.response.json()).toEqual(prior);
    const failedEvent = `${eventId}failed`;
    await fixture.backend.rpc('receive_stripe_receipt', { p_event_id: failedEvent, p_event_type: 'customer.subscription.updated', p_subscription_id: fixture.subscriptionId, p_customer_id: fixture.customer, p_fingerprint: 'verified-failure-fixture' });
    await expect(processReceipt(fixture.backend, new TestStripe('sk_test_fixture', async () => new Response(null, { status: 503 })), failedEvent)).rejects.toThrow(/retryable/);
    expect((await admin.from('stripe_receipts').select('state').eq('event_id', failedEvent).single()).data?.state).toBe('failed');
    await processReceipt(fixture.backend, fixture.stripe, failedEvent);
    expect((await admin.from('stripe_receipts').select('state').eq('event_id', failedEvent).single()).data?.state).toBe('processed');
    await signIn(page, fixture.member.email); await expect(page.getByTestId('billing-status')).toContainText('active');
    await capture(page, info, 6, { prior, failedReceiptRetried: true, externalMode: 'real Stripe current object; synthetic signed delivery and targeted failure fixture' });
  } finally { await cancelProviderSubscription(fixture.subscriptionId); }
});

test('lane 7 concurrent and out of order receipts converge on current Stripe status', async ({ page }, info) => {
  const fixture = await currentSubscriptionFixture('billing-order');
  try {
    await cancelProviderSubscription(fixture.subscriptionId);
    const results = await Promise.all([deliverTestReceipt(fixture.subscriptionId, fixture.customer, { created: 9999999999 }), deliverTestReceipt(fixture.subscriptionId, fixture.customer, { created: 1 })]);
    for (const result of results) if (!result.response.ok) await processReceipt(fixture.backend, fixture.stripe, result.eventId);
    for (const result of results) expect((await admin.from('stripe_receipts').select('state').eq('event_id', result.eventId).single()).data?.state).toBe('processed');
    expect((await persistedStatus(fixture.member.id))[0].status).toBe('canceled');
    await signIn(page, fixture.member.email); await expect(page.getByTestId('billing-status')).toContainText('canceled');
    await capture(page, info, 7, { currentStripeStatus: 'canceled', createdTimestampIgnored: true, eventIds: results.map(result => result.eventId) });
  } finally { await cancelProviderSubscription(fixture.subscriptionId); }
});

test('lane 8 crash after receipt persistence or claim recovers with a fenced current-object retry', async ({ page }, info) => {
  const fixture = await currentSubscriptionFixture('billing-crash');
  try {
    const eventId = `evt_fixture_${randomUUID().replaceAll('-', '')}`;
    await fixture.backend.rpc('receive_stripe_receipt', { p_event_id: eventId, p_event_type: 'customer.subscription.updated', p_subscription_id: fixture.subscriptionId, p_customer_id: fixture.customer, p_fingerprint: 'verified-crash-fixture' });
    expect((await admin.from('stripe_receipts').select('state').eq('event_id', eventId).single()).data?.state).toBe('pending');
    const crashed = z.object({ claim_token: z.uuid() }).parse(await fixture.backend.rpc('claim_stripe_receipt', { p_event_id: eventId }));
    await admin.from('stripe_writers').update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq('subscription_id', fixture.subscriptionId);
    await processReceipt(fixture.backend, fixture.stripe, eventId);
    const stored = await admin.from('stripe_receipts').select('state,attempts').eq('event_id', eventId).single();
    expect(stored.data).toEqual({ state: 'processed', attempts: 2 });
    const duplicate = await stripeWorker().rpc('finish_stripe_receipt', { p_event_id: eventId, p_claim_token: crashed.claim_token, p_account_id: fixture.member.id, p_status: 'canceled' });
    expect(duplicate.data.status).toBe('active');
    await signIn(page, fixture.member.email); await expect(page.getByTestId('billing-status')).toContainText('active');
    await capture(page, info, 8, { receipt: stored.data, expiredCompletionReturnedPriorResult: true });
  } finally { await cancelProviderSubscription(fixture.subscriptionId); }
});

test('lane 9 another account cannot read billing and webhook scope cannot change membership', async ({ page }, info) => {
  const fixture = await currentSubscriptionFixture('billing-private');
  try {
    const delivered = await deliverTestReceipt(fixture.subscriptionId, fixture.customer); expect(delivered.response.ok).toBe(true);
    const stranger = await actor({ label: 'billing-private-stranger' });
    expect((await stranger.client.from('billing_subscriptions').select('*')).data).toEqual([]);
    expect((await stranger.client.from('billing_accounts').select('*')).data).toEqual([]);
    expect((await stranger.client.from('billing_jobs').select('*')).data).toEqual([]);
    expect((await stripeWorker().from('memberships').update({ role: 'administrator' }).eq('user_id', stranger.id)).error).not.toBeNull();
    await signIn(page, stranger.email); await expect(page.getByTestId('billing-status')).toContainText('No test subscription');
    await capture(page, info, 9, { crossAccountRows: 0, workerRoleMutationDenied: true });
  } finally { await cancelProviderSubscription(fixture.subscriptionId); }
});

test('lane 10 test labels keyboard failure retry and hosted checkout cancellation', async ({ page }, info) => {
  const fixture = await billingFixture('billing-accessible');
  await signIn(page, fixture.member.email);
  await expect(page.getByText('STRIPE TEST MODE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start test checkout', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Start test checkout', exact: true })).toBeFocused();
  await page.route('**/functions/v1/stripe-checkout', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Targeted transport failure fixture' }) }));
  await page.keyboard.press('Enter'); await expect(page.getByRole('alert')).toContainText('Retry the same action');
  await page.unroute('**/functions/v1/stripe-checkout');
  await startCheckout(page, fixture.member.email);
  const back = page.getByRole('link', { name: /Back/i }).first();
  await expect(back).toBeVisible(); await back.click();
  await expect(page).toHaveURL(/\/billing\?checkout=canceled/);
  await expect(page.getByTestId('billing-status')).toContainText('No test subscription');
  expect((await fixture.member.client.from('memberships').select('status').eq('community_id', fixture.community.id).eq('user_id', fixture.member.id)).data).toEqual([{ status: 'active' }]);
  await capture(page, info, 10, { keyboardActivated: true, transportFailureRetried: true, hostedCheckoutCanceled: true, testOnly: true });
});
