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
