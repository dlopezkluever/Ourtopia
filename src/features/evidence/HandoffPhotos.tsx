import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { evidenceSchema, type Evidence } from '../handoff/model';
import { evidenceDigest, recoverEvidence, type EvidenceAttempt } from './recovery';

export function Photo({ evidence, casePhoto = false, alt }: { evidence: Evidence; casePhoto?: boolean; alt?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true; let objectUrl = '';
    void supabase.storage.from('exchange-evidence').download(evidence.object_path).then(({ data }) => {
      if (active && data) { objectUrl = URL.createObjectURL(data); setUrl(objectUrl); }
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [evidence.object_path]);
  return url ? <img src={url} alt={alt ?? (casePhoto ? 'Submitted case evidence' : 'Private Handoff condition')}/> : <p>Photo unavailable.</p>;
}
export function HandoffPhotos({ userId, exchangeId, disputeId, purpose, evidence, editable, onChanged }: { userId: string; exchangeId: string; disputeId?: string; purpose?: 'return'; evidence: Evidence[]; editable: boolean; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState(false);
  async function upload() {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 5242880) { setError('Choose a JPEG, PNG, or WebP photo up to 5 MB.'); return; }
    setBusy(true); setError('');
    try {
      const hash = await evidenceDigest(await file.arrayBuffer());
      const key = `handoff-upload-${userId}-${disputeId ?? exchangeId}-${purpose ?? ''}${file.type}-${file.size}-${hash}`;
      const stored = sessionStorage.getItem(key);
      const attempt: EvidenceAttempt = stored ? JSON.parse(stored) : { id: crypto.randomUUID(), prepare: crypto.randomUUID(), complete: crypto.randomUUID() };
      sessionStorage.setItem(key, JSON.stringify(attempt));
      if (disputeId) {
        const prepared = await supabase.rpc('prepare_dispute_evidence', { p_intent_id: attempt.prepare, p_dispute_id: disputeId, p_evidence_id: attempt.id, p_mime_type: file.type, p_byte_size: file.size });
        if (prepared.error) throw prepared.error;
        const photo = evidenceSchema.parse(prepared.data);
        const uploaded = await supabase.storage.from('exchange-evidence').upload(photo.object_path, file, { contentType: file.type, upsert: false });
        if (uploaded.error) {
          const existing = await supabase.storage.from('exchange-evidence').download(photo.object_path);
          if (!existing.data || await evidenceDigest(await existing.data.arrayBuffer()) !== hash) throw uploaded.error;
        }
        const completed = await supabase.rpc('complete_exchange_evidence', { p_intent_id: attempt.complete, p_evidence_id: photo.id });
        if (completed.error) throw completed.error;
      } else {
        await recoverEvidence(file, attempt, {
          authorize: async () => {
            const current = await supabase.auth.getUser();
            if (current.error || current.data.user?.id !== userId) throw new Error('Sign in to the same account before retrying.');
            const access = purpose === 'return'
              ? await supabase.rpc('read_item_return', { p_exchange_id: exchangeId })
              : await supabase.rpc('read_item_handoff', { p_exchange_id: exchangeId });
            if (access.error) throw access.error;
          },
          prepare: async (identity, photo) => {
            const result = purpose === 'return'
              ? await supabase.rpc('prepare_return_evidence', { p_intent_id: identity.prepare, p_exchange_id: exchangeId, p_evidence_id: identity.id, p_mime_type: photo.type, p_byte_size: photo.size })
              : await supabase.rpc('prepare_exchange_evidence', { p_intent_id: identity.prepare, p_exchange_id: exchangeId, p_evidence_id: identity.id, p_mime_type: photo.type, p_byte_size: photo.size });
            if (result.error) throw result.error;
            return result.data;
          },
          upload: (path, photo) => supabase.storage.from('exchange-evidence').upload(path, photo, { contentType: photo.type, upsert: false }),
          download: async path => {
            const result = await supabase.storage.from('exchange-evidence').download(path);
            if (result.error) throw result.error;
            return result.data;
          },
          complete: async identity => {
            const result = await supabase.rpc('complete_exchange_evidence', { p_intent_id: identity.complete, p_evidence_id: identity.id });
            if (result.error) throw result.error;
            return result.data;
          },
        });
      }
      sessionStorage.removeItem(key); setFile(null); onChanged();
    } catch { setError('Photo not confirmed. Select the same file and retry safely, or continue without photos.'); }
    finally { setBusy(false); }
  }
  const returning = purpose === 'return' && !disputeId;
  return <section className="handoff-photos" aria-label={disputeId ? 'Submitted case photos' : returning ? 'Optional Return photos' : 'Optional Handoff photos'}><h3>{disputeId ? 'Case evidence' : returning ? 'Optional Return photos' : 'Optional photos'}</h3><p>{disputeId ? 'Submit relevant photos for both participants and this Community’s administrators. General conversations and other Handoff photos stay private.' : returning ? 'Photograph the item as it comes back if helpful. Only the two participants can see these photos. You can confirm Return without photos.' : 'Record existing marks with your camera if helpful. You can complete Handoff without photos.'}</p>
    <div className="handoff-photo-grid">{evidence.map(photo => <div key={photo.id}>{photo.state === 'ready' ? <Photo evidence={photo} casePhoto={!!disputeId} alt={returning ? 'Private Return condition' : undefined}/> : <p>Photo awaiting upload retry.</p>}</div>)}</div>
    {editable && <><label>Camera or photo<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)}/></label><button type="button" disabled={!file || busy} onClick={() => void upload()}>{busy ? 'Uploading photo...' : 'Upload or retry photo'}</button><p>After an interruption, select the same file to resume its saved identity.</p>{returning && <p><a href={`/pwa/evidence/${exchangeId}?purpose=return`}>Recover an interrupted Return photo</a></p>}</>}
    {editable && !disputeId && <button type="button" onClick={() => setSkipped(true)}>Skip optional photos</button>}
    {skipped && <p role="status">{returning ? 'Photos skipped. Continue with the Return condition.' : 'Photos skipped. Continue with condition acknowledgment.'}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
