import { z } from 'zod';

export const voteResponse = z.object({ id: z.uuid(), author_id: z.uuid(), body: z.string(), created_at: z.string() });
export const voteEvidence = z.object({ id: z.uuid(), author_id: z.uuid(), body: z.string(), created_at: z.string() });
export const disciplinaryVote = z.object({
  id: z.uuid(), community_id: z.uuid(), accused_id: z.uuid(), opened_by: z.uuid(), reason: z.string(), opened_at: z.string(), closes_at: z.string(),
  eligible_count: z.number().int(), state: z.enum(['open', 'passed', 'failed']), turnout: z.number().int().nullable(),
  remove_votes: z.number().int().nullable(), retain_votes: z.number().int().nullable(), closed_at: z.string().nullable(),
  can_respond: z.boolean(), can_vote: z.boolean(), can_close: z.boolean(), my_ballot: z.enum(['remove', 'retain']).nullable(),
  evidence: z.array(voteEvidence), responses: z.array(voteResponse),
});
export type DisciplinaryVote = z.infer<typeof disciplinaryVote>;

export const voteStateLabel: Record<DisciplinaryVote['state'], string> = { open: 'Open', passed: 'Passed', failed: 'Failed' };
export const ballotLabels = { remove: 'Remove the member', retain: 'Keep the member' } as const;
export const voteNoticeMessages: Record<string, string> = {
  disciplinary_vote_opened: 'A seven-day Community removal vote is open. Review the allegation, respond if accused, or vote if eligible.',
  disciplinary_vote_ending_soon: 'A Community removal vote closes in 24 hours. Review it in Disciplinary votes.',
  disciplinary_vote_response: 'The accused member submitted a response to a removal vote. Review it in Disciplinary votes.',
  disciplinary_vote_closed: 'A Community removal vote has a recorded result. A passing result needs a separate administrator action.',
};
