import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';

export type MisconductRule = 'late_return' | 'unresolved_damage' | 'confirmed_theft';

export const misconductEventSchema = z.object({
  id: z.uuid(), rule: z.string(), points: z.number().int(), recipient_id: z.uuid(), reason: z.string().nullable(),
  corrects_event_id: z.uuid().nullable(), created_at: z.string(),
});
export type MisconductEvent = z.infer<typeof misconductEventSchema>;

export async function recordVerifiedMisconduct(intentId: string, disputeId: string, rule: MisconductRule, recipientId: string, reason: string) {
  const result = await supabase.rpc('record_verified_misconduct', {
    p_intent_id: intentId, p_dispute_id: disputeId, p_rule: rule, p_recipient_id: recipientId, p_reason: reason,
  });
  if (result.error) throw result.error;
  return result.data as { eventId: string; points: number; rule: MisconductRule; recipientId: string };
}

export async function correctReputationEvent(intentId: string, eventId: string, reason: string) {
  const result = await supabase.rpc('correct_reputation_event', { p_intent_id: intentId, p_event_id: eventId, p_reason: reason });
  if (result.error) throw result.error;
  return result.data as { eventId: string; correctsEventId: string; points: number };
}

// Corrections carry their Exchange and their own source kind, so the case is matched by Exchange rather than Dispute.
export async function readMisconductEvents(exchangeId: string) {
  const result = await supabase.from('reputation_events')
    .select('id,rule,points,recipient_id,reason,corrects_event_id,created_at')
    .eq('exchange_id', exchangeId).in('source_kind', ['dispute', 'reputation_correction'])
    .order('created_at').order('id');
  if (result.error) throw result.error;
  return z.array(misconductEventSchema).parse(result.data);
}
