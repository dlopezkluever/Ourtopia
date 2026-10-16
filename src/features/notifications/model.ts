export const noticeKinds: Record<string, { label: string; message: string }> = {
  membership_applied: { label: 'Membership application', message: 'A membership application is ready to review.' },
  membership_approved: { label: 'Membership approved', message: 'Your membership application was approved.' },
  membership_rejected: { label: 'Membership rejected', message: 'Your membership application was rejected. Your decision reason is in your applications.' },
  vouch_requested: { label: 'Vouch request', message: 'An applicant requested your Vouch. Review their pending application in Vouches.' },
  vouch_submitted: { label: 'Vouch statement', message: 'A Vouch statement is ready to read in Vouches. Membership still requires separate approval.' },
};

export function deliveryLabel(kind: string, channel: string, state: string, attempts: number) {
  const stateLabels: Record<string, string> = { pending: 'Waiting to send', processing: 'Sending', failed: 'Failed', delivered: 'Delivered' };
  return `${noticeKinds[kind]?.label ?? 'Notification'} · ${channel === 'in_app' ? 'In app' : 'Email'} · ${stateLabels[state] ?? state} · ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}
