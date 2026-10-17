import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import type { ReadState } from '../profiles/useAccessScopedRead';

// Access hints and lost channels clear cached requests first; decisions, notices, and focus re-read in place.
export function useBorrowingRead<T>(userId: string, key: string, read: () => Promise<T>) {
  const [state, setState] = useState<ReadState<T>>({ status: 'loading' });
  const readCurrent = useEffectEvent(read);
  const reloadRef = useRef<() => void>(() => undefined);
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
        if (active && request === generation) setState({ status: 'denied', message: error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Borrow Requests are unavailable.' });
      }
    }
    void load(true);
    const clear = () => void load(true);
    const refresh = () => void load(false);
    reloadRef.current = refresh;
    const channel = supabase.channel(`borrowing-${userId}-${key}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${userId}` }, clear)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notification_hints', filter: `recipient_id=eq.${userId}` }, refresh);
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (!data.session) { clear(); return; }
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => { if (active && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) clear(); });
    });
    window.addEventListener('focus', refresh);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false; reloadRef.current = () => undefined;
      void supabase.removeChannel(channel); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility);
    };
  }, [userId, key]);
  const reload = useCallback(() => reloadRef.current(), []);
  return [state, reload] as const;
}
