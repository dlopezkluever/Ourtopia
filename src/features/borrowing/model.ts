import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';

export const borrowRequestSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), listing_id: z.uuid(), owner_id: z.uuid(), borrower_id: z.uuid(),
  starts_on: z.string(), ends_on: z.string(), status: z.enum(['requested', 'approved', 'rejected', 'expired']),
  version: z.number().int(), exchange_id: z.uuid().nullable(),
});
export type BorrowRequest = z.infer<typeof borrowRequestSchema>;
export const reservationSchema = z.object({
  exchange_id: z.uuid(), starts_on: z.string(), ends_on: z.string(), acknowledgment_due_at: z.string(),
  blocking: z.boolean(), custody_unresolved: z.boolean(), condition: z.string(), replacement_value: z.number(), lending_conditions: z.string(),
});
export type Reservation = z.infer<typeof reservationSchema>;

export async function submitBorrowRequest(listingId: string, startsOn: string, endsOn: string, intent: string) {
  const result = await supabase.rpc('submit_borrow_request', { p_intent_id: intent, p_listing_id: listingId, p_starts_on: startsOn, p_ends_on: endsOn });
  if (result.error) throw result.error;
  return borrowRequestSchema.parse(result.data);
}
export async function decideBorrowRequest(request: BorrowRequest, decision: 'approved' | 'rejected', intent: string) {
  const result = await supabase.rpc('decide_borrow_request', { p_intent_id: intent, p_request_id: request.id, p_expected_version: request.version, p_decision: decision });
  if (result.error) throw result.error;
  return borrowRequestSchema.parse(result.data);
}
export function borrowError(error: unknown) {
  const value = z.object({ code: z.string().optional(), message: z.string() }).safeParse(error);
  if (!value.success) return 'Could not reach the server. Retry with the same details.';
  if (value.data.code === '23P01') return 'These dates conflict with another reservation, or item custody remains unresolved. Choose other dates or wait for physical recovery.';
  return value.data.message;
}
