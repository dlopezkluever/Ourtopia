import { useEffect, useRef, useState, type FormEvent } from 'react';
import { decideStalledReview, readStalledQueue, readStalledReview } from './api';
import { gapLabels, missingForVerified, stalledReviewReasons, type DecisionOutcome, type EvidenceKey, type QueueRow, type StalledReview } from './model';

const emptyEvidence: Record<EvidenceKey, boolean> = { return_record: false, condition: false, work_record: false };

export function StalledReviewQueue({ communityId }: { communityId: string }) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { readStalledQueue(communityId).then(setRows, () => setError('Stalled review unavailable.')); }, [communityId]);
  return <section className="handoff-page stalled-review-queue" aria-labelledby="stalled-queue-title">
    <span className="eyebrow">ADMINISTRATOR REVIEW</span>
    <h1 id="stalled-queue-title">Stalled confirmations</h1>
    <p>These Exchanges stay in their current state until you record a reasoned decision. Silence never completes them.</p>
    {error && <p role="alert">{error}</p>}
    {rows === null && !error ? <p role="status">Opening stalled reviews...</p> : rows?.length === 0 ? <p>No stalled confirmations are waiting.</p> : null}
    {rows && rows.length > 0 && <ul className="stalled-review-list">{rows.map(row => <li key={row.exchangeId}>
      <a href={`/stalled/case/${row.exchangeId}`}>{row.kind === 'item' ? 'Item loan' : 'Help Exchange'} · {row.state.replace(/_/g, ' ')}</a>
      <span> · {row.reasons.map(reason => stalledReviewReasons[reason] ?? reason).join('; ')}</span>
    </li>)}</ul>}
  </section>;
}

export function StalledReviewCase({ exchangeId, userId }: { exchangeId: string; userId: string }) {
  const [view, setView] = useState<StalledReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { readStalledReview(exchangeId).then(setView, () => setError('Stalled review unavailable.')); }, [exchangeId, userId]);
  if (!view) return <section className="handoff-page"><p role={error ? 'alert' : 'status'}>{error ?? 'Opening stalled review...'}</p></section>;
  return <section className="handoff-page stalled-review-case" aria-labelledby="stalled-case-title">
    <span className="eyebrow">{view.kind === 'item' ? 'ITEM LOAN' : 'HELP EXCHANGE'}</span>
    <h1 id="stalled-case-title">Stalled confirmation</h1>
    <p>Reasons: {view.reasons.map(reason => stalledReviewReasons[reason.reason] ?? reason.reason).join('; ') || 'none recorded'}</p>
    <dl className="stalled-record">
      <dt>Current state</dt><dd>{view.state.replace(/_/g, ' ')}</dd>
      <dt>Handoff</dt><dd>{view.record.handedOffAt ? 'Recorded' : 'Not recorded'}</dd>
      <dt>Return</dt><dd>{view.record.returnedAt ? `Recorded, condition: ${view.record.condition ?? ''}` : 'Not recorded'}</dd>
      <dt>Return confirmations</dt><dd>{[view.record.ownerConfirmedAt, view.record.borrowerConfirmedAt].filter(Boolean).length} of 2</dd>
      <dt>Helper or requester confirmations</dt><dd>{[view.record.helperConfirmedAt, view.record.requesterConfirmedAt].filter(Boolean).length} of 2</dd>
      <dt>Open issue</dt><dd>{view.record.openDispute ? 'Open' : view.record.unresolvedDispute ? 'Decided as unresolved' : 'None'}</dd>
    </dl>
    {view.decision ? <DecisionSummary view={view} /> : view.canDecide ? <DecisionForm view={view} onDecided={setView} /> : <p>{view.participant ? 'You can answer this case in its Exchange. Only an administrator who is not a participant records the decision.' : 'Waiting for an administrator decision.'}</p>}
    <p><a href={`/stalled/${view.communityId}`}>Back to stalled confirmations</a></p>
  </section>;
}

function DecisionSummary({ view }: { view: StalledReview }) {
  const decision = view.decision!;
  return <section aria-labelledby="stalled-decision-title"><h2 id="stalled-decision-title">Recorded decision</h2>
    <p><strong>{decision.outcome === 'verified_completion' ? 'Verified completion' : 'Closed without completion'}</strong>. {decision.reason}</p>
    <p className="muted">Recorded {new Date(decision.decidedAt).toLocaleString()}</p></section>;
}

function DecisionForm({ view, onDecided }: { view: StalledReview; onDecided: (next: StalledReview) => void }) {
  const [outcome, setOutcome] = useState<DecisionOutcome>('closed_without_completion');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<Record<EvidenceKey, boolean>>(emptyEvidence);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef(crypto.randomUUID());
  const citations = view.kind === 'item' ? (['return_record', 'condition'] as const) : (['work_record'] as const);
  const gaps = outcome === 'verified_completion' ? missingForVerified(view, evidence) : [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onDecided(await decideStalledReview(intent.current, view.exchangeId, outcome, reason, evidence));
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : 'The decision was not recorded. Refresh and try again.');
    } finally { setBusy(false); }
  }
  return <form className="stalled-decision" onSubmit={submit} aria-labelledby="stalled-decide-title">
    <h2 id="stalled-decide-title">Record a decision</h2>
    <fieldset>
      <legend>Outcome</legend>
      <label><input type="radio" name="outcome" value="verified_completion" checked={outcome === 'verified_completion'} onChange={() => setOutcome('verified_completion')} /> Verified completion</label>
      <label><input type="radio" name="outcome" value="closed_without_completion" checked={outcome === 'closed_without_completion'} onChange={() => setOutcome('closed_without_completion')} /> Close without completion</label>
    </fieldset>
    <fieldset>
      <legend>Records you cite</legend>
      {citations.map(key => <label key={key}><input type="checkbox" checked={evidence[key]} onChange={event => setEvidence({ ...evidence, [key]: event.target.checked })} />
        {key === 'return_record' ? 'I checked the recorded Return' : key === 'condition' ? 'I checked the recorded condition and it is resolved' : 'I checked the supporting Exchange records or work evidence'}</label>)}
    </fieldset>
    <label>Reason for this decision<textarea name="reason" value={reason} onChange={event => setReason(event.target.value)} minLength={10} maxLength={4000} required rows={4} /></label>
    {outcome === 'verified_completion' && gaps.length > 0 && <p role="note">Still missing for verified completion: {gaps.map(gap => gapLabels[gap] ?? gap).join(', ')}.</p>}
    {message && <p role="alert">{message}</p>}
    <button type="submit" disabled={busy}>{busy ? 'Recording...' : 'Record decision'}</button>
  </form>;
}
