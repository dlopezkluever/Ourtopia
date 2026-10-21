import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { localDeadline } from '../borrowing/model';
import { reviewQueueSchema, reviewReasons } from './model';

export function ReviewQueue({ userId }: { userId: string }) {
  const [state, refresh] = useBorrowingRead(userId, 'exchange-review-queue', async () => {
    const result = await supabase.from('exchange_review_items').select('id,exchange_id,community_id,reason,queued_at,communities(name)').order('queued_at', { ascending: false }).limit(50);
    if (result.error) throw result.error;
    return reviewQueueSchema.parse(result.data);
  });
  return <section className="handoff-page review-queue" aria-labelledby="review-queue-title"><span className="eyebrow">ADMINISTRATOR REVIEW</span><h1 id="review-queue-title">Exchange review queue</h1>
    <p>Stalled Returns wait here in their current state. Silence never completes an Exchange or grants points. Return condition, photos and logistics stay with the two participants.</p>
    {state.status === 'loading' ? <p role="status">Opening review queue...</p> : state.status === 'denied' ? <p role="alert">Review queue unavailable.</p>
      : state.data.length === 0 ? <p>No Exchanges are waiting for review.</p>
      : <ul>{state.data.map(item => <li key={item.id}><a href={`/stalled/case/${item.exchange_id}`}><strong>{reviewReasons[item.reason]}</strong></a> ·{item.communities?.name ?? 'Community'} · queued <time dateTime={item.queued_at}>{localDeadline(item.queued_at)}</time></li>)}</ul>}
    <button className="text-button" onClick={refresh}>Refresh review queue</button></section>;
}
