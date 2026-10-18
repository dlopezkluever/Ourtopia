import { supabase } from '../../lib/supabase/client';
import { decisionCaseSchema, decisionViewSchema, type CaseAction } from './model';

export async function readDecisions(exchangeId: string) {
  const result = await supabase.rpc('read_dispute_decisions', { p_exchange_id: exchangeId });
  if (result.error) throw result.error;
  return decisionViewSchema.parse(result.data);
}

export async function actOnDispute(userId: string, disputeId: string, action: CaseAction, details: Record<string, string>) {
  const intentStorageKey = `dispute-command-decision-${userId}-${JSON.stringify([disputeId, action, details])}`;
  const intent = sessionStorage.getItem(intentStorageKey) ?? crypto.randomUUID();
  sessionStorage.setItem(intentStorageKey, intent);
  const result = await supabase.rpc('act_on_dispute', { p_intent_id: intent, p_dispute_id: disputeId, p_action: action, p_details: details });
  if (result.error) throw result.error;
  sessionStorage.removeItem(intentStorageKey);
  return decisionCaseSchema.parse(result.data);
}
