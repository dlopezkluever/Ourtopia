import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';

export function RecoveryForm({ onComplete }: { onComplete: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const password = String(new FormData(event.currentTarget).get('password'));
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setError(error.message);
    else { history.replaceState({}, '', '/'); onComplete(); }
  }
  return <section className="account-card"><h2>Choose a fresh start.</h2><p className="muted">Set a new password for your Ourtopia account.</p>
    <form onSubmit={submit}><label htmlFor="new-password">New password</label><input id="new-password" name="password" type="password" minLength={8} autoComplete="new-password" required/>
      {error && <p role="alert" className="error">{error}</p>}<Button type="submit" disabled={busy} className="primary-button">{busy ? 'Saving…' : 'Save new password'}</Button>
    </form></section>;
}
