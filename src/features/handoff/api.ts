import { supabase } from '../../lib/supabase/client';
import { handoffSchema, type Handoff, type HandoffAction } from './model';

export async function readHandoff(exchangeId: string) {
  const result = await supabase.rpc('read_item_handoff', { p_exchange_id: exchangeId });
  if (result.error) throw result.error;
  return handoffSchema.parse(result.data);
}
export async function readHandoffs(listingId?: string) {
  let query = supabase.from('item_reservations').select('exchange_id').order('created_at', { ascending: false });
  if (listingId) query = query.eq('listing_id', listingId);
  const result = await query;
  if (result.error) throw result.error;
  return Promise.all((result.data ?? []).map(row => readHandoff(row.exchange_id)));
}
export async function handoffCommand(handoff: Handoff, action: HandoffAction, details: Record<string, string | boolean>, intent: string) {
  const result = await supabase.rpc('command_item_handoff', { p_intent_id: intent, p_exchange_id: handoff.exchange_id, p_expected_revision: handoff.revision, p_action: action, p_details: details });
  if (result.error) throw result.error;
  return handoffSchema.parse(result.data);
}
