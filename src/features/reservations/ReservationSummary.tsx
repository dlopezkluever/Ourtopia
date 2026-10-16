import { useEffect, useState } from 'react';
import { calendarDate, localDeadline, type BorrowStatus, type Reservation } from '../borrowing/model';

export function ReservationSummary({ reservation, status, exchangeState, viewer, counterpart }: {
  reservation: Reservation; status: BorrowStatus; exchangeState: string | null; viewer: 'owner' | 'borrower'; counterpart: string;
}) {
  const due = Date.parse(reservation.acknowledgment_due_at);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'approved' || now >= due) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(due - now, 60000));
    return () => clearTimeout(timer);
  }, [status, now, due]);
  const deadline = <time dateTime={reservation.acknowledgment_due_at}>{localDeadline(reservation.acknowledgment_due_at)}</time>;
  const lapsed = status === 'approved' && exchangeState === 'approved' && !reservation.acknowledged_at && now >= due;
  return <section className="reservation-summary" aria-label="Reservation">
    <h4>{status === 'expired' ? 'Approval expired' : lapsed ? 'Acknowledgment deadline passed' : 'Dates reserved'}</h4>
    <p>{calendarDate(reservation.starts_on)} through {calendarDate(reservation.ends_on)}. Both days are included.</p>
    <p>Item Exchange: {exchangeState === 'approved' ? 'Approved' : exchangeState === 'expired' ? 'Expired' : exchangeState ?? 'Unavailable'}.</p>
    {status === 'expired' && <p>The borrower did not acknowledge the terms by {deadline}. The dates are released{viewer === 'borrower' ? ', and you can send a new Borrow Request.' : ' for other requests.'}</p>}
    {lapsed && <p>Acknowledgment closed at {deadline}. The server releases this reservation shortly; acknowledgment is no longer accepted.</p>}
    {status === 'approved' && !lapsed && <p>
      {viewer === 'borrower' ? <>Next: acknowledge the return date, condition, replacement value, and responsibility terms by {deadline}. If you do not, the reservation is released.</>
        : <>Next: {counterpart} acknowledges the terms by {deadline}. If they do not, the reservation is released automatically.</>}
    </p>}
    {reservation.custody_unresolved && <p>Physical recovery of the item must be recorded before anyone else can be approved.</p>}
  </section>;
}
