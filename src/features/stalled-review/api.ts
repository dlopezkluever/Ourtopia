import { supabase } from '../../lib/supabase/client';
import { queueSchema, stalledReviewSchema, type DecisionOutcome, type EvidenceKey } from './model';

export async function readStalledReview(exchangeId: string) {
  const result = await supabase.rpc('read_stalled_review', { p_exchange_id: exchangeId });
  if (result.error) throw result.error;
  return stalledReviewSchema.parse(result.data);
}

export async function readStalledQueue(communityId: string) {
  const result = await supabase.rpc('read_stalled_review_queue', { p_community_id: communityId });
  if (result.error) throw result.error;
  return queueSchema.parse(result.data);
}

export async function decideStalledReview(intentId: string, exchangeId: string, outcome: DecisionOutcome, reason: string, evidence: Record<EvidenceKey, boolean>) {
  const result = await supabase.rpc('decide_stalled_review', {
    p_intent_id: intentId, p_exchange_id: exchangeId, p_outcome: outcome, p_reason: reason,
    p_evidence: Object.fromEntries(Object.entries(evidence).filter(([, cited]) => cited).map(([key]) => [key, 'true'])),
  });
  if (result.error) throw result.error;
  return stalledReviewSchema.parse(result.data);
}
