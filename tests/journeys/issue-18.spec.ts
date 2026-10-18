import { test, expect, type Page, type TestInfo, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeMember, actor, admin, caseAction, completedExchanges, createCommunity, membershipFixture, password, reviewedDispute, seedIncident, seedReputationEvent } from '../../scripts/verify/backend';

test.describe.configure({ timeout: 150000 });

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

// Closed as unresolved through the command the case page uses, so each lane starts from the same persisted decision.
async function unresolvedCase(label: string) {
  const f = await reviewedDispute(label);
  const decided = await caseAction(f.owner, f.disputeId, 'decide', { outcome: 'unresolved', reason: 'The submitted evidence supports the reported damage.' });
  expect(decided.error).toBeNull();
  return f;
}

async function openCase(page: Page, email: string, exchangeId: string) {
  await signIn(page, email);
  await page.goto(`/disputes/${exchangeId}`);
  await expect(page.getByRole('heading', { name: 'Remedies and decisions', exact: true })).toBeVisible();
  return page.getByRole('region', { name: 'Verified misconduct' });
}

async function recordPenalty(misconduct: Locator, rule: string, party: string, reason: string) {
  await misconduct.getByLabel('Rule').selectOption(rule);
  if (rule !== 'late_return') await misconduct.getByLabel('Responsible member').selectOption({ label: party });
  await misconduct.getByLabel('Reason for verified decision').fill(reason);
  await misconduct.getByRole('button', { name: 'Record verified penalty' }).click();
}

async function save(page: Page, info: TestInfo, lane: number, data: unknown) {
  const path = info.outputPath(`lane-${lane}/scenario.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  writeFileSync(info.outputPath(`lane-${lane}/scenario.json`), JSON.stringify({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), project: info.project.name, data,
  }, null, 2));
}

test('lane 1 damage decision, -10 history, and later linked correction', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-1-${info.project.name}`);
  const misconduct = await openCase(page, f.owner.email, f.exchangeId);
  await recordPenalty(misconduct, 'unresolved_damage', 'Borrower', 'The dated return photographs show new damage.');
  await expect(misconduct.getByRole('status')).toContainText('Recorded -10 for Unresolved damage.');
  const ledger = misconduct.getByRole('list', { name: 'Verified penalties and corrections' });
  await expect(ledger).toContainText('-10');
  await misconduct.getByLabel('Correction reason').fill('A later dated repair receipt reverses the finding.');
  await misconduct.getByRole('button', { name: 'Append linked correction' }).click();
  await expect(ledger).toContainText('Linked correction');
  await expect(ledger).toContainText('+10');
  const rows = await admin.from('reputation_events').select('id,points,corrects_event_id,reason').eq('exchange_id', f.exchangeId).order('created_at');
  const [original, correction] = rows.data ?? [];
  expect(rows.data?.length).toBe(2);
  expect(original).toMatchObject({ points: -10, corrects_event_id: null });
  expect(correction).toMatchObject({ points: 10, corrects_event_id: original?.id });
  await save(page, info, 1, { persisted: rows.data });
});

test('lane 2 member sees the -10 history and its linked correction on own standing', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-2-${info.project.name}`);
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'The dated return photographs show new damage.' });
  expect(recorded.error).toBeNull();
  const correction = await f.owner.client.rpc('correct_reputation_event', { p_intent_id: randomUUID(), p_event_id: (recorded.data as { eventId: string }).eventId,
    p_reason: 'A later dated repair receipt reverses the finding.' });
  expect(correction.error).toBeNull();
  await signIn(page, f.bob.email);
  await page.goto('/standing');
  const history = page.getByRole('region', { name: new RegExp(`Your history in ${f.community.name}`) });
  await expect(history).toContainText('Unresolved damage');
  await expect(history).toContainText('-10');
  await expect(history).toContainText('Linked correction');
  await expect(history).toContainText('+10');
  await save(page, info, 2, { member: f.bob.id });
});

test('lane 3 late return to the borrower and confirmed theft each apply once', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-3-${info.project.name}`);
  const misconduct = await openCase(page, f.owner.email, f.exchangeId);
  await misconduct.getByLabel('Rule').selectOption('late_return');
  await expect(misconduct.getByLabel('Responsible member')).toBeDisabled();
  await misconduct.getByLabel('Reason for verified decision').fill('The item came back two days after the agreed return.');
  await misconduct.getByRole('button', { name: 'Record verified penalty' }).click();
  await expect(misconduct.getByRole('status')).toContainText('Recorded -2 for Late return.');
  await recordPenalty(misconduct, 'confirmed_theft', 'Borrower', 'The owner recovered the item from a third party.');
  await expect(misconduct.getByRole('status')).toContainText('Recorded -30 for Confirmed theft.');
  const rows = await admin.from('reputation_events').select('rule,points,recipient_id').eq('exchange_id', f.exchangeId).order('points');
  expect(rows.data).toEqual([
    { rule: 'confirmed_theft', points: -30, recipient_id: f.bob.id },
    { rule: 'late_return', points: -2, recipient_id: f.bob.id },
  ]);
  await save(page, info, 3, { persisted: rows.data });
});

