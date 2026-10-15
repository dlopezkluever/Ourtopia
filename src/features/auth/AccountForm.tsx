import { useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';

type Mode = 'sign-in' | 'register' | 'recover';

export function AccountForm() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const titles = { 'sign-in': 'Good to have you here.', register: 'A little trust goes a long way.', recover: 'Let’s get you back in.' };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get('email'));
    const password = String(fields.get('password'));
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'recover') {
        const result = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/auth/callback` });
        if (result.error) throw result.error;
        setNotice('If an account exists for that email, a recovery link is on its way. Open it to choose a new password.');
      } else if (mode === 'register') {
        const result = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/auth/callback` } });
        if (result.error) throw result.error;
        setNotice('Check your inbox to verify your email. Open the link to finish joining Ourtopia.');
      } else {
        const result = await supabase.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not connect. Please try again.');
    } finally { setBusy(false); }
  }

  function changeMode(next: Mode) { setMode(next); setNotice(''); setError(''); }

  return <section className="account-card" aria-labelledby="account-title">
    <span className="eyebrow">YOUR NEXT CHAPTER, TOGETHER</span>
    <h2 id="account-title">{titles[mode]}</h2>
    <p className="muted">{mode === 'recover' ? 'We’ll email you a secure link to reset your password.' : 'A place for the people you know, and the things you can do for each other.'}</p>
    {mode !== 'recover' && <div className="tabs" aria-label="Account options">
      <button type="button" className={mode === 'sign-in' ? 'selected' : ''} onClick={() => changeMode('sign-in')}>Sign in</button>
      <button type="button" className={mode === 'register' ? 'selected' : ''} onClick={() => changeMode('register')}>Create account</button>
    </div>}
    <form onSubmit={submit}>
      <label htmlFor="email">Email address</label>
      <input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={busy}/>
      {mode !== 'recover' && <><div className="label-row"><label htmlFor="password">Password</label>{mode === 'sign-in' && <button type="button" className="text-button" onClick={() => changeMode('recover')}>Forgot password?</button>}</div>
        <input id="password" name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={8} required disabled={busy}/>
        {mode === 'register' && <p className="field-help">Use at least 8 characters. We’ll verify your email before you create a Community.</p>}
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice"><CheckCircle2 size={20}/>{notice}</p>}
      <Button type="submit" className="primary-button" disabled={busy}>{busy ? 'Please wait…' : mode === 'recover' ? 'Send recovery link' : mode === 'register' ? 'Create account' : 'Sign in'}<ArrowRight size={18}/></Button>
    </form>
    {mode === 'recover' && <button type="button" className="text-button back" onClick={() => changeMode('sign-in')}>Back to sign in</button>}
    <p className="privacy-note">Private by design. Your Community is only visible to its approved members.</p>
  </section>;
}
