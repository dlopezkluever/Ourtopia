import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowUpRight, Leaf, LockKeyhole, Sprout } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { AccountForm } from '../features/auth/AccountForm';
import { RecoveryForm } from '../features/auth/RecoveryForm';
import { MembershipPortal } from '../features/membership/MembershipPortal';
import { CommunityHome } from '../features/communities/CommunityHome';
import { MessagesPage } from '../features/messages/MessagesPage';
import { ProfilesPage } from '../features/profiles/ProfilesPage';
import { OwnStanding } from '../features/profiles/OwnStanding';
import { profileRoute } from '../features/profiles/model';
import { VouchesPage } from '../features/vouches/VouchesPage';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(location.hash.includes('type=recovery'));
  const [error, setError] = useState(() => new URLSearchParams(location.hash.slice(1)).get('error_description') ?? '');
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next); setLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') {
        for (const key of Object.keys(sessionStorage)) if (key.startsWith('message-draft-') || key.startsWith('message-start-')) sessionStorage.removeItem(key);
        setRecovery(false); history.replaceState({}, '', '/');
      }
    });
    void supabase.auth.getSession().then(({ data, error }) => { if (error) setError(error.message); setSession(data.session); setLoading(false); });
    return () => data.subscription.unsubscribe();
  }, []);

  async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) setError(error.message);
  }

  return <div className="app-shell"><header className="site-header"><a className="brand" href="/" aria-label="Ourtopia home"><span className="brand-mark"><Leaf size={22}/></span>ourtopia<span className="brand-period">.</span></a><div className="header-right">{session ? <><a className="text-button" href="/membership">Invites &amp; applications</a><a className="text-button" href="/vouches">Vouches</a><a className="text-button" href="/messages">Messages</a><a className="text-button" href="/standing">Your standing</a><span className="signed-in-email">{session.user.email}</span><button className="text-button" onClick={() => void signOut()}>Sign out<ArrowUpRight size={15}/></button></> : <span className="header-tagline">Good things grow together.</span>}</div></header>
    <main>{error && <p role="alert" className="error global-error">{error}</p>}{loading ? <p role="status" className="loading">Getting things ready…</p> : recovery && session ? <div className="recovery-layout"><RecoveryForm onComplete={() => setRecovery(false)}/></div> : session ? (location.pathname === '/vouches' ? <VouchesPage key={session.user.id} userId={session.user.id}/> : location.pathname === '/membership' ? <MembershipPortal key={session.user.id} user={session.user}/> : location.pathname.startsWith('/messages') ? <MessagesPage key={session.user.id} user={session.user}/> : location.pathname === '/standing' ? <OwnStanding key={session.user.id} userId={session.user.id}/> : profileRoute(location.pathname) ? <ProfilesPage key={session.user.id} userId={session.user.id} route={profileRoute(location.pathname)!}/> : <CommunityHome key={session.user.id} user={session.user}/>) : <div className="entry-layout"><section className="entry-story"><span className="eyebrow"><span className="tiny-line"/> A LITTLE MORE POSSIBLE</span><h1>Less on your own.<br/>More <em>together.</em></h1><p>We all have something to share.<br/>A spare tool. A helping hand. A little time.<br/>Find your people. Build your Ourtopia.</p><div className="story-art" aria-hidden="true"><div className="art-circle"/><div className="art-stem"><Sprout size={148} strokeWidth={1}/></div><div className="art-note note-one">a helping hand <span>↗</span></div><div className="art-note note-two"><span>✳</span> a shared beginning</div><div className="art-dots">✦</div></div><div className="story-footer"><span className="mini-avatars"><i>A</i><i>M</i><i>J</i></span><p>For neighbors. For friends.<br/><strong>For a better kind of everyday.</strong></p></div></section><AccountForm/></div>}</main>
    <footer className="site-footer"><span>Small circles. Stronger communities.</span><span><LockKeyhole size={13}/> Built on trust, kept private.</span><span>© {new Date().getFullYear()} Ourtopia</span></footer></div>;
}
