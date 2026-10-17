import { z } from 'zod';

export const caseActions = ['propose_remedy', 'agree_remedy', 'confirm_settlement', 'request_review', 'open_review', 'decide', 'correct_outcome', 'record_recovery'] as const;
export type CaseAction = typeof caseActions[number];
export const remedyKinds = { repair: 'Borrower repairs the item', replacement: 'Borrower replaces the item', no_compensation: 'No compensation needed', other: 'Another agreed resolution' } as const;
export type RemedyKind = keyof typeof remedyKinds;

const historySchema = z.object({
  id: z.uuid(), action: z.string(), actor_id: z.uuid(), from_status: z.string(), to_status: z.string(),
  remedy_kind: z.enum(['repair', 'replacement', 'no_compensation', 'other']).nullable(), remedy_id: z.uuid().nullable(),
  outcome: z.enum(['resolved', 'unresolved']).nullable(), body: z.string().nullable(), corrects_id: z.uuid().nullable(), created_at: z.string(),
});
export const decisionCaseSchema = z.object({
  id: z.uuid(), exchange_id: z.uuid(), issue_type: z.string(), status: z.string(), reporter_id: z.uuid(), respondent_id: z.uuid(),
  created_at: z.string(), closed_at: z.string().nullable(),
  remedy: z.object({ id: z.uuid(), kind: z.enum(['repair', 'replacement', 'no_compensation', 'other']), terms: z.string(), proposer_id: z.uuid(), created_at: z.string(), agreed: z.boolean(), confirmed_by: z.array(z.uuid()) }).nullable(),
  outcome: z.object({ outcome: z.enum(['resolved', 'unresolved']), reason: z.string().nullable(), actor_id: z.uuid(), created_at: z.string(), corrected: z.boolean(), action_id: z.uuid() }).nullable(),
  history: z.array(historySchema),
  next_actions: z.array(z.enum(caseActions)),
});
export const decisionViewSchema = z.object({
  exchange_id: z.uuid(), kind: z.enum(['item', 'help']), state: z.string(), completed_at: z.string().nullable(),
  provider_id: z.uuid(), receiver_id: z.uuid(), participant: z.boolean(),
  records: z.object({
    handoff: z.object({ condition: z.string().nullable(), accessories: z.string().nullable(), handed_off_at: z.string().nullable() }).nullable(),
    reservation: z.object({ starts_on: z.string(), ends_on: z.string(), condition: z.string(), replacement_value: z.number(), custody_unresolved: z.boolean(), blocking: z.boolean() }).nullable(),
    events: z.array(z.object({ kind: z.string(), actor_id: z.uuid().nullable(), created_at: z.string() })),
  }),
  cases: z.array(decisionCaseSchema),
});
export type DecisionCase = z.infer<typeof decisionCaseSchema>;
export type DecisionView = z.infer<typeof decisionViewSchema>;

export const statusLabels: Record<string, string> = {
  issue_reported: 'Issue reported', repairing: 'Repairing', replacement_agreed: 'Replacement agreed', disputed: 'Disputed',
  admin_review: 'Administrator review', resolved: 'Resolved', unresolved: 'Unresolved',
};
export const historyLabels: Record<string, string> = {
  remedy_proposed: 'Proposed a remedy', remedy_agreed: 'Agreed to the remedy', settlement_confirmed: 'Confirmed settlement',
  review_requested: 'Requested administrator review', review_opened: 'Opened administrator review', outcome_recorded: 'Recorded the outcome',
  outcome_corrected: 'Appended an outcome correction', item_recovered: 'Recorded item recovery',
};

export function roleLabel(view: DecisionView, dispute: DecisionCase, userId: string, actorId: string | null) {
  if (actorId === userId) return 'You';
  if (actorId === dispute.reporter_id) return 'Reporter';
  if (actorId === dispute.respondent_id) return 'Respondent';
  return actorId && [view.provider_id, view.receiver_id].includes(actorId) ? 'Participant' : 'Administrator';
}

export function nextStep(dispute: DecisionCase) {
  if (dispute.closed_at) return dispute.outcome?.outcome === 'unresolved' ? 'Closed as unresolved. The unresolved indicator stays visible.' : 'Closed as resolved.';
  if (dispute.status === 'admin_review') return 'An administrator reviews submitted evidence and records a reasoned outcome.';
  if (dispute.status === 'disputed') return 'An administrator opens review of the contested case.';
  if (!dispute.remedy) return 'Either participant proposes a remedy or requests administrator review.';
  if (!dispute.remedy.agreed) return 'The other participant agrees to the proposed remedy, or proposes another.';
  return `Both participants confirm settlement (${dispute.remedy.confirmed_by.length} of 2 confirmed).`;
}
