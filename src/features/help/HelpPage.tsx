import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowLeft, CalendarClock, HandHeart, LockKeyhole, MapPin, Plus, Search, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { helpExchangeStateLabels } from '../exchanges/model';
import { ScoreCard } from '../reputation/Standing';
import { localExplanation } from '../reputation/model';
import { ThankExchange } from '../thank-yous/ThankExchange';
import {
  commitResultSchema, errorMessage, helpCategories, helpCompletionSchema, helpExchangeSchema, helpPostDetailSchema, helpPostSchema, helpRoute, intentFor,
  listingFields, localInput, needPostFields, postKindLabels, postPath, scheduleFields, skillLevels, when,
  type HelpExchange, type HelpPost, type HelpPostDetail, type PostKind,
} from './model';

type Community = { id: string; name: string };

export function HelpPage({ user }: { user: User }) {
  const [path, setPath] = useState(location.pathname);
  const route = helpRoute(path) ?? {};
  const [communities, setCommunities] = useState<Community[] | null>(null);
  const [mine, setMine] = useState<HelpExchange[]>([]);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [epoch, setEpoch] = useState(0);

  function go(next: string) { history.pushState({}, '', next); setPath(next); }

  useEffect(() => {
    let active = true;
    void Promise.all([supabase.from('communities').select('id,name').order('name'), supabase.rpc('my_help_exchanges')]).then(([communityResult, mineResult]) => {
      if (!active) return;
      setError(communityResult.error?.message ?? mineResult.error?.message ?? '');
      setCommunities(communityResult.data ?? []);
      setMine(helpExchangeSchema.array().parse(mineResult.data ?? []));
    });
    return () => { active = false; };
  }, [version, epoch]);

  useEffect(() => {
    let active = true;
    const revalidate = () => setVersion(value => value + 1);
    // Access changes drop every cached help record before the fresh authorized read.
    const clear = () => { setCommunities(null); setMine([]); setEpoch(value => value + 1); };
    const channel = supabase.channel(`help-${user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${user.id}` }, clear)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${user.id}` }, revalidate);
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (!data.session) { clear(); return; }
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => {
        if (!active) return;
        if (status === 'SUBSCRIBED') revalidate();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') clear();
      });
    });
    const popstate = () => setPath(location.pathname);
    const visibility = () => { if (document.visibilityState === 'visible') revalidate(); };
    window.addEventListener('popstate', popstate);
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false; void supabase.removeChannel(channel);
      window.removeEventListener('popstate', popstate); window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visibility);
    };
  }, [user.id]);

  if (communities === null) return <p role="status" className="loading">Opening help…</p>;
  const communityId = route.communityId ?? communities[0]?.id;
  const community = communities.find(row => row.id === communityId);
  const changed = () => setVersion(value => value + 1);

  return <section className="help-layout">
    <aside className="help-side" aria-labelledby="help-title">
      <span className="eyebrow">OFFER OR ASK FOR HELP</span>
      <h1 id="help-title">Help</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {communities.length > 0 && <><label htmlFor="help-community">Community</label>
        <select id="help-community" value={community?.id ?? ''} onChange={event => go(`/help/${event.target.value}`)}>
          {!community && <option value="">Choose a Community</option>}
          {communities.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></>}
      <h2 className="help-side-title">Your help Exchanges</h2>
      {mine.length === 0 ? <p className="muted">No help Exchanges yet. Accepted offers appear here.</p>
        : <ul className="help-mine" aria-label="Your help Exchanges">{mine.map(exchange => <li key={exchange.id}>
          <a href={postPath(exchange.communityId, exchange.sourceKind, exchange.sourceId)} onClick={event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); go(postPath(exchange.communityId, exchange.sourceKind, exchange.sourceId));
          }}><strong>{exchange.sourceTitle}</strong><small>{exchange.helperId === user.id ? `You help ${exchange.requesterEmail}` : `${exchange.helperEmail} helps you`} · {helpExchangeStateLabels[exchange.state]}</small></a>
        </li>)}</ul>}
    </aside>
    <div className="help-main">
      {route.post && route.communityId ? <HelpPostPage key={`${route.post.id}-${epoch}`} userId={user.id} communityId={route.communityId} kind={route.post.kind} postId={route.post.id} version={version} go={go} onChanged={changed}/>
        : !communityId ? <div className="account-card"><Users/><h2>Join a Community first.</h2><p className="muted">Help offers and needs are shared inside a private Community.</p></div>
        : !community ? <div className="account-card"><LockKeyhole/><h2>Help board unavailable.</h2><p className="muted">Only active members of this Community can browse its help.</p></div>
        : <HelpBoard key={`${community.id}-${epoch}`} community={community} version={version} go={go}/>}
    </div>
  </section>;
}

function HelpBoard({ community, version, go }: { community: Community; version: number; go: (path: string) => void }) {
  const [filters, setFilters] = useState({ search: '', kind: '', category: '' });
  const [search, setSearch] = useState('');
  const [posts, setPosts] = useState<HelpPost[] | null>(null);
  const [creating, setCreating] = useState<PostKind | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void supabase.rpc('help_board', { p_community_id: community.id, p_search: filters.search, p_post_kind: filters.kind, p_category: filters.category }).then(({ data, error }) => {
      if (!active) return;
      setError(error?.message ?? '');
      setPosts(error ? [] : helpPostSchema.array().parse(data ?? []));
    });
    return () => { active = false; };
  }, [community.id, filters, version]);

  return <section className="help-board" aria-labelledby="board-title">
    <span className="eyebrow">{community.name.toUpperCase()}</span>
    <h2 id="board-title">Help board</h2>
    <p className="muted">Offer a skill or ask for a hand. Every accepted helper gets a separate help Exchange.</p>
    <div className="help-actions">
      <Button className="primary-button" type="button" aria-expanded={creating === 'listing'} onClick={() => setCreating(creating === 'listing' ? null : 'listing')}><HandHeart size={16}/> Offer help</Button>
      <Button className="primary-button" type="button" aria-expanded={creating === 'need_post'} onClick={() => setCreating(creating === 'need_post' ? null : 'need_post')}><Plus size={16}/> Ask for help</Button>
    </div>
    {creating && <PostForm key={creating} kind={creating} communityId={community.id} onSaved={post => go(postPath(community.id, post.postKind, post.id))} onCancel={() => setCreating(null)}/>}
    <form className="help-filters" role="search" onSubmit={event => { event.preventDefault(); setFilters({ ...filters, search }); }}>
      <div><label htmlFor="help-search">Search help</label><input id="help-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Moving, tutoring, a place…"/></div>
      <div><label htmlFor="help-kind">Show</label><select id="help-kind" value={filters.kind} onChange={event => setFilters({ ...filters, search, kind: event.target.value })}>
        <option value="">Offers and needs</option><option value="listing">Help offers</option><option value="need_post">Help needs</option>
      </select></div>
      <div><label htmlFor="help-category">Category</label><select id="help-category" value={filters.category} onChange={event => setFilters({ ...filters, search, category: event.target.value })}>
        <option value="">All categories</option>{Object.entries(helpCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></div>
      <Button className="secondary-button" type="submit"><Search size={15}/> Search</Button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {posts === null ? <p role="status" className="loading">Loading help…</p> : posts.length === 0 ? <p className="muted help-empty">No open help matches yet.</p>
      : <ul className="help-list" aria-label="Help posts">{posts.map(post => <li key={post.id}><article className="help-card" aria-label={post.title}>
        <span className={`help-kind help-kind-${post.postKind}`}>{postKindLabels[post.postKind]} · {helpCategories[post.category]}</span>
        <h3><a href={postPath(community.id, post.postKind, post.id)} onClick={event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); go(postPath(community.id, post.postKind, post.id));
        }}>{post.title}</a></h3>
        {post.postKind === 'listing' ? <p className="help-meta">{post.skill} · {skillLevels[post.skillLevel]} · {post.geographicConstraints}</p>
          : <p className="help-meta">{when(post.startsAt)} · {post.durationMinutes} min · {post.location} · <strong>{post.openPlaces} of {post.helpersNeeded} places open</strong></p>}
        <p className="help-by">By {post.ownerEmail}</p>
      </article></li>)}</ul>}
  </section>;
}

function PostForm({ kind, communityId, post, onSaved, onCancel }: { kind: PostKind; communityId: string; post?: HelpPost; onSaved: (post: HelpPost) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const memory = useRef<{ payload: string; id: string } | null>(null);
  const listing = post?.postKind === 'listing' ? post : undefined;
  const need = post?.postKind === 'need_post' ? post : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const parsed = kind === 'listing' ? listingFields.safeParse(values) : needPostFields.safeParse(values);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
    const payload = post ? { post: post.id, fields: parsed.data } : { communityId, kind, fields: parsed.data };
    const intent = intentFor(memory, payload);
    setBusy(true);
    try {
      const { data, error } = post
        ? await supabase.rpc('edit_help_post', { p_intent_id: intent, p_post_kind: kind, p_post_id: post.id, p_fields: parsed.data })
        : await supabase.rpc('create_help_post', { p_intent_id: intent, p_community_id: communityId, p_post_kind: kind, p_fields: parsed.data });
      if (error) throw error;
      memory.current = null;
      onSaved(helpPostSchema.parse(data));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  const prefix = post ? `edit-${post.id}` : `new-${kind}`;
  const field = (name: string) => `${prefix}-${name}`;
  return <form className="help-form account-card" onSubmit={submit} aria-labelledby={field('title-heading')}>
    <h3 id={field('title-heading')}>{post ? 'Edit this post' : kind === 'listing' ? 'Offer help' : 'Ask for help'}</h3>
    <label htmlFor={field('title')}>Title</label><input id={field('title')} name="title" defaultValue={post?.title} required minLength={3} maxLength={120} disabled={busy}/>
    <label htmlFor={field('description')}>Description <span className="optional">(optional)</span></label><textarea id={field('description')} name="description" defaultValue={post?.description} maxLength={2000} rows={3} disabled={busy}/>
    <label htmlFor={field('category')}>Category</label><select id={field('category')} name="category" defaultValue={post?.category ?? 'other'} disabled={busy}>
      {Object.entries(helpCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    {kind === 'listing' ? <>
      <label htmlFor={field('skill')}>Skill</label><input id={field('skill')} name="skill" defaultValue={listing?.skill} required minLength={2} maxLength={120} disabled={busy}/>
      <label htmlFor={field('skill_level')}>Skill level</label><select id={field('skill_level')} name="skill_level" defaultValue={listing?.skillLevel ?? 'intermediate'} disabled={busy}>
        {Object.entries(skillLevels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor={field('availability')}>Availability</label><input id={field('availability')} name="availability" defaultValue={listing?.availability} placeholder="Weekday evenings" required minLength={2} maxLength={500} disabled={busy}/>
      <label htmlFor={field('geographic_constraints')}>Area you can help in</label><input id={field('geographic_constraints')} name="geographic_constraints" defaultValue={listing?.geographicConstraints} placeholder="Within 2 miles of Maple Street" required minLength={2} maxLength={500} disabled={busy}/>
      <label htmlFor={field('scheduling_preferences')}>Scheduling preferences <span className="optional">(optional)</span></label><input id={field('scheduling_preferences')} name="scheduling_preferences" defaultValue={listing?.schedulingPreferences} maxLength={500} disabled={busy}/>
    </> : <>
      <label htmlFor={field('starts_at')}>Date and time</label><input id={field('starts_at')} name="starts_at" type="datetime-local" defaultValue={need ? localInput(need.startsAt) : undefined} required disabled={busy}/>
      <label htmlFor={field('duration_minutes')}>Duration (minutes)</label><input id={field('duration_minutes')} name="duration_minutes" type="number" min={15} max={1440} step={15} defaultValue={need?.durationMinutes ?? 120} required disabled={busy}/>
      <label htmlFor={field('location')}>Location</label><input id={field('location')} name="location" defaultValue={need?.location} required minLength={2} maxLength={300} disabled={busy}/>
      <label htmlFor={field('helpers_needed')}>Helpers needed</label><input id={field('helpers_needed')} name="helpers_needed" type="number" min={1} max={20} defaultValue={need?.helpersNeeded ?? 1} required disabled={busy}/>
    </>}
    <p className="field-help">Help needs no item condition, replacement value, or photos.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="help-form-actions">
      <Button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : post ? 'Save changes' : kind === 'listing' ? 'Publish help offer' : 'Publish Need Post'}</Button>
      <button type="button" className="text-button" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function HelpPostPage({ userId, communityId, kind, postId, version, go, onChanged }: { userId: string; communityId: string; kind: PostKind; postId: string; version: number; go: (path: string) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<HelpPostDetail | null>(null);
  const [denied, setDenied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const memory = useRef<{ payload: string; id: string } | null>(null);

  useEffect(() => {
    let active = true;
    void supabase.rpc('help_post', { p_post_kind: kind, p_post_id: postId }).then(({ data, error }) => {
      if (!active) return;
      if (error) { setDetail(null); setDenied(true); return; }
      setDenied(false); setDetail(helpPostDetailSchema.parse(data));
    });
    return () => { active = false; };
  }, [kind, postId, version, refresh]);

  const changed = () => { setRefresh(value => value + 1); onChanged(); };
  async function run(command: () => PromiseLike<{ error: { message: string } | null }>) {
    setError('');
    try {
      const { error } = await command();
      if (error) throw error;
      memory.current = null; changed();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const back = <button type="button" className="text-button help-back" onClick={() => go(`/help/${communityId}`)}><ArrowLeft size={15}/> Back to help board</button>;
  if (denied) return <div>{back}<div className="account-card"><LockKeyhole/><h2>Help post unavailable.</h2><p className="muted">Only active members of its Community, and participants in its help Exchanges, can open this post.</p></div></div>;
  if (!detail) return <p role="status" className="loading">Opening this post…</p>;
  const { post, viewerIsOwner, viewerActive, commitments, exchanges } = detail;
  const pending = commitments.filter(row => row.status === 'pending');
  const ownPending = commitments.find(row => row.memberId === userId && row.status === 'pending');
  const holdsPlace = exchanges.some(row => row.helperId === userId && row.placeStatus === 'active');
  const canCommit = viewerActive && !viewerIsOwner && post.status === 'open' && !ownPending && !holdsPlace && (post.postKind === 'listing' || post.openPlaces > 0);

  return <article className="help-post" aria-labelledby="post-title">
    {back}
    <span className={`help-kind help-kind-${post.postKind}`}>{postKindLabels[post.postKind]} · {helpCategories[post.category]}{post.status === 'withdrawn' ? ' · Withdrawn' : ''}</span>
    <h2 id="post-title">{post.title}</h2>
    {!viewerActive && <p className="notice" role="note">Your Community access ended. You can view and cancel your existing help obligation.</p>}
    <p className="help-by">{viewerIsOwner ? 'You posted this' : `Posted by ${post.ownerEmail}`}</p>
    {post.description && <p className="help-description">{post.description}</p>}
    {post.postKind === 'listing' ? <dl className="help-facts">
      <dt>Skill</dt><dd>{post.skill} · {skillLevels[post.skillLevel]}</dd>
      <dt>Availability</dt><dd>{post.availability}</dd>
      <dt>Area</dt><dd>{post.geographicConstraints}</dd>
      {post.schedulingPreferences && <><dt>Scheduling</dt><dd>{post.schedulingPreferences}</dd></>}
      <dt>Helper</dt><dd>{viewerIsOwner ? 'You help each requester you accept, in a separate help Exchange.' : `${post.ownerEmail} is the helper; you would be the requester.`}</dd>
    </dl> : <>
      <dl className="help-facts">
        <dt>When</dt><dd><CalendarClock size={14}/> {when(post.startsAt)} · {post.durationMinutes} min</dd>
        <dt>Where</dt><dd><MapPin size={14}/> {post.location}</dd>
        <dt>Requester</dt><dd>{viewerIsOwner ? 'You accept each helper independently.' : post.ownerEmail}</dd>
      </dl>
      <p className="places-summary" role="status" aria-label="Remaining places"><strong>{post.openPlaces} of {post.helpersNeeded} places open</strong></p>
      {viewerIsOwner && <ol className="help-places" aria-label="Helper places">{Array.from({ length: post.helpersNeeded }, (_, index) => {
        const holder = exchanges.find(row => row.place === index + 1 && row.placeStatus === 'active');
        return <li key={index}>Place {index + 1} · {holder ? `${holder.helperEmail} · ${helpExchangeStateLabels[holder.state]}` : 'Open'}</li>;
      })}</ol>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {viewerIsOwner && post.status === 'open' && <div className="help-owner">
      {editing ? <PostForm kind={post.postKind} communityId={communityId} post={post} onSaved={() => { setEditing(false); changed(); }} onCancel={() => setEditing(false)}/>
        : <div className="help-form-actions"><button type="button" className="text-button" onClick={() => setEditing(true)}>Edit post</button>
          <button type="button" className="text-button" onClick={() => void run(() => supabase.rpc('withdraw_help_post', { p_intent_id: intentFor(memory, { withdraw: post.id }), p_post_kind: post.postKind, p_post_id: post.id }))}>Withdraw post</button></div>}
      <h3>Offers waiting for you</h3>
      {pending.length === 0 ? <p className="muted">No offers waiting.</p> : <ul className="help-offers" aria-label="Offers waiting">{pending.map(offer => <li key={offer.id}>
        <span><strong>{offer.memberEmail}</strong>{offer.note && <small>{offer.note}</small>}</span>
        <Button className="primary-button" type="button" aria-label={`Accept ${offer.memberEmail}`} onClick={() => void run(() => supabase.rpc('accept_help_commitment', { p_intent_id: intentFor(memory, { accept: offer.id }), p_commitment_id: offer.id }))}>Accept</Button>
      </li>)}</ul>}
    </div>}
    {ownPending && <p className="notice" role="note">Your offer is waiting for {post.ownerEmail} to accept.</p>}
    {canCommit && <CommitForm post={post} onCommitted={changed}/>}
    {post.postKind === 'need_post' && !viewerIsOwner && post.openPlaces === 0 && !holdsPlace && <p className="notice" role="note">Every place on this Need Post is filled.</p>}
    {exchanges.length > 0 && <section className="help-exchanges" aria-labelledby="exchanges-title">
      <h3 id="exchanges-title">{viewerIsOwner ? (post.postKind === 'need_post' ? 'Each helper' : 'Each requester') : 'Your help Exchange'}</h3>
      {exchanges.map(exchange => <ExchangeCard key={exchange.id} exchange={exchange} userId={userId} canSchedule={viewerActive} onChanged={changed}/>)}
    </section>}
  </article>;
}

function CommitForm({ post, onCommitted }: { post: HelpPost; onCommitted: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const memory = useRef<{ payload: string; id: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { data, error } = await supabase.rpc('commit_help', { p_intent_id: intentFor(memory, { post: post.id, note }), p_post_kind: post.postKind, p_post_id: post.id, p_note: note });
      if (error) throw error;
      commitResultSchema.parse(data);
      memory.current = null; setNote(''); onCommitted();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <form className="help-commit" onSubmit={submit}>
    <label htmlFor="commit-note">Note for {post.ownerEmail} <span className="optional">(optional)</span></label>
    <textarea id="commit-note" value={note} onChange={event => setNote(event.target.value)} maxLength={500} rows={2} disabled={busy}/>
    {error && <p role="alert" className="error">{error}</p>}
    <Button className="primary-button" type="submit" disabled={busy}>{busy ? 'Sending…' : post.postKind === 'listing' ? 'Request this help' : 'Offer to help'}</Button>
  </form>;
}

function ExchangeCard({ exchange, userId, canSchedule, onChanged }: { exchange: HelpExchange; userId: string; canSchedule: boolean; onChanged: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const memory = useRef<{ payload: string; id: string } | null>(null);
  const name = (id: string, email: string) => id === userId ? 'You' : email;
  const counterpart = exchange.helperId === userId ? exchange.requesterEmail : exchange.helperEmail;
  const open = exchange.state === 'committed' || exchange.state === 'scheduled';
  const id = (field: string) => `${exchange.id}-${field}`;

  async function send(command: 'schedule' | 'cancel' | 'confirm' | 'dispute', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError('');
    const values = event ? Object.fromEntries(new FormData(event.currentTarget)) : {};
    let call: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    if (command === 'schedule') {
      const parsed = scheduleFields.safeParse(values);
      if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
      call = () => supabase.rpc('schedule_help_exchange', { p_intent_id: intentFor(memory, { schedule: exchange.id, fields: parsed.data }), p_exchange_id: exchange.id, p_fields: parsed.data });
    } else if (command === 'cancel') {
      const reason = String(values.reason ?? '').trim();
      if (!reason) { setError('Give a reason for cancelling.'); return; }
      call = () => supabase.rpc('cancel_help_exchange', { p_intent_id: intentFor(memory, { cancel: exchange.id, reason }), p_exchange_id: exchange.id, p_reason: reason });
    } else {
      const disagreement = command === 'dispute' ? String(values.disagreement ?? '').trim() : '';
      if (command === 'dispute' && !disagreement) { setError('Describe what does not match.'); return; }
      const action = command === 'dispute' ? 'dispute' : 'confirm';
      call = () => supabase.rpc('command_help_completion', { p_intent_id: intentFor(memory, { completion: exchange.id, revision: exchange.completion?.revision ?? 0, action, disagreement }), p_exchange_id: exchange.id, p_expected_revision: exchange.completion?.revision ?? 0, p_action: action, p_disagreement: disagreement || undefined });
    }
    setBusy(true);
    try {
      const { data, error } = await call();
      if (error) throw error;
      if (command === 'confirm' || command === 'dispute') helpCompletionSchema.parse(data);
      else helpExchangeSchema.parse(data);
      memory.current = null; onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="help-exchange" aria-label={`Help Exchange with ${counterpart}`}>
    <div className="help-exchange-head">
      <strong>{name(exchange.helperId, exchange.helperEmail)} {exchange.helperId === userId ? 'help' : 'helps'} {name(exchange.requesterId, exchange.requesterEmail).replace(/^You$/, 'you')}</strong>
      <span className={`help-state help-state-${exchange.state}`}>{helpExchangeStateLabels[exchange.state]}</span>
    </div>
    <dl className="help-facts">
      <dt>Helper</dt><dd>{exchange.helperEmail}</dd>
      <dt>Requester</dt><dd>{exchange.requesterEmail}</dd>
      {exchange.place !== null && <><dt>Place</dt><dd>Place {exchange.place}{exchange.placeStatus === 'closed' ? ' · reopened' : ''}</dd></>}
      {exchange.startsAt && <><dt>Schedule</dt><dd>{when(exchange.startsAt)} · {exchange.durationMinutes} min · {exchange.meetingPoint}</dd></>}
      {exchange.cancelReason && <><dt>Cancellation</dt><dd>{exchange.cancelledBy === userId ? 'You' : exchange.cancelledBy === exchange.helperId ? exchange.helperEmail : exchange.requesterEmail} cancelled: {exchange.cancelReason}</dd></>}
    </dl>
    {error && <p role="alert" className="error">{error}</p>}
    {open && canSchedule && <form className="help-schedule" onSubmit={event => void send('schedule', event)}>
      <label htmlFor={id('starts')}>Start time</label><input id={id('starts')} name="starts_at" type="datetime-local" defaultValue={exchange.startsAt ? localInput(exchange.startsAt) : undefined} required disabled={busy}/>
      <label htmlFor={id('duration')}>Duration (minutes)</label><input id={id('duration')} name="duration_minutes" type="number" min={15} max={1440} step={15} defaultValue={exchange.durationMinutes ?? 60} required disabled={busy}/>
      <label htmlFor={id('meeting')}>Meeting point</label><input id={id('meeting')} name="meeting_point" defaultValue={exchange.meetingPoint ?? ''} required minLength={2} maxLength={300} disabled={busy}/>
      <Button className="primary-button" type="submit" disabled={busy}>{exchange.state === 'scheduled' ? 'Update schedule' : 'Save schedule'}</Button>
    </form>}
    {open && <form className="help-cancel" onSubmit={event => void send('cancel', event)}>
      <label htmlFor={id('reason')}>Reason for cancelling</label><input id={id('reason')} name="reason" maxLength={500} disabled={busy}/>
      <Button className="secondary-button" type="submit" disabled={busy}>Cancel help</Button>
    </form>}
    {(exchange.state === 'scheduled' || exchange.state === 'completion_pending') && !exchange.completion?.openDispute && <section className="help-completion" aria-label="Confirm help completion">
      <h3>Did the help happen?</h3>
      {exchange.completion?.firstConfirmedBy && <p>Waiting for the other participant to confirm. No scores change until both agree.</p>}
      {!exchange.completion?.firstConfirmedBy || (exchange.completion.firstConfirmedBy !== userId && !(exchange.completion.helperConfirmedAt && exchange.completion.requesterConfirmedAt)) ? <Button className="primary-button" type="button" disabled={busy} onClick={() => void send('confirm')}>Confirm completed help</Button> : null}
      {exchange.state === 'completion_pending' && exchange.completion?.firstConfirmedBy !== userId && <form onSubmit={event => void send('dispute', event)}><label htmlFor={id('disagreement')}>If the account differs, describe what happened</label><textarea id={id('disagreement')} name="disagreement" minLength={1} maxLength={4000} required disabled={busy}/><Button className="secondary-button" type="submit" disabled={busy}>Report disagreement</Button></form>}
    </section>}
    {exchange.state === 'completed' && exchange.completion && <section aria-label="Completed Help Exchange">
      <p role="status">Help completed.</p>
      <ScoreCard label="Community Solidarity Score" score={exchange.completion.standing.score} title={exchange.completion.standing.title}
        completed={exchange.completion.standing.completedInteractions} explanation={localExplanation}/>
      <p>{exchange.completion.awards.some(award => award.recipientId === userId)
        ? 'You earned +3 for completing help. Both participants gained one Qualifying Interaction.'
        : 'Receiving help does not change your score. Both participants gained one Qualifying Interaction.'}</p>
      <ThankExchange userId={userId} communityId={exchange.communityId} exchangeId={exchange.id} onChanged={onChanged}/>
      <a href="/standing">View your Reputation Event history</a>
    </section>}
  </section>;
}
