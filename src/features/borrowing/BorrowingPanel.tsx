import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { readDirectory, readProfile } from '../profiles/model';
import { ScoreCard, TrustIndicators, HistoryList } from '../reputation/Standing';
import { globalExplanation, localExplanation } from '../reputation/model';
import { listingSchema, type Listing } from '../listings/model';
import { ReservationSummary } from '../reservations/ReservationSummary';
import { borrowProblem, borrowStatusLabels, calendarDate, inclusiveDays, type BorrowProblem, type BorrowView } from './model';
import { decideBorrowRequest, readBorrowViews, submitBorrowRequest } from './api';
import { useBorrowingRead } from './useBorrowingRead';

const listingSummarySchema = z.array(z.object({ id: z.uuid(), title: z.string(), minimum_score: z.number().int() }));

async function readBorrowing(listingId?: string) {
  const requests = await readBorrowViews({ listingId });
  const communities = [...new Set(requests.map(request => request.community_id))];
  const [directories, titles] = await Promise.all([
    Promise.all(communities.map(id => readDirectory(id).catch(() => []))),
    requests.length ? supabase.from('listings').select('id,title,minimum_score').in('id', [...new Set(requests.map(request => request.listing_id))]) : Promise.resolve({ data: [], error: null }),
  ]);
  if (titles.error) throw titles.error;
  const people = new Map(directories.flat().map(entry => [entry.user_id, entry.email]));
  return { requests, people, listings: new Map(listingSummarySchema.parse(titles.data).map(row => [row.id, row])) };
}

function rangeText(startsOn: string, endsOn: string) {
  const days = inclusiveDays(startsOn, endsOn);
  return `${calendarDate(startsOn)} through ${calendarDate(endsOn)} (${days} ${days === 1 ? 'day' : 'days'}, both included)`;
}

function Problem({ problem }: { problem: BorrowProblem | null }) {
  if (!problem) return null;
  return <div role="alert" className={`borrow-problem borrow-problem-${problem.kind}`}><strong>{problem.kind === 'conflict' ? 'Reservation conflict' : problem.kind === 'ineligible' ? 'Not eligible' : problem.kind === 'stale' ? 'This changed' : 'Not sent'}</strong><p>{problem.message}</p></div>;
}

function TrustReview({ userId, request, email, minimum }: { userId: string; request: BorrowView; email: string; minimum?: number }) {
  const state = useAccessScopedRead(userId, `borrow-trust-${request.id}`, () => readProfile(request.community_id, request.borrower_id));
  if (state.status === 'loading') return <p role="status">Loading current standing…</p>;
  if (state.status === 'denied') return <p className="borrow-note">The borrower's current standing is unavailable. They may no longer be an active member, and approval will be refused.</p>;
  const profile = state.data;
  const below = minimum !== undefined && profile.local.score < minimum;
  return <section className="trust-review" aria-label={`Current standing of ${email}`}>
    <h4>Current standing of {email}</h4>
    <div className="trust-review-scores">
      <ScoreCard label="Community Solidarity Score" score={profile.local.score} title={profile.local.title} completed={profile.local.completedInteractions} explanation={localExplanation}/>
      <ScoreCard label="Global Solidarity Score" score={profile.trust.globalScore} title={profile.globalTitle} completed={profile.trust.completedInteractions} explanation={globalExplanation}/>
    </div>
    {minimum !== undefined && <p className={below ? 'borrow-warning' : 'borrow-note'}>{below ? `Below this Listing's minimum of ${minimum}. Approval will be refused.` : `Meets this Listing's minimum of ${minimum}.`}</p>}
    <TrustIndicators trust={profile.trust}/>
    <HistoryList events={profile.history} heading="Local history in this Community"/>
    <p className="borrow-note">The server checks the current score again when you approve.</p>
  </section>;
}

