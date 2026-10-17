import { supabase } from '../../lib/supabase/client';
import { disputeViewSchema } from './model';

export async function readDisputes(exchangeId: string) {
  const result = await supabase.rpc('read_exchange_disputes', { p_exchange_id: exchangeId });
  if (result.error) throw result.error;
  return disputeViewSchema.parse(result.data);
}
