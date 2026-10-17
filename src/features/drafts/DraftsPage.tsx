import { useRef, useState, useEffect, useEffectEvent } from 'react';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { supabase } from '../../lib/supabase/client';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { errorMessage } from '../help/model';
import { commandDraft } from './api';
import { draftSchema, kinds, fields, draftFields, initialValues, publishFields, type Draft, type DraftKind } from './model';

export function DraftsPage({ userId }: { userId: string }) {
  const [communityId, setCommunity] = useState('');
  const [kind, setKind] = useState<DraftKind>('item');
  const access = useAccessScopedRead(userId, 'draft-communities', async () => {
    const result = await supabase.from('communities').select('id,name').order('name');
    if (result.error) throw result.error;
    return result.data;
  });
  const communities = access.status === 'ready' ? access.data : [];
  const selected = communityId || communities[0]?.id;
  return <section className="draft-layout"><h1>Draft contributions</h1><p>Start here to save an unfinished item or Help post. Changes save automatically while connected. Only you can resume your drafts, after a fresh Community access check.</p>
    <label htmlFor="draft-community">Community</label><select id="draft-community" value={selected ?? ''} onChange={event => setCommunity(event.target.value)}><option value="">Choose a Community</option>{communities.map(community => <option key={community.id} value={community.id}>{community.name}</option>)}</select>
    <label htmlFor="draft-kind">Contribution type</label><select id="draft-kind" value={kind} onChange={event => setKind(event.target.value as DraftKind)}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    {access.status === 'loading' ? <p role="status">Checking current access...</p> : selected && communities.some(community => community.id === selected) ? <DraftLoader key={`${selected}-${kind}`} userId={userId} communityId={selected} kind={kind}/> : <p role="status">Community unavailable. Active membership is required to restore a draft.</p>}
  </section>;
}
function DraftLoader({ userId, communityId, kind }: { userId: string; communityId: string; kind: DraftKind }) {
  const [refresh, setRefresh] = useState(0);
  const access = useAccessScopedRead(userId, `draft-${communityId}-${kind}-${refresh}`, async () => {
    const allowed = await supabase.rpc('is_active_member', { target_community: communityId });
    if (allowed.error || !allowed.data) throw new Error('Current membership required.');
    const result = await supabase.from('contribution_drafts').select('*').eq('community_id', communityId).eq('owner_id', userId).eq('kind', kind).maybeSingle();
    if (result.error) throw result.error;
    return result.data ? draftSchema.parse(result.data) : undefined;
  });
  if (access.status !== 'ready') return <div><p role="status">{access.status === 'loading' ? 'Checking draft access...' : 'Draft unavailable. Reconnect and check your membership.'}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry draft access</button></div>;
  return <DraftEditor userId={userId} communityId={communityId} kind={kind} draft={access.data} onReload={() => setRefresh(value => value + 1)}/>;
}
function DraftEditor({ userId, communityId, kind, draft, onReload }: { userId: string; communityId: string; kind: DraftKind; draft?: Draft; onReload: () => void }) {
  const [values, setValues] = useState(() => initialValues(kind, draft));
  const [message, setMessage] = useState(draft?.status === 'editing' ? 'Saved draft restored after checking your access.' : 'Your draft will save as you type.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(draft?.revision ?? 0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const last = useRef(draft?.status === 'editing' ? JSON.stringify(draft.fields) : '');
  const pending = useRef<{ payload: string; intent: string } | null>(null);
  const edited = useRef(false);
  const editVersion = useRef(0);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function change(name: string, value: string) {
    edited.current = true; ++editVersion.current;
    setValues(current => ({ ...current, [name]: value })); setError(''); setMessage('Saving draft...');
  }
  function save(fields: ReturnType<typeof draftFields> | ReturnType<typeof publishFields>) {
    const payload = JSON.stringify(fields);
    const version = editVersion.current;
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!alive.current || last.current === payload) return;
      if (pending.current?.payload !== payload) pending.current = { payload, intent: crypto.randomUUID() };
      const result = await commandDraft(userId, communityId, kind, revision.current, 'save', fields, pending.current.intent);
      revision.current = result.draft.revision; last.current = payload; pending.current = null;
      if (alive.current && editVersion.current === version) setMessage('Draft saved privately. You can safely reload.');
    });
    return queue.current;
  }
  const autoSave = useEffectEvent(() => {
    void save(draftFields(kind, values)).catch(cause => { if (alive.current) setError(errorMessage(cause)); });
  });
  useEffect(() => {
    if (!edited.current || busy) return;
    const timer = window.setTimeout(autoSave, 600);
    return () => window.clearTimeout(timer);
  }, [values, kind, busy]);
  async function publish() {
    edited.current = false;
    setBusy(true); setError('');
    try {
      const fields = publishFields(kind, values);
      await save(fields);
      const payload = `publish-${revision.current}`;
      if (pending.current?.payload !== payload) pending.current = { payload, intent: crypto.randomUUID() };
      const result = await commandDraft(userId, communityId, kind, revision.current, 'publish', fields, pending.current.intent);
      if (!alive.current) return;
      const id = result.published!.id;
      location.assign(kind === 'item' ? `/communities/${communityId}/listings/${id}` : `/help/${communityId}/${kind === 'help_offer' ? 'listing' : 'need'}/${id}`);
    } catch (cause) {
      setError(cause instanceof z.ZodError ? cause.issues.map(issue => `${issue.path.join(' ')}: ${issue.message}`).join(' ') : errorMessage(cause));
      window.setTimeout(() => alert.current?.focus(), 0);
    } finally { if (alive.current) setBusy(false); }
  }
  return <form className="account-card draft-form" aria-label={`${kinds[kind]} draft`} onSubmit={event => { event.preventDefault(); void publish(); }}>
    <h2>{kinds[kind]} draft</h2><fieldset disabled={busy}>{fields[kind].map(field => <div key={field.name}><label htmlFor={`draft-${field.name}`}>{field.label}{field.optional ? ' (optional)' : ''}</label>{field.options ? <select id={`draft-${field.name}`} value={values[field.name]} onChange={event => change(field.name, event.target.value)}>{(Array.isArray(field.options) ? field.options.map(value => [value, value]) : Object.entries(field.options)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === 'textarea' ? <textarea id={`draft-${field.name}`} value={values[field.name]} maxLength={field.max ?? 2000} onChange={event => change(field.name, event.target.value)}/> : <input id={`draft-${field.name}`} type={field.type ?? 'text'} step={field.name === 'replacement_value' ? '0.01' : undefined} value={values[field.name]} maxLength={field.max ?? 500} onChange={event => change(field.name, event.target.value)}/>}</div>)}
      <p className="field-help">Photos are optional. Borrowing is free. Gratitude never buys priority or approval.</p><p role="status">{message}</p>{error && <p ref={alert} tabIndex={-1} role="alert">{error}</p>}
      <Button className="secondary-button" type="button" onClick={() => void save(draftFields(kind, values)).catch(cause => setError(errorMessage(cause)))}>Save draft</Button><Button className="primary-button" type="submit">Publish contribution</Button><button type="button" onClick={() => { setBusy(true); void queue.current.catch(() => {}).then(() => commandDraft(userId, communityId, kind, revision.current, 'discard', {})).then(onReload).catch(cause => { setError(errorMessage(cause)); setBusy(false); }); }}>Discard draft</button>
    </fieldset></form>;
}
