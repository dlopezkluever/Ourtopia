import { useEffect, useState, type FormEvent } from 'react';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { calendarDate, localDeadline } from '../borrowing/model';
import { HandoffPhotos } from '../evidence/HandoffPhotos';
import { HandoffNotices } from './HandoffNotices';
import { handoffCommand, readHandoff, readHandoffs } from './api';
import { nextActor, stateLabels, termsAcknowledgment, type Handoff, type HandoffAction } from './model';

export function HandoffLinks({ userId, listingId }: { userId: string; listingId?: string }) {
  const [state] = useBorrowingRead(userId, `handoff-links-${listingId ?? 'all'}`, () => readHandoffs(listingId));
  if (state.status !== 'ready' || state.data.length === 0) return null;
  return <section className="handoff-links" aria-label="Your item Handoffs"><h2>Your item Handoffs</h2>{state.data.map(h => <p key={h.exchange_id}><a href={`/handoffs/${h.exchange_id}`}>{stateLabels[h.state] ?? h.state} · {calendarDate(h.reservation.starts_on)} through {calendarDate(h.reservation.ends_on)}</a></p>)}</section>;
}

function HandoffCard({ h, userId, refresh }: { h: Handoff; userId: string; refresh: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false); const [conditionAck, setConditionAck] = useState(false);
  const [time, setTime] = useState(''); const [meeting, setMeeting] = useState('');
  const [condition, setCondition] = useState(''); const [accessories, setAccessories] = useState(''); const [reason, setReason] = useState('');
  async function act(action: HandoffAction, details: Record<string, string | boolean> = {}) {
    const key = `handoff-command-${userId}-${h.exchange_id}-${h.revision}-${action}-${JSON.stringify(details)}`;
    const intent = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, intent);
    setBusy(true); setError('');
    try { await handoffCommand(h, action, details, intent); sessionStorage.removeItem(key); refresh(); }
    catch (failure) { setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'The server did not confirm this action. Retry safely.'); }
    finally { setBusy(false); }
  }
  const submit = (event: FormEvent, action: HandoffAction, details: Record<string, string | boolean>) => { event.preventDefault(); void act(action, details); };
  const pending = h.state === 'handoff_pending'; const before = pending || h.state === 'approved';
  return <article className="handoff-card" aria-label="Item Handoff"><span className="eyebrow">{userId === h.owner_id ? 'YOU ARE LENDING' : 'YOU ARE BORROWING'}</span><h1>Item Handoff</h1>
    <p role="status" className="handoff-status">{stateLabels[h.state] ?? h.state}</p><p><strong>Next actor.</strong> {nextActor(h, userId)}</p>
    <p>Return by {calendarDate(h.reservation.ends_on)}. Reserved from {calendarDate(h.reservation.starts_on)}.</p>
    <p>Acknowledgment deadline <time dateTime={h.reservation.acknowledgment_due_at}>{localDeadline(h.reservation.acknowledgment_due_at)}</time>.</p>
    {h.state === 'approved' && <section aria-label="Borrower terms"><h2>Agree before you borrow</h2><p>Expected condition. {h.reservation.condition}</p><p>Replacement value. ${h.reservation.replacement_value.toFixed(2)}</p><p>{h.reservation.lending_conditions}</p><p>Communicate damage promptly and work with the owner to repair or resolve negligent damage.</p>
      {userId === h.borrower_id ? <><label className="handoff-check"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)}/>I acknowledge the return date, condition expectations, replacement value, and responsibility to communicate and resolve negligent damage.</label><button className="primary-button" disabled={busy || !accepted} onClick={() => void act('acknowledge_terms', termsAcknowledgment)}>Acknowledge terms</button></> : <p>Waiting for the borrower to acknowledge.</p>}
    </section>}
    {h.starts_at && <section aria-label="Current Handoff schedule"><h2>Current schedule</h2><p><time dateTime={h.starts_at}>{localDeadline(h.starts_at)}</time></p><p>{h.location}</p><p>{h.schedule_confirmed_at ? 'Schedule confirmed by both participants.' : 'Proposal awaiting the other participant.'}</p></section>}
    {pending && <><section aria-label="Arrange Handoff"><h2>{h.starts_at ? 'Change the schedule' : 'Arrange Handoff'}</h2><form onSubmit={event => submit(event, 'propose_schedule', { starts_at: new Date(time).toISOString(), location: meeting })}>
      <label>Handoff time<input type="datetime-local" required value={time} onChange={event => setTime(event.target.value)}/></label><label>Meeting location<input required maxLength={500} value={meeting} onChange={event => setMeeting(event.target.value)}/></label><button disabled={busy} type="submit">Propose schedule</button></form>
      {h.starts_at && !h.schedule_confirmed_at && h.proposed_by !== userId && <button className="primary-button" disabled={busy} onClick={() => void act('confirm_schedule')}>Confirm schedule</button>}</section>
      {h.schedule_confirmed_at && <section aria-label="Condition at Handoff"><h2>At Handoff</h2>{h.condition ? <><p>Recorded condition. {h.condition}</p><p>Accessories. {h.accessories || 'None'}</p>{h.condition_recorded_by !== userId && <><label className="handoff-check"><input type="checkbox" checked={conditionAck} onChange={event => setConditionAck(event.target.checked)}/>I acknowledge the item is received in the documented condition with these accessories.</label><button className="primary-button" disabled={busy || !conditionAck} onClick={() => void act('confirm_handoff', { condition_acknowledged: true })}>Confirm Handoff</button></>}</> : <form onSubmit={event => submit(event, 'record_condition', { condition, accessories })}><label>Item condition<textarea required maxLength={2000} value={condition} onChange={event => setCondition(event.target.value)}/></label><label>Included accessories<textarea required maxLength={2000} value={accessories} onChange={event => setAccessories(event.target.value)}/></label><p>Saving confirms your account of condition. The other participant then acknowledges it.</p><button disabled={busy}>Record condition</button></form>}</section>}
    </>}
    {(pending || h.evidence.length > 0) && <HandoffPhotos userId={userId} exchangeId={h.exchange_id} evidence={h.evidence} editable={pending || (h.state === 'checked_out' && h.evidence.some(photo => photo.uploader_id === userId && photo.state === 'pending'))} onChanged={refresh}/>}
    {h.handed_off_at && <section aria-label="Recorded Handoff"><h2>Handoff recorded</h2><p>{localDeadline(h.handed_off_at)}</p><p>Condition. {h.condition}</p><p>Accessories. {h.accessories || 'None'}</p><p>Both participants acknowledged condition. {h.evidence.filter(photo => photo.state === 'ready').length} optional photos.</p></section>}
    {before && <form className="handoff-cancel" aria-label="Cancel before Handoff" onSubmit={event => submit(event, 'cancel', { reason })}><h2>Plans changed?</h2><label>Cancellation reason<textarea required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)}/></label><button disabled={busy}>Cancel before Handoff</button><p>Releases the reservation with no automatic reputation loss.</p></form>}
    {h.cancelled_reason && <p>Cancellation reason. {h.cancelled_reason}</p>}
    {error && <p role="alert" className="error">{error}</p>}<button disabled={busy} onClick={refresh}>Refresh Handoff</button>
  </article>;
}
export function HandoffPage({ userId, exchangeId }: { userId: string; exchangeId?: string }) {
  const [state, refresh] = useBorrowingRead(userId, `handoff-${exchangeId ?? 'overview'}`, () => exchangeId ? readHandoff(exchangeId).then(h => [h]) : readHandoffs());
  useEffect(() => {
    if (state.status !== 'denied') return;
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(`handoff-command-${userId}-${exchangeId ?? ''}`) || key.startsWith(`handoff-upload-${userId}-${exchangeId ?? ''}`)) sessionStorage.removeItem(key);
    }
  }, [state.status, userId, exchangeId]);
  return <section className="handoff-page"><a href="/borrowing">Borrow Requests</a>{state.status === 'loading' ? <p role="status">Opening Handoffs...</p> : state.status === 'denied' ? <><h1>Handoff unavailable</h1><p>Only authorized participants can open these logistics and photos. Cached records were cleared.</p></> : exchangeId ? state.data.map(h => <HandoffCard key={`${h.exchange_id}-${h.revision}`} h={h} userId={userId} refresh={refresh}/>) : <><h1>Your Handoffs</h1>{state.data.length ? state.data.map(h => <p key={h.exchange_id}><a href={`/handoffs/${h.exchange_id}`}>{stateLabels[h.state] ?? h.state} · Return by {calendarDate(h.reservation.ends_on)}</a></p>) : <p>No approved item Exchanges yet.</p>}</>}<HandoffNotices userId={userId}/></section>;
}
