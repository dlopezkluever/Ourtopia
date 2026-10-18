import { useState, type FormEvent } from 'react';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { localDeadline } from '../borrowing/model';
import { HandoffPhotos, Photo } from '../evidence/HandoffPhotos';
import { issueTypes } from '../disputes/model';
import { standingText, exchangeCount } from '../reputation/model';
import { readReturn, returnCommand } from './api';
import { returnStep, reviewReasons, stepText, type ReturnAction, type ReturnView } from './model';
import { ThankExchange } from '../thank-yous/ThankExchange';

function person(view: ReturnView, id: string | null, userId: string) {
  if (!id) return 'Nobody';
  if (id === userId) return 'You';
  return id === view.owner_id ? 'The owner' : 'The borrower';
}

function Comparison({ view, userId }: { view: ReturnView; userId: string }) {
  const handoffPhotos = view.evidence.filter(photo => photo.purpose === 'handoff' && photo.state === 'ready');
  const returnPhotos = view.evidence.filter(photo => photo.purpose === 'return' && photo.state === 'ready');
  return <section aria-label="Handoff and Return comparison"><h2>Handoff and Return</h2><div className="return-compare">
    <div><h3>At Handoff</h3><p>Condition. {view.handoff.condition ?? 'Not recorded'}</p><p>Accessories. {view.handoff.accessories || 'None'}</p><p>{handoffPhotos.length} Handoff photos</p><div className="handoff-photo-grid">{handoffPhotos.map(photo => <Photo key={photo.id} evidence={photo}/>)}</div></div>
    <div><h3>At Return</h3>{view.record ? <><p>Condition. {view.record.condition}</p><p>Accessories. {view.record.accessories || 'None'}</p><p>Recorded by {person(view, view.record.recorded_by, userId).toLowerCase()} at <time dateTime={view.record.returned_at}>{localDeadline(view.record.returned_at)}</time>.</p></> : <p>No Return recorded yet.</p>}<p>{returnPhotos.length} Return photos</p><div className="handoff-photo-grid">{returnPhotos.map(photo => <Photo key={photo.id} evidence={photo} alt="Private Return condition"/>)}</div></div>
  </div></section>;
}

