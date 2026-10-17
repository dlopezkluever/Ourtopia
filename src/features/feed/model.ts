import { z } from 'zod';

export const feedEntrySchema = z.discriminatedUnion('kind', [
  z.object({ id: z.uuid(), kind: z.literal('item_loan_completed'), title: z.string(), completed_at: z.string(), owner: z.string().nullable(), borrower: z.string().nullable() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('exchange_thank_you'), message: z.string(), created_at: z.string(), author: z.string().nullable(), recipient: z.string().nullable() }).strict(),
]);
export const feedSchema = z.array(feedEntrySchema);
export type FeedEntry = z.infer<typeof feedEntrySchema>;
export function feedSentence(entry: FeedEntry) {
  return entry.kind === 'item_loan_completed'
    ? `${entry.owner ?? 'A former member'} lent ${entry.title} to ${entry.borrower ?? 'a former member'}. The loan is complete.`
    : `${entry.author ?? 'A former member'} thanked ${entry.recipient ?? 'a former member'}: “${entry.message}”`;
}
