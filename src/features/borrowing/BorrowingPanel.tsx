import { useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { readProfile, type MemberProfileData } from '../profiles/model';
import { listingSchema, localDate } from '../listings/model';
import { borrowError, borrowRequestSchema, decideBorrowRequest, reservationSchema, submitBorrowRequest, type BorrowRequest } from './model';
import { ReservationSummary } from '../reservations/ReservationSummary';

function TrustReview({ communityId, subjectId, userId }: { communityId: string; subjectId: string; userId: string }) {
  const state = useAccessScopedRead(userId, `borrow-trust-${communityId}-${subjectId}`, () => readProfile(communityId, subjectId));
  if (state.status !== 'ready') return <p role="status">Current borrower profile unavailable. Refresh before deciding.</p>;
  return <TrustDetails profile={state.data}/>;
}
function TrustDetails({ profile }: { profile: MemberProfileData }) {
  return <section aria-label="Current borrower standing"><h3>Current borrower standing</h3><p>{profile.email}</p>
    <p>Local {profile.local.score} — {profile.local.title}. {profile.local.completedInteractions} completed Exchanges.</p>
    <p>Global {profile.trust.globalScore} — {profile.globalTitle}. {profile.trust.completedInteractions} completed Exchanges.</p>
    <p>Unresolved Disputes: {profile.trust.incidents.filter(i => i.type === 'unresolved_dispute').length}</p>
    <p>Serious incidents: {profile.trust.incidents.filter(i => i.type === 'serious_violation').length}</p>
    <h4>Permitted local history</h4>{profile.history.length ? <ul>{profile.history.map(event => <li key={event.id}>{event.rule}: {event.points > 0 ? '+' : ''}{event.points} points</li>)}</ul> : <p>No verified local history yet.</p>}
    <a href={`/communities/${profile.communityId}/members/${profile.userId}`}>Open full permitted profile</a>
  </section>;
}

export function BorrowingPanel({ userId, communityId, listingId }: { userId: string; communityId?: string; listingId?: string }) {
  const [revision, setRevision] = useState(0);
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState('');
  const [intent, setIntent] = useState(() => crypto.randomUUID());
  const state = useAccessScopedRead(userId, `borrowing-${listingId ?? 'all'}-${revision}`, async () => {
    let query = supabase.from('borrow_requests').select('*').order('created_at', { ascending: false });
    if (listingId) query = query.eq('listing_id', listingId);
    const requests = await query;
    if (requests.error) throw requests.error;
    const reservations = await supabase.from('item_reservations').select('*');
    if (reservations.error) throw reservations.error;
    const listing = listingId ? await supabase.from('listings').select('*,listing_availability(starts_on,ends_on)').eq('id', listingId).single() : null;
    if (listing?.error) throw listing.error;
    return { requests: borrowRequestSchema.array().parse(requests.data), reservations: reservationSchema.array().parse(reservations.data), listing: listing ? listingSchema.parse(listing.data) : null };
  });
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!listingId) return;
    setBusy(true); setError('');
    try { await submitBorrowRequest(listingId, startsOn, endsOn, intent); setIntent(crypto.randomUUID()); setRevision(v => v + 1); }
    catch (error) { setError(borrowError(error)); }
    finally { setBusy(false); }
  }
  async function decide(request: BorrowRequest, decision: 'approved' | 'rejected') {
    setBusy(true); setError('');
    const key = `borrow-decision-${userId}-${request.id}-${request.version}-${decision}`;
    const saved = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, saved);
    try { await decideBorrowRequest(request, decision, saved); sessionStorage.removeItem(key); setRevision(v => v + 1); }
    catch (error) { setError(borrowError(error)); }
    finally { setBusy(false); }
  }
  if (state.status === 'loading') return <p role="status">Opening Borrow Requests...</p>;
  if (state.status === 'denied') return <section className="borrowing-panel"><h2>Borrow Requests unavailable</h2><p>Current access is required. Your private data has been cleared.</p><a href="/">Your Communities</a></section>;
  const { listing, requests, reservations } = state.data;
  return <section className="borrowing-panel" aria-label="Borrow Requests"><h2>Borrow Requests</h2>
    <p>Owners choose whom to lend to. Applications do not reserve an item.</p><button onClick={() => setRevision(v => v + 1)} disabled={busy}>Refresh current requests</button>
    {listing && listing.owner_id !== userId && listing.status === 'published' && <form onSubmit={event => void submit(event)}>
      <h3>Request this item</h3><p>Choose dates within Listing availability. The first and last days are included.</p>
      <label>Borrow from<input type="date" required value={startsOn} onChange={event => { setStartsOn(event.target.value); setIntent(crypto.randomUUID()); }}/></label>
      <label>Borrow through<input type="date" required min={startsOn} value={endsOn} onChange={event => { setEndsOn(event.target.value); setIntent(crypto.randomUUID()); }}/></label>
      <button type="submit" disabled={busy}>Send Borrow Request</button>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
    {!requests.length && <p>No Borrow Requests yet.</p>}
    {requests.map(request => <article key={request.id} className="borrow-request" aria-label={`Borrow Request ${request.id}`}>
      <h3>{request.status === 'approved' ? 'Approved Borrow Request' : request.status === 'rejected' ? 'Declined Borrow Request' : request.status === 'expired' ? 'Expired Borrow Request' : 'Requested dates'}</h3>
      <p>{localDate(request.starts_on)} through {localDate(request.ends_on)}</p>
      {!listingId && <a href={`/communities/${request.community_id}/listings/${request.listing_id}`}>Open requested Listing</a>}
      {request.owner_id === userId && request.status === 'requested' && <>
        <button onClick={() => setReview(review === request.id ? '' : request.id)}>Review borrower standing</button>
        {review === request.id && <><TrustReview userId={userId} communityId={communityId ?? request.community_id} subjectId={request.borrower_id}/><div className="listing-actions">
          <button disabled={busy} onClick={() => void decide(request, 'approved')}>Approve request</button><button disabled={busy} onClick={() => void decide(request, 'rejected')}>Decline request</button>
        </div><p>Approval checks current membership, score, dates and custody again on the server.</p></>}
      </>}
      {reservations.filter(r => r.exchange_id === request.exchange_id).map(reservation => <ReservationSummary key={reservation.exchange_id} reservation={reservation} status={request.status}/>)}
    </article>)}
  </section>;
}