function RequestCard({ userId, request, people, title, minimum, onChanged }: { userId: string; request: BorrowView; people: Map<string, string>; title?: string; minimum?: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BorrowProblem | null>(null);
  const owner = request.owner_id === userId;
  const borrower = request.borrower_id === userId ? 'you' : people.get(request.borrower_id) ?? 'a former member';
  const lender = request.owner_id === userId ? 'you' : people.get(request.owner_id) ?? 'a former member';
  async function decide(decision: 'approved' | 'rejected') {
    const key = `borrow-decision-${userId}-${request.id}-${request.version}-${decision}`;
    const intent = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, intent);
    setBusy(true); setProblem(null);
    try { await decideBorrowRequest(request, decision, intent); sessionStorage.removeItem(key); onChanged(); }
    catch (error) { const next = borrowProblem(error); if (next.kind !== 'network') sessionStorage.removeItem(key); setProblem(next); }
    finally { setBusy(false); }
  }
  return <article className="borrow-request" aria-label={`Borrow Request from ${borrower} for ${calendarDate(request.starts_on)} through ${calendarDate(request.ends_on)}`}>
    <div className="borrow-request-head"><span className={`borrow-status borrow-status-${request.status}`}>{borrowStatusLabels[request.status]}</span>{title && <a href={`/communities/${request.community_id}/listings/${request.listing_id}`}>{title}</a>}</div>
    <h3>{owner ? `Request from ${borrower}` : `Your request to ${lender}`}</h3>
    <p>{rangeText(request.starts_on, request.ends_on)}</p>
    {request.status === 'requested' && !owner && <p className="borrow-note">Next: the owner chooses whether to lend. This application does not reserve the item, and other people may also apply.</p>}
    {request.status === 'rejected' && <p className="borrow-note">{owner ? 'You declined this request.' : 'The owner declined this request.'} Nothing was reserved.</p>}
    {request.status === 'requested' && owner && <>
      <p className="borrow-note">Next: review current standing, then approve or decline. Approval reserves these dates for 48 hours while the borrower acknowledges the terms.</p>
      <TrustReview userId={userId} request={request} email={borrower} minimum={minimum}/>
      <div className="borrow-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void decide('approved')}>Approve {borrower}</button>
        <button type="button" disabled={busy} onClick={() => void decide('rejected')}>Decline {borrower}</button>
      </div>
    </>}
    {request.reservation && <ReservationSummary reservation={request.reservation} status={request.status} exchangeState={request.exchange_state} viewer={owner ? 'owner' : 'borrower'} counterpart={owner ? borrower : lender}/>}
    <Problem problem={problem}/>
  </article>;
}

