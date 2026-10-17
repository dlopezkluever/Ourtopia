import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { borrowRequestSchema, borrowViewSchema, reservationSchema, type BorrowRequest, type BorrowView } from './model';

export async function readBorrowViews(filter: { listingId?: string }) {
  let requests = supabase.from('borrow_requests').select('*').order('created_at', { ascending: false });
  if (filter.listingId) requests = requests.eq('listing_id', filter.listingId);
  const [requestRows, reservationRows, exchangeRows] = await Promise.all([
    requests,
    supabase.from('item_reservations').select('exchange_id,starts_on,ends_on,acknowledgment_due_at,acknowledged_at,blocking,custody_unresolved'),
    supabase.from('exchanges').select('id,state').eq('kind', 'item'),
  ]);
  for (const result of [requestRows, reservationRows, exchangeRows]) if (result.error) throw result.error;
  const reservations = new Map(reservationSchema.array().parse(reservationRows.data).map(row => [row.exchange_id, row]));
  const states = new Map(z.array(z.object({ id: z.uuid(), state: z.string() })).parse(exchangeRows.data).map(row => [row.id, row.state]));
  return borrowRequestSchema.array().parse(requestRows.data).map((request): BorrowView => ({
    ...request,
    exchange_state: request.exchange_id ? states.get(request.exchange_id) ?? null : null,
    reservation: request.exchange_id ? reservations.get(request.exchange_id) ?? null : null,
  }));
}

export async function submitBorrowRequest(listingId: string, startsOn: string, endsOn: string, intent: string) {
  const result = await supabase.rpc('submit_borrow_request', { p_intent_id: intent, p_listing_id: listingId, p_starts_on: startsOn, p_ends_on: endsOn });
  if (result.error) throw result.error;
  return borrowViewSchema.parse(result.data);
}

export async function decideBorrowRequest(request: BorrowRequest, decision: 'approved' | 'rejected', intent: string) {
  const result = await supabase.rpc('decide_borrow_request', { p_intent_id: intent, p_request_id: request.id, p_expected_version: request.version, p_decision: decision });
  if (result.error) throw result.error;
  return borrowViewSchema.parse(result.data);
}
