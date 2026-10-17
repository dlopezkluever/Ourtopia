import { evidenceSchema } from '../handoff/model';

export type EvidenceAttempt = { id: string; prepare: string; complete: string };
export type EvidenceAdapter = {
  authorize: () => Promise<void>;
  prepare: (attempt: EvidenceAttempt, file: File) => Promise<unknown>;
  upload: (path: string, file: File) => Promise<{ error: unknown }>;
  download: (path: string) => Promise<Blob | null>;
  complete: (attempt: EvidenceAttempt) => Promise<unknown>;
};
export const evidenceDigest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

// Handoff and Return adapters own server commands. This helper never advances an Exchange.
export async function recoverEvidence(file: File, attempt: EvidenceAttempt, adapter: EvidenceAdapter) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 5242880) throw new Error('Choose a JPEG, PNG, or WebP photo up to 5 MB.');
  await adapter.authorize();
  const photo = evidenceSchema.parse(await adapter.prepare(attempt, file));
  if (photo.id !== attempt.id || photo.byte_size !== file.size || photo.mime_type !== file.type) throw new Error('Evidence retry identity does not match.');
  await adapter.authorize();
  const uploaded = await adapter.upload(photo.object_path, file);
  if (uploaded.error) {
    await adapter.authorize();
    const existing = await adapter.download(photo.object_path);
    if (!existing || await evidenceDigest(await existing.arrayBuffer()) !== await evidenceDigest(await file.arrayBuffer())) throw uploaded.error;
  }
  await adapter.authorize();
  return evidenceSchema.parse(await adapter.complete(attempt));
}
