import { useEffect, useEffectEvent, useState } from 'react';
import { supabase } from '../../lib/supabase/client';

export type ReadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'denied'; message: string };

export function useAccessScopedRead<T>(userId: string, key: string, read: () => Promise<T>) {
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
      } catch (error) {
        if (active && request === generation) setState({ status: 'denied', message: error && typeof error === 'object' && 'message' in error ? String(error.message) : 'This view is unavailable.' });
      }
    }
    void load(true);
    // Focus and visibility revalidate in place so editors and file inputs stay mounted; a failed read still denies.
    const revalidate = () => void load(false);
    const refresh = () => void load(true);
    const channel = supabase.channel(`profile-access-${userId}-${key}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${userId}` }, refresh);
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active || !data.session) return;
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => {
        if (!active) return;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') refresh();
      });
    });
    window.addEventListener('focus', revalidate);
    const visibility = () => { if (document.visibilityState === 'visible') revalidate(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; void supabase.removeChannel(channel); window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visibility); };
  }, [userId, key]);
  return state;
}
