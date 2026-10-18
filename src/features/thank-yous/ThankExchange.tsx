import { useRef, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase/client';
import { useBorrowingRead } from '../borrowing/useBorrowingRead';
import { thankYouResultSchema, thankYouSchema } from './model';

export function ThankExchange({ userId, communityId, exchangeId, onChanged }: { userId: string; communityId: string; exchangeId: string; onChanged: () => void }) {
  const [state, reload] = useBorrowingRead(userId, `thank-you-${exchangeId}`, async () => {
    const result = await supabase.from('exchange_thank_yous').select('id,community_id,exchange_id,author_id,recipient_id,event_id,message,created_at').eq('community_id', communityId).eq('exchange_id', exchangeId).order('created_at');
    if (result.error) throw result.error;
    return thankYouSchema.array().parse(result.data);
  });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const memory = useRef<{ message: string; intent: string } | null>(null);
  if (state.status !== 'ready') return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    const intent = memory.current?.message === text ? memory.current.intent : crypto.randomUUID();
    memory.current = { message: text, intent };
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await supabase.rpc('thank_exchange', { p_intent_id: intent, p_exchange_id: exchangeId, p_message: text });
      if (result.error) throw result.error;
      const saved = thankYouResultSchema.parse(result.data);
      memory.current = null; setMessage(''); setNotice(saved.points_awarded ? 'Your partner received one thank-you point.' : 'Your partner has already received the thank-you point for this Exchange.');
      reload(); onChanged();
    } catch (cause) {
      setError(cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : 'The thank-you could not be saved. Retry safely.');
    } finally { setBusy(false); }
  }
  return <section className="exchange-thank-yous" aria-label="Thank your Exchange partner">
    <h3>Thank your Exchange partner</h3>
    {state.data.map(thankYou => <p key={thankYou.id}><strong>{thankYou.author_id === userId ? 'You wrote:' : 'Your partner wrote:'}</strong> {thankYou.message}</p>)}
    <form onSubmit={event => void submit(event)}>
      <label htmlFor={`thank-you-${exchangeId}`}>A public thank-you <span className="optional">(visible inside this Community)</span></label>
      <textarea id={`thank-you-${exchangeId}`} value={message} onChange={event => setMessage(event.target.value)} maxLength={500} required disabled={busy}/>
      <button className="primary-button" disabled={busy || message.trim().length === 0}>{busy ? 'Saving…' : 'Thank your partner'}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
