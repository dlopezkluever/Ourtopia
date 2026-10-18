import { z } from 'zod';

export const messageSnapshotSchema = z.object({
  id: z.uuid(), dispute_id: z.uuid(), community_id: z.uuid(), source_message_id: z.uuid(), source_author_id: z.uuid(),
  source_created_at: z.string(), body: z.string(), submitter_id: z.uuid(), submitted_at: z.string(),
});
export const sourceMessageSchema = z.object({ id: z.uuid(), author_id: z.uuid(), body: z.string(), created_at: z.string() });
export const messageEvidenceViewSchema = z.object({
  dispute_id: z.uuid(), can_submit: z.boolean(), snapshots: z.array(messageSnapshotSchema), sources: z.array(sourceMessageSchema),
});
export const submissionSchema = z.object({ dispute_id: z.uuid(), added: z.number().int(), snapshots: z.array(messageSnapshotSchema) });
export type MessageSnapshot = z.infer<typeof messageSnapshotSchema>;
export type MessageEvidenceView = z.infer<typeof messageEvidenceViewSchema>;