test('lane 4 distinct rules on one source are accepted and a repeated rule is refused', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-4-${info.project.name}`);
  const misconduct = await openCase(page, f.owner.email, f.exchangeId);
  await recordPenalty(misconduct, 'unresolved_damage', 'Borrower', 'First verified damage finding.');
  await expect(misconduct.getByRole('status')).toContainText('Recorded -10');
  await recordPenalty(misconduct, 'unresolved_damage', 'Borrower', 'Repeated submission of the same finding.');
  await expect(misconduct.getByRole('alert')).toContainText('already applies to this member for this decision');
  await recordPenalty(misconduct, 'late_return', 'Borrower', 'A distinct rule on the same source is allowed.');
  await expect(misconduct.getByRole('status')).toContainText('Recorded -2');
  const rows = await admin.from('reputation_events').select('rule').eq('source_id', f.disputeId).order('rule');
  expect(rows.data?.map(row => row.rule)).toEqual(['late_return', 'unresolved_damage']);
  await save(page, info, 4, { rules: rows.data });
});

test('lane 5 clamped score and preserved completed Exchange count on the member profile', async ({ page }, info) => {
  const owner = await membershipFixture(`misconduct-lane-5-${info.project.name}`);
  const bob = await activeMember(owner.owner, owner.community.id, 'lane-5-bob');
  const alice = await activeMember(owner.owner, owner.community.id, 'lane-5-alice');
  await completedExchanges(owner.community.id, alice.id, bob.id, 2, 'item');
  await seedReputationEvent(owner.community.id, bob.id, -100);
  await seedReputationEvent(owner.community.id, bob.id, -100);
  await signIn(page, owner.owner.email);
  await page.goto(`/communities/${owner.community.id}/members/${bob.id}`);
  const score = page.getByRole('region', { name: 'Community Solidarity Score' });
  await expect(score).toContainText('0 — Lumpen');
  await expect(score).toContainText('2 completed Exchanges');
  await save(page, info, 5, { score: 0, completedInteractions: 2 });
});

test('lane 6 low-volume serious incident is visible against a 400 versus 20 history', async ({ page }, info) => {
  const big = await membershipFixture(`misconduct-lane-6-big-${info.project.name}`);
  const bob = await activeMember(big.owner, big.community.id, 'lane-6-bob');
  const small = await membershipFixture(`misconduct-lane-6-small-${info.project.name}`);
  await completedExchanges(big.community.id, big.owner.id, bob.id, 400, 'item');
  await completedExchanges(small.community.id, small.owner.id, bob.id, 20, 'item');
  await seedIncident(small.community.id, bob.id, 'serious_violation', 'confirmed');
  await signIn(page, big.owner.email);
  await page.goto(`/communities/${big.community.id}/members/${bob.id}`);
  const trust = page.getByRole('region', { name: 'Trust indicators' });
  await expect(trust).toContainText('Serious violation');
  await expect(trust).toContainText('confirmed');
  await expect(trust).toContainText('Shown apart from Solidarity Scores.');
  await save(page, info, 6, { weights: { big: 400, small: 20 } });
});

test('lane 7 raw redacted trust output carries type and status only', async ({ page }, info) => {
  const big = await membershipFixture(`misconduct-lane-7-big-${info.project.name}`);
  const bob = await activeMember(big.owner, big.community.id, 'lane-7-bob');
  const small = await membershipFixture(`misconduct-lane-7-small-${info.project.name}`);
  await completedExchanges(small.community.id, small.owner.id, bob.id, 20, 'item');
  await seedIncident(small.community.id, bob.id, 'serious_violation', 'confirmed');
  const trust = await big.owner.client.rpc('global_trust', { p_subject: bob.id });
  expect(trust.error).toBeNull();
  const text = JSON.stringify(trust.data);
  for (const hidden of [small.community.id, small.community.name, big.community.id, bob.id]) expect(text).not.toContain(hidden);
  expect(Object.keys(trust.data as object).sort()).toEqual(['completedInteractions', 'globalScore', 'incidents']);
  await signIn(page, big.owner.email);
  await page.goto(`/communities/${big.community.id}/members/${bob.id}`);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain(small.community.name);
  await save(page, info, 7, { raw: trust.data });
});

test('lane 8 tampering and foreign administrator attempts fail', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-8-${info.project.name}`);
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'Verified before the tampering attempts.' });
  expect(recorded.error).toBeNull();
  const eventId = (recorded.data as { eventId: string }).eventId;
  const foreign = await actor({ label: `lane-8-foreign-${info.project.name}` });
  expect((await createCommunity(foreign.client)).error).toBeNull();
  expect((await foreign.client.rpc('correct_reputation_event', { p_intent_id: randomUUID(), p_event_id: eventId, p_reason: 'Foreign correction.' })).error?.code).toBe('42501');
  expect((await f.alice.client.from('reputation_events').update({ points: 0 }).eq('id', eventId)).error).toBeTruthy();
  expect((await f.alice.client.from('community_events').insert({ community_id: f.community.id, actor_id: f.alice.id, kind: 'forged', intent_id: randomUUID() })).error).toBeTruthy();
  await signIn(page, foreign.email);
  await page.goto(`/disputes/${f.exchangeId}`);
  await expect(page.getByRole('region', { name: 'Verified misconduct' })).toHaveCount(0);
  const ledger = await admin.from('reputation_events').select('points').eq('id', eventId).single();
  expect(ledger.data).toEqual({ points: -10 });
  await save(page, info, 8, { attempts: 'denied' });
});

