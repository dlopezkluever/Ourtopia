import { z } from 'zod';

export const communitySchema = z.object({
  id: z.uuid(), name: z.string(), description: z.string(),
  created_by: z.uuid(), created_at: z.string(),
});
export type Community = z.infer<typeof communitySchema>;
export const communityInput = z.object({
  name: z.string().trim().min(2, 'Choose a name with at least 2 characters.').max(80),
  description: z.string().trim().max(500),
});
