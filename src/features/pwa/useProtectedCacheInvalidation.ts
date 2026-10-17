import { useEffect } from 'react';
import { supabase } from '../../lib/supabase/client';
import { clearProtectedClientStorage } from './privacy';

export function useProtectedCacheInvalidation(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    const clear = () => clearProtectedClientStorage(false);
    const channel = supabase.channel(`pwa-cache-access-${userId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${userId}` }, clear);
    let active = true;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active || !data.session) return;
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => { if (active && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) clear(); });
    });
    window.addEventListener('focus', clear);
    const visible = () => { if (document.visibilityState === 'visible') clear(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; void supabase.removeChannel(channel); window.removeEventListener('focus', clear); document.removeEventListener('visibilitychange', visible); };
  }, [userId]);
}
