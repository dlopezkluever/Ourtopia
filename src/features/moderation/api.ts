import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { auditRow, contentRow, ownNoticeRow, rosterRow, type ContentItem, type ContentKind, type MembershipAction } from './model';

export async function readRoster(communityId: string) {
  const result = await supabase.rpc('moderation_roster', { p_community_id: communityId });
  if (result.error) throw result.error;
  return z.array(rosterRow).parse(result.data);
}

export async function readOpenContent(communityId: string): Promise<ContentItem[]> {
  const [listings, helpListings, helpNeeds, itemNeeds] = await Promise.all([
    supabase.from('listings').select('id,title,owner_id').eq('community_id', communityId).eq('status', 'published'),
    supabase.from('help_listings').select('id,title,owner_id').eq('community_id', communityId).eq('status', 'open'),
    supabase.from('help_need_posts').select('id,title,owner_id').eq('community_id', communityId).eq('status', 'open'),
    supabase.from('item_need_posts').select('id,title,owner_id:author_id').eq('community_id', communityId).eq('status', 'open'),
  ]);
  for (const result of [listings, helpListings, helpNeeds, itemNeeds]) if (result.error) throw result.error;
  return [
    ...z.array(contentRow).parse(listings.data).map(row => ({ ...row, kind: 'listing' as const })),
    ...z.array(contentRow).parse(helpListings.data).map(row => ({ ...row, kind: 'help_listing' as const })),
    ...z.array(contentRow).parse(helpNeeds.data).map(row => ({ ...row, kind: 'help_need_post' as const })),
    ...z.array(contentRow).parse(itemNeeds.data).map(row => ({ ...row, kind: 'item_need_post' as const })),
  ];
}

export async function readAuditLog(communityId: string) {
  const result = await supabase.from('moderation_actions').select('id,subject_kind,subject_user_id,action,reason,actor_id,created_at')
    .eq('community_id', communityId).order('created_at', { ascending: false }).limit(50);
  if (result.error) throw result.error;
  return z.array(auditRow).parse(result.data);
}

export async function readOwnNotices(userId: string) {
  const result = await supabase.from('moderation_actions').select('community_id,action,reason,created_at')
    .eq('subject_user_id', userId).eq('subject_kind', 'membership').order('created_at', { ascending: false }).limit(200);
  if (result.error) throw result.error;
  return z.array(ownNoticeRow).parse(result.data);
}

export async function readAdministeredCommunities(userId: string) {
  const result = await supabase.from('memberships').select('community_id,communities(name)').eq('user_id', userId).eq('role', 'administrator').eq('status', 'active');
  if (result.error) throw result.error;
  return z.array(z.object({ community_id: z.uuid(), communities: z.object({ name: z.string() }).nullable() })).parse(result.data);
}

// The intent identity is kept per payload so a retry after a dropped response returns the prior result.
function intentFor(userId: string, command: string, payload: Record<string, string>) {
  const key = `moderation-command-${userId}-${JSON.stringify([command, payload])}`;
  const intent = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, intent);
  return { intent, done: () => sessionStorage.removeItem(key) };
}

export async function moderateMembership(userId: string, communityId: string, targetUserId: string, action: MembershipAction, reason: string) {
  const { intent, done } = intentFor(userId, 'moderate_membership', { communityId, targetUserId, action, reason });
  const result = await supabase.rpc('moderate_membership', { p_intent_id: intent, p_community_id: communityId, p_user_id: targetUserId, p_action: action, p_reason: reason });
  if (result.error) throw result.error;
  done();
}

export async function moderateContent(userId: string, communityId: string, kind: ContentKind, subjectId: string, reason: string) {
  const { intent, done } = intentFor(userId, 'moderate_content', { communityId, kind, subjectId, reason });
  const result = await supabase.rpc('moderate_content', { p_intent_id: intent, p_community_id: communityId, p_subject_kind: kind, p_subject_id: subjectId, p_reason: reason });
  if (result.error) throw result.error;
  done();
}
