import { useEffect, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { NotificationList } from '../notifications/NotificationList';
import { commandIntent, errorMessage, type Application, type Invite } from './model';

export function MembershipPortal({ user }: { user: User }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load(clear = false) {
      if (!active) return;
      const request = ++generation;
      if (clear) { setInvites([]); setApplications([]); }
      const [invites, applications] = await Promise.all([
        supabase.from('invites').select('*').eq('recipient_email', user.email?.toLowerCase() ?? '').order('created_at', { ascending: false }),
        supabase.from('membership_applications').select('*').eq('applicant_id', user.id).order('created_at', { ascending: false }),
      ]);
      if (!active || request !== generation) return;
      setInvites((invites.data ?? []).filter(invite => !invite.redeemed_by && new Date(invite.expires_at).getTime() > Date.now())); setApplications(applications.data ?? []);
      setError(invites.error?.message ?? applications.error?.message ?? ''); setLoading(false);
    }
    void load();
    const channel = supabase.channel(`application-status-${user.id}`).on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${user.id}`,
    }, () => void load(true)).subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') void load(true);
      else if (status === 'SUBSCRIBED') void load();
    });
    const refresh = () => void load();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); void supabase.removeChannel(channel); };
  }, [user.id, user.email, version]);

  async function apply(inviteId: string) {
    setBusy(true); setError('');
    const intent = commandIntent(`apply-${user.id}`, inviteId);
    try {
      const result = await supabase.rpc('redeem_invite', { p_intent_id: intent.id, p_invite_id: inviteId });
      if (result.error) throw result.error;
      intent.complete(); setVersion(value => value + 1);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function applyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('invite') ?? '').trim();
    const id = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (!id) { setError('Enter the Invite code or link your administrator shared.'); return; }
    void apply(id);
  }

  return <section className="membership-page"><a href="/">Back to your Communities</a><span className="eyebrow">A PLACE IN YOUR CIRCLE</span><h1>Invites & applications</h1><p>An Invite lets you apply. Your Community stays private until an administrator approves you.</p>
    {!user.email_confirmed_at && <p role="status">Verify your email before applying. Open the link in your inbox, then sign in again.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={applyCode} className="membership-card"><label htmlFor="invite-code">Invite code or link</label><input id="invite-code" name="invite" defaultValue={new URLSearchParams(location.search).get('invite') ?? ''} required/><Button disabled={busy || !user.email_confirmed_at} type="submit">Apply with Invite</Button></form>
    {loading ? <p role="status">Loading your applications...</p> : <><h2>Your Invites</h2>{invites.map(invite => <article className="membership-card" key={invite.id}><h3>{invite.community_name}</h3><p>Expires {new Date(invite.expires_at).toLocaleString()}</p><Button disabled={busy} onClick={() => void apply(invite.id)}>Request membership in {invite.community_name}</Button></article>)}
    <h2>Your applications</h2>{applications.length === 0 && <p>No applications yet. Ask your administrator for an Invite.</p>}{applications.map(application => <article className="membership-card" key={application.id}><h3>{application.community_name}</h3><p role="status">{application.status === 'pending' ? 'Pending administrator approval' : application.status === 'approved' ? 'Approved' : 'Rejected'}</p>{application.reason && <p>Decision reason. {application.reason}</p>}{application.status === 'approved' && <a href={`/communities/${application.community_id}`}>Open Community</a>}</article>)}</>}
    <NotificationList userId={user.id} version={version}/>
  </section>;
}
