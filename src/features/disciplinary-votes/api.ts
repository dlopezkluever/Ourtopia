import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { disciplinaryVote } from './model';

const communityRow = z.object({ community_id: z.uuid(), communities: z.object({ name: z.string() }).nullable() });
const rosterRow = z.object({ user_id: z.uuid(), email: z.string(), role: z.enum(['administrator', 'member']), status: z.enum(['pending', 'active', 'suspended', 'removed']), joined_at: z.string() });
const voteNotice = z.object({ id: z.uuid(), kind: z.enum(['disciplinary_vote_opened', 'disciplinary_vote_ending_soon', 'disciplinary_vote_response', 'disciplinary_vote_closed']), created_at: z.string() });

function identity(userId: string, command: string, payload: unknown) {
  const key = `disciplinary-vote-${userId}-${command}-${JSON.stringify(payload)}`;
  const intent = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, intent);
  return { intent, done: () => sessionStorage.removeItem(key) };
}

async function run<T>(userId: string, command: string, payload: unknown, action: (intent: string) => PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { intent, done } = identity(userId, command, payload);
  const result = await action(intent);
  if (result.error) throw result.error;
  done();
  return result.data;
}

export async function accessibleCommunities(userId: string) {
  const result = await supabase.from('memberships').select('community_id,communities(name)').eq('user_id', userId).eq('status', 'active');
  if (result.error) throw result.error;
  return z.array(communityRow).parse(result.data).map(row => ({ id: row.community_id, name: row.communities?.name ?? 'Community' }));
}

export async function administeredCommunities(userId: string) {
  const result = await supabase.from('memberships').select('community_id,communities(name)').eq('user_id', userId).eq('role', 'administrator').eq('status', 'active');
  if (result.error) throw result.error;
  return z.array(communityRow).parse(result.data).map(row => ({ id: row.community_id, name: row.communities?.name ?? 'Community' }));
}

export async function readRoster(communityId: string) {
  const result = await supabase.rpc('moderation_roster', { p_community_id: communityId });
  if (result.error) throw result.error;
  return z.array(rosterRow).parse(result.data);
}

export async function readVotes(communityId: string) {
  const result = await supabase.rpc('list_disciplinary_votes', { p_community_id: communityId });
  if (result.error) throw result.error;
  return z.array(disciplinaryVote).parse(result.data);
}

export async function readDefenseVotes() {
  const result = await supabase.rpc('list_my_defense_votes');
  if (result.error) throw result.error;
  return z.array(disciplinaryVote).parse(result.data);
}

export async function readVoteNotices(userId: string) {
  const result = await supabase.from('notifications').select('id,kind,created_at').eq('recipient_id', userId)
    .in('kind', ['disciplinary_vote_opened', 'disciplinary_vote_ending_soon', 'disciplinary_vote_response', 'disciplinary_vote_closed'])
    .order('created_at', { ascending: false }).limit(20);
  if (result.error) throw result.error;
  return z.array(voteNotice).parse(result.data);
}

export async function openVote(userId: string, communityId: string, accusedId: string, reason: string, evidence: string) {
  return run(userId, 'open', { communityId, accusedId, reason, evidence }, intent => supabase.rpc('open_disciplinary_vote', {
    p_intent_id: intent, p_community_id: communityId, p_accused_id: accusedId, p_reason: reason, p_evidence: evidence,
  }));
}

export async function respond(userId: string, voteId: string, body: string) {
  return run(userId, 'response', { voteId, body }, intent => supabase.rpc('submit_disciplinary_response', { p_intent_id: intent, p_vote_id: voteId, p_body: body }));
}

export async function castBallot(userId: string, voteId: string, choice: 'remove' | 'retain') {
  return run(userId, 'ballot', { voteId, choice }, intent => supabase.rpc('cast_disciplinary_ballot', { p_intent_id: intent, p_vote_id: voteId, p_choice: choice }));
}

export async function closeVote(userId: string, voteId: string) {
  return run(userId, 'close', { voteId }, intent => supabase.rpc('close_disciplinary_vote', { p_intent_id: intent, p_vote_id: voteId }));
}

export async function enactRemoval(userId: string, voteId: string, reason: string) {
  return run(userId, 'remove', { voteId, reason }, intent => supabase.rpc('enact_disciplinary_removal', { p_intent_id: intent, p_vote_id: voteId, p_reason: reason }));
}
