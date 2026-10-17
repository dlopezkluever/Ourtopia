import { z } from 'zod';

export const deliverySchema = z.object({
  id: z.uuid(), event_id: z.uuid(), recipient_id: z.uuid(), channel: z.enum(['email', 'in_app']), kind: z.string(),
  state: z.enum(['pending', 'processing', 'failed', 'delivered', 'suppressed']), attempts: z.number(),
  due: z.boolean(),
  next_attempt_at: z.string(), delivered_at: z.string().nullable(), created_at: z.string(), last_error: z.string().nullable(),
  reminder_due_at: z.string().nullable(), current_schedule: z.boolean().nullable(),
  history: z.array(z.object({ number: z.number(), started_at: z.string(), finished_at: z.string().nullable(), error: z.string().nullable() })),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const deliveryLabels = { pending: 'Pending', processing: 'Processing', failed: 'Retryable failure', delivered: 'Delivered', suppressed: 'Obsolete reminder suppressed' };
export function noticeLabel(kind: string) { return kind.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()); }
