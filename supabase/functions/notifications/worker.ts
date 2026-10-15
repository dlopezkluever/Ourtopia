export type Delivery = {
  id: string;
  claim_token: string;
  recipient_email: string;
  channel: 'email' | 'in_app';
  kind: string;
};

export type DeliveryBackend = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type EmailSender = (message: { to: string; subject: string; text: string; idempotencyKey: string }) => Promise<void>;

const subjects: Record<string, string> = {
  membership_applied: 'A membership application is ready to review',
  membership_approved: 'Your membership application was approved',
  membership_rejected: 'Your membership application was rejected',
};

export async function deliverOne(backend: DeliveryBackend, sendEmail: EmailSender, outboxId?: string) {
  const claimed = await backend.rpc('claim_notification', { p_outbox_id: outboxId ?? null });
  if (claimed.error) throw new Error(claimed.error.message);
  if (!claimed.data) return null;
  const item = claimed.data as Delivery;
  let failure: string | null = null;
  try {
    if (item.channel === 'email') await sendEmail({
      to: item.recipient_email,
      subject: subjects[item.kind] ?? 'You have an Ourtopia notification',
      text: 'Sign in to Ourtopia to view your notification and current application status.',
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
