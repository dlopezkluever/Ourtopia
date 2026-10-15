import { z } from 'zod';
import { historyEventSchema, standingSchema, trustSchema } from '../reputation/model';
import { supabase } from '../../lib/supabase/client';

export const directoryEntrySchema = z.object({
  user_id: z.uuid(), email: z.string(), role: z.enum(['administrator', 'member']), joined_at: z.string(),
  score: z.number().int(), title: z.string(), completed_interactions: z.number().int(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const memberProfileSchema = z.object({
  userId: z.uuid(), email: z.string(), role: z.enum(['administrator', 'member']), joinedAt: z.string(), communityId: z.uuid(),
  local: standingSchema, globalTitle: z.string(), trust: trustSchema, history: z.array(historyEventSchema),
  sharedCommunities: z.array(z.object({ communityId: z.uuid(), name: z.string(), role: z.string() })),
});
export type MemberProfileData = z.infer<typeof memberProfileSchema>;

export const ownReputationSchema = z.object({
  userId: z.uuid(), global: standingSchema,
  communities: z.array(z.object({ communityId: z.uuid(), name: z.string(), membershipStatus: z.string(), local: standingSchema, history: z.array(historyEventSchema) })),
});
export type OwnReputation = z.infer<typeof ownReputationSchema>;

export const roleLabel = (role: string) => role === 'administrator' ? 'Administrator' : 'Member';
export const membershipLabel = (status: string) => status === 'active' ? 'Active member' : status === 'suspended' ? 'Suspended' : 'Former member';

export type ProfileRoute = { communityId: string; subjectId?: string };
export function profileRoute(pathname: string): ProfileRoute | null {
  const match = /^\/communities\/([0-9a-f-]{36})\/members(?:\/([0-9a-f-]{36}))?\/?$/i.exec(pathname);
  return match ? { communityId: match[1], subjectId: match[2] } : null;
}

async function unwrap<T>(request: PromiseLike<{ data: unknown; error: { message: string } | null }>, schema: z.ZodType<T>) {
  const { data, error } = await request;
  if (error) throw error;
  return schema.parse(data);
}

export async function readCommunityName(communityId: string) {
  const rows = await unwrap(supabase.from('communities').select('name').eq('id', communityId), z.array(z.object({ name: z.string() })));
  if (rows.length === 0) throw new Error('This private Community is only available to its active members.');
  return rows[0].name;
}
export const readDirectory = (communityId: string) => unwrap(supabase.rpc('member_directory', { p_community_id: communityId }), z.array(directoryEntrySchema));
export const readProfile = (communityId: string, subjectId: string) => unwrap(supabase.rpc('member_profile', { p_community_id: communityId, p_subject: subjectId }), memberProfileSchema);
export const readOwnReputation = () => unwrap(supabase.rpc('my_reputation'), ownReputationSchema);
