import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { readDirectory } from '../profiles/model';
import { categories, listingSchema, type Listing } from '../listings/model';
import { ListingForm } from '../listings/ListingForm';
import { useListingAccess } from '../listings/useListingAccess';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { submitBorrowRequest } from '../borrowing/api';
import { borrowProblem, borrowStatusLabels, borrowStatusSchema, calendarDate, inclusiveDays, type BorrowProblem } from '../borrowing/model';
import { errorMessage, intentFor } from '../help/model';
import { itemNeedSchema, needFieldsSchema, needImageSchema, needPath, needResponseSchema, urgencies, valueRange, type ItemNeed, type NeedResponse } from './model';
import { NeedImage } from './NeedImage';

const ownRequestSchema = z.object({ id: z.uuid(), listing_id: z.uuid(), status: borrowStatusSchema, starts_on: z.iso.date(), ends_on: z.iso.date() });
const listingQuery = '*,listing_availability(starts_on,ends_on)';
const dates = (startsOn: string, endsOn: string) => `${calendarDate(startsOn)} through ${calendarDate(endsOn)}`;

async function readNeeds(userId: string, communityId: string, needId?: string) {
  const community = await supabase.from('communities').select('name').eq('id', communityId).single();
  if (community.error) throw community.error;
  const [needs, directory, images, responses, listings, requests] = await Promise.all([
    supabase.from('item_need_posts').select('*').eq('community_id', communityId).order('created_at', { ascending: false }),
    readDirectory(communityId),
    needId ? supabase.from('item_need_images').select('*').eq('need_id', needId) : Promise.resolve({ data: [], error: null }),
    needId ? supabase.from('item_need_responses').select('*').eq('need_id', needId).order('created_at') : Promise.resolve({ data: [], error: null }),
    needId ? supabase.from('listings').select(listingQuery).eq('community_id', communityId).eq('status', 'published') : Promise.resolve({ data: [], error: null }),
    needId ? supabase.from('borrow_requests').select('id,listing_id,status,starts_on,ends_on').eq('borrower_id', userId).eq('community_id', communityId).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [needs, images, responses, listings, requests]) if (result.error) throw result.error;
  return {
    name: community.data.name, directory, needs: itemNeedSchema.array().parse(needs.data), images: needImageSchema.array().parse(images.data),
    responses: needResponseSchema.array().parse(responses.data), listings: new Map(listingSchema.array().parse(listings.data).map(listing => [listing.id, listing])),
    requests: ownRequestSchema.array().parse(requests.data),
  };
}

function NeedForm({ userId, communityId, need, onSaved, onCancel }: { userId: string; communityId: string; need?: ItemNeed; onSaved: (id: string) => void; onCancel: () => void }) {
  const draftKey = `item-need-draft-${userId}-${communityId}-${need?.id ?? 'new'}`;
  const [draft] = useState<Record<string, string> | null>(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) ?? 'null'); } catch { return null; } });
  const initial = draft ?? (need ? { ...need, value_min: need.value_min?.toString() ?? '', value_max: need.value_max?.toString() ?? '' } : null);
  const memory = useRef<{ payload: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const values = (form: HTMLFormElement) => Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = needFieldsSchema.safeParse(values(event.currentTarget));
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
    setBusy(true); setError('');
    try {
      const result = await supabase.rpc('save_item_need', { p_intent_id: intentFor(memory, parsed.data), p_community_id: communityId, ...(need ? { p_need_id: need.id } : {}), p_expected_version: need?.version ?? 0, p_details: parsed.data });
      if (result.error) throw result.error;
      sessionStorage.removeItem(draftKey);
      onSaved(itemNeedSchema.parse(result.data).id);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <section className="account-card listing-form" aria-labelledby="need-form-title"><h2 id="need-form-title">{need ? 'Edit item need' : 'Ask for an item'}</h2><p>Tell your Community what you need. Owners can answer with a Listing, and you then send them an ordinary Borrow Request.</p>
    <form onSubmit={event => void submit(event)} onChange={event => sessionStorage.setItem(draftKey, JSON.stringify(values(event.currentTarget)))}>
      <fieldset disabled={busy}>
        <label htmlFor="need-title">What do you need?</label><input id="need-title" name="title" defaultValue={initial?.title} required minLength={2} maxLength={120}/>
        <label htmlFor="need-description">Description</label><textarea id="need-description" name="description" defaultValue={initial?.description} required maxLength={2000}/>
        <label htmlFor="need-category">Category</label><select id="need-category" name="category" defaultValue={initial?.category ?? 'tools'}>{categories.map(category => <option key={category}>{category}</option>)}</select>
        <fieldset className="availability-fields"><legend>Requested dates</legend><p>Both days are included.</p><div className="availability-row">
          <label>First day needed<input name="starts_on" type="date" required defaultValue={initial?.starts_on}/></label>
          <label>Last day needed<input name="ends_on" type="date" required defaultValue={initial?.ends_on}/></label>
        </div></fieldset>
        <fieldset className="availability-fields need-urgency"><legend>Urgency</legend>{Object.entries(urgencies).map(([value, label]) => <label key={value}><input type="radio" name="urgency" value={value} defaultChecked={(initial?.urgency ?? 'flexible') === value}/> {label}</label>)}</fieldset>
        <fieldset className="availability-fields"><legend>Replacement value range <span className="optional">(optional)</span></legend><p>Helps owners judge what fits. Leave both empty if unsure.</p><div className="availability-row">
          <label>Lowest value ($)<input name="value_min" type="number" step="0.01" min="0" max="1000000" defaultValue={initial?.value_min ?? ''}/></label>
          <label>Highest value ($)<input name="value_max" type="number" step="0.01" min="0" max="1000000" defaultValue={initial?.value_max ?? ''}/></label>
        </div></fieldset>
        {!need && <p className="field-help">You can add an optional image after posting.</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary-button">{busy ? 'Saving…' : need ? 'Save changes' : 'Post item need'}</button><button type="button" className="text-button" onClick={onCancel}>Cancel</button>
      </fieldset>
    </form>
  </section>;
}

function BorrowFromResponse({ need, listing, onSent }: { need: ItemNeed; listing: Listing; onSent: () => void }) {
  const [startsOn, setStartsOn] = useState(need.starts_on);
  const [endsOn, setEndsOn] = useState(need.ends_on);
  const memory = useRef<{ payload: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BorrowProblem | null>(null);
  const [sent, setSent] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setProblem(null); setSent('');
    try {
      const request = await submitBorrowRequest(listing.id, startsOn, endsOn, intentFor(memory, { listing: listing.id, startsOn, endsOn }));
      setSent(`Borrow Request sent for ${dates(request.starts_on, request.ends_on)}. The owner decides whether to lend.`); onSent();
    } catch (cause) { setProblem(borrowProblem(cause)); } finally { setBusy(false); }
  }
  const days = startsOn && endsOn && startsOn <= endsOn ? inclusiveDays(startsOn, endsOn) : 0;
  return <form className="borrow-form" aria-label={`Borrow Request for ${listing.title}`} onSubmit={event => void submit(event)}>
    <h4>Send a Borrow Request</h4>
    <p className="borrow-note">This is a separate application to the owner. Dates must fit one availability range: {listing.listing_availability.map(range => dates(range.starts_on, range.ends_on)).join('; ')}.</p>
    <div className="borrow-dates">
      <label>First day<input type="date" required value={startsOn} onChange={event => setStartsOn(event.target.value)}/></label>
      <label>Last day<input type="date" required min={startsOn || undefined} value={endsOn} onChange={event => setEndsOn(event.target.value)}/></label>
    </div>
    {days > 0 && <p className="borrow-note" aria-live="polite">{days} {days === 1 ? 'day' : 'days'}, both included.</p>}
    <button type="submit" className="primary-button" disabled={busy}>Send Borrow Request</button>
    {problem && <p role="alert" className="error">{problem.message}</p>}
    {sent && <p role="status" className="borrow-sent">{sent}</p>}
  </form>;
}

function ResponseCard({ userId, need, response, listing, responder, requests, onChanged }: { userId: string; need: ItemNeed; response: NeedResponse; listing?: Listing; responder: string; requests: z.infer<typeof ownRequestSchema>[]; onChanged: () => void }) {
  const [error, setError] = useState('');
  const memory = useRef<{ payload: string; id: string } | null>(null);
  const mine = response.responder_id === userId;
  async function withdraw() {
    setError('');
    const result = await supabase.rpc('withdraw_item_need_response', { p_intent_id: intentFor(memory, response.id), p_response_id: response.id });
    if (result.error) setError(errorMessage(result.error)); else onChanged();
  }
  if (!listing) return mine ? <article className="borrow-request" aria-label="Your withdrawn response"><p>{response.status === 'withdrawn' ? 'You withdrew this response.' : 'The linked Listing is no longer available.'}</p></article> : null;
  const sentRequests = requests.filter(request => request.listing_id === listing.id);
  return <article className="borrow-request" aria-label={`Response: ${listing.title}`}>
    <div className="borrow-request-head"><span className="borrow-status">{response.status === 'offered' ? 'Offered' : 'Withdrawn'}</span><a href={`/communities/${need.community_id}/listings/${listing.id}`}>{listing.title}</a></div>
    <h3>{mine ? 'You offered your Listing' : `${responder} offered a Listing`}</h3>
    {response.note && <p>{response.note}</p>}
    <p className="borrow-note">Estimated replacement value {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(listing.replacement_value)} · minimum local score {listing.minimum_score}</p>
    {sentRequests.map(request => <p key={request.id} className="borrow-note">Your Borrow Request for {dates(request.starts_on, request.ends_on)}: {borrowStatusLabels[request.status]}.</p>)}
    {response.status === 'offered' && need.author_id === userId && <BorrowFromResponse need={need} listing={listing} onSent={onChanged}/>}
    {response.status === 'offered' && mine && <button type="button" onClick={() => void withdraw()}>Withdraw response</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </article>;
}

function RespondForm({ userId, need, own, onChanged }: { userId: string; need: ItemNeed; own: Listing[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [choice, setSelected] = useState('');
  const selected = own.some(listing => listing.id === choice) ? choice : own[0]?.id ?? '';
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const memory = useRef<{ payload: string; id: string } | null>(null);
  async function respond(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const payload = { need: need.id, listing: selected, note };
      const result = await supabase.rpc('respond_to_item_need', { p_intent_id: intentFor(memory, payload), p_need_id: need.id, p_listing_id: selected, p_note: note });
      if (result.error) throw result.error;
      setNote(''); onChanged();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  if (creating) return <ListingForm userId={userId} communityId={need.community_id} onCancel={() => setCreating(false)} onSaved={id => { setSelected(id); setCreating(false); onChanged(); }}/>;
  return <form className="borrow-form" aria-label="Answer with a Listing" onSubmit={event => void respond(event)}>
    <h3>Answer with a Listing</h3>
    <p className="borrow-note">Offering a Listing reserves nothing. The author still sends you a Borrow Request, and you choose whether to lend.</p>
    {own.length ? <label>Your Listing<select value={selected} onChange={event => setSelected(event.target.value)}>{own.map(listing => <option key={listing.id} value={listing.id}>{listing.title}</option>)}</select></label> : <p>You have no published Listings in this Community yet.</p>}
    <label>Note to the author <span className="optional">(optional)</span><textarea value={note} maxLength={1000} onChange={event => setNote(event.target.value)}/></label>
    {own.length > 0 && <button type="submit" className="primary-button" disabled={busy || !selected}>{busy ? 'Offering…' : 'Offer this Listing'}</button>}
    <button type="button" onClick={() => setCreating(true)}>Share a new item for this need</button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}

export function ItemNeedsPage({ userId, communityId, needId }: { userId: string; communityId: string; needId?: string }) {
  const [state, reload] = useBorrowingRead(userId, `item-needs-${communityId}-${needId ?? 'all'}`, () => readNeeds(userId, communityId, needId));
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [urgency, setUrgency] = useState('');
  const [neededOn, setNeededOn] = useState('');
  const [error, setError] = useState('');
  const withdrawMemory = useRef<{ payload: string; id: string } | null>(null);
  if (state.status === 'loading') return <p role="status" className="loading">Opening Community requests…</p>;
  if (state.status === 'denied') return <section className="account-card"><h2>Community requests unavailable.</h2><p role="alert">This private Community is only available to its active members.</p><a href="/">Back to your Communities</a></section>;
  const { name, directory, needs, images, responses, listings, requests } = state.data;
  const people = new Map(directory.map(entry => [entry.user_id, entry.email]));
  const administrator = directory.find(entry => entry.user_id === userId)?.role === 'administrator';
  const need = needId ? needs.find(value => value.id === needId) : undefined;
  if (editing) return <NeedForm userId={userId} communityId={communityId} need={need} onCancel={() => setEditing(false)} onSaved={id => location.assign(needPath(communityId, id))}/>;
  if (needId && !need) return <section className="account-card"><h2>Need Post unavailable.</h2><a href={needPath(communityId)}>Back to Community requests</a></section>;
  if (need) {
    const author = need.author_id === userId;
    const canEdit = need.status === 'open' && (author || administrator);
    const visible = responses.filter(response => listings.has(response.listing_id) || response.responder_id === userId);
    const own = [...listings.values()].filter(listing => listing.owner_id === userId && !responses.some(response => response.listing_id === listing.id && response.status === 'offered'));
    async function withdraw() {
      setError('');
      const result = await supabase.rpc('withdraw_item_need', { p_intent_id: intentFor(withdrawMemory, need!.version), p_need_id: need!.id, p_expected_version: need!.version });
      if (result.error) setError(errorMessage(result.error)); else reload();
    }
    return <section className="listings-layout"><a href={needPath(communityId)}>Back to Community requests in {name}</a><article className="listing-detail">
      <span className="eyebrow">{need.category} · Item need · {need.status === 'open' ? urgencies[need.urgency] : 'Withdrawn'}</span><h1>{need.title}</h1><p>{need.description}</p>
      <dl><dt>Requested dates</dt><dd>{dates(need.starts_on, need.ends_on)} ({inclusiveDays(need.starts_on, need.ends_on)} days, both included)</dd><dt>Urgency</dt><dd>{urgencies[need.urgency]}</dd><dt>Replacement value range</dt><dd>{valueRange(need)}</dd><dt>Posted by</dt><dd>{author ? 'You' : people.get(need.author_id) ?? 'A former member'}</dd></dl>
      <NeedImage needId={need.id} images={images} canEdit={canEdit} onChanged={reload}/>
      {need.status === 'withdrawn' && <p role="status">This Need Post was withdrawn. Its history is retained.</p>}
      {canEdit && <div className="listing-actions"><button type="button" onClick={() => setEditing(true)}>Edit item need</button><button type="button" onClick={() => void withdraw()}>Withdraw item need</button></div>}
      {error && <p role="alert" className="error">{error}</p>}
    </article>
    <section className="borrowing-panel" aria-label="Responses"><h2>Responses</h2>
      <p className="borrow-note">{author ? 'Open a response to send that owner a Borrow Request. Responses alone reserve nothing.' : 'Members answer by linking a Listing. The author then sends an ordinary Borrow Request.'}</p>
      {visible.length === 0 && <p>No Listings offered yet.</p>}
      {visible.map(response => <ResponseCard key={`${response.id}-${response.status}`} userId={userId} need={need} response={response} listing={listings.get(response.listing_id)} responder={people.get(response.responder_id) ?? 'A member'} requests={requests} onChanged={reload}/>)}
      {need.status === 'open' && !author && <RespondForm userId={userId} need={need} own={own} onChanged={reload}/>}
    </section></section>;
  }
  const filtered = needs.filter(value => value.status === 'open' && (!search || `${value.title} ${value.description}`.toLowerCase().includes(search.toLowerCase()))
    && (!category || value.category === category) && (!urgency || value.urgency === urgency) && (!neededOn || (value.starts_on <= neededOn && value.ends_on >= neededOn)));
  return <section className="listings-layout"><a href={`/communities/${communityId}`}>{name} home</a><span className="eyebrow">YOUR COMMUNITY · WAYS TO CONTRIBUTE</span><h1>Community requests</h1><p>Items your neighbors are looking for. Answer with something you can lend.</p>
    <button type="button" className="primary-button" onClick={() => setEditing(true)}>Ask for an item</button>
    <form className="listing-filters" aria-label="Need Post filters" onSubmit={event => event.preventDefault()}>
      <label>Search item needs<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <label>Filter category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Filter urgency<select value={urgency} onChange={event => setUrgency(event.target.value)}><option value="">Any urgency</option>{Object.entries(urgencies).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Needed on<input type="date" value={neededOn} onChange={event => setNeededOn(event.target.value)}/></label>
    </form>
    <p role="status">{filtered.length} open item {filtered.length === 1 ? 'need' : 'needs'}</p>
    <div className="listing-grid">{filtered.map(value => <article className="listing-card" key={value.id} aria-label={value.title}><span className="eyebrow">{value.category} · {urgencies[value.urgency]}</span><h2><a href={needPath(communityId, value.id)}>{value.title}</a></h2><p>{value.description}</p><p>{dates(value.starts_on, value.ends_on)}</p><p>Asked by {value.author_id === userId ? 'you' : people.get(value.author_id) ?? 'a member'}</p></article>)}</div>
  </section>;
}

export function ItemNeedsFeed({ userId, communityId }: { userId: string; communityId: string }) {
  const state = useListingAccess(userId, `item-needs-feed-${communityId}`, async () => {
    const result = await supabase.from('item_need_posts').select('*').eq('community_id', communityId).eq('status', 'open').order('created_at', { ascending: false }).limit(5);
    if (result.error) throw result.error;
    return itemNeedSchema.array().parse(result.data);
  });
  if (state.status !== 'ready') return null;
  return <section className="listings-layout item-needs-feed" aria-label="Community requests feed"><span className="eyebrow">COMMUNITY FEED</span><h2>Members are looking for</h2>
    {state.data.length ? <ul>{state.data.map(need => <li key={need.id}><a href={needPath(communityId, need.id)}>{need.title}</a> · {urgencies[need.urgency]} · {dates(need.starts_on, need.ends_on)}</li>)}</ul> : <p>No open item needs right now.</p>}
    <a href={needPath(communityId)}>See all Community requests</a></section>;
}

export function NeedsLink() {
  const current = /^\/communities\/([0-9a-f-]{36})/i.exec(location.pathname)?.[1];
  return <a className="text-button" href={current ? needPath(current) : '/needs'}>Community requests</a>;
}

export function NeedsRedirect({ userId }: { userId: string }) {
  const state = useAccessScopedRead(userId, 'needs-navigation', async () => {
    const result = await supabase.from('communities').select('id').order('created_at').limit(1);
    if (result.error) throw result.error;
    return z.array(z.object({ id: z.uuid() })).parse(result.data)[0]?.id ?? null;
  });
  useEffect(() => { if (state.status === 'ready' && state.data) location.replace(needPath(state.data)); }, [state]);
  if (state.status === 'ready' && !state.data) return <section className="account-card"><h2>No Community yet.</h2><p>Join or create a Community to ask for items.</p><a href="/">Back home</a></section>;
  return <p role="status" className="loading">Opening Community requests…</p>;
}
