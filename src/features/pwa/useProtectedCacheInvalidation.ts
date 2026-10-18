import { useEffect } from 'react';
import { supabase } from '../../lib/supabase/client';
import { clearRevokedProtectedStorage } from './privacy';

// Membership refresh for protected client storage. Focus, visibility, access hints and channel errors re-read the
// account's active memberships; storage is cleared only when that successful read shows lost access. A failed read
// (offline, network drop) clears nothing, so drafts and intent ids survive app switches, camera trips and outages.
export function useProtectedCacheInvalidation(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let generation = 0;
    let known: Set<string> | null = null;
    async function refresh() {
      const request = ++generation;
      const result = await supabase.from('memberships').select('community_id').eq('user_id', userId!).eq('status', 'active');
      if (!active || request !== generation || result.error) return;
      const current = new Set(result.data.map(row => row.community_id));
      const lostAccess = known === null ? current.size === 0 : [...known].some(id => !current.has(id));
      known = current;
      clearRevokedProtectedStorage(userId!, current, lostAccess);
    }
    const revalidate = () => void refresh();
    const channel = supabase.channel(`pwa-cache-access-${userId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'membership_access_hints', filter: `user_id=eq.${userId}` }, revalidate);
    void refresh();
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active || !data.session) return;
      await supabase.realtime.setAuth(data.session.access_token);
      if (!active) return;
      channel.subscribe(status => { if (active && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) revalidate(); });
    });
    window.addEventListener('focus', revalidate);
    const visible = () => { if (document.visibilityState === 'visible') revalidate(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; void supabase.removeChannel(channel); window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visible); };
  }, [userId]);
}
