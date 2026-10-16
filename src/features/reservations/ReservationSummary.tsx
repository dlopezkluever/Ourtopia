import type { Reservation } from '../borrowing/model';
import { localDate } from '../listings/model';

export function ReservationSummary({ reservation, status }: { reservation: Reservation; status: string }) {
  const overdue = status === 'approved' && Date.now() >= Date.parse(reservation.acknowledgment_due_at);
  return <section aria-label="Reservation" className="reservation-summary"><h3>{status === 'expired' ? 'Approval expired' : overdue ? 'Acknowledgment deadline passed' : 'Reserved dates'}</h3>
    <p>{localDate(reservation.starts_on)} through {localDate(reservation.ends_on)}. Both dates are included.</p>
    <p>Acknowledge by <time dateTime={reservation.acknowledgment_due_at}>{new Date(reservation.acknowledgment_due_at).toLocaleString()}</time> in your local time. Approval lasts 48 hours.</p>
    {overdue ? <p>The server will release this unacknowledged reservation. Acknowledgment is already unavailable.</p> : <p>{reservation.blocking ? 'The item is reserved.' : 'The dates have been released.'}</p>}
    {reservation.custody_unresolved && <p>Physical recovery is required before another approval.</p>}
    <p>Condition at approval: {reservation.condition}</p><p>Replacement value: ${reservation.replacement_value.toFixed(2)}</p><p>{reservation.lending_conditions}</p>
    {status === 'approved' && !overdue && <p>Next, the borrower acknowledges responsibility and arranges handoff. Handoff is delivered in the next release.</p>}
  </section>;
}
