import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { errorMessage } from '../help/model';
import { needImageSchema, type NeedImage as Image } from './model';

const bucket = 'item-need-images';
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

function PrivateImage({ image }: { image: Image }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void supabase.storage.from(bucket).download(image.object_path).then(result => {
      if (!active || !result.data) return;
      objectUrl = URL.createObjectURL(result.data); setUrl(objectUrl);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image.object_path]);
  return url ? <img src={url} alt="What the author needs"/> : <p>Image unavailable. Refresh to check access.</p>;
}

export function NeedImage({ needId, images, canEdit, onChanged }: { needId: string; images: Image[]; canEdit: boolean; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = images.find(image => image.state !== 'removed');
  async function remove(imageId: string) {
    setError('');
    const result = await supabase.rpc('remove_item_need_image', { p_intent_id: crypto.randomUUID(), p_image_id: imageId });
    if (result.error) setError(errorMessage(result.error)); else onChanged();
  }
  async function upload() {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 5242880) { setError('Choose a JPEG, PNG, or WebP image up to 5 MB.'); return; }
    setBusy(true); setError('');
    try {
      const digest = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
      // The reserved identity survives a reload, so retrying the same file resumes instead of reserving a second image.
      const key = `item-need-upload-${needId}-${file.type}-${file.size}-${digest}`;
      let attempt: { imageId: string; prepare: string; complete: string } | null = null;
      try { attempt = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { attempt = null; }
      attempt ??= { imageId: crypto.randomUUID(), prepare: crypto.randomUUID(), complete: crypto.randomUUID() };
      sessionStorage.setItem(key, JSON.stringify(attempt));
      const prepared = await supabase.rpc('prepare_item_need_image', { p_intent_id: attempt.prepare, p_need_id: needId, p_image_id: attempt.imageId, p_mime_type: file.type, p_byte_size: file.size });
      if (prepared.error) throw prepared.error;
      const image = needImageSchema.parse(prepared.data);
      const uploaded = await supabase.storage.from(bucket).upload(image.object_path, file, { contentType: file.type, upsert: false });
      if (uploaded.error) {
        const existing = await supabase.storage.from(bucket).download(image.object_path);
        if (existing.error || !existing.data) throw uploaded.error;
        if (hex(await crypto.subtle.digest('SHA-256', await existing.data.arrayBuffer())) !== digest) throw new Error('The stored upload differs. Choose a fresh image.');
      }
      const completed = await supabase.rpc('complete_item_need_image', { p_intent_id: attempt.complete, p_image_id: image.id });
      if (completed.error) throw completed.error;
      sessionStorage.removeItem(key);
      setFile(null); onChanged();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  const shown = current && (current.state === 'ready' || canEdit) ? current : undefined;
  return <section aria-label="Need Post image"><h3>Image</h3>
    {shown ? <div className="listing-images"><div>{shown.state === 'ready' ? <PrivateImage image={shown}/> : <p>Upload awaiting retry.</p>}{canEdit && <button type="button" onClick={() => void remove(shown.id)}>Remove image</button>}</div></div> : <p>No image added.</p>}
    {canEdit && shown?.state !== 'ready' && <><label htmlFor="need-image">Optional private image (JPEG, PNG, WebP, up to 5 MB)</label><input id="need-image" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }}/>
      <button type="button" disabled={!file || busy} onClick={() => void upload()}>{busy ? 'Uploading…' : 'Upload or retry image'}</button><p className="field-help">Only current members of this Community can see it.</p></>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
