import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { actOnDispute, readDecisions } from './api';
import { historyLabels, nextStep, remedyKinds, roleLabel, statusLabels, type CaseAction, type DecisionCase, type DecisionView, type RemedyKind } from './model';

const issueLabels: Record<string, string> = { damage: 'Damage or condition', missing_item: 'Missing item or accessories', other: 'Other Exchange problem' };
const when = (value: string) => <time dateTime={value}>{new Date(value).toLocaleString()}</time>;

function TextAction({ label, button, required = true, onSubmit, busy }: { label: string; button: string; required?: boolean; busy: boolean; onSubmit: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (await onSubmit(text)) setText(''); }
  return <form onSubmit={event => void submit(event)}><label>{label}<textarea required={required} maxLength={4000} value={text} onChange={event => setText(event.target.value)}/></label><button className="primary-button" disabled={busy}>{button}</button></form>;
}

function OutcomeAction({ legend, reasonLabel, button, busy, onSubmit }: { legend: string; reasonLabel: string; button: string; busy: boolean; onSubmit: (outcome: string, reason: string) => Promise<boolean> }) {
  const [outcome, setOutcome] = useState(''); const [reason, setReason] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (await onSubmit(outcome, reason)) setReason(''); }
  return <form onSubmit={event => void submit(event)}><fieldset><legend>{legend}</legend>
    {(['resolved', 'unresolved'] as const).map(value => <label key={value} className="decision-choice"><input type="radio" name={`${legend}-outcome`} required value={value} checked={outcome === value} onChange={() => setOutcome(value)}/>{statusLabels[value]}</label>)}
  </fieldset><label>{reasonLabel}<textarea required maxLength={4000} value={reason} onChange={event => setReason(event.target.value)}/></label><button className="primary-button" disabled={busy}>{button}</button></form>;
}

