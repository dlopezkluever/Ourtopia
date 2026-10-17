export type Delivery = {
  id: string;
  claim_token: string;
  recipient_email: string;
  channel: 'email' | 'in_app';
  kind: string;
  reminder_id?: string | null;
};

export type DeliveryBackend = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type EmailSender = (message: { to: string; subject: string; text: string; idempotencyKey: string }) => Promise<void>;

const subjects: Record<string, string> = {
  item_need_responded: 'Someone answered your item Need Post',
  item_handoff_upcoming: 'Your item Handoff is coming up',
  item_handoff_proposed: 'A Handoff schedule needs your confirmation',
  item_handoff_scheduled: 'Your Handoff schedule is confirmed',
  item_terms_acknowledged: 'The borrower acknowledged the item terms',
  item_handoff_condition_recorded: 'Review the item condition at Handoff',
  item_handed_off: 'Your item Handoff was recorded',
  item_handoff_cancelled: 'Your item Handoff was cancelled',
  item_dispute_opened: 'An Exchange issue was reported',
  item_dispute_response: 'An Exchange issue case was updated',
  item_dispute_remedy: 'A remedy for an Exchange issue needs your attention',
  item_dispute_review: 'An Exchange issue case moved toward administrator review',
  item_dispute_outcome: 'An Exchange issue case has a recorded outcome',
  item_dispute_recovery: 'An administrator recorded item recovery',
  borrow_requested: 'A Borrow Request is ready to review',
  borrow_approved: 'Your Borrow Request was approved. Acknowledge within 48 hours',
  borrow_rejected: 'Your Borrow Request was declined',
  borrow_expired: 'An unacknowledged item approval expired',
  membership_applied: 'A membership application is ready to review',
  membership_approved: 'Your membership application was approved',
  membership_rejected: 'Your membership application was rejected',
  help_commitment_offered: 'Someone offered to help on your post',
  help_commitment_accepted: 'Your help offer was accepted',
  help_scheduled: 'Your help Exchange has a schedule',
  help_cancelled: 'A help Exchange was cancelled',
};

export async function deliverOne(backend: DeliveryBackend, sendEmail: EmailSender, outboxId?: string) {
  const claimed = await backend.rpc('claim_notification', { p_outbox_id: outboxId ?? null });
  if (claimed.error) throw new Error(claimed.error.message);
  if (!claimed.data) return null;
  const item = claimed.data as Delivery;
  if (item.reminder_id) {
    const current = await backend.rpc('check_notification_claim', { p_outbox_id: item.id, p_claim_token: item.claim_token });
    if (current.error) throw new Error(current.error.message);
    if (!current.data) return null;
  }
  let failure: string | null = null;
  try {
    if (item.channel === 'email') await sendEmail({
      to: item.recipient_email,
      subject: subjects[item.kind] ?? 'You have an Ourtopia notification',
      text: item.kind === 'item_need_responded' ? 'Sign in to Ourtopia and open Community requests to review the offered Listing and send a separate Borrow Request.' : item.kind.startsWith('item_dispute_') ? 'Sign in to Ourtopia and open Exchange issues to review the case.' : item.kind.startsWith('item_') ? 'Sign in to Ourtopia and open Handoffs to view the current schedule and status.' : item.kind.startsWith('help_') ? 'Sign in to Ourtopia to view the current status of your help Exchange.' : item.kind.startsWith('borrow_') ? 'Sign in to Ourtopia and open Borrow Requests to view the current status.' : 'Sign in to Ourtopia to view your notification and current status.',
      idempotencyKey: item.id,
    });
  } catch {
    failure = 'Email delivery failed. Retry is scheduled.';
  }
  const finished = await backend.rpc('finish_notification', { p_outbox_id: item.id, p_claim_token: item.claim_token, p_error: failure });
  if (finished.error) throw new Error(finished.error.message);
  return finished.data;
}

export function httpEmailSender(url: string, key: string, from: string): EmailSender {
  return async message => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': message.idempotencyKey },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Email provider rejected delivery.');
  };
}
