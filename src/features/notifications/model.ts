export const noticeKinds: Record<string, { label: string; message: string }> = {
  exchange_thank_you: { label: 'Thank-you', message: 'Your Exchange partner thanked you. Open your Community profile to read it.' },
  item_need_responded: { label: 'Item Need Post response', message: 'Someone answered your item Need Post with a Listing. Open Community requests to review it and send a separate Borrow Request.' },
  membership_applied: { label: 'Membership application', message: 'A membership application is ready to review.' },
  membership_approved: { label: 'Membership approved', message: 'Your membership application was approved.' },
  membership_rejected: { label: 'Membership rejected', message: 'Your membership application was rejected. Your decision reason is in your applications.' },
  borrow_requested: { label: 'Borrow Request', message: 'Someone asked to borrow your item. Review it in Borrow Requests.' },
  borrow_approved: { label: 'Borrow Request approved', message: 'Your Borrow Request was approved. Acknowledge the terms within 48 hours.' },
  borrow_rejected: { label: 'Borrow Request declined', message: 'Your Borrow Request was declined. Nothing was reserved.' },
  borrow_expired: { label: 'Item approval expired', message: 'An item approval expired without acknowledgment. The reserved dates were released.' },
  vouch_requested: { label: 'Vouch request', message: 'An applicant requested your Vouch. Review their pending application in Vouches.' },
  vouch_submitted: { label: 'Vouch statement', message: 'A Vouch statement is ready to read in Vouches. Membership still requires separate approval.' },
};

export function deliveryLabel(kind: string, channel: string, state: string, attempts: number) {
  const stateLabels: Record<string, string> = { pending: 'Waiting to send', processing: 'Sending', failed: 'Failed', delivered: 'Delivered' };
  return `${noticeKinds[kind]?.label ?? 'Notification'} · ${channel === 'in_app' ? 'In app' : 'Email'} · ${stateLabels[state] ?? state} · ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}
