import { helpExchangeSchema, helpPostSchema } from '../../src/features/help/model';
import { deliverOne } from '../../supabase/functions/notifications/worker';
import { borrowViewSchema } from '../../src/features/borrowing/model';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

for (const file of ['.env.local', '.env.test.local']) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z_]+)=["']?(.*?)["']?$/.exec(line);
      if (match) process.env[match[1]] ??= match[2];
    }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
const config = z.object({
  url: z.url(), anon: z.string().min(20), service: z.string().min(20),
  mailbox: z.url(), secret: z.string().min(20),
}).parse({
  url: process.env.VITE_SUPABASE_URL,
  anon: process.env.VITE_SUPABASE_ANON_KEY,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  mailbox: process.env.TEST_MAILBOX_URL ?? `http://127.0.0.1:${/\[local_smtp\][\s\S]*?^port\s*=\s*(\d+)/m.exec(readFileSync('supabase/config.toml', 'utf8'))?.[1]}`,
  secret: process.env.TEST_JWT_SECRET,
});
if (!['localhost', '127.0.0.1'].includes(new URL(config.url).hostname)) throw new Error('Verification requires a disposable local backend.');
const laneConfig = readFileSync('supabase/config.toml', 'utf8');
const laneProject = /^project_id\s*=\s*"([^"]+)"/m.exec(laneConfig)?.[1];
const laneApiPort = /\[api\][\s\S]*?^port\s*=\s*(\d+)/m.exec(laneConfig)?.[1];
const laneInboxPort = /\[local_smtp\][\s\S]*?^port\s*=\s*(\d+)/m.exec(laneConfig)?.[1];
if (!/^ourtopia-issue-\d+$/.test(laneProject ?? '') || new URL(config.url).port !== laneApiPort || new URL(config.mailbox).port !== laneInboxPort) throw new Error('Verification environment must match this disposable lane config.');

export const backendUrl = config.url;
export const anonKey = config.anon;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
export const admin = createClient(config.url, config.service, options);
export function publicClient() { return createClient(config.url, config.anon, options); }
export function stripeWorker() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'stripe_worker', iss: `${config.url}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${payload}.${createHmac('sha256', config.secret).update(payload).digest('base64url')}`;
  return createClient(config.url, config.anon, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } });
}
export const password = 'Ourtopia-test-password-48!';

