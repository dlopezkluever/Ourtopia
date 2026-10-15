import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowLeft, LockKeyhole, MessageCircle, Send } from 'lucide-react';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { conversationSchema, errorMessage, inboxRowSchema, messageBody, messageSchema, readDraft, startIntent, type Draft, type InboxRow, type Message } from './model';

const conversationPath = (path: string) => /^\/messages\/([0-9a-f-]{36})$/.exec(path)?.[1];

export function MessagesPage({ user }: { user: User }) {
  const [path, setPath] = useState(location.pathname);
  const conversationId = conversationPath(path);
  const [inbox, setInbox] = useState<InboxRow[] | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [communities, setCommunities] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const reload = useRef<(clear?: boolean) => Promise<void>>(async () => {});

  function go(next: string) { setMessages([]); history.pushState({}, '', next); setPath(next); }

  useEffect(() => {
    let active = true;
    async function load(clear = false) {
      const request = ++generation.current;
      if (clear) { setInbox(null); setMessages([]); setCommunities([]); }
      const [inboxResult, messageResult, communityResult] = await Promise.all([
        supabase.rpc('conversation_inbox'),
        conversationId ? supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at').order('id') : null,
        supabase.from('communities').select('id,name').order('name'),
      ]);
      if (!active || request !== generation.current) return;
      const failure = inboxResult.error ?? messageResult?.error ?? communityResult.error;
      if (failure) { setInbox([]); setMessages([]); setCommunities([]); setError(failure.message); return; }
      setError('');
      setInbox(inboxRowSchema.array().parse(inboxResult.data));
      setMessages(messageSchema.array().parse(messageResult?.data ?? []));
      setCommunities(communityResult.data ?? []);
    }
    reload.current = load;
    void load(true);
    return () => { active = false; };
  }, [conversationId]);

  useEffect(() => {
    let active = true;
    const revalidate = () => { void reload.current(); };
    const clear = () => { void reload.current(true); };
    const accessChanged = () => {
      for (const key of Object.keys(sessionStorage)) if (key.startsWith('message-draft-')) sessionStorage.removeItem(key);
      clear();
    };
    const channel = supabase.channel(`messages-${user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${user.id}` }, accessChanged)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${user.id}` }, revalidate);
    async function connect() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (!data.session) { clear(); return; }
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => {
        if (!active) return;
        if (status === 'SUBSCRIBED') revalidate();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') clear();
      });
    }
    void connect();
    const popstate = () => { setMessages([]); setPath(location.pathname); };
    const visibility = () => { if (document.visibilityState === 'visible') revalidate(); };
    const timer = window.setInterval(revalidate, 15000);
    window.addEventListener('popstate', popstate);
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false; void supabase.removeChannel(channel); clearInterval(timer);
      window.removeEventListener('popstate', popstate); window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visibility);
    };
  }, [user.id]);

  if (inbox === null) return <p role="status" className="loading">Opening your conversations…</p>;
  const current = conversationId ? inbox.find(row => row.id === conversationId) : undefined;

  return <section className={`messages-layout${conversationId ? ' has-conversation' : ''}`}>
    <aside className="messages-inbox" aria-labelledby="inbox-title">
      <span className="eyebrow">PRIVATE MESSAGES</span>
      <h1 id="inbox-title">Inbox</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {inbox.length === 0 ? <p className="muted messages-empty">No conversations yet.</p> : <nav aria-label="Conversations"><ul className="conversation-list">{inbox.map(row => <li key={row.id}>
        <a href={`/messages/${row.id}`} aria-current={row.id === conversationId ? 'page' : undefined} onClick={event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); go(`/messages/${row.id}`);
        }}><span className="avatar">{row.counterpart_email.charAt(0).toUpperCase()}</span><span><strong>{row.counterpart_email}</strong><small>{row.community_name}{row.last_message_at ? ` · ${new Date(row.last_message_at).toLocaleString()}` : ' · No messages yet'}</small></span></a>
      </li>)}</ul></nav>}
      <StartConversation communities={communities} onStarted={id => go(`/messages/${id}`)}/>
    </aside>
    <div className="messages-main">
      {conversationId && <button type="button" className="text-button messages-back" onClick={() => go('/messages')}><ArrowLeft size={15}/> Back to inbox</button>}
      {!conversationId ? <div className="messages-placeholder"><MessageCircle size={40} strokeWidth={1.2}/><p>Choose a conversation or start one with another active member of your Community.</p></div>
        : !current ? <div className="account-card"><LockKeyhole/><h2>Conversation unavailable.</h2><p className="muted">Only its two participants can read this conversation, and only while their Community membership allows it.</p></div>
        : <Conversation key={current.id} conversation={current} messages={messages} userId={user.id} onSent={() => void reload.current()}/>}
    </div>
  </section>;
}

function Conversation({ conversation, messages, userId, onSent }: { conversation: InboxRow; messages: Message[]; userId: string; onSent: () => void }) {
  return <section className="conversation" aria-labelledby="conversation-title">
    <span className="private-badge"><LockKeyhole size={13}/> {conversation.community_name} · Only you two can read this</span>
    <h2 id="conversation-title">Conversation with {conversation.counterpart_email}</h2>
    {messages.length === 0 ? <p className="muted messages-empty">No messages yet. Say hello and arrange your handoff or help.</p>
      : <ol className="message-list" aria-label="Messages">{messages.map(message => {
        const author = message.author_id === userId ? 'You' : conversation.counterpart_email;
        return <li key={message.id} className={message.author_id === userId ? 'own-message' : undefined}><article aria-label={`Message from ${author}`}>
          <span className="message-meta">{author} · <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time></span>
          <p className="message-body">{message.body}</p>
        </article></li>;
      })}</ol>}
    {conversation.can_send ? <Composer conversationId={conversation.id} userId={userId} counterpart={conversation.counterpart_email} onSent={onSent}/>
      : <p className="notice" role="note"><LockKeyhole size={16}/> Sending is closed because your Community membership is not active. You can read existing messages here to select Dispute evidence.</p>}
  </section>;
}

function Composer({ conversationId, userId, counterpart, onSent }: { conversationId: string; userId: string; counterpart: string; onSent: () => void }) {
  const key = `message-draft-${userId}-${conversationId}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(key));
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>(draft.attempted ? 'failed' : 'idle');
  const [error, setError] = useState(draft.attempted ? 'This message was not confirmed before the page closed.' : '');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (status === 'sent' || status === 'failed') field.current?.focus(); }, [status]);

  function save(next: Draft) {
    setDraft(next);
    if (next.body || next.attempted) sessionStorage.setItem(key, JSON.stringify(next)); else sessionStorage.removeItem(key);
  }

  function edit(body: string) {
    save(draft.attempted ? { intent: crypto.randomUUID(), body, attempted: false } : { ...draft, body });
    if (status !== 'sending') { setStatus('idle'); setError(''); }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = messageBody.safeParse(draft.body);
    if (!parsed.success) { setStatus('failed'); setError(parsed.error.issues[0].message); return; }
    const attempt = { ...draft, attempted: true };
    save(attempt); setStatus('sending'); setError('');
    try {
      const { data, error } = await supabase.rpc('send_message', { p_intent_id: attempt.intent, p_conversation_id: conversationId, p_body: parsed.data });
      if (error) throw error;
      messageSchema.parse(data);
      save({ intent: crypto.randomUUID(), body: '', attempted: false });
      setStatus('sent');
      onSent();
    } catch (cause) {
      setStatus('failed');
      setError(cause instanceof TypeError ? 'The connection dropped before the message was confirmed.' : errorMessage(cause));
    }
  }

  const failed = status === 'failed' && draft.attempted;
  return <form className="composer" onSubmit={send} aria-busy={status === 'sending'}>
    <label htmlFor="message-body">Message to {counterpart}</label>
    <textarea id="message-body" ref={field} value={draft.body} rows={3} maxLength={4000} onChange={event => edit(event.target.value)} aria-describedby="message-status" disabled={status === 'sending'}/>
    {status === 'failed' && error && <p role="alert" className="error">Not sent. {error}{failed ? ' Retry sends this same message once.' : ''}</p>}
    <p id="message-status" role="status" className="message-status">{status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent' : ''}</p>
    <Button className="primary-button" type="submit" disabled={status === 'sending'}>{failed ? 'Retry sending' : 'Send message'}<Send size={16}/></Button>
  </form>;
}

