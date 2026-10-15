import type { Database } from '../../lib/supabase/database.types';
import { z } from 'zod';

export type Invite = Database['public']['Tables']['invites']['Row'];
export type Application = Database['public']['Tables']['membership_applications']['Row'];
export type OutboxEntry = Database['public']['Tables']['notification_outbox']['Row'];
export const inviteSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), community_name: z.string(), recipient_email: z.email(),
  issued_by: z.uuid(), created_at: z.string(), expires_at: z.string(),
  redeemed_by: z.uuid().nullable(), redeemed_at: z.string().nullable(),
});

export function commandIntent(operation: string, payload: unknown) {
  const key = `membership-intent-${operation}-${JSON.stringify(payload)}`;
  const id = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return { id, complete: () => sessionStorage.removeItem(key) };
}

export function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'The request could not be confirmed. Retry with the same details.';
}
