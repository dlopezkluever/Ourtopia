import { z } from 'zod';

export const stalledReviewReasons: Record<string, string> = {
  missing_return_confirmation: 'A Return is missing a participant confirmation',
  overdue_return: 'An item Return is overdue',
  missing_help_confirmation: 'Help completion is missing a confirmation',
  unresolved_dispute: 'An Exchange issue was decided as unresolved',
};

export const decisionOutcomes = ['verified_completion', 'closed_without_completion'] as const;
export type DecisionOutcome = (typeof decisionOutcomes)[number];

export const evidenceKeys = ['return_record', 'condition', 'work_record'] as const;
export type EvidenceKey = (typeof evidenceKeys)[number];

const decisionSchema = z.object({
  outcome: z.enum(decisionOutcomes), reason: z.string(), evidence: z.record(z.string(), z.unknown()),
  reviewReason: z.string(), decidedBy: z.uuid(), decidedAt: z.string(),
}).nullable();

export const stalledReviewSchema = z.object({
  exchangeId: z.uuid(), kind: z.enum(['item', 'help']), state: z.string(), communityId: z.uuid(),
  providerId: z.uuid(), receiverId: z.uuid(), completedAt: z.string().nullable(), participant: z.boolean(),
  reasons: z.array(z.object({ reason: z.string(), queuedAt: z.string() })),
  record: z.object({
    handedOffAt: z.string().nullable(), returnedAt: z.string().nullable(), condition: z.string().nullable(),
    ownerConfirmedAt: z.string().nullable(), borrowerConfirmedAt: z.string().nullable(), contested: z.boolean(),
    helperConfirmedAt: z.string().nullable(), requesterConfirmedAt: z.string().nullable(), disagreement: z.string().nullable(),
    openDispute: z.boolean(), unresolvedDispute: z.boolean(),
  }),
  recordGaps: z.array(z.string()),
  decision: decisionSchema,
  custodyUnresolved: z.boolean(),
  recovery: z.object({ reason: z.string(), decidedBy: z.uuid(), decidedAt: z.string() }).nullable(),
  canDecide: z.boolean(),
  canRecover: z.boolean(),
});
export type StalledReview = z.infer<typeof stalledReviewSchema>;

export const queueSchema = z.array(z.object({
  exchangeId: z.uuid(), kind: z.enum(['item', 'help']), state: z.string(),
  reasons: z.array(z.string()), queuedAt: z.string(),
}));
export type QueueRow = z.infer<typeof queueSchema>[number];

export const gapLabels: Record<string, string> = {
  handoff: 'a recorded Handoff', return: 'a recorded Return', confirmation: 'a participant confirmation',
  conflict: 'a resolved condition or conflicting account', evidence: 'citation of the records',
};

export function missingForVerified(view: StalledReview, evidence: Record<EvidenceKey, boolean>) {
  const gaps = view.recordGaps.filter(gap => gap !== 'evidence');
  const cited = view.kind === 'item' ? evidence.return_record && evidence.condition : evidence.work_record;
  if (!cited) gaps.push('evidence');
  return gaps;
}
