import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { checkoutUrl, readBilling, requestBilling, type Subscription, type BillingJob } from './model';

export function BillingPage({ user }: { user: User }) {
  const [communities, setCommunities] = useState<{ id: string; name: string }[]>([]);
  const [community, setCommunity] = useState('');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [job, setJob] = useState<BillingJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [failedAction, setFailedAction] = useState<'checkout' | 'cancel' | null>(null);
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load(clear = false) {
      const current = ++generation;
      if (clear) { setCommunities([]); setCommunity(''); }
      try {
        const [billing, communities] = await Promise.all([readBilling(), supabase.from('communities').select('id,name')]);
        if (!active || current !== generation) return;
        if (communities.error) throw communities.error;
        setReadError('');
        setSubscriptions(billing.subscriptions); setJob(billing.jobs[0] ?? null);
        setCommunities(communities.data); setCommunity(previous => communities.data.some(item => item.id === previous) ? previous : communities.data[0]?.id ?? '');
      } catch { if (active && current === generation) setReadError('Your test billing status could not be loaded. Refresh status to try again.'); }
      finally { if (active && current === generation) setLoading(false); }
    }
    void load();
    const refresh = () => void load(true);
    const channel = supabase.channel(`billing-membership-${user.id}`).on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${user.id}`,
    }, refresh).subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') refresh();
    });
    const timer = window.setInterval(() => void load(), 1000);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility); void supabase.removeChannel(channel); };
  }, [user.id, version]);

  async function act(kind: 'checkout' | 'cancel') {
    setBusy(true); setError(''); setMessage(''); setFailedAction(null);
    try {
      const outcome = await requestBilling(community, kind, user.id);
      setJob(outcome);
      if (kind === 'checkout') location.assign(checkoutUrl(outcome.checkout_url));
      else setMessage('Cancellation requested in Stripe test mode. The verified webhook will confirm your current status.');
      setVersion(value => value + 1);
    } catch (failure) { setFailedAction(kind); setError(failure instanceof Error ? failure.message : 'Test billing failed. Retry this action.'); }
    finally { setBusy(false); }
  }

  const current = subscriptions.find(item => !['canceled', 'incomplete_expired'].includes(item.status)) ?? subscriptions[0];
  const hasSubscription = current && !['canceled', 'incomplete_expired'].includes(current.status);
  return <section className="billing-page"><a href="/">Back to your Communities</a><span className="eyebrow">PILOT BILLING</span>
    <h1>A test run, together.</h1><p className="billing-intro">Try the $5 monthly subscription in Stripe test mode. Use test payment details only. No real payment is collected.</p>
    <div className="billing-access"><strong>Your Community access stays the same.</strong><p>Unpaid, failed, and canceled test subscriptions never change membership or administrator roles.</p></div>
    {(error || readError) && <p className="error" role="alert">{error || readError}</p>}{message && <p role="status">{message}</p>}
    {new URLSearchParams(location.search).has('checkout') && <p>Welcome back. A return from Checkout does not confirm payment. Your status below comes from a verified Stripe webhook.</p>}
    <article className="billing-card"><span className="billing-badge">STRIPE TEST MODE</span><h2>$5 <small>/ month</small></h2>
      {loading ? <p role="status">Loading test subscription status...</p> : <><p role="status" data-testid="billing-status">Test subscription status: <strong>{current?.status.replaceAll('_', ' ') ?? 'No test subscription'}</strong></p>
        {current && <p>Last verified {new Date(current.reconciled_at).toLocaleString()}. {current.cancel_at_period_end ? 'Cancellation is scheduled.' : ''}</p>}
        {job?.state === 'failed' && <p role="alert">{job.last_error}</p>}
        {job?.state === 'processing' && <p role="status">Your last test billing action is processing. Retry shortly if this continues.</p>}
        {communities.length > 0 ? <><label htmlFor="billing-community">Community membership for this request</label><select id="billing-community" value={community} onChange={event => setCommunity(event.target.value)}>{communities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <div className="billing-actions">{hasSubscription ? <Button disabled={busy} onClick={() => void act('cancel')}>{failedAction === 'cancel' ? 'Retry test cancellation' : 'Cancel test subscription'}</Button> : <Button disabled={busy} onClick={() => void act('checkout')}>{failedAction === 'checkout' || (job?.kind === 'checkout' && (job.state === 'failed' || job.state === 'processing')) ? 'Retry test checkout' : 'Start test checkout'}</Button>}
            <Button disabled={busy} variant="outline" onClick={() => { setError(''); setVersion(value => value + 1); }}>Refresh status</Button></div></> : <p>An approved Community membership is required to start a test billing action. Your own subscription status remains available here.</p>}
      </>}
    </article><p>Production billing activation is a separate first post-MVP release.</p>
  </section>;
}
