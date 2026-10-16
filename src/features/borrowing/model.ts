import { z } from 'zod';

export const borrowStatusSchema = z.enum(['requested', 'approved', 'rejected', 'expired']);
export type BorrowStatus = z.infer<typeof borrowStatusSchema>;

export const reservationSchema = z.object({
  exchange_id: z.uuid(), starts_on: z.iso.date(), ends_on: z.iso.date(), acknowledgment_due_at: z.string(),
  acknowledged_at: z.string().nullable(), blocking: z.boolean(), custody_unresolved: z.boolean(),
});
export type Reservation = z.infer<typeof reservationSchema>;

export const borrowRequestSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), listing_id: z.uuid(), owner_id: z.uuid(), borrower_id: z.uuid(),
  starts_on: z.iso.date(), ends_on: z.iso.date(), status: borrowStatusSchema, version: z.number().int(),
  exchange_id: z.uuid().nullable(), created_at: z.string(), decided_at: z.string().nullable(),
});
export type BorrowRequest = z.infer<typeof borrowRequestSchema>;

export const borrowViewSchema = borrowRequestSchema.extend({ exchange_state: z.string().nullable(), reservation: reservationSchema.nullable() });
export type BorrowView = z.infer<typeof borrowViewSchema>;

export const borrowStatusLabels: Record<BorrowStatus, string> = {
  requested: 'Waiting for the owner', approved: 'Approved and reserved', rejected: 'Declined', expired: 'Approval expired',
};

// Calendar dates are not instants. Format them in UTC so every display timezone shows the same day.
export function calendarDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
export function inclusiveDays(startsOn: string, endsOn: string) {
  return Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86400000) + 1;
}
export function localDeadline(instant: string) {
  return new Date(instant).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

const commandError = z.object({ code: z.string().optional(), message: z.string() });
export type BorrowProblem = { kind: 'conflict' | 'ineligible' | 'stale' | 'denied' | 'invalid' | 'network'; message: string };
export function borrowProblem(error: unknown): BorrowProblem {
  const value = commandError.safeParse(error);
  if (!value.success || !value.data.code) return { kind: 'network', message: 'The server did not confirm this action. Try again. Retrying is safe and will not send it twice.' };
  const { code, message } = value.data;
  if (code === '23P01') return { kind: 'conflict', message: `${message} Nothing was reserved, and the borrower was not notified.` };
  if (code === '23514') return { kind: 'ineligible', message: `${message} Nothing was reserved.` };
  if (code === '55000') return { kind: 'stale', message: `${message} Refresh to see the current state.` };
  if (code === '42501') return { kind: 'denied', message };
  return { kind: 'invalid', message };
}