function RemedyProposal({ busy, onSubmit }: { busy: boolean; onSubmit: (kind: RemedyKind, terms: string) => Promise<boolean> }) {
  const [kind, setKind] = useState<RemedyKind>('repair'); const [terms, setTerms] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (await onSubmit(kind, terms)) setTerms(''); }
  return <form onSubmit={event => void submit(event)}><label>Remedy type<select value={kind} onChange={event => setKind(event.target.value as RemedyKind)}>{Object.entries(remedyKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>Remedy terms<textarea required maxLength={4000} value={terms} onChange={event => setTerms(event.target.value)}/></label><button className="primary-button" disabled={busy}>Propose remedy</button></form>;
}

function DecisionCard({ view, dispute, userId, refresh }: { view: DecisionView; dispute: DecisionCase; userId: string; refresh: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const can = (action: CaseAction) => dispute.next_actions.includes(action);
  async function run(action: CaseAction, details: Record<string, string>) {
    setBusy(true); setError('');
    try { await actOnDispute(userId, dispute.id, action, details); refresh(); return true; }
    catch (failure) { setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'Action not confirmed. Retry safely.'); refresh(); return false; }
    finally { setBusy(false); }
  }
  const remedy = dispute.remedy;
  const unresolved = dispute.outcome?.outcome === 'unresolved';
  return <article className="dispute-card decision-card" aria-label="Case decision">
    <h3>{issueLabels[dispute.issue_type] ?? 'Exchange issue'} case</h3>
    <p className={`decision-status status-${dispute.status}`}><strong>Status</strong> {statusLabels[dispute.status] ?? dispute.status}{dispute.closed_at && <> · closed {when(dispute.closed_at)}</>}</p>
    {unresolved && <p className="dispute-unresolved"><strong>Unresolved outcome.</strong> This case stays visible as an unresolved trust indicator for both participants.</p>}
    {dispute.outcome && <p className="decision-outcome"><strong>{dispute.outcome.corrected ? 'Corrected outcome' : 'Outcome'}</strong> {statusLabels[dispute.outcome.outcome]}{dispute.outcome.reason ? `. ${dispute.outcome.reason}` : '. Settled by the agreed remedy.'}</p>}
    <p><strong>Next step</strong> {nextStep(dispute)}</p>
    {remedy && <div className="decision-remedy"><p><strong>Current remedy</strong> {remedyKinds[remedy.kind]}. {remedy.terms}</p>
      <p>Proposed by {roleLabel(view, dispute, userId, remedy.proposer_id)}. {remedy.agreed ? 'Both participants agreed.' : 'Awaiting agreement.'} Settlement confirmations {remedy.confirmed_by.length} of 2{remedy.confirmed_by.includes(userId) ? ', including yours' : ''}.</p></div>}
    {can('agree_remedy') && <button className="primary-button" disabled={busy} onClick={() => void run('agree_remedy', { remedy_id: remedy!.id })}>Agree to this remedy</button>}
    {can('confirm_settlement') && <button className="primary-button" disabled={busy} onClick={() => void run('confirm_settlement', { remedy_id: remedy!.id })}>Confirm settlement</button>}
    {can('propose_remedy') && <RemedyProposal busy={busy} onSubmit={(kind, terms) => run('propose_remedy', { kind, terms })}/>}
    {can('request_review') && <TextAction busy={busy} label="Why does this case need administrator review?" button="Request administrator review" onSubmit={reason => run('request_review', { reason })}/>}
    {can('open_review') && <TextAction busy={busy} required={dispute.status === 'replacement_agreed'} label={dispute.status === 'replacement_agreed' ? 'How has the agreed replacement stalled?' : 'Review note (optional)'} button="Open administrator review" onSubmit={note => run('open_review', note.trim() ? { note } : {})}/>}
    {can('decide') && <OutcomeAction busy={busy} legend="Case outcome" reasonLabel="Reason for this outcome" button="Record outcome" onSubmit={(outcome, reason) => run('decide', { outcome, reason })}/>}
    {can('correct_outcome') && <OutcomeAction busy={busy} legend="Corrected outcome" reasonLabel="Reason for the correction" button="Append correction" onSubmit={(outcome, reason) => run('correct_outcome', { outcome, reason })}/>}
    {can('record_recovery') && <TextAction busy={busy} label="How did the owner recover the item?" button="Record item recovery" onSubmit={reason => run('record_recovery', { reason })}/>}
    {error && <p role="alert">{error}</p>}
    <h4>Decision history</h4>
    {dispute.history.length === 0 ? <p>No remedy or review actions yet.</p> : <ol className="dispute-history" aria-label="Decision history">{dispute.history.map(entry => <li key={entry.id}>
      <strong>{roleLabel(view, dispute, userId, entry.actor_id)}</strong> {historyLabels[entry.action] ?? entry.action}{entry.remedy_kind ? `: ${remedyKinds[entry.remedy_kind]}` : ''}{entry.outcome ? `: ${statusLabels[entry.outcome]}` : ''}
      {entry.from_status !== entry.to_status && <> ({statusLabels[entry.from_status] ?? entry.from_status} to {statusLabels[entry.to_status] ?? entry.to_status})</>}{when(entry.created_at)}{entry.body && <p>{entry.body}</p>}</li>)}</ol>}
  </article>;
}

function ExchangeRecords({ view }: { view: DecisionView }) {
  const { handoff, reservation, events } = view.records;
  return <section className="dispute-card" aria-label="Relevant Exchange records"><h3>Relevant Exchange records</h3>
    <p>{view.kind === 'help' ? 'Help Exchange' : 'Item Exchange'}. Fulfillment {view.state.replaceAll('_', ' ')}{view.completed_at && <>, completed {when(view.completed_at)}</>}.</p>
    {view.kind === 'help' && <p>Help Exchanges have no item condition, custody or Return records.</p>}
    {reservation && <p>Reserved {reservation.starts_on} to {reservation.ends_on}. Replacement value ${reservation.replacement_value.toFixed(2)}. Listed condition: {reservation.condition}</p>}
    {reservation?.custody_unresolved && <p className="dispute-block"><strong>Item custody unresolved.</strong> The item stays unavailable until an administrator records recovery. Closing the case does not release it.</p>}
    {reservation && !reservation.custody_unresolved && !reservation.blocking && <p>Item custody is resolved. The reservation no longer blocks the Listing.</p>}
    {handoff?.handed_off_at && <p>Handoff recorded {when(handoff.handed_off_at)}. Condition: {handoff.condition}. Accessories: {handoff.accessories || 'none'}.</p>}
    <details><summary>Exchange event history ({events.length})</summary><ol className="dispute-history">{events.map((event, index) => <li key={index}>{event.kind.replaceAll('_', ' ')}{when(event.created_at)}</li>)}</ol></details>
  </section>;
}

export function DisputeDecisions({ userId, exchangeId }: { userId: string; exchangeId: string }) {
  const [state, refresh] = useBorrowingRead(userId, `dispute-decisions-${exchangeId}`, () => readDecisions(exchangeId));
  if (state.status !== 'ready' || state.data.cases.length === 0) return null;
  const view = state.data;
  return <section className="disputes-page dispute-decisions" aria-label="Remedies and decisions"><h2>Remedies and decisions</h2>
    {view.cases.map(dispute => <DecisionCard key={dispute.id} view={view} dispute={dispute} userId={userId} refresh={refresh}/>)}
    <ExchangeRecords view={view}/><DecisionNotices userId={userId}/></section>;
}

const noticeText: Record<string, string> = {
  item_dispute_remedy: 'A remedy was proposed, agreed or confirmed.', item_dispute_review: 'A case moved toward administrator review.',
  item_dispute_outcome: 'A case outcome was recorded.', item_dispute_recovery: 'An administrator recorded item recovery.',
};
function DecisionNotices({ userId }: { userId: string }) {
  const [state] = useBorrowingRead(userId, 'dispute-decision-notices', async () => {
    const result = await supabase.from('notifications').select('id,kind,created_at').eq('recipient_id', userId).in('kind', Object.keys(noticeText)).order('created_at', { ascending: false }).limit(20);
    if (result.error) throw result.error;
    return result.data;
  });
  if (state.status !== 'ready' || !state.data.length) return null;
  return <section aria-label="Decision notices"><h3>Decision notices</h3>{state.data.map(notice => <p key={notice.id}>{noticeText[notice.kind]} {when(notice.created_at)}</p>)}</section>;
}

export function DisputeReviewQueue({ userId }: { userId: string }) {
  const [state] = useBorrowingRead(userId, 'dispute-review-queue', async () => {
    const result = await supabase.from('disputes').select('id,exchange_id,status,issue_type,created_at').is('closed_at', null).neq('reporter_id', userId).neq('respondent_id', userId).order('created_at');
    if (result.error) throw result.error;
    return result.data;
  });
  if (state.status !== 'ready' || !state.data.length) return null;
  return <section className="disputes-page" aria-label="Cases to review"><h2>Cases to review</h2>{state.data.map(row => <p key={row.id}><a href={`/disputes/${row.exchange_id}`}>{issueLabels[row.issue_type] ?? 'Exchange issue'} · {statusLabels[row.status] ?? row.status}</a></p>)}</section>;
}
