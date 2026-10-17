import { z } from 'zod';

export const feedEntrySchema = z.object({ id: z.uuid(), kind: z.literal('item_loan_completed'), title: z.string(), completed_at: z.string(), owner: z.string().nullable(), borrower: z.string().nullable() }).strict();
export const feedSchema = z.array(feedEntrySchema);
export type FeedEntry = z.infer<typeof feedEntrySchema>;
export function feedSentence(entry: FeedEntry) {
  return `${entry.owner ?? 'A former member'} lent ${entry.title} to ${entry.borrower ?? 'a former member'}. The loan is complete.`;
}
