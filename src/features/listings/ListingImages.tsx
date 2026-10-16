import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { errorMessage, imageSchema, type ListingImage } from './model';

function PrivateImage({ image }: { image: ListingImage }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void supabase.storage.from('listing-images').download(image.object_path).then(result => {
      if (!active || !result.data) return;
      objectUrl = URL.createObjectURL(result.data); setUrl(objectUrl);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image.object_path]);
  return url ? <img src={url} alt="Shared item"/> : <p>Image unavailable. Refresh to check access.</p>;
}

export function ListingImages({ listingId, images, canEdit, onChanged }: { listingId: string; images: ListingImage[]; canEdit: boolean; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ fingerprint: string; imageId: string; prepare: string; complete: string } | null>(null);
  async function remove(imageId: string) {
    const result = await supabase.rpc('remove_listing_image', { p_intent_id: crypto.randomUUID(), p_image_id: imageId });
    if (result.error) setError(result.error.message); else onChanged();
  }
  async function upload() {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5242880 || file.size === 0) { setError('Choose a JPEG, PNG, or WebP image up to 5 MB.'); return; }
    setBusy(true); setError('');
    try {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
      const fingerprint = `${file.type}-${file.size}-${digest}`;
      const key = `listing-upload-${listingId}-${fingerprint}`;
      let attempt = pending?.fingerprint === fingerprint ? pending : null;
      if (!attempt) {
        try { attempt = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { attempt = null; }
      }
      attempt ??= { fingerprint, imageId: crypto.randomUUID(), prepare: crypto.randomUUID(), complete: crypto.randomUUID() };
      setPending(attempt); sessionStorage.setItem(key, JSON.stringify(attempt));
      const prepared = await supabase.rpc('prepare_listing_image', { p_intent_id: attempt.prepare, p_listing_id: listingId, p_image_id: attempt.imageId, p_mime_type: file.type, p_byte_size: file.size });
      if (prepared.error) throw prepared.error;
      const image = imageSchema.parse(prepared.data);
      const uploaded = await supabase.storage.from('listing-images').upload(image.object_path, file, { contentType: file.type, upsert: false });
      if (uploaded.error) {
        const existing = await supabase.storage.from('listing-images').download(image.object_path);
        if (existing.error || !existing.data) throw uploaded.error;
        const recovered = await crypto.subtle.digest('SHA-256', await existing.data.arrayBuffer());
        if (Array.from(new Uint8Array(recovered), byte => byte.toString(16).padStart(2, '0')).join('') !== digest) throw new Error('Stored upload differs. Choose a fresh image.');
      }
      const completed = await supabase.rpc('complete_listing_image', { p_intent_id: attempt.complete, p_image_id: image.id });
      if (completed.error) throw completed.error;
      sessionStorage.removeItem(key);
      setFile(null); setPending(null); onChanged();
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <section aria-label="Listing images"><h3>Images</h3><div className="listing-images">{images.filter(image => image.state !== 'removed' && (image.state === 'ready' || canEdit)).map((image, index) => <div key={image.id}>{image.state === 'ready' ? <PrivateImage image={image}/> : <p>Upload awaiting retry.</p>}{canEdit && <button type="button" onClick={() => void remove(image.id)}>Remove image {index + 1}</button>}</div>)}</div>
    {canEdit && <><label htmlFor="listing-image">Private image (JPEG, PNG, WebP, up to 5 MB)</label><input id="listing-image" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }}/><button type="button" disabled={!file || busy} onClick={() => void upload()}>{busy ? 'Uploading...' : 'Upload or retry image'}</button><p className="field-help">Retry the same file after an interruption. Images are only available to current Community members.</p></>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
