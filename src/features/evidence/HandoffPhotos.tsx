import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { evidenceSchema, type Evidence } from '../handoff/model';

export function Photo({ evidence, casePhoto = false, alt }: { evidence: Pick<Evidence, 'object_path'>; casePhoto?: boolean; alt?: string }) {
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
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
type UploadAttempt = { id: string; prepare: string; complete: string };
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
      const hash = await digest(await file.arrayBuffer());
      const key = `handoff-upload-${userId}-${disputeId ?? exchangeId}-${purpose ?? ''}${file.type}-${file.size}-${hash}`;
      const stored = sessionStorage.getItem(key);
      const attempt: UploadAttempt = stored ? JSON.parse(stored) : { id: crypto.randomUUID(), prepare: crypto.randomUUID(), complete: crypto.randomUUID() };
      sessionStorage.setItem(key, JSON.stringify(attempt));
      const prepared = disputeId
        ? await supabase.rpc('prepare_dispute_evidence', { p_intent_id: attempt.prepare, p_dispute_id: disputeId, p_evidence_id: attempt.id, p_mime_type: file.type, p_byte_size: file.size })
        : purpose === 'return' ? await supabase.rpc('prepare_return_evidence', { p_intent_id: attempt.prepare, p_exchange_id: exchangeId, p_evidence_id: attempt.id, p_mime_type: file.type, p_byte_size: file.size })
        : await supabase.rpc('prepare_exchange_evidence', { p_intent_id: attempt.prepare, p_exchange_id: exchangeId, p_evidence_id: attempt.id, p_mime_type: file.type, p_byte_size: file.size });
      if (prepared.error) throw prepared.error;
      const photo = evidenceSchema.parse(prepared.data);
      const uploaded = await supabase.storage.from('exchange-evidence').upload(photo.object_path, file, { contentType: file.type, upsert: false });
      if (uploaded.error) {
        const existing = await supabase.storage.from('exchange-evidence').download(photo.object_path);
        if (!existing.data || await digest(await existing.data.arrayBuffer()) !== hash) throw uploaded.error;
      }
      const completed = await supabase.rpc('complete_exchange_evidence', { p_intent_id: attempt.complete, p_evidence_id: photo.id });
      if (completed.error) throw completed.error;
      sessionStorage.removeItem(key); setFile(null); onChanged();
    } catch { setError('Photo not confirmed. Select the same file and retry safely, or continue without photos.'); }
    finally { setBusy(false); }
  }
  const returning = purpose === 'return' && !disputeId;
  return <section className="handoff-photos" aria-label={disputeId ? 'Submitted case photos' : returning ? 'Optional Return photos' : 'Optional Handoff photos'}><h3>{disputeId ? 'Case evidence' : returning ? 'Optional Return photos' : 'Optional photos'}</h3><p>{disputeId ? 'Submit relevant photos for both participants and this Community’s administrators. General conversations and other Handoff photos stay private.' : returning ? 'Photograph the item as it comes back if helpful. Only the two participants can see these photos. You can confirm Return without photos.' : 'Record existing marks with your camera if helpful. You can complete Handoff without photos.'}</p>
    <div className="handoff-photo-grid">{evidence.map(photo => <div key={photo.id}>{photo.state === 'ready' ? <Photo evidence={photo} casePhoto={!!disputeId} alt={returning ? 'Private Return condition' : undefined}/> : <p>Photo awaiting upload retry.</p>}</div>)}</div>
    {editable && <><label>Camera or photo<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)}/></label><button type="button" disabled={!file || busy} onClick={() => void upload()}>{busy ? 'Uploading photo...' : 'Upload or retry photo'}</button><p>After an interruption, select the same file to resume its saved identity.</p></>}
    {editable && !disputeId && <button type="button" onClick={() => setSkipped(true)}>Skip optional photos</button>}
    {skipped && <p role="status">{returning ? 'Photos skipped. Continue with the Return condition.' : 'Photos skipped. Continue with condition acknowledgment.'}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
