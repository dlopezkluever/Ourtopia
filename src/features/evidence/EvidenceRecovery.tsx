import { useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { handoffSchema } from '../handoff/model';
import { useAccessScopedRead } from '../profiles/useAccessScopedRead';
import { evidenceDigest, recoverEvidence, type EvidenceAttempt } from './recovery';

export function EvidenceRecovery({ userId, exchangeId }: { userId: string; exchangeId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const access = useAccessScopedRead(userId, `photo-recovery-${exchangeId}`, async () => {
    const result = await supabase.rpc('read_item_handoff', { p_exchange_id: exchangeId });
    if (result.error) throw result.error;
    return handoffSchema.parse(result.data);
  });
  async function retry() {
    if (!file) return;
    setBusy(true); setMessage('');
    try {
      const hash = await evidenceDigest(await file.arrayBuffer());
      const key = `handoff-upload-${userId}-${exchangeId}-${file.type}-${file.size}-${hash}`;
      const saved = sessionStorage.getItem(key);
      const attempt: EvidenceAttempt = saved ? JSON.parse(saved) : { id: crypto.randomUUID(), prepare: crypto.randomUUID(), complete: crypto.randomUUID() };
      sessionStorage.setItem(key, JSON.stringify(attempt));
      await recoverEvidence(file, attempt, {
        authorize: async () => {
          const current = await supabase.auth.getUser();
          if (current.error || current.data.user?.id !== userId) throw new Error('Sign in to the same account before retrying.');
          const result = await supabase.rpc('read_item_handoff', { p_exchange_id: exchangeId }); if (result.error) throw result.error;
        },
        prepare: async (identity, photo) => {
          const result = await supabase.rpc('prepare_exchange_evidence', { p_intent_id: identity.prepare, p_exchange_id: exchangeId, p_evidence_id: identity.id, p_mime_type: photo.type, p_byte_size: photo.size });
          if (result.error) throw result.error; return result.data;
        },
        upload: (path, photo) => supabase.storage.from('exchange-evidence').upload(path, photo, { contentType: photo.type, upsert: false }),
        download: async path => { const result = await supabase.storage.from('exchange-evidence').download(path); if (result.error) throw result.error; return result.data; },
        complete: async identity => { const result = await supabase.rpc('complete_exchange_evidence', { p_intent_id: identity.complete, p_evidence_id: identity.id }); if (result.error) throw result.error; return result.data; },
      });
      sessionStorage.removeItem(key); setFile(null); setMessage('Photo confirmed. Exchange state is unchanged.');
    } catch { setMessage('Photo not confirmed. Reconnect, select the same file, and retry. Your current server access and Exchange state must still allow it. Photos remain optional.'); }
    finally { setBusy(false); }
  }
  return <section className="draft-layout"><h1>Recover an optional photo</h1><p>Select the same camera photo after an interruption. A retry reuses its evidence identity. This never confirms Handoff or Return.</p>
    {access.status === 'ready' ? <><label htmlFor="recover-photo">Camera or photo</label><input id="recover-photo" type="file" capture="environment" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)}/><button className="primary-button" type="button" disabled={!file || busy} onClick={() => void retry()}>{busy ? 'Checking and uploading...' : 'Retry optional photo'}</button></> : <p role="status">Photo recovery unavailable until current access is checked online.</p>}
    {message && <p role="status">{message}</p>}<p><a href={`/handoffs/${exchangeId}`}>Back to Handoff without adding photos</a></p>
  </section>;
}
