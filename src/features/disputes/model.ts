import { z } from 'zod';
import { evidenceSchema } from '../handoff/model';

export const caseSchema = z.object({
  id: z.uuid(), exchange_id: z.uuid(), reporter_id: z.uuid(), respondent_id: z.uuid(),
  issue_type: z.enum(['damage', 'missing_item', 'other']), status: z.string(), closed_at: z.string().nullable(),
  responses: z.array(z.object({ id: z.uuid(), author_id: z.uuid(), body: z.string(), created_at: z.string() })),
  evidence: z.array(evidenceSchema),
});
export const disputeViewSchema = z.object({
  exchange_id: z.uuid(), state: z.string(), completed_at: z.string().nullable(), participant: z.boolean(), can_report: z.boolean(), cases: z.array(caseSchema),
});
export type DisputeCase = z.infer<typeof caseSchema>;
export type DisputeView = z.infer<typeof disputeViewSchema>;
export const issueTypes = { damage: 'Damage or condition', missing_item: 'Missing item or accessories', other: 'Other Exchange problem' };
