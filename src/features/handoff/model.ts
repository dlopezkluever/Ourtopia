import { z } from 'zod';

export const evidenceSchema = z.object({ id: z.uuid(), exchange_id: z.uuid(), uploader_id: z.uuid(), object_path: z.string(), state: z.enum(['pending', 'ready']), mime_type: z.string(), byte_size: z.number() });
export type Evidence = z.infer<typeof evidenceSchema>;
export const handoffSchema = z.object({
  exchange_id: z.uuid(), community_id: z.uuid(), owner_id: z.uuid(), borrower_id: z.uuid(), state: z.string(), revision: z.number(), schedule_revision: z.number(),
  starts_at: z.string().nullable(), location: z.string().nullable(), proposed_by: z.uuid().nullable(), schedule_confirmed_at: z.string().nullable(),
  condition: z.string().nullable(), accessories: z.string().nullable(), condition_recorded_by: z.uuid().nullable(),
  owner_condition_ack_at: z.string().nullable(), borrower_condition_ack_at: z.string().nullable(), handed_off_at: z.string().nullable(), cancelled_reason: z.string().nullable(),
  reservation: z.object({ starts_on: z.string(), ends_on: z.string(), acknowledgment_due_at: z.string(), acknowledged_at: z.string().nullable(), condition: z.string(), replacement_value: z.number(), lending_conditions: z.string(), blocking: z.boolean(), custody_unresolved: z.boolean() }),
  evidence: z.array(evidenceSchema),
});
export type Handoff = z.infer<typeof handoffSchema>;
export type HandoffAction = 'acknowledge_terms' | 'propose_schedule' | 'confirm_schedule' | 'record_condition' | 'confirm_handoff' | 'cancel';
export const termsAcknowledgment = { return_date: true, condition: true, replacement_value: true, responsibility: true };
export const stateLabels: Record<string, string> = { approved: 'Awaiting terms', handoff_pending: 'Arranging Handoff', checked_out: 'Checked out', cancelled: 'Cancelled', expired: 'Approval expired', closed_without_completion: 'Closed without completion', completed: 'Completed' };
export function nextActor(h: Handoff, userId: string) {
  if (h.state === 'approved') return h.borrower_id === userId ? 'You acknowledge the terms before the deadline.' : 'The borrower acknowledges the terms before the deadline.';
  if (h.state !== 'handoff_pending') return h.state === 'checked_out' ? 'The borrower returns the item by the agreed date.' : 'No Handoff action remains.';
  if (!h.starts_at) return 'Either participant proposes a time and location.';
  if (!h.schedule_confirmed_at) return h.proposed_by === userId ? 'The other participant confirms the schedule.' : 'You confirm the proposed schedule.';
  if (!h.condition) return 'Either participant records condition and accessories at Handoff.';
  return h.condition_recorded_by === userId ? 'The other participant acknowledges condition and receives the item.' : 'You acknowledge condition and confirm Handoff.';
}