export async function actor({ verified = true, label = 'actor' } = {}) {
  const email = `${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: verified });
  if (error || !data.user) throw error ?? new Error('Actor setup failed.');
  const client = publicClient();
  if (verified) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } else {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: data.user.id, role: 'authenticated', aud: 'authenticated', iss: `${config.url}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600, email, email_confirmed_at: new Date().toISOString() })}`;
    const token = `${body}.${createHmac('sha256', config.secret).update(body).digest('base64url')}`;
    return { email, id: data.user.id, client: createClient(config.url, config.anon, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } }) };
  }
  return { email, id: data.user.id, client };
}

export async function createCommunity(client: ReturnType<typeof publicClient>, intent = randomUUID(), name = 'Maple Street Neighbors') {
  return client.rpc('create_community', { p_intent_id: intent, p_name: name, p_description: 'A little more possible together.' });
}

export async function membershipFixture(label = 'membership') {
  const owner = await actor({ label: `${label}-admin` });
  const applicant = await actor({ label: `${label}-applicant` });
  const community = z.object({ id: z.uuid(), name: z.string() }).parse((await createCommunity(owner.client, randomUUID(), `${label} circle`)).data);
  return { owner, applicant, community };
}

export async function issueInvite(owner: Awaited<ReturnType<typeof actor>>, communityId: string, email: string, intent = randomUUID()) {
  const result = await owner.client.rpc('issue_invite', { p_intent_id: intent, p_community_id: communityId, p_email: email });
  if (result.error) throw result.error;
  return z.object({ id: z.uuid(), community_id: z.uuid(), expires_at: z.string(), recipient_email: z.string() }).parse(result.data);
}

export async function applyInvite(applicant: Awaited<ReturnType<typeof actor>>, inviteId: string, intent = randomUUID()) {
  const result = await applicant.client.rpc('redeem_invite', { p_intent_id: intent, p_invite_id: inviteId });
  if (result.error) throw result.error;
  return z.object({ id: z.uuid(), community_id: z.uuid(), status: z.literal('pending'), applicant_id: z.uuid() }).parse(result.data);
}

export async function decideApplication(owner: Awaited<ReturnType<typeof actor>>, applicationId: string, decision: 'approved' | 'rejected' = 'approved', reason = '', intent = randomUUID()) {
  return owner.client.rpc('decide_membership', { p_intent_id: intent, p_application_id: applicationId, p_decision: decision, p_reason: reason });
}

export async function deliveryFixture(label = 'delivery') {
  const fixture = await membershipFixture(label);
  const application = await applyInvite(fixture.applicant, (await issueInvite(fixture.owner, fixture.community.id, fixture.applicant.email)).id);
  const decision = await decideApplication(fixture.owner, application.id);
  if (decision.error) throw decision.error;
  const outbox = await admin.from('notification_outbox').select('*').eq('event_id', decision.data.decision_event_id).order('channel');
  if (outbox.error) throw outbox.error;
  const email = outbox.data.find(row => row.channel === 'email');
  const inApp = outbox.data.find(row => row.channel === 'in_app');
  if (!email || !inApp) throw new Error('Approval must enqueue both delivery channels.');
  return { ...fixture, application, email, inApp };
}

export async function failedDelivery(label = 'delivery-failure', error = 'Synthetic provider outage') {
  const fixture = await deliveryFixture(label);
  const failed = await deliverOne(admin, async () => { throw new Error(error); }, fixture.email.id) as { state: string };
  if (failed.state !== 'failed') throw new Error('Expected a durable email failure.');
  return fixture;
}

// Realtime starts delivering database changes several seconds after a reset; wait until a probe change arrives.
export async function realtimeReady(timeoutMs = 60000) {
  const probe = await actor({ label: 'realtime-probe' });
  const community = z.object({ id: z.uuid() }).parse((await createCommunity(probe.client)).data);
  const session = await probe.client.auth.getSession();
  await probe.client.realtime.setAuth(session.data.session?.access_token ?? anonKey);
  let delivered = false;
  const channel = probe.client.channel(`realtime-probe-${randomUUID()}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_events', filter: `community_id=eq.${community.id}` }, change => { if (change.new.kind === 'realtime_probe') delivered = true; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Realtime probe did not subscribe.')), timeoutMs);
      channel.subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); } });
    });
    const deadline = Date.now() + timeoutMs;
    while (!delivered) {
      if (Date.now() > deadline) throw new Error(`Realtime delivered no changes within ${timeoutMs}ms.`);
      const { error } = await admin.from('community_events').insert({ community_id: community.id, actor_id: probe.id, intent_id: randomUUID(), kind: 'realtime_probe' });
      if (error) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await probe.client.removeChannel(channel); probe.client.realtime.disconnect(); }
}

const messageList = z.object({ messages: z.array(z.object({ ID: z.string() })) });
const messageDetail = z.object({ HTML: z.string().optional(), Text: z.string().optional() });
export async function mailboxLink(email: string, type: 'signup' | 'recovery') {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await fetch(`${config.mailbox}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (!result.ok) throw new Error(`Mailbox returned ${result.status}.`);
    const list = messageList.parse(await result.json());
    for (const message of list.messages) {
      const details = await fetch(`${config.mailbox}/api/v1/message/${message.ID}`);
      const value = messageDetail.parse(await details.json());
      const body = `${value.HTML ?? ''}\n${value.Text ?? ''}`.replaceAll('&amp;', '&');
      const links = body.match(/https?:\/\/[^\s"<>]+/g) ?? [];
      const link = links.find(url => url.includes('/auth/v1/verify?') && url.includes(`type=${type}`));
      if (link) return link;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No ${type} email arrived before the 30s timeout.`);
}