function ReturnCard({ view, userId, refresh }: { view: ReturnView; userId: string; refresh: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [condition, setCondition] = useState(view.record?.recorded_by === userId ? view.record.condition : ''); const [accessories, setAccessories] = useState(view.record?.recorded_by === userId ? view.record.accessories : '');
  const [matches, setMatches] = useState(false); const [disagreement, setDisagreement] = useState(''); const [issue, setIssue] = useState<keyof typeof issueTypes>('damage');
  async function act(action: ReturnAction, details: Record<string, string | boolean>) {
    const key = `handoff-command-${userId}-${view.exchange_id}-return-${view.revision}-${action}-${JSON.stringify(details)}`;
    const intent = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, intent);
    setBusy(true); setError('');
    try { await returnCommand(view, action, details, intent); sessionStorage.removeItem(key); refresh(); }
    catch (failure) { setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'The server did not confirm this action. Retry safely.'); }
    finally { setBusy(false); }
  }
  const submit = (event: FormEvent, action: ReturnAction, details: Record<string, string | boolean>) => { event.preventDefault(); void act(action, details); };
  const step = returnStep(view, userId);
  const open = view.state === 'checked_out' || view.state === 'return_pending';
  const ownConfirmed = view.record && (userId === view.owner_id ? view.record.owner_confirmed_at : view.record.borrower_confirmed_at);
  return <article className="handoff-card return-card" aria-label="Item Return"><span className="eyebrow">RETURN</span><h1>Item Return</h1>
    <p role="status" className="handoff-status">{view.state === 'completed' ? 'Loan completed' : view.state === 'return_pending' ? 'Return awaiting confirmation' : view.state === 'checked_out' ? 'Checked out' : view.state.replaceAll('_', ' ')}</p>
    <p><strong>Next step.</strong> {stepText[step]}</p>
    {view.state === 'checked_out' && <p>Return due by <time dateTime={view.return_due_at}>{localDeadline(view.return_due_at)}</time>.</p>}
    <Comparison view={view} userId={userId}/>
    {open && !view.record?.contested_at && <HandoffPhotos userId={userId} exchangeId={view.exchange_id} purpose="return" evidence={view.evidence.filter(photo => photo.purpose === 'return' && photo.uploader_id === userId)} editable onChanged={refresh}/>}
    {(step === 'record' || (step === 'await_counterpart' && view.record)) && <section aria-label="Record Return"><h2>{step === 'record' ? 'Record the Return' : 'Correct your Return record'}</h2>
      <form onSubmit={event => submit(event, 'record_return', { condition, accessories })}><label>Condition at Return<textarea required maxLength={2000} value={condition} onChange={event => setCondition(event.target.value)}/></label><label>Returned accessories<textarea required maxLength={2000} value={accessories} onChange={event => setAccessories(event.target.value)}/></label><p>Saving records that the item is physically back with its owner and confirms your account of its condition. The other participant then confirms or contests it.</p><button className="primary-button" disabled={busy}>{step === 'record' ? 'Record Return' : 'Update Return record'}</button></form></section>}
    {step === 'respond' && <><section aria-label="Confirm Return"><h2>Confirm the Return</h2><label className="handoff-check"><input type="checkbox" checked={matches} onChange={event => setMatches(event.target.checked)}/>The item is back and its condition and accessories match the recorded Return.</label><button className="primary-button" disabled={busy || !matches} onClick={() => void act('confirm_return', { condition_matches: true })}>Confirm Return</button></section>
      <form className="handoff-cancel" aria-label="Report a different condition" onSubmit={event => submit(event, 'contest_return', { condition: disagreement, issue_type: issue })}><h2>Condition does not match?</h2><label>Issue type<select value={issue} onChange={event => setIssue(event.target.value as keyof typeof issueTypes)}>{Object.entries(issueTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Condition you see<textarea required maxLength={2000} value={disagreement} onChange={event => setDisagreement(event.target.value)}/></label><p>This opens an Exchange issue for both participants and this Community’s administrators. Ordinary completion stays blocked until it is resolved.</p><button disabled={busy}>Report condition disagreement</button></form></>}
    {step === 'await_counterpart' && ownConfirmed && <p>You confirmed this Return. Waiting for the other participant.</p>}
    {(step === 'contested' || view.open_dispute) && <p className="dispute-block" role="note">Ordinary completion is blocked while an Exchange issue is open. <a href={`/disputes/${view.exchange_id}`}>Open Exchange issues</a></p>}
    {view.review.length > 0 && <section aria-label="Administrator review"><h2>Administrator review</h2>{view.review.map(item => <p key={item.reason}>{reviewReasons[item.reason]}. Queued <time dateTime={item.queued_at}>{localDeadline(item.queued_at)}</time>. The Exchange stays incomplete and earns no points.</p>)}</section>}
    {view.state === 'completed' && <section aria-label="Completed loan"><h2>Loan completed</h2><p>Both participants confirmed the Return{view.completed_at ? <> on <time dateTime={view.completed_at}>{localDeadline(view.completed_at)}</time></> : null}. One Qualifying Interaction was recorded for each participant.</p>
      <p>Your Community Solidarity Score is now {standingText(view.standing.score, view.standing.title)} with {exchangeCount(view.standing.completedInteractions)}.</p><p>{userId === view.owner_id ? 'You earned +2 for sharing this item.' : 'You earned +1 for returning this item.'} <a href="/standing">See your history</a></p></section>}
    {view.state === 'completed' && <ThankExchange userId={userId} communityId={view.community_id} exchangeId={view.exchange_id} onChanged={refresh}/>}
    {error && <p role="alert" className="error">{error}</p>}<button disabled={busy} onClick={refresh}>Refresh Return</button>
  </article>;
}

export function ReturnPanel({ userId, exchangeId }: { userId: string; exchangeId: string }) {
  const [state, refresh] = useBorrowingRead(userId, `return-${exchangeId}`, () => readReturn(exchangeId));
  if (state.status !== 'ready' || !state.data.handoff.handed_off_at) return null;
  return <section className="handoff-page return-page"><ReturnCard key={`${state.data.exchange_id}-${state.data.revision}-${state.data.state}`} view={state.data} userId={userId} refresh={refresh}/></section>;
}
