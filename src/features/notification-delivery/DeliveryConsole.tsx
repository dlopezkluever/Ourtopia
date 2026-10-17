import { useEffect, useState } from 'react';
import { z } from 'zod';
import { supabase } from '../../lib/supabase/client';
import { Button } from '../../components/ui/button';
import { commandIntent } from '../membership/model';
import { deliveryLabels, deliverySchema, noticeLabel, type Delivery } from './model';

const localTime = (value: string) => new Date(value).toLocaleString();

export function DeliveryConsole({ userId }: { userId: string }) {
  const communityId = new URLSearchParams(location.search).get('community') ?? '';
  const before = new URLSearchParams(location.search).get('before');
  const [communities, setCommunities] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Delivery[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load(clear = false) {
      if (!active) return;
      const request = ++generation;
      if (clear) { setRows([]); setCommunities([]); }
      const memberships = await supabase.from('memberships').select('community_id').eq('user_id', userId).eq('status', 'active').eq('role', 'administrator');
      const allowed = (memberships.data ?? []).map(row => row.community_id);
      const communities = allowed.length ? await supabase.from('communities').select('id,name').in('id', allowed) : { data: [], error: null };
      const result = communityId && allowed.includes(communityId) ? await supabase.rpc('inspect_notification_deliveries', { p_community_id: communityId, p_before: before ?? undefined }) : null;
      if (!active || generation !== request) return;
      setCommunities(communities.data ?? []);
      setRows([]);
      if (memberships.error || communities.error || result?.error || (communityId && !allowed.includes(communityId))) {
        setError('Delivery diagnostics require current administrator access to this Community.');
      } else {
        try { setRows(result ? z.array(deliverySchema).parse(result.data) : []); setError(''); }
        catch { setError('Delivery diagnostics could not be loaded. Refresh to try again.'); }
      }
      setLoading(false);
    }
    void load(true);
    const refresh = () => void load(true);
    const timer = window.setInterval(refresh, 10000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const channel = supabase.channel(`delivery-access-${userId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${userId}` }, refresh).subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') refresh();
    });
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); void supabase.removeChannel(channel); };
  }, [userId, communityId, before, version]);

  async function retry(row: Delivery) {
    setBusy(true); setNotice('');
    const intent = commandIntent(`delivery-retry-${userId}`, row.id);
    try {
      const result = await supabase.rpc('retry_notification', { p_intent_id: intent.id, p_outbox_id: row.id });
      if (result.error) {
        setNotice(result.error.code === '55000' ? 'This delivery has already moved on. Refresh for its current status.' : 'Retry could not be requested. Check your current administrator access and try again.');
      } else { intent.complete(); setNotice('Retry requested. Delivery runs after the original workflow commits.'); }
      setVersion(value => value + 1);
    } catch { setNotice('The retry response was interrupted. Try again to reuse the same request.'); }
    finally { setBusy(false); }
  }

  return <section className="membership-page delivery-console"><a href="/">Back to your Communities</a><span className="eyebrow">COMMUNITY ADMINISTRATION</span><h1>Notice deliveries</h1><p>Inspect delivery attempts and retry failures. Retrying a notice preserves the original membership or Exchange outcome.</p>
    <label htmlFor="delivery-community">Community</label><select id="delivery-community" value={communityId} onChange={event => { location.href = `/deliveries?community=${event.target.value}`; }}><option value="">Choose a Community</option>{communities.map(community => <option value={community.id} key={community.id}>{community.name}</option>)}</select>
    <Button onClick={() => setVersion(value => value + 1)} disabled={busy}>Refresh deliveries</Button>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading deliveries...</p> : communityId && !error && rows.length === 0 ? <p>No deliveries yet.</p> : null}
    <div className="delivery-grid">{rows.map(row => <article key={row.id} className="membership-card delivery-card" aria-label={`${noticeLabel(row.kind)} ${row.channel} ${row.id}`}>
      <h2>{noticeLabel(row.kind)}</h2><p>{row.channel === 'email' ? 'Email' : 'In-app notice'}</p><p role="status">{deliveryLabels[row.state]}</p>
      {row.due && <p>Due for a worker attempt</p>}
      <dl><dt>Notice identity</dt><dd>{row.id}</dd><dt>Recipient identity</dt><dd>{row.recipient_id}</dd><dt>Attempts</dt><dd>{row.attempts}</dd><dt>Next attempt</dt><dd>{row.state === 'delivered' || row.state === 'suppressed' ? 'None' : localTime(row.next_attempt_at)}</dd>{row.delivered_at && <><dt>Delivered at</dt><dd>{localTime(row.delivered_at)}</dd></>}{row.reminder_due_at && <><dt>Reminder due</dt><dd>{localTime(row.reminder_due_at)}</dd><dt>Schedule</dt><dd>{row.current_schedule ? 'Current' : 'Obsolete'}</dd></>}</dl>
      {row.last_error && <p>{row.last_error}</p>}{row.state === 'failed' && <Button disabled={busy || row.current_schedule === false} onClick={() => void retry(row)}>Retry delivery</Button>}
      <details><summary>Attempt history ({row.history.length})</summary>{row.history.length === 0 && <p>No attempts yet.</p>}<ol>{row.history.map(attempt => <li key={attempt.number}>Attempt {attempt.number}. Started {localTime(attempt.started_at)}. {attempt.finished_at ? `Finished ${localTime(attempt.finished_at)}. ${attempt.error ?? (row.state === 'suppressed' ? 'Suppressed because the reminder schedule changed.' : 'Delivered.')}` : 'Processing.'}</li>)}</ol></details>
    </article>)}</div>{before && <a href={`/deliveries?community=${communityId}`}>Latest deliveries</a>}{rows.length === 50 && <p><a href={`/deliveries?community=${communityId}&before=${rows.at(-1)!.id}`}>Older deliveries</a></p>}
  </section>;
}