export function receipt(name: string, result: unknown) {
  const directory = process.env.EVIDENCE_DIR ?? '.pilot-evidence';
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/${name}.json`, JSON.stringify({ utc: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0, backend: config.url, result }, null, 2));
}

export async function activeMember(owner: Awaited<ReturnType<typeof actor>>, communityId: string, label = 'member') {
  const member = await actor({ label });
  const application = await applyInvite(member, (await issueInvite(owner, communityId, member.email)).id);
  const decision = await decideApplication(owner, application.id);
  if (decision.error) throw decision.error;
  return member;
}

export async function pendingVouchApplicant(owner: Awaited<ReturnType<typeof actor>>, communityId: string, label = 'vouch-applicant') {
  const applicant = await actor({ label });
  const application = await applyInvite(applicant, (await issueInvite(owner, communityId, applicant.email)).id);
  return { applicant, application };
}

export async function vouchFixture(label = 'vouch') {
  const { owner, community } = await membershipFixture(label);
  const sponsor = await activeMember(owner, community.id, `${label}-sponsor`);
  const { applicant, application } = await pendingVouchApplicant(owner, community.id, `${label}-pending`);
  return { owner, community, sponsor, applicant, application };
}

export async function configureVouch(owner: Awaited<ReturnType<typeof actor>>, communityId: string, sponsorId: string, limit = 3, eligible = true, intent = randomUUID()) {
  return owner.client.rpc('configure_vouch', { p_intent_id: intent, p_community_id: communityId, p_sponsor_id: sponsorId, p_eligible: eligible, p_annual_limit: limit });
}

export async function submitVouch(sponsor: Awaited<ReturnType<typeof actor>>, applicationId: string, statement = 'I know this neighbor and trust them to contribute thoughtfully.', intent = randomUUID()) {
  return sponsor.client.rpc('submit_vouch', { p_intent_id: intent, p_application_id: applicationId, p_statement: statement });
}

export const conversationRow = z.object({ id: z.uuid(), community_id: z.uuid(), participant_low: z.uuid(), participant_high: z.uuid(), started_by: z.uuid(), created_at: z.string() });
export const messageRow = z.object({ id: z.uuid(), conversation_id: z.uuid(), community_id: z.uuid(), author_id: z.uuid(), intent_id: z.uuid(), body: z.string(), created_at: z.string() });

export async function startConversation(starter: Awaited<ReturnType<typeof actor>>, communityId: string, participantId: string, intent = randomUUID()) {
  const result = await starter.client.rpc('start_conversation', { p_intent_id: intent, p_community_id: communityId, p_participant_id: participantId });
  if (result.error) throw result.error;
  return conversationRow.parse(result.data);
}

export async function sendMessage(author: Awaited<ReturnType<typeof actor>>, conversationId: string, body: string, intent = randomUUID()) {
  const result = await author.client.rpc('send_message', { p_intent_id: intent, p_conversation_id: conversationId, p_body: body });
  if (result.error) throw result.error;
  return messageRow.parse(result.data);
}

export async function conversationFixture(label = 'conversation') {
  const { owner, community } = await membershipFixture(label);
  const first = await activeMember(owner, community.id, `${label}-first`);
  const second = await activeMember(owner, community.id, `${label}-second`);
  const conversation = await startConversation(first, community.id, second.id);
  return { owner, community, first, second, conversation };
}

// Server-seeded verified history: completed Exchanges settled through the real completion producer.
export async function completedExchanges(communityId: string, providerId: string, receiverId: string, count: number, kind: 'item' | 'help' = 'help') {
  if (count === 0) return [];
  const rows = Array.from({ length: count }, () => ({ community_id: communityId, kind, provider_id: providerId, receiver_id: receiverId, source_kind: kind === 'help' ? 'need_post' : 'listing', source_id: randomUUID(), state: 'completed' }));
  const inserted = await admin.from('exchanges').insert(rows).select('id');
  if (inserted.error) throw inserted.error;
  const ids = z.array(z.object({ id: z.uuid() })).parse(inserted.data).map(row => row.id);
  const settled = await admin.rpc('settle_exchange_completions', { p_exchange_ids: ids });
  if (settled.error) throw settled.error;
  return ids;
}

export async function seedReputationEvent(communityId: string, recipientId: string, points: number, rule = 'fixture_adjustment') {
  const result = await admin.from('reputation_events').insert({ community_id: communityId, recipient_id: recipientId, rule, points, source_kind: 'fixture', source_id: randomUUID(), verified_by_command: 'fixture_seed' }).select('id').single();
  if (result.error) throw result.error;
  return result.data.id;
}

export async function seedIncident(communityId: string, subjectId: string, type: 'unresolved_dispute' | 'serious_violation', status: string) {
  const result = await admin.from('trust_incidents').insert({ community_id: communityId, subject_id: subjectId, type, status, source_kind: 'fixture', source_id: randomUUID() }).select('id').single();
  if (result.error) throw result.error;
  return result.data.id;
}

export const drillDetails = {
  title: "Alice's Makita drill", description: 'Cordless Makita drill with two batteries and charger.', category: 'tools', condition: 'Good. Light marks on the case.',
  replacement_value: 180, pickup_notes: 'Meet at the front porch.', lending_conditions: 'Return with charged batteries.', minimum_score: 45,
  gratitude: 'Optional $5 toward replacement bits. No priority benefit.', availability: [{ starts_on: '2027-01-10', ends_on: '2027-01-20' }, { starts_on: '2027-02-01', ends_on: '2027-02-05' }],
};
export async function listingFixture(label = 'listing') {
  const f = await membershipFixture(label);
  const alice = await activeMember(f.owner, f.community.id, `${label}-alice`);
  const bob = await activeMember(f.owner, f.community.id, `${label}-bob`);
  return { ...f, alice, bob };
}
export async function publishDrill(member: Awaited<ReturnType<typeof actor>>, communityId: string, details = drillDetails, intent = randomUUID()) {
  const result = await member.client.rpc('save_listing', { p_intent_id: intent, p_community_id: communityId, p_listing_id: null, p_expected_version: 0, p_details: details });
  if (result.error) throw result.error;
  return z.object({ id: z.uuid(), community_id: z.uuid(), owner_id: z.uuid(), title: z.string(), status: z.string(), version: z.number(), replacement_value: z.number(), minimum_score: z.number() }).parse(result.data);
}
export const listingImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
export async function prepareListingImage(member: Awaited<ReturnType<typeof actor>>, listingId: string) {
  const result = await member.client.rpc('prepare_listing_image', { p_intent_id: randomUUID(), p_listing_id: listingId, p_image_id: randomUUID(), p_mime_type: 'image/png', p_byte_size: listingImageBytes.length });
  if (result.error) throw result.error;
  return z.object({ id: z.uuid(), object_path: z.string() }).parse(result.data);
}
export async function uploadListingImage(member: Awaited<ReturnType<typeof actor>>, listingId: string) {
  const image = await prepareListingImage(member, listingId);
  const uploaded = await member.client.storage.from('listing-images').upload(image.object_path, listingImageBytes, { contentType: 'image/png' });
  if (uploaded.error) throw uploaded.error;
  const completed = await member.client.rpc('complete_listing_image', { p_intent_id: randomUUID(), p_image_id: image.id });
  if (completed.error) throw completed.error;
  return image;
}

export async function borrowingFixture(label = 'borrowing') {
  const f = await listingFixture(label);
  const carol = await activeMember(f.owner, f.community.id, `${label}-carol`);
  const listing = await publishDrill(f.alice, f.community.id);
  return { ...f, carol, listing };
}
export async function requestItem(borrower: Awaited<ReturnType<typeof actor>>, listingId: string, startsOn = '2027-01-15', endsOn = '2027-01-17', intent = randomUUID()) {
  const result = await borrower.client.rpc('submit_borrow_request', { p_intent_id: intent, p_listing_id: listingId, p_starts_on: startsOn, p_ends_on: endsOn });
  if (result.error) throw result.error;
  return borrowViewSchema.parse(result.data);
}
export async function decideBorrow(owner: Awaited<ReturnType<typeof actor>>, request: { id: string; version: number }, decision: 'approved' | 'rejected' = 'approved', intent = randomUUID()) {
  return owner.client.rpc('decide_borrow_request', { p_intent_id: intent, p_request_id: request.id, p_expected_version: request.version, p_decision: decision });
}
export async function approveBorrow(owner: Awaited<ReturnType<typeof actor>>, request: { id: string; version: number }) {
  const result = await decideBorrow(owner, request);
  if (result.error) throw result.error;
  return borrowViewSchema.parse(result.data);
}
// Test-only shortening of the configured 48-hour acknowledgment window; always restored.
export async function withAcknowledgmentWindow<T>(window: string, run: () => Promise<T>) {
  const set = async (value: string) => { const result = await admin.from('allocation_settings').update({ acknowledgment_window: value }).eq('singleton', true); if (result.error) throw result.error; };
  await set(window);
  try { return await run(); } finally { await set('48 hours'); }
}
// Stands in for issue 7 Handoff: the borrower acknowledged in time and took the item.
export async function checkOutFixture(exchangeId: string) {
  for (const update of [admin.from('item_reservations').update({ acknowledged_at: new Date().toISOString() }).eq('exchange_id', exchangeId), admin.from('exchanges').update({ state: 'handoff_pending' }).eq('id', exchangeId), admin.from('exchanges').update({ state: 'checked_out' }).eq('id', exchangeId)]) {
    const result = await update; if (result.error) throw result.error;
  }
}
export async function overdueBorrowFixture(f: Awaited<ReturnType<typeof borrowingFixture>>) {
  const exchange = await admin.from('exchanges').insert({ community_id: f.community.id, kind: 'item', provider_id: f.alice.id, receiver_id: f.bob.id, source_kind: 'listing', source_id: f.listing.id, state: 'approved' }).select('id').single();
  if (exchange.error) throw exchange.error;
  const request = await admin.from('borrow_requests').insert({ community_id: f.community.id, listing_id: f.listing.id, owner_id: f.alice.id, borrower_id: f.bob.id, starts_on: '2020-01-15', ends_on: '2020-01-17', status: 'approved', version: 2, exchange_id: exchange.data.id, decided_at: new Date().toISOString() }).select('id').single();
  if (request.error) throw request.error;
  const reservation = await admin.from('item_reservations').insert({ exchange_id: exchange.data.id, request_id: request.data.id, listing_id: f.listing.id, starts_on: '2020-01-15', ends_on: '2020-01-17', acknowledgment_due_at: new Date(Date.now() + 48 * 3600000).toISOString(), condition: drillDetails.condition, replacement_value: drillDetails.replacement_value, lending_conditions: drillDetails.lending_conditions });
  if (reservation.error) throw reservation.error;
  await checkOutFixture(exchange.data.id);
  return { exchange_id: exchange.data.id, request_id: request.data.id };
}
export async function borrowRecords(listingId: string) {
  const [requests, reservations, exchanges] = await Promise.all([
    admin.from('borrow_requests').select('id,borrower_id,status,version,exchange_id,starts_on,ends_on').eq('listing_id', listingId).order('created_at'),
    admin.from('item_reservations').select('exchange_id,request_id,dates,blocking,custody_unresolved,acknowledgment_due_at').eq('listing_id', listingId).order('starts_on'),
    admin.from('exchanges').select('id,kind,state,provider_id,receiver_id').eq('source_id', listingId).order('created_at'),
  ]);
  for (const result of [requests, reservations, exchanges]) if (result.error) throw result.error;
  return { requests: requests.data ?? [], reservations: reservations.data ?? [], exchanges: exchanges.data ?? [] };
}
export async function borrowNotices(communityId: string, kind: string) {
  const result = await admin.from('notification_outbox').select('recipient_id,channel,kind').eq('community_id', communityId).eq('kind', kind).order('recipient_id').order('channel');
  if (result.error) throw result.error;
  return result.data;
}

export async function handoffFixture(label = 'handoff') {
  const f = await borrowingFixture(label);
  const loan = await approveBorrow(f.alice, await requestItem(f.bob, f.listing.id));
  return { ...f, exchangeId: loan.exchange_id!, loan };
}
export async function itemHandoff(member: Awaited<ReturnType<typeof actor>>, exchangeId: string) {
  const result = await member.client.rpc('read_item_handoff', { p_exchange_id: exchangeId });
  if (result.error) throw result.error;
  const { handoffSchema } = await import('../../src/features/handoff/model');
  return handoffSchema.parse(result.data);
}
export async function handoffAction(member: Awaited<ReturnType<typeof actor>>, exchangeId: string, revision: number, action: string, details: Record<string, string | boolean> = {}, intent = randomUUID()) {
  return member.client.rpc('command_item_handoff', { p_intent_id: intent, p_exchange_id: exchangeId, p_expected_revision: revision, p_action: action, p_details: details });
}
// Upcoming Handoff notices with the same currency rule as private.reminder_current.
export async function handoffReminders(exchangeId: string) {
  const reminders = await admin.from('notification_reminders').select('id,event_id,due_at').eq('source_key', exchangeId).eq('kind', 'item_handoff_upcoming');
  if (reminders.error) throw reminders.error;
  const outbox = await admin.from('notification_outbox').select('id,channel,kind,state,event_id,reminder_id,reminder_due_at').in('reminder_id', reminders.data.map(row => row.id));
  if (outbox.error) throw outbox.error;
  return outbox.data.map(row => {
    const reminder = reminders.data.find(r => r.id === row.reminder_id)!;
    return { ...row, current: reminder.event_id === row.event_id && Date.parse(reminder.due_at) === Date.parse(row.reminder_due_at!) };
  });
}
export const handoffTerms = { return_date: true, condition: true, replacement_value: true, responsibility: true };
export const handoffSchedule = () => ({ starts_at: new Date(Date.now() + 2 * 3600000).toISOString(), location: 'Front porch at 12 Maple Street' });
export const handoffCondition = { condition: 'Good. Light marks on the case.', accessories: 'Two batteries and charger' };
export async function advanceHandoff(f: Awaited<ReturnType<typeof handoffFixture>>, through: 'terms' | 'schedule' | 'condition' | 'checked_out' = 'checked_out') {
  const steps = [
    [f.bob, 'acknowledge_terms', handoffTerms], [f.alice, 'propose_schedule', handoffSchedule()],
    [f.bob, 'confirm_schedule', {}], [f.alice, 'record_condition', handoffCondition],
    [f.bob, 'confirm_handoff', { condition_acknowledged: true }],
  ] as const;
  const end = { terms: 1, schedule: 3, condition: 4, checked_out: 5 }[through];
  for (let index = 0; index < end; index++) {
    const [member, action, details] = steps[index];
    const result = await handoffAction(member, f.exchangeId, index, action, details);
    if (result.error) throw result.error;
  }
  return itemHandoff(f.bob, f.exchangeId);
}

export const helpListingFields = (overrides: Record<string, unknown> = {}) => ({ title: 'Moving help with a van', description: 'I can lift and drive.', category: 'moving', skill: 'Lifting and van driving', skill_level: 'experienced', availability: 'Weekend mornings', geographic_constraints: 'Within 3 miles of Maple Street', scheduling_preferences: 'Two days notice', ...overrides });
export const helpNeedFields = (helpers = 2, overrides: Record<string, unknown> = {}) => ({ title: 'Move a couch upstairs', description: 'Third floor, no lift.', category: 'moving', starts_at: new Date(Date.now() + 3 * 86400000).toISOString(), duration_minutes: 120, location: '12 Maple Street', helpers_needed: helpers, ...overrides });
export const helpScheduleFields = (overrides: Record<string, unknown> = {}) => ({ starts_at: new Date(Date.now() + 2 * 86400000).toISOString(), duration_minutes: 90, meeting_point: 'Side gate on Maple Street', ...overrides });

export async function createHelpPost(author: Awaited<ReturnType<typeof actor>>, communityId: string, kind: 'listing' | 'need_post', fields: Record<string, unknown>, intent = randomUUID()) {
  const result = await author.client.rpc('create_help_post', { p_intent_id: intent, p_community_id: communityId, p_post_kind: kind, p_fields: fields });
  if (result.error) throw result.error;
  return helpPostSchema.parse(result.data);
}

export async function commitHelp(member: Awaited<ReturnType<typeof actor>>, kind: 'listing' | 'need_post', postId: string, note = '', intent = randomUUID()) {
  const result = await member.client.rpc('commit_help', { p_intent_id: intent, p_post_kind: kind, p_post_id: postId, p_note: note });
  if (result.error) throw result.error;
  return z.object({ id: z.uuid(), status: z.literal('pending'), member_id: z.uuid() }).parse(result.data).id;
}

export async function acceptHelp(owner: Awaited<ReturnType<typeof actor>>, commitmentId: string, intent = randomUUID()) {
  const result = await owner.client.rpc('accept_help_commitment', { p_intent_id: intent, p_commitment_id: commitmentId });
  if (result.error) throw result.error;
  return helpExchangeSchema.parse(result.data);
}

// An administrator-owned Community with a requester/author and active helper members.
export async function helpFixture(label = 'help', helpers = 3) {
  const { owner, community } = await membershipFixture(label);
  const author = await activeMember(owner, community.id, `${label}-author`);
  const members = [];
  for (let index = 0; index < helpers; index++) members.push(await activeMember(owner, community.id, `${label}-helper${index + 1}`));
  return { owner, community, author, members };
}
