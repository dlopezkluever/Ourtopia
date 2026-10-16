import { useEffect, useState } from 'react';
import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { useListingAccess } from './useListingAccess';
import { readDirectory } from '../profiles/model';
import { categories, errorMessage, imageSchema, listingSchema, localDate } from './model';
import { ListingForm } from './ListingForm';
import { ListingImages } from './ListingImages';

export function ListingsPage({ userId, communityId, listingId }: { userId: string; communityId: string; listingId?: string }) {
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [member, setMember] = useState('');
  const [from, setFrom] = useState('');
  const [through, setThrough] = useState('');
  const [eligible, setEligible] = useState(false);
  const [error, setError] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const state = useListingAccess(userId, `listings-${communityId}-${listingId ?? 'feed'}-${revision}`, async () => {
    const community = await supabase.from('communities').select('name').eq('id', communityId).single();
    if (community.error) throw community.error;
    const [result, directory, imageResult] = await Promise.all([
      supabase.from('listings').select('*,listing_availability(starts_on,ends_on)').eq('community_id', communityId).order('created_at', { ascending: false }),
      readDirectory(communityId),
      listingId ? supabase.from('listing_images').select('*').eq('listing_id', listingId) : Promise.resolve({ data: [], error: null }),
    ]);
    if (result.error) throw result.error;
    if (imageResult.error) throw imageResult.error;
    return { name: community.data.name, listings: listingSchema.array().parse(result.data), directory, images: imageSchema.array().parse(imageResult.data) };
  });
  if (state.status === 'loading') return <p role="status" className="loading">Opening Listings...</p>;
  if (state.status === 'denied') return <section className="account-card"><h2>Listings unavailable.</h2><p role="alert">This private Community is only available to its active members.</p><a href="/">Back to your Communities</a></section>;
  const { listings, directory, images, name } = state.data;
  const own = directory.find(value => value.user_id === userId);
  const listing = listingId ? listings.find(value => value.id === listingId) : undefined;
  const base = `/communities/${communityId}/listings`;
  const canEdit = listing && (listing.owner_id === userId || own?.role === 'administrator') && listing.status === 'published';
  async function withdraw() {
    if (!listing) return;
    setError('');
    const result = await supabase.rpc('withdraw_listing', { p_intent_id: crypto.randomUUID(), p_listing_id: listing.id, p_expected_version: listing.version });
    if (result.error) setError(errorMessage(result.error)); else setRevision(value => value + 1);
  }
  if (editing) return <ListingForm userId={userId} communityId={communityId} listing={listing} onCancel={() => setEditing(false)} onSaved={id => { location.assign(`${base}/${id}`); }}/>;
  if (listingId && !listing) return <section className="account-card"><h2>Listing unavailable.</h2><a href={base}>Back to Listings</a></section>;
  if (listing) return <section className="listings-layout"><a href={base}>Back to Listings in {name}</a><article className="listing-detail">
    <span className="eyebrow">{listing.category} · Item · {listing.status}</span><h1>{listing.title}</h1><p>{listing.description}</p>
    <a href={`/communities/${communityId}/members/${listing.owner_id}`}>View owner profile</a>
    <dl><dt>Condition</dt><dd>{listing.condition}</dd><dt>Estimated replacement value</dt><dd>{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(listing.replacement_value)}</dd><dt>Pickup notes</dt><dd>{listing.pickup_notes || 'Arrange with the owner.'}</dd><dt>Lending conditions</dt><dd>{listing.lending_conditions || 'Discuss with the owner.'}</dd><dt>Minimum Community Solidarity Score</dt><dd>{listing.minimum_score}</dd></dl>
    <section aria-label="Availability"><h3>Availability</h3><ul>{listing.listing_availability.map((range, index) => <li key={index}>{localDate(range.starts_on)} through {localDate(range.ends_on)}</li>)}</ul><p>Inclusive calendar dates. No recurrence.</p></section>
    {listing.gratitude && <aside className="gratitude"><h3>Optional gratitude</h3><p>{listing.gratitude}</p><p>Borrowing is free. No payment, priority benefit, or guaranteed approval.</p></aside>}
    <ListingImages listingId={listing.id} images={images} canEdit={!!canEdit} onChanged={() => setRevision(value => value + 1)}/>
    {listing.status === 'withdrawn' ? <p role="status">This Listing has been withdrawn. Its history is retained.</p> : <><button type="button" onClick={() => setRequestOpen(true)}>Borrow Request</button>{requestOpen && <section aria-label="Borrow Request"><h3>Borrow Request</h3><p>No request has been sent. Choose your first and last day in the Borrow Request form below.</p>{(own?.score ?? 0) < listing.minimum_score && <p>Your Community Solidarity Score is below this Listing's minimum.</p>}</section>}</>}
    {canEdit && <div className="listing-actions"><button onClick={() => setEditing(true)}>Edit Listing</button><button onClick={() => void withdraw()}>Withdraw Listing</button></div>}{error && <p role="alert">{error}</p>}
  </article></section>;
  const filtered = listings.filter(value => value.status === 'published' && (!search || `${value.title} ${value.description}`.toLowerCase().includes(search.toLowerCase())) && (!category || value.category === category) && (!type || value.type === type) && (!member || value.owner_id === member) && (!eligible || value.minimum_score <= (own?.score ?? 0)) && ((!from && !through) || value.listing_availability.some(range => (!from || range.starts_on <= from && range.ends_on >= from) && (!through || range.ends_on >= through && range.starts_on <= through))));
  return <section className="listings-layout"><a href={`/communities/${communityId}`}>{name} home</a><span className="eyebrow">YOUR COMMUNITY · SHARED POSSIBILITIES</span><h1>Community Listings</h1><p>Find something useful. Share something you love.</p><button type="button" className="primary-button" onClick={() => setEditing(true)}>Share an item</button>
    <form className="listing-filters" onSubmit={event => event.preventDefault()} aria-label="Listing filters">
      <label>Search Listings<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <label>Filter category<select aria-label="Filter category" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Listing type<select aria-label="Listing type" value={type} onChange={event => setType(event.target.value)}><option value="">All types</option><option value="item">Item</option></select></label>
      <label>Member<select aria-label="Member" value={member} onChange={event => setMember(event.target.value)}><option value="">All members</option>{directory.map(value => <option key={value.user_id} value={value.user_id}>{value.email}</option>)}</select></label>
      <label>Needed from<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label><label>Needed through<input type="date" value={through} onChange={event => setThrough(event.target.value)}/></label>
      <label className="checkbox-label"><input type="checkbox" checked={eligible} onChange={event => setEligible(event.target.checked)}/>Only Listings I meet the minimum score for</label>
    </form><p role="status">{filtered.length} {filtered.length === 1 ? 'Listing' : 'Listings'}</p><div className="listing-grid">{filtered.map(value => <article className="listing-card" key={value.id}><span className="eyebrow">{value.category} · Item</span><h2><a href={`${base}/${value.id}`}>{value.title}</a></h2><p>{value.description}</p><p>Minimum local score {value.minimum_score}</p><p>{value.listing_availability.map(range => `${localDate(range.starts_on)} through ${localDate(range.ends_on)}`).join(', ')}</p></article>)}</div>
  </section>;
}

export function ListingsLink() {
  const current = /^\/communities\/([0-9a-f-]{36})/i.exec(location.pathname)?.[1];
  return <a className="text-button" href={current ? `/communities/${current}/listings` : '/listings'}>Community Listings</a>;
}

export function ListingsRedirect({ userId }: { userId: string }) {
  const state = useAccessScopedRead(userId, 'listings-navigation', async () => {
    const result = await supabase.from('communities').select('id').order('created_at').limit(1);
    if (result.error) throw result.error;
    return z.array(z.object({ id: z.uuid() })).parse(result.data)[0]?.id ?? null;
  });
  useEffect(() => { if (state.status === 'ready' && state.data) location.replace(`/communities/${state.data}/listings`); }, [state]);
  if (state.status === 'ready' && !state.data) return <section className="account-card"><h2>No Community yet.</h2><p>Join or create a Community to share and find items.</p><a href="/">Back home</a></section>;
  return <p role="status" className="loading">Opening Listings...</p>;
}

export function OwnerListings({ userId, communityId, subjectId }: { userId: string; communityId: string; subjectId: string }) {
  const state = useAccessScopedRead(userId, `owner-listings-${communityId}-${subjectId}`, async () => {
    const profile = await supabase.rpc('member_profile', { p_community_id: communityId, p_subject: subjectId });
    if (profile.error) throw profile.error;
    const result = await supabase.from('listings').select('*,listing_availability(starts_on,ends_on)').eq('community_id', communityId).eq('owner_id', subjectId).eq('status', 'published');
    if (result.error) throw result.error;
    return listingSchema.array().parse(result.data);
  });
  if (state.status !== 'ready') return null;
  return <section className="listings-layout" aria-label="Member Listings"><h2>Items shared with this Community</h2>{state.data.length ? <ul>{state.data.map(listing => <li key={listing.id}><a href={`/communities/${communityId}/listings/${listing.id}`}>{listing.title}</a></li>)}</ul> : <p>No published items yet.</p>}</section>;
}
