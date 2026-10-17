import { z } from 'zod';
import { standingSchema } from '../reputation/model';

export const returnEvidenceSchema = z.object({ id: z.uuid(), exchange_id: z.uuid(), uploader_id: z.uuid(), purpose: z.enum(['handoff', 'return']), object_path: z.string(), state: z.enum(['pending', 'ready']), mime_type: z.string(), byte_size: z.number() });
export const returnViewSchema = z.object({
  exchange_id: z.uuid(), community_id: z.uuid(), state: z.string(), owner_id: z.uuid(), borrower_id: z.uuid(), completed_at: z.string().nullable(),
  return_due_at: z.string(), revision: z.number().int(),
  record: z.object({
    returned_at: z.string(), condition: z.string(), accessories: z.string(), recorded_by: z.uuid(), owner_confirmed_at: z.string().nullable(),
    borrower_confirmed_at: z.string().nullable(), contested_by: z.uuid().nullable(), contested_at: z.string().nullable(), contested_condition: z.string().nullable(), review_due_at: z.string(),
  }).nullable(),
  handoff: z.object({ handed_off_at: z.string().nullable(), condition: z.string().nullable(), accessories: z.string().nullable() }),
  evidence: z.array(returnEvidenceSchema), open_dispute: z.boolean(),
  review: z.array(z.object({ reason: z.enum(['missing_return_confirmation', 'overdue_return']), queued_at: z.string() })),
  standing: standingSchema,
});
export type ReturnView = z.infer<typeof returnViewSchema>;
export type ReturnAction = 'record_return' | 'confirm_return' | 'contest_return';
export const reviewReasons = { missing_return_confirmation: 'Return confirmation missing for seven days', overdue_return: 'Return overdue for seven days' } as const;

export type ReturnStep = 'none' | 'record' | 'await_counterpart' | 'respond' | 'contested' | 'completed' | 'closed';
export function returnStep(view: ReturnView, userId: string): ReturnStep {
  if (view.state === 'completed' || view.state === 'returned') return 'completed';
  if (view.state === 'checked_out') return 'record';
  if (view.state !== 'return_pending' || !view.record) return view.state === 'closed_without_completion' ? 'closed' : 'none';
  if (view.record.contested_at) return 'contested';
  return view.record.recorded_by === userId ? 'await_counterpart' : 'respond';
}
export const stepText: Record<ReturnStep, string> = {
  none: 'Return opens after Handoff.',
  record: 'Either participant records the physical Return, its condition and accessories.',
  await_counterpart: 'The other participant confirms or contests the recorded Return.',
  respond: 'You confirm the recorded Return condition or report a different condition.',
  contested: 'Condition disagreement. The open Exchange issue blocks ordinary completion.',
  completed: 'Loan completed. No Return action remains.',
  closed: 'Closed without completion. The item stays unavailable until an administrator records recovery.',
};
export const reviewQueueSchema = z.array(z.object({
  id: z.uuid(), exchange_id: z.uuid(), community_id: z.uuid(), reason: z.enum(['missing_return_confirmation', 'overdue_return']), queued_at: z.string(),
  communities: z.object({ name: z.string() }).nullable(),
}));
