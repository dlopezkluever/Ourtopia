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
  item_return_upcoming: 'Your item Return is due soon. Open the Return to record it.',
  item_return_overdue: 'An item Return is overdue. Record the Return once the item is back.',
  item_return_recorded: 'A Return was recorded. Confirm or contest its condition.',
  item_return_confirmation_due: 'A recorded Return is still waiting for your confirmation.',
  item_returned: 'Both participants confirmed the Return.',
  item_completed: 'Your loan is complete. Your standing and history are updated.',
  item_return_review_queued: 'A stalled Return was sent to administrator review. It stays incomplete.',
  item_stalled_review_decided: 'An administrator recorded the outcome of a stalled Return review.',
  item_stalled_recovery_recorded: 'An administrator recorded recovery of a stalled item loan.',
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
