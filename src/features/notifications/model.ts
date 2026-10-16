export const noticeKinds: Record<string, { label: string; message: string }> = {
  membership_applied: { label: 'Membership application', message: 'A membership application is ready to review.' },
  membership_approved: { label: 'Membership approved', message: 'Your membership application was approved.' },
  membership_rejected: { label: 'Membership rejected', message: 'Your membership application was rejected. Your decision reason is in your applications.' },
  borrow_requested: { label: 'Borrow Request', message: 'Someone asked to borrow your item. Review it in Borrow Requests.' },
  borrow_approved: { label: 'Borrow Request approved', message: 'Your Borrow Request was approved. Acknowledge the terms within 48 hours.' },
  borrow_rejected: { label: 'Borrow Request declined', message: 'Your Borrow Request was declined. Nothing was reserved.' },
  borrow_expired: { label: 'Item approval expired', message: 'An item approval expired without acknowledgment. The reserved dates were released.' },
};

export function deliveryLabel(kind: string, channel: string, state: string, attempts: number) {
  const stateLabels: Record<string, string> = { pending: 'Waiting to send', processing: 'Sending', failed: 'Failed', delivered: 'Delivered' };
  return `${noticeKinds[kind]?.label ?? 'Notification'} · ${channel === 'in_app' ? 'In app' : 'Email'} · ${stateLabels[state] ?? state} · ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}
