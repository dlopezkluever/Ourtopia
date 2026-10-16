import { z } from 'zod';
import { exchangeKindSchema } from '../exchanges/model';

export const standingSchema = z.object({ score: z.number().int().min(0).max(100), title: z.string(), completedInteractions: z.number().int().min(0) });
export type Standing = z.infer<typeof standingSchema>;

export const incidentSchema = z.object({ type: z.enum(['unresolved_dispute', 'serious_violation']), status: z.string() }).strict();
export const trustSchema = z.object({ globalScore: z.number().int(), completedInteractions: z.number().int(), incidents: z.array(incidentSchema) }).strict();
export type Trust = z.infer<typeof trustSchema>;

export const historyEventSchema = z.object({
  id: z.uuid(), rule: z.string(), points: z.number().int(), sourceKind: z.string(), exchangeId: z.uuid().nullable(),
  exchangeKind: exchangeKindSchema.nullable(), correctsEventId: z.uuid().nullable(), reason: z.string().nullable(), createdAt: z.string(),
});
export type HistoryEvent = z.infer<typeof historyEventSchema>;

const ruleLabels: Record<string, string> = {
  item_owner_share: 'Shared an item',
  item_borrower_return: 'Returned a borrowed item',
  help_helper_completed: 'Completed help',
};
export function ruleLabel(rule: string) { return ruleLabels[rule] ?? 'Verified standing change'; }

export const incidentLabels: Record<z.infer<typeof incidentSchema>['type'], string> = {
  unresolved_dispute: 'Unresolved Dispute',
  serious_violation: 'Serious violation',
};

export function standingText(score: number, title: string) { return `${score} — ${title}`; }
export function exchangeCount(count: number) { return `${count} completed ${count === 1 ? 'Exchange' : 'Exchanges'}`; }
export function signedPoints(points: number) { return points > 0 ? `+${points}` : String(points); }

export const localExplanation = 'Starts at 50. Adds the points of every verified Reputation Event in this Community, kept between 0 and 100. Shows Unproven until the first completed Exchange here.';
export const globalExplanation = 'Averages Community scores, weighted by completed Exchanges in each Community and rounded half up. Communities without completed Exchanges carry no weight. With none anywhere it stays 50 — Unproven.';
