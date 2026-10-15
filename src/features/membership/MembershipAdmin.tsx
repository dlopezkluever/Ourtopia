import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { deliveryLabel } from '../notifications/model';
import { commandIntent, errorMessage, inviteSchema, type Application, type Invite, type OutboxEntry } from './model';

export function MembershipAdmin({ communityId, userId }: { communityId: string; userId: string }) {
  const [applications, setApplications] = useState<Application[]>([]);
  const [deliveries, setDeliveries] = useState<OutboxEntry[]>([]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load() {
      const request = ++generation;
      const [applications, deliveries] = await Promise.all([
        supabase.from('membership_applications').select('*').eq('community_id', communityId).order('created_at', { ascending: false }),
        supabase.from('notification_outbox').select('*').eq('community_id', communityId).order('created_at', { ascending: false }),
      ]);
      if (!active || request !== generation) return;
      setApplications(applications.data ?? []); setDeliveries(deliveries.data ?? []);
      if (applications.error || deliveries.error) setError(applications.error?.message ?? deliveries.error?.message ?? '');
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    const focus = () => void load(); window.addEventListener('focus', focus);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [communityId, version]);

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    const intent = commandIntent(`issue-${userId}`, [communityId, email]);
    try {
      const result = await supabase.rpc('issue_invite', { p_intent_id: intent.id, p_community_id: communityId, p_email: email });
      if (result.error) throw result.error;
      setInvite(inviteSchema.parse(result.data)); intent.complete(); setVersion(value => value + 1);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  async function decide(event: FormEvent<HTMLFormElement>, application: Application) {
    event.preventDefault(); setBusy(true); setError('');
    const fields = new FormData(event.currentTarget);
    const decision = String(fields.get('decision'));
    const reason = String(fields.get('reason') ?? '').trim();
    const intent = commandIntent(`decide-${userId}`, [application.id, decision, reason]);
    try {
      const result = await supabase.rpc('decide_membership', { p_intent_id: intent.id, p_application_id: application.id, p_decision: decision, p_reason: reason });
      if (result.error) throw result.error;
      intent.complete(); setVersion(value => value + 1);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  async function retry(id: string) {
    setBusy(true); setError('');
    const intent = commandIntent(`retry-${userId}`, id);
    try {
      const result = await supabase.rpc('retry_notification', { p_intent_id: intent.id, p_outbox_id: id });
      if (result.error) throw result.error;
      intent.complete(); setVersion(value => value + 1);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  return <section className="membership-admin"><h2>Grow your circle</h2><p>Invite someone you know. They will need to verify their email and apply before you approve access.</p>
    <form onSubmit={issue} className="membership-card"><label htmlFor="invite-email">Invitee email</label><input id="invite-email" name="email" type="email" maxLength={254} required/><Button type="submit" disabled={busy}>Issue Invite</Button></form>
    {error && <p role="alert" className="error">{error}</p>}{invite && <div className="membership-card" role="status"><p>Invite ready for {invite.recipient_email}. Expires {new Date(invite.expires_at).toLocaleString()}.</p><label htmlFor="invite-link">Share this Invite link</label><input id="invite-link" readOnly value={`${location.origin}/membership?invite=${invite.id}`} onFocus={event => event.target.select()}/></div>}
    <h2>Membership requests</h2>{applications.length === 0 && <p>No requests to review yet.</p>}{applications.map(application => <article className="membership-card" key={application.id}><h3>{application.applicant_email}</h3><p>{application.status === 'pending' ? 'Pending review' : application.status}</p>{application.reason && <p>{application.reason}</p>}{application.status === 'pending' && <form onSubmit={event => void decide(event, application)}>
      <label htmlFor={`decision-${application.id}`}>Decision for {application.applicant_email}</label><select id={`decision-${application.id}`} name="decision" defaultValue="approved"><option value="approved">Approve</option><option value="rejected">Reject</option></select>
      <label htmlFor={`reason-${application.id}`}>Reason for {application.applicant_email}</label><textarea id={`reason-${application.id}`} name="reason" maxLength={1000} placeholder="Required for rejection"/>
      <Button type="submit" disabled={busy}>Confirm decision for {application.applicant_email}</Button>
    </form>}</article>)}
    <h2>Notice delivery</h2><p>Membership decisions stay in effect while notices retry.</p>{deliveries.map(item => <article className="delivery-row" key={item.id}><span>{deliveryLabel(item.kind, item.channel, item.state, item.attempts)}</span>{item.state === 'failed' && <Button disabled={busy} onClick={() => void retry(item.id)}>Retry {item.channel === 'email' ? 'email' : 'in app'} notice</Button>}</article>)}
  </section>;
}
