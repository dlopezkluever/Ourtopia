import { z } from 'zod';

export const membershipActions = ['suspend', 'reinstate', 'remove'] as const;
export type MembershipAction = typeof membershipActions[number];
export const contentKinds = ['listing', 'help_listing', 'help_need_post', 'item_need_post'] as const;
export type ContentKind = typeof contentKinds[number];

export const actionLabels: Record<MembershipAction | 'withdraw', string> = {
  suspend: 'Suspend', reinstate: 'Reinstate', remove: 'Remove', withdraw: 'Withdraw',
};
export const contentLabels: Record<ContentKind, string> = {
  listing: 'Item Listing', help_listing: 'Help Listing', help_need_post: 'Help Need Post', item_need_post: 'Item Need Post',
};
export const pastTense: Record<MembershipAction | 'withdraw', string> = {
  suspend: 'suspended', reinstate: 'reinstated', remove: 'removed', withdraw: 'withdrawn',
};

export const rosterRow = z.object({
  user_id: z.uuid(), email: z.string(), role: z.enum(['administrator', 'member']),
  status: z.enum(['pending', 'active', 'suspended', 'removed']), joined_at: z.string(),
});
export type RosterRow = z.infer<typeof rosterRow>;

export const contentRow = z.object({ id: z.uuid(), title: z.string(), owner_id: z.uuid() });
export type ContentItem = z.infer<typeof contentRow> & { kind: ContentKind };

export const auditRow = z.object({
  id: z.uuid(), subject_kind: z.enum(['membership', ...contentKinds]), subject_user_id: z.uuid(),
  action: z.enum(['suspend', 'reinstate', 'remove', 'withdraw']), reason: z.string(), actor_id: z.uuid(), created_at: z.string(),
});
export type AuditRow = z.infer<typeof auditRow>;

export const ownNoticeRow = z.object({ community_id: z.uuid(), action: z.enum(['suspend', 'reinstate', 'remove']), reason: z.string(), created_at: z.string() });
export type OwnNotice = z.infer<typeof ownNoticeRow>;

// Latest membership action per Community decides the notice. Suspended or removed people keep only their obligation channel.
export function activeRestrictions(notices: OwnNotice[]) {
  const latest = new Map<string, OwnNotice>();
  for (const notice of [...notices].sort((a, b) => b.created_at.localeCompare(a.created_at))) if (!latest.has(notice.community_id)) latest.set(notice.community_id, notice);
  return [...latest.values()].filter(notice => notice.action === 'suspend' || notice.action === 'remove');
}

export function messageOf(failure: unknown) {
  return failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'Action not confirmed. Retry safely.';
}
