import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import type { Database } from '../../lib/supabase/database.types';
import { noticeKinds } from './model';

type Notice = Database['public']['Tables']['notifications']['Row'];

export function NotificationList({ userId, version }: { userId: string; version: number }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load() {
      const request = ++generation;
      const result = await supabase.from('notifications').select('*').eq('recipient_id', userId).order('created_at', { ascending: false });
      if (active && request === generation) { setNotices(result.data ?? []); setError(result.error?.message ?? ''); }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [userId, version]);
  return <section aria-label="Notifications"><h2>Your notices</h2>{error && <p role="alert">{error}</p>}{notices.length === 0 && <p>No notices yet.</p>}{notices.map(notice => <article className="membership-card" key={notice.id}><p>{noticeKinds[notice.kind]?.message ?? 'You have a new notification.'}</p><time dateTime={notice.created_at}>{new Date(notice.created_at).toLocaleString()}</time></article>)}</section>;
}
