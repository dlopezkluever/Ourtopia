import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, House, LockKeyhole, Plus, Sprout, Users } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { communityInput, communitySchema, type Community } from './model';

export function CommunityHome({ user }: { user: User }) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [intent, setIntent] = useState(() => sessionStorage.getItem(`create-intent-${user.id}`) ?? crypto.randomUUID());
  const requestedId = location.pathname.startsWith('/communities/') ? location.pathname.split('/')[2] : undefined;
  const current = requestedId ? communities.find(community => community.id === requestedId) : communities[0];

  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load() {
      const request = ++generation;
      const { data, error } = await supabase.from('communities').select('*').order('created_at');
      if (!active || request !== generation) return;
      if (error) { setCommunities([]); setError(error.message); }
      else setCommunities(communitySchema.array().parse(data));
      setLoading(false);
    }
    void load();
    const refresh = () => { setCommunities([]); setLoading(true); void load(); };
    const channel = supabase.channel(`membership-access-${user.id}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${user.id}` }, refresh);
    async function connect() {
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error || !data.session) { ++generation; setCommunities([]); setLoading(true); return; }
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => {
        if (!active) return;
        if (status === 'SUBSCRIBED') refresh();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          ++generation; setCommunities([]); setLoading(true);
        }
      });
    }
    void connect();
    window.addEventListener('focus', refresh);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; void supabase.removeChannel(channel); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility); };
  }, [user.id]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const fields = new FormData(event.currentTarget);
    const parsed = communityInput.safeParse({ name: fields.get('name'), description: fields.get('description') });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
    setBusy(true);
    sessionStorage.setItem(`create-intent-${user.id}`, intent);
    try {
      const { data, error } = await supabase.rpc('create_community', { p_intent_id: intent, p_name: parsed.data.name, p_description: parsed.data.description });
      if (error) throw error;
      const community = communitySchema.parse(data);
      setCommunities(previous => [...previous.filter(row => row.id !== community.id), community]);
      history.replaceState({}, '', `/communities/${community.id}`);
      sessionStorage.removeItem(`create-intent-${user.id}`);
      setIntent(crypto.randomUUID()); setCreating(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Creation could not be confirmed. Retry with the same details to safely recover it.'); }
    finally { setBusy(false); }
  }

  if (loading) return <p role="status" className="loading">Opening your Communities…</p>;
  if (!user.email_confirmed_at) return <section className="account-card"><h2>One small step first.</h2><p>Verify your email before creating a Community. Open the link in your inbox, then sign in again.</p></section>;
  if (requestedId && !current && !creating) return <section className="account-card"><LockKeyhole/><h2>Community unavailable.</h2><p>This private Community is only available to its active members.</p><a href="/">Back to your Communities</a></section>;

  if (!current || creating) return <section className="create-layout"><div className="create-intro"><span className="eyebrow">SMALL CIRCLES. REAL POSSIBILITIES.</span><h1>Every good thing starts<br/>with a few people.</h1><p>Bring your neighbors, friends, or collective together. Make a private space to share what you have and help where you can.</p><div className="benefit"><LockKeyhole/><div><strong>Yours to grow, privately.</strong><p>Only approved members can see your Community.</p></div></div><div className="benefit"><Users/><div><strong>You’ll be the first administrator.</strong><p>A trusted person to help your circle get started.</p></div></div></div>
    <section className="account-card" aria-labelledby="create-title"><div className="icon-box"><Sprout/></div><h2 id="create-title">Plant the first seed.</h2><p className="muted">Give your Community a name that feels like home.</p><form onSubmit={create}>
      <label htmlFor="community-name">Community name</label><input id="community-name" name="name" placeholder="e.g. Maple Street Neighbors" minLength={2} maxLength={80} required disabled={busy}/>
      <label htmlFor="description">A little about your Community <span className="optional">(optional)</span></label><textarea id="description" name="description" placeholder="Who’s your circle? What brings you together?" maxLength={500} rows={4} disabled={busy}/>
      <p className="field-help"><LockKeyhole size={14}/> Private Community · invitation and approval required</p>
      {error && <p role="alert" className="error">{error}</p>}<Button className="primary-button" disabled={busy} type="submit">{busy ? 'Creating your Community…' : 'Create Community'}<ArrowRight size={18}/></Button>
      {current && <button type="button" className="text-button back" onClick={() => setCreating(false)}>Cancel</button>}
    </form></section></section>;

  return <section className="community-layout"><aside className="sidebar"><span className="eyebrow">YOUR COMMUNITY</span><div className="community-monogram">{current.name.charAt(0).toUpperCase()}</div><h2>{current.name}</h2><span className="private-badge"><LockKeyhole size={13}/> Private Community</span><div className="sidebar-nav"><House size={18}/> Community home</div><button className="text-button" onClick={() => { history.replaceState({}, '', '/'); setCreating(true); }}><Plus size={16}/> Create another Community</button>
    {communities.length > 1 && <nav aria-label="Your Communities">{communities.map(community => <a key={community.id} href={`/communities/${community.id}`}>{community.name}</a>)}</nav>}
  </aside><div className="home-content"><span className="eyebrow">A PLACE TO BEGIN</span><h1>Welcome to {current.name}.</h1><p className="home-description">{current.description || 'A small circle. A shared beginning. A little more possible, together.'}</p><div className="welcome-card"><div className="seed-art" aria-hidden="true"><Sprout size={70} strokeWidth={1.2}/></div><span className="private-badge">YOUR FIRST CHAPTER</span><h2>You’ve planted something good.</h2><p>Your private Community is ready. You’re its first active administrator.</p><div className="membership-proof"><span className="avatar">{user.email?.charAt(0).toUpperCase()}</span><div><strong>{user.email}</strong><span>Administrator · Active member</span></div><span className="active-dot"/></div></div><div className="home-footer"><LockKeyhole size={18}/><p>What happens here stays in your circle.<br/><span>Only active members can access this Community.</span></p></div><p className="created-date">Created {new Date(current.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</p></div></section>;
}
