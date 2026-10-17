import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { localDeadline } from '../borrowing/model';

const messages: Record<string, string> = {
  item_handoff_upcoming: 'Your upcoming Handoff needs your attention. Open the current schedule in your Handoffs.',
  item_handoff_proposed: 'A participant proposed a Handoff schedule. Review the current time and location.',
  item_handoff_scheduled: 'Your Handoff schedule is confirmed.',
  item_terms_acknowledged: 'The borrower acknowledged the item terms.',
  item_handoff_condition_recorded: 'Review and acknowledge the recorded Handoff condition.',
  item_handed_off: 'Your item Handoff was recorded.',
  item_handoff_cancelled: 'Your Handoff was cancelled and its dates released.',
};
export function HandoffNotices({ userId }: { userId: string }) {
  const [state] = useBorrowingRead(userId, 'handoff-notices', async () => {
    const result = await supabase.from('notifications').select('id,kind,created_at').eq('recipient_id', userId).like('kind', 'item_%').order('created_at', { ascending: false }).limit(20);
    if (result.error) throw result.error;
    return result.data;
  });
  if (state.status !== 'ready' || state.data.length === 0) return null;
  return <section aria-label="Handoff notices"><h2>Handoff notices</h2>{state.data.map(notice => <p key={notice.id}>{messages[notice.kind] ?? 'Your Handoff has an update.'} <time dateTime={notice.created_at}>{localDeadline(notice.created_at)}</time></p>)}</section>;
}
