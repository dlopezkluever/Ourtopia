import { z } from 'zod';

export const inboxRowSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), community_name: z.string(), counterpart_id: z.uuid(), counterpart_email: z.string(),
  created_at: z.string(), last_message_at: z.string().nullable(), can_send: z.boolean(),
});
export type InboxRow = z.infer<typeof inboxRowSchema>;

export const messageSchema = z.object({
  id: z.uuid(), conversation_id: z.uuid(), community_id: z.uuid(), author_id: z.uuid(), intent_id: z.uuid(), body: z.string(), created_at: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), participant_low: z.uuid(), participant_high: z.uuid(), started_by: z.uuid(), created_at: z.string(),
});

export const messageBody = z.string().trim().min(1, 'Write a message first.').max(4000, 'Keep messages to 4000 characters.');

export type Draft = { intent: string; body: string; attempted: boolean };

export function readDraft(key: string): Draft {
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return z.object({ intent: z.uuid(), body: z.string(), attempted: z.boolean() }).parse(JSON.parse(stored));
  } catch { sessionStorage.removeItem(key); }
  return { intent: crypto.randomUUID(), body: '', attempted: false };
}

export function startIntent(communityId: string, participantId: string) {
  const key = `message-start-${communityId}-${participantId}`;
  const id = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return { id, complete: () => sessionStorage.removeItem(key) };
}

export function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'The request could not be confirmed.';
}
