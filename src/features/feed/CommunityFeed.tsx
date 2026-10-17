import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { feedSchema, feedSentence } from './model';

export function CommunityFeed({ userId, communityId }: { userId: string; communityId: string }) {
  const [state] = useBorrowingRead(userId, `community-feed-${communityId}`, async () => {
    const result = await supabase.rpc('read_community_feed', { p_community_id: communityId });
    if (result.error) throw result.error;
    return feedSchema.parse(result.data);
  });
  if (state.status !== 'ready') return null;
  return <section className="listings-layout community-feed" aria-label="Community activity feed"><span className="eyebrow">COMMUNITY FEED</span><h2>Community activity</h2>
    {state.data.length ? <ul>{state.data.map(entry => <li key={`${entry.kind}-${entry.id}`}>{feedSentence(entry)} <time dateTime={entry.kind === 'item_loan_completed' ? entry.completed_at : entry.created_at}>{new Date(entry.kind === 'item_loan_completed' ? entry.completed_at : entry.created_at).toLocaleDateString()}</time></li>)}</ul> : <p>No completed loans or thank-yous yet.</p>}
  </section>;
}
