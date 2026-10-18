import { z } from 'zod';

export const thankYouSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), exchange_id: z.uuid(), author_id: z.uuid(), recipient_id: z.uuid(),
  event_id: z.uuid(), message: z.string(), created_at: z.string(),
}).strict();
export const thankYouResultSchema = thankYouSchema.extend({ points_awarded: z.boolean() }).strict();
export type ThankYou = z.infer<typeof thankYouSchema>;

export const publicThankYouSchema = z.object({ id: z.uuid(), author_id: z.uuid(), message: z.string(), created_at: z.string() }).strict();
export type PublicThankYou = z.infer<typeof publicThankYouSchema>;