function RequestForm({ listing, onSent }: { listing: Listing; onSent: () => void }) {
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [intent, setIntent] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BorrowProblem | null>(null);
  const [sent, setSent] = useState('');
  function change(set: (value: string) => void, value: string) { set(value); setIntent(crypto.randomUUID()); setSent(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setProblem(null);
    try {
      const request = await submitBorrowRequest(listing.id, startsOn, endsOn, intent);
      setSent(`Borrow Request sent for ${rangeText(request.starts_on, request.ends_on)}. The owner has been notified.`);
      setIntent(crypto.randomUUID()); setStartsOn(''); setEndsOn(''); onSent();
    } catch (error) { setProblem(borrowProblem(error)); }
    finally { setBusy(false); }
  }
  return <form className="borrow-form" onSubmit={event => void submit(event)} aria-label="Request this item">
    <h3>Request this item</h3>
    <p className="borrow-note">Choose the first and last day you need it. Both days are included. Dates must fit one availability range:</p>
    <ul className="borrow-availability">{listing.listing_availability.map(range => <li key={`${range.starts_on}-${range.ends_on}`}>{calendarDate(range.starts_on)} through {calendarDate(range.ends_on)}</li>)}</ul>
    <div className="borrow-dates">
      <label>First day<input type="date" required value={startsOn} onChange={event => change(setStartsOn, event.target.value)}/></label>
      <label>Last day<input type="date" required min={startsOn || undefined} value={endsOn} onChange={event => change(setEndsOn, event.target.value)}/></label>
    </div>
    {startsOn && endsOn && startsOn <= endsOn && <p className="borrow-note" aria-live="polite">You are asking for {rangeText(startsOn, endsOn)}.</p>}
    <button type="submit" className="primary-button" disabled={busy}>Send Borrow Request</button>
    <Problem problem={problem}/>
    {sent && <p role="status" className="borrow-sent">{sent}</p>}
  </form>;
}

export function BorrowingPanel({ userId, communityId, listingId }: { userId: string; communityId: string; listingId: string }) {
  const [state, refresh] = useBorrowingRead(userId, `listing-${listingId}`, async () => {
    const [borrowing, listing] = await Promise.all([
      readBorrowing(listingId),
      supabase.from('listings').select('*,listing_availability(starts_on,ends_on)').eq('id', listingId).eq('community_id', communityId).maybeSingle(),
    ]);
    if (listing.error) throw listing.error;
    return { ...borrowing, listing: listing.data ? listingSchema.parse(listing.data) : null };
  });
  if (state.status === 'loading') return <section className="borrowing-panel" aria-label="Borrow Requests" aria-busy="true"><h2>Borrow Requests</h2></section>;
  if (state.status === 'denied') return <section className="borrowing-panel" aria-label="Borrow Requests"><h2>Borrow Requests unavailable</h2><p>Current Community access is required. Cached requests were cleared.</p></section>;
  const { listing, requests, people } = state.data;
  if (!listing) return null;
  const owner = listing.owner_id === userId;
  const pending = requests.filter(request => request.status === 'requested').length;
  return <section className="borrowing-panel" aria-label="Borrow Requests">
    <h2>{owner ? 'Borrow Requests for this item' : 'Borrow this item'}</h2>
    {owner ? <p className="borrow-note">You choose whom to lend to. {pending ? `${pending} ${pending === 1 ? 'request is' : 'requests are'} waiting.` : 'No requests are waiting.'} Several people may apply for the same dates; only one approval can hold them.</p>
      : listing.status === 'published' ? <RequestForm listing={listing} onSent={refresh}/> : <p className="borrow-note">This Listing was withdrawn and takes no new requests.</p>}
    {requests.length > 0 && <h3 className="borrow-list-heading">{owner ? 'Requests' : 'Your requests for this item'}</h3>}
    {requests.map(request => <RequestCard key={`${request.id}-${request.version}`} userId={userId} request={request} people={people} minimum={listing.minimum_score} onChanged={refresh}/>)}
  </section>;
}

export function BorrowingOverview({ userId }: { userId: string }) {
  const [state, refresh] = useBorrowingRead(userId, 'overview', () => readBorrowing());
  if (state.status === 'loading') return <p role="status" className="loading">Opening Borrow Requests…</p>;
  if (state.status === 'denied') return <section className="account-card"><h2>Borrow Requests unavailable</h2><p>Current access is required. Cached requests were cleared.</p><a href="/">Back to your Communities</a></section>;
  const { requests, people, listings } = state.data;
  const lending = requests.filter(request => request.owner_id === userId);
  const borrowing = requests.filter(request => request.borrower_id === userId);
  return <section className="borrowing-panel borrowing-overview" aria-label="Borrow Requests">
    <span className="eyebrow">LENDING AND BORROWING</span>
    <h1>Borrow Requests</h1>
    <p className="borrow-note">Requests you sent and requests for your items. Calendar dates include the first and last day.</p>
    <h2>For your items</h2>
    {lending.length ? lending.map(request => <RequestCard key={`${request.id}-${request.version}`} userId={userId} request={request} people={people} title={listings.get(request.listing_id)?.title ?? 'Listing unavailable'} minimum={listings.get(request.listing_id)?.minimum_score} onChanged={refresh}/>) : <p>No one has asked to borrow your items yet.</p>}
    <h2>Your requests</h2>
    {borrowing.length ? borrowing.map(request => <RequestCard key={`${request.id}-${request.version}`} userId={userId} request={request} people={people} title={listings.get(request.listing_id)?.title ?? 'Listing unavailable'} minimum={listings.get(request.listing_id)?.minimum_score} onChanged={refresh}/>) : <p>You have not requested any items yet.</p>}
  </section>;
}
