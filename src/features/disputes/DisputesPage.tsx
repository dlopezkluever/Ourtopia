import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { HandoffPhotos } from '../evidence/HandoffPhotos';
import { issueTypes, type DisputeCase, type DisputeView } from './model';
import { readDisputes } from './api';

async function savedIntent(userId: string, payload: unknown, run: (intent: string) => PromiseLike<{ error: { message: string } | null }>) {
  const key = `dispute-command-${userId}-${JSON.stringify(payload)}`;
  const intent = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, intent);
  const result = await run(intent);
  if (result.error) throw result.error;
  sessionStorage.removeItem(key);
}

function CaseCard({ dispute, view, userId, refresh }: { dispute: DisputeCase; view: DisputeView; userId: string; refresh: () => void }) {
  const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function respond(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await savedIntent(userId, [dispute.id, body], intent => supabase.rpc('respond_to_dispute', { p_intent_id: intent, p_dispute_id: dispute.id, p_body: body }));
      setBody(''); refresh();
    } catch (failure) { setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'Response not confirmed. Retry safely.'); }
    finally { setBusy(false); }
  }
  const editable = view.participant && !dispute.closed_at;
  return <article className="dispute-card" aria-label="Structured case"><h2>{issueTypes[dispute.issue_type]}</h2><p>Case status. {dispute.status.replaceAll('_', ' ')}</p>
    <ol className="dispute-history">{dispute.responses.map(response => <li key={response.id}><strong>{response.author_id === userId ? 'You' : response.author_id === dispute.reporter_id ? 'Reporter' : 'Respondent'}</strong><time dateTime={response.created_at}>{new Date(response.created_at).toLocaleString()}</time><p>{response.body}</p></li>)}</ol>
    <HandoffPhotos userId={userId} exchangeId={view.exchange_id} disputeId={dispute.id} evidence={dispute.evidence} editable={editable} onChanged={refresh}/>
    {editable && <form onSubmit={event => void respond(event)}><label>Your response<textarea required maxLength={4000} value={body} onChange={event => setBody(event.target.value)}/></label><button className="primary-button" disabled={busy}>Send response</button></form>}
    {error && <p role="alert">{error}</p>}
  </article>;
}

function ExchangeCases({ view, userId, refresh }: { view: DisputeView; userId: string; refresh: () => void }) {
  const [type, setType] = useState<keyof typeof issueTypes>('damage'); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function report(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await savedIntent(userId, [view.exchange_id, type, body], intent => supabase.rpc('report_exchange_issue', { p_intent_id: intent, p_exchange_id: view.exchange_id, p_issue_type: type, p_body: body }));
      setBody(''); refresh();
    } catch (failure) { setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'Report not confirmed. Retry safely.'); }
    finally { setBusy(false); }
  }
  const open = view.cases.some(dispute => !dispute.closed_at);
  return <><h1>Exchange issues</h1><p role="status">{open ? 'Disputed' : 'No open case'}. Fulfillment remains {view.state.replaceAll('_', ' ')}.</p>
    {open && <p className="dispute-block" role="note">Ordinary completion is blocked while a case is open. Both participants can submit evidence and respond.</p>}
    {view.completed_at && <p>Completed {new Date(view.completed_at).toLocaleString()}. Existing Qualifying Interactions are preserved.</p>}
    {view.participant && <a href={`/handoffs/${view.exchange_id}`}>View permitted Handoff records</a>}
    {view.can_report ? <form className="dispute-card" aria-label="Report an Exchange issue" onSubmit={event => void report(event)}><h2>Report a problem</h2><p>Repeated reports of the same issue add to its open case.</p><label>Issue type<select value={type} onChange={event => setType(event.target.value as keyof typeof issueTypes)}>{Object.entries(issueTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>What happened?<textarea required maxLength={4000} value={body} onChange={event => setBody(event.target.value)}/></label><button className="primary-button" disabled={busy}>Report issue</button></form> : view.participant && <p>The reporting window has ended. Responses to an existing open case remain available.</p>}
    {error && <p role="alert">{error}</p>}{view.cases.map(dispute => <CaseCard key={dispute.id} dispute={dispute} view={view} userId={userId} refresh={refresh}/>)}</>;
}

export function DisputesPage({ userId, exchangeId }: { userId: string; exchangeId?: string }) {
  const [state, refresh] = useBorrowingRead(userId, `disputes-${exchangeId ?? 'all'}`, async () => {
    if (exchangeId) return { view: await readDisputes(exchangeId), links: [] };
    const [exchanges, cases] = await Promise.all([supabase.from('exchanges').select('id,state').eq('kind', 'item'), supabase.from('disputes').select('exchange_id')]);
    if (exchanges.error) throw exchanges.error; if (cases.error) throw cases.error;
    const links = new Map((exchanges.data ?? []).map(row => [row.id, row.state]));
    for (const row of cases.data ?? []) if (!links.has(row.exchange_id)) links.set(row.exchange_id, 'Submitted case');
    return { view: null, links: [...links].map(([id, label]) => ({ id, label })) };
  });
  return <section className="disputes-page"><a href="/disputes">All Exchange issues</a>{state.status === 'loading' ? <p role="status">Opening cases...</p> : state.status === 'denied' ? <><h1>Case unavailable</h1><p>Only participants and authorized Community administrators can inspect submitted cases.</p></> : state.data.view ? <ExchangeCases view={state.data.view} userId={userId} refresh={refresh}/> : <><h1>Your Exchange issues</h1>{state.data.links.map(link => <p key={link.id}><a href={`/disputes/${link.id}`}>Exchange issues · {link.label.replaceAll('_', ' ')}</a></p>)}{state.data.links.length === 0 && <p>No eligible Exchanges or submitted cases.</p>}</>}<button onClick={refresh}>Refresh cases</button><DisputeNotices userId={userId}/></section>;
}

function DisputeNotices({ userId }: { userId: string }) {
  const [state] = useBorrowingRead(userId, 'dispute-notices', async () => {
    const result = await supabase.from('notifications').select('id,kind,created_at').eq('recipient_id', userId).in('kind', ['item_dispute_opened', 'item_dispute_response']).order('created_at', { ascending: false }).limit(20);
    if (result.error) throw result.error;
    return result.data;
  });
  if (state.status !== 'ready' || !state.data.length) return null;
  return <section aria-label="Case notices"><h2>Case notices</h2>{state.data.map(notice => <p key={notice.id}>{notice.kind === 'item_dispute_opened' ? 'An Exchange issue was reported. Review your submitted cases.' : 'A participant added a case response or evidence.'} <time dateTime={notice.created_at}>{new Date(notice.created_at).toLocaleString()}</time></p>)}</section>;
}

export function DisputeLink({ exchangeId }: { exchangeId?: string }) {
  return <p><a href={exchangeId ? `/disputes/${exchangeId}` : '/disputes'}>Report or respond to an Exchange issue</a></p>;
}
