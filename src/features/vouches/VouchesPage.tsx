import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { commandIntent, errorMessage } from '../membership/model';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { workspaceSchema, applicantStatementSchema } from './model';

const noticesSchema = z.array(z.object({ id: z.uuid(), kind: z.string(), created_at: z.string() }));

async function readWorkspace(communityId: string) {
  const result = await supabase.rpc('vouch_workspace' as never, { p_community_id: communityId } as never);
  if (result.error) throw result.error;
  return workspaceSchema.parse(result.data);
}

export function VouchesPage({ userId }: { userId: string }) {
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const communityId = new URLSearchParams(location.search).get('community');
  const state = useAccessScopedRead(userId, `vouches-${communityId}-${version}`, async () => {
    const [communities, applications, statements, notices] = await Promise.all([
      supabase.from('communities').select('id,name'),
      supabase.from('membership_applications').select('*').eq('applicant_id', userId),
      supabase.rpc('my_vouch_statements' as never),
      supabase.from('notifications').select('id,kind,created_at').in('kind', ['vouch_requested', 'vouch_submitted']),
    ]);
    for (const result of [communities, applications, statements, notices]) if (result.error) throw result.error;
    return { communities: communities.data ?? [], applications: applications.data ?? [], statements: z.array(applicantStatementSchema).parse(statements.data), notices: noticesSchema.parse(notices.data), workspace: communityId ? await readWorkspace(communityId) : null };
  });
  async function command(event: FormEvent<HTMLFormElement>, name: 'configure_vouch' | 'submit_vouch' | 'request_vouch', fixed: Record<string, unknown>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const fields = new FormData(event.currentTarget);
    const payload = { ...fixed };
    if (name === 'configure_vouch') { payload.p_sponsor_id = fields.get('sponsor'); payload.p_eligible = fields.get('eligible') === 'true'; payload.p_annual_limit = Number(fields.get('limit')); }
    if (name === 'submit_vouch') payload.p_statement = String(fields.get('statement') ?? '').trim();
    if (name === 'request_vouch') payload.p_sponsor_email = String(fields.get('email') ?? '').trim();
    const intent = commandIntent(`vouch-${userId}-${name}`, payload);
    try {
      const result = await supabase.rpc(name as never, { ...payload, p_intent_id: intent.id } as never);
      if (result.error) throw result.error;
      intent.complete();
      setMessage(name === 'request_vouch' ? 'Vouch requested. Your application still needs administrator approval.' : name === 'configure_vouch' ? 'Sponsorship settings saved.' : 'Vouch saved. The applicant still needs administrator approval.');
      setVersion(value => value + 1);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <section className="membership-page vouches-page"><a href="/">Back to your Communities</a><span className="eyebrow">TRUST IN YOUR CIRCLE</span><h1>Vouches</h1><p>A Vouch is a trust statement. Membership still requires an Invite and separate administrator approval. Vouches change no scores or completed Exchange counts.</p>
    <Button onClick={() => setVersion(value => value + 1)} disabled={busy}>Refresh Vouches and notices</Button>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {state.status === 'loading' ? <p role="status">Loading Vouches...</p> : state.status === 'denied' ? <p role="alert">{state.message}</p> : <>
      <nav aria-label="Vouch Communities">{state.data.communities.map(community => <a key={community.id} href={`/vouches?community=${community.id}`}>{community.name}</a>)}</nav>
      {state.data.workspace && <><h2>Vouches in {state.data.workspace.name}</h2><p role="status">{state.data.workspace.eligible ? `Eligible sponsor. ${state.data.workspace.used} of ${state.data.workspace.annualLimit} Vouches used in the rolling year.` : 'Sponsorship eligibility is granted by your administrator.'}</p>
        {state.data.workspace.administrator && <form className="membership-card" onSubmit={event => void command(event, 'configure_vouch', { p_community_id: communityId })}><h3>Sponsorship settings</h3>
          <label htmlFor="vouch-member">Member</label><select id="vouch-member" name="sponsor" required>{state.data.workspace.members.map(member => <option key={member.id} value={member.id}>{member.email} ({member.eligible ? 'eligible' : 'not eligible'})</option>)}</select>
          <label htmlFor="vouch-eligibility">Eligibility</label><select id="vouch-eligibility" name="eligible"><option value="true">Grant eligibility</option><option value="false">Revoke eligibility</option></select>
          <label htmlFor="vouch-limit">Community annual limit per sponsor</label><input id="vouch-limit" name="limit" type="number" min="0" max="100" required defaultValue={state.data.workspace.annualLimit}/><Button disabled={busy}>Save sponsorship settings</Button>
        </form>}
        <section aria-label="Vouch requests"><h3>Vouch requests</h3>{state.data.workspace.requests.length === 0 && <p>No requests yet.</p>}{state.data.workspace.requests.map(request => <p key={request.id}>Vouch requested by {request.applicantEmail}. Application {request.status}.</p>)}</section>
        {state.data.workspace.eligible && <section aria-label="Pending applicants"><h3>Pending applicants</h3>{state.data.workspace.applications.map(application => <form className="membership-card" key={application.id} onSubmit={event => void command(event, 'submit_vouch', { p_application_id: application.id })}><h4>{application.email}</h4><label htmlFor={`statement-${application.id}`}>Trust statement for {application.email}</label><textarea id={`statement-${application.id}`} name="statement" required maxLength={2000}/><Button disabled={busy}>Vouch for {application.email}</Button></form>)}</section>}
        <section aria-label="Sponsor history"><h3>{state.data.workspace.administrator ? 'Community Vouch statements' : 'Your sponsor history'}</h3>{state.data.workspace.history.length === 0 && <p>No Vouches yet.</p>}{state.data.workspace.history.map(item => <article className="membership-card" key={item.id}><h4>{item.applicantEmail}</h4><p>Vouched for by {item.sponsorEmail}</p><p>{item.statement}</p><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></article>)}</section>
      </>}
      <section aria-label="Your applications and statements"><h2>Your applications and statements</h2>{state.data.applications.length === 0 && <p>No applications yet. An administrator must first send you an Invite.</p>}{state.data.applications.map(application => <article className="membership-card" key={application.id}><h3>{application.community_name}</h3><p role="status">{application.status === 'pending' ? 'Pending administrator approval' : application.status}</p>{state.data.statements.filter(item => item.application_id === application.id).map(item => <blockquote key={item.id}>{item.statement}<footer>Vouched for by {item.sponsorEmail} on {new Date(item.created_at).toLocaleString()}</footer></blockquote>)}{application.status === 'pending' && <form onSubmit={event => void command(event, 'request_vouch', { p_application_id: application.id })}><label htmlFor={`sponsor-${application.id}`}>Sponsor email for {application.community_name}</label><input id={`sponsor-${application.id}`} name="email" type="email" required maxLength={254}/><Button disabled={busy}>Request a Vouch</Button></form>}</article>)}</section>
      <section aria-label="Vouch notices"><h2>Your Vouch notices</h2>{state.data.notices.length === 0 && <p>No Vouch notices yet.</p>}{state.data.notices.map(notice => <article className="membership-card" key={notice.id}><p>{notice.kind === 'vouch_requested' ? 'An applicant requested your Vouch. Review their pending application in your Community.' : 'A Vouch statement is ready to read. Membership still requires separate approval.'}</p><time dateTime={notice.created_at}>{new Date(notice.created_at).toLocaleString()}</time></article>)}</section>
    </>}
  </section>;
}
