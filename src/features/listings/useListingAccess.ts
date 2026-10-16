import { useEffect, useEffectEvent, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import type { ReadState } from '../profiles/useAccessScopedRead';

export function useListingAccess<T>(userId: string, key: string, read: () => Promise<T>) {
  const [state, setState] = useState<ReadState<T>>({ status: 'loading' });
  const readCurrent = useEffectEvent(read);
  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load(clear: boolean) {
      const request = ++generation;
      if (clear) setState({ status: 'loading' });
      try {
        const data = await readCurrent();
        if (active && request === generation) setState({ status: 'ready', data });
      } catch {
        if (active && request === generation) setState({ status: 'denied', message: 'This Community is unavailable.' });
      }
    }
    void load(true);
    const clear = () => void load(true);
    const refresh = () => void load(false);
    const channel = supabase.channel(`listing-access-${userId}-${key}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${userId}` }, clear);
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active || !data.session) return;
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => { if (active && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) clear(); });
    });
    window.addEventListener('focus', refresh);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; void supabase.removeChannel(channel); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility); };
  }, [userId, key]);
  return state;
}
