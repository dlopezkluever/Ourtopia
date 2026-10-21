import { supabase } from '../../lib/supabase/client';
import { pilotMetricsSchema } from './model';

export async function readPilotMetrics(communityId: string) {
  const { data, error } = await supabase.rpc('read_pilot_metrics', { p_community_id: communityId });
  if (error) throw error;
  return pilotMetricsSchema.parse(data);
}
