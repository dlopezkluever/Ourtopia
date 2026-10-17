import { supabase } from '../../lib/supabase/client';
import { returnViewSchema, type ReturnAction, type ReturnView } from './model';

export async function readReturn(exchangeId: string) {
  const result = await supabase.rpc('read_item_return', { p_exchange_id: exchangeId });
  if (result.error) throw result.error;
  return returnViewSchema.parse(result.data);
}
export async function returnCommand(view: ReturnView, action: ReturnAction, details: Record<string, string | boolean>, intent: string) {
  const result = await supabase.rpc('command_item_return', { p_intent_id: intent, p_exchange_id: view.exchange_id, p_expected_revision: view.revision, p_action: action, p_details: details });
  if (result.error) throw result.error;
  return returnViewSchema.parse(result.data);
}