function StartConversation({ communities, onStarted }: { communities: { id: string; name: string }[]; onStarted: (id: string) => void }) {
  const [communityId, setCommunityId] = useState('');
  const [loaded, setLoaded] = useState<{ communityId: string; rows: { user_id: string; email: string }[] }>({ communityId: '', rows: [] });
  const [participantId, setParticipantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = communities.some(community => community.id === communityId) ? communityId : communities[0]?.id ?? '';
  const candidates = loaded.communityId === selected ? loaded.rows : [];

  useEffect(() => {
    let active = true;
    if (!selected) return;
    void supabase.rpc('conversation_candidates', { p_community_id: selected }).then(({ data, error }) => {
      if (!active) return;
      setLoaded({ communityId: selected, rows: data ?? [] }); setError(error?.message ?? '');
    });
    return () => { active = false; };
  }, [selected]);

  if (communities.length === 0) return <p className="muted messages-empty">Join a Community as an active member to start a conversation.</p>;
  const participant = candidates.some(candidate => candidate.user_id === participantId) ? participantId : candidates[0]?.user_id ?? '';

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!participant) return;
    setBusy(true); setError('');
    const intent = startIntent(selected, participant);
    try {
      const { data, error } = await supabase.rpc('start_conversation', { p_intent_id: intent.id, p_community_id: selected, p_participant_id: participant });
      if (error) throw error;
      const conversation = conversationSchema.parse(data);
      intent.complete();
      onStarted(conversation.id);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <form className="start-conversation" onSubmit={start} aria-labelledby="start-title">
    <h2 id="start-title">Start a conversation</h2>
    <label htmlFor="conversation-community">Community</label>
    <select id="conversation-community" value={selected} onChange={event => setCommunityId(event.target.value)} disabled={busy}>
      {communities.map(community => <option key={community.id} value={community.id}>{community.name}</option>)}
    </select>
    <label htmlFor="conversation-member">Member</label>
    {candidates.length === 0 ? <p className="muted">No other active members in this Community yet.</p>
      : <select id="conversation-member" value={participant} onChange={event => setParticipantId(event.target.value)} disabled={busy}>
        {candidates.map(candidate => <option key={candidate.user_id} value={candidate.user_id}>{candidate.email}</option>)}
      </select>}
    {error && <p role="alert" className="error">{error}</p>}
    <Button className="primary-button" type="submit" disabled={busy || !participant}>{busy ? 'Starting…' : 'Start conversation'}</Button>
  </form>;
}