test('lane 9 verified events and global weight stay with the owner after membership removal', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-9-${info.project.name}`);
  const recorded = await f.owner.client.rpc('record_verified_misconduct', { p_intent_id: randomUUID(), p_dispute_id: f.disputeId, p_rule: 'unresolved_damage',
    p_recipient_id: f.bob.id, p_reason: 'Verified before the membership ended.' });
  expect(recorded.error).toBeNull();
  const removed = await admin.from('memberships').update({ status: 'removed' }).eq('community_id', f.community.id).eq('user_id', f.bob.id);
  expect(removed.error).toBeNull();
  await signIn(page, f.bob.email);
  await page.goto('/standing');
  const history = page.getByRole('region', { name: new RegExp(`Your history in ${f.community.name}`) });
  await expect(history).toContainText('Unresolved damage');
  await expect(history).toContainText('-10');
  await save(page, info, 9, { removedMembership: true });
});

test('lane 10 penalty, correction, and serious-incident status are reachable by keyboard', async ({ page }, info) => {
  const f = await unresolvedCase(`misconduct-lane-10-${info.project.name}`);
  const misconduct = await openCase(page, f.owner.email, f.exchangeId);
  await expect(misconduct.getByRole('combobox', { name: 'Rule' })).toBeVisible();
  await misconduct.getByLabel('Rule').selectOption('confirmed_theft');
  await misconduct.getByLabel('Responsible member').selectOption({ label: 'Borrower' });
  await misconduct.getByLabel('Reason for verified decision').fill('Confirmed theft reported by the owner.');
  await misconduct.getByRole('button', { name: 'Record verified penalty' }).focus();
  await page.keyboard.press('Enter');
  await expect(misconduct.getByRole('status')).toContainText('Recorded -30 for Confirmed theft.');
  await misconduct.getByLabel('Correction reason').focus();
  await page.keyboard.type('A later receipt shows the item was returned.');
  await misconduct.getByRole('button', { name: 'Append linked correction' }).focus();
  await page.keyboard.press('Enter');
  await expect(misconduct.getByRole('list', { name: 'Verified penalties and corrections' })).toContainText('Linked correction');
  const profile = await page.goto(`/communities/${f.community.id}/members/${f.bob.id}`);
  expect(profile?.ok()).toBeTruthy();
  await expect(page.getByRole('region', { name: 'Trust indicators' })).toContainText('Serious violation');
  await save(page, info, 10, { keyboard: true });
});

