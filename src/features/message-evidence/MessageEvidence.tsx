import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { messageEvidenceViewSchema, submissionSchema } from './model';

type Case = { id: string; reporter_id: string; respondent_id: string };
const when = (value: string) => new Date(value).toLocaleString();

async function readMessageEvidence(disputeId: string) {
  const result = await supabase.rpc('read_dispute_message_evidence', { p_dispute_id: disputeId });
  if (result.error) throw result.error;
  return messageEvidenceViewSchema.parse(result.data);
}

export function MessageEvidence({ dispute, userId }: { dispute: Case; userId: string }) {
  const [state, refresh] = useBorrowingRead(userId, `message-evidence-${dispute.id}`, () => readMessageEvidence(dispute.id));
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const party = (id: string) => id === userId ? 'You' : id === dispute.reporter_id ? 'Reporter' : 'Respondent';

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setStatus('');
    if (selected.length === 0) { setError('Select at least one message.'); return; }
    setBusy(true);
    const ids = [...selected].sort();
    const key = `dispute-command-messages-${userId}-${dispute.id}-${ids.join(',')}`;
    const intent = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, intent);
    try {
      const result = await supabase.rpc('submit_dispute_messages', { p_intent_id: intent, p_dispute_id: dispute.id, p_message_ids: ids });
      if (result.error) throw result.error;
      sessionStorage.removeItem(key);
      const outcome = submissionSchema.parse(result.data);
      setSelected([]);
      setStatus(outcome.added === 0 ? 'Already submitted. The existing snapshot was kept.' : `${outcome.added} selected ${outcome.added === 1 ? 'message' : 'messages'} copied into the case.`);
      refresh();
    } catch (failure) {
      setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'Submission not confirmed. Retry safely.');
    } finally { setBusy(false); }
  }

  if (state.status === 'loading') return <p role="status">Opening submitted messages...</p>;
  if (state.status === 'denied') return null;
  const view = state.data;
  const submittedByMe = new Set(view.snapshots.filter(row => row.submitter_id === userId).map(row => row.source_message_id));
  return <section className="message-evidence" aria-label="Submitted messages">
    <h3>Submitted messages</h3>
    <p className="message-evidence-note">Only messages a participant selects are copied into this case. Administrators never see the rest of the conversation.</p>
    {view.snapshots.length === 0 ? <p>No messages submitted yet.</p> : <ol className="message-snapshots">{view.snapshots.map(row => <li key={row.id} aria-label="Message snapshot">
      <blockquote>{row.body}</blockquote>
      <dl>
        <dt>Author</dt><dd>{party(row.source_author_id)}</dd>
        <dt>Sent</dt><dd><time dateTime={row.source_created_at}>{when(row.source_created_at)}</time></dd>
        <dt>Submitted by</dt><dd>{party(row.submitter_id)}</dd>
        <dt>Submitted</dt><dd><time dateTime={row.submitted_at}>{when(row.submitted_at)}</time></dd>
        <dt>Source message</dt><dd><code>{row.source_message_id}</code></dd>
      </dl>
    </li>)}</ol>}
    {view.can_submit && <form onSubmit={event => void submit(event)} aria-label="Select messages as evidence">
      <fieldset>
        <legend>Choose messages from your conversation with the other participant</legend>
        {view.sources.length === 0 ? <p>No messages with the other participant in this Community.</p> : view.sources.map(message => <label key={message.id} className="message-choice">
          <input type="checkbox" checked={selected.includes(message.id)} onChange={event => setSelected(current => event.target.checked ? [...current, message.id] : current.filter(id => id !== message.id))}/>
          <span><strong>{party(message.author_id)}</strong> <time dateTime={message.created_at}>{when(message.created_at)}</time>{submittedByMe.has(message.id) && <em> Already submitted</em>}<span className="message-choice-body">{message.body}</span></span>
        </label>)}
      </fieldset>
      {view.sources.length > 0 && <button className="primary-button" disabled={busy}>Submit selected messages</button>}
    </form>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
