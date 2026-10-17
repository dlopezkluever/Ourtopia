import { supabase } from '../../lib/supabase/client';
import { resultSchema, type DraftKind } from './model';
import type { Json } from '../../lib/supabase/database.types';

export async function commandDraft(ownerId: string, communityId: string, kind: DraftKind, revision: number, action: 'save' | 'publish' | 'discard', fields: Json, intent: string = crypto.randomUUID()) {
  const result = await supabase.rpc('command_contribution_draft', { p_intent_id: intent, p_owner_id: ownerId, p_community_id: communityId, p_kind: kind, p_expected_revision: revision, p_action: action, p_fields: fields });
  if (result.error) throw result.error;
  return resultSchema.parse(result.data);
}
