import { z } from 'zod';

export const feedEntrySchema = z.discriminatedUnion('kind', [
  z.object({ id: z.uuid(), kind: z.literal('item_loan_completed'), title: z.string(), completed_at: z.string(), owner: z.string().nullable(), borrower: z.string().nullable() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('help_completed'), title: z.string(), completed_at: z.string(), owner: z.string().nullable(), borrower: z.string().nullable() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('exchange_thank_you'), message: z.string(), created_at: z.string(), author: z.string().nullable(), recipient: z.string().nullable() }).strict(),
]);
export const feedSchema = z.array(feedEntrySchema);
export type FeedEntry = z.infer<typeof feedEntrySchema>;
export function feedSentence(entry: FeedEntry) {
  if (entry.kind === 'item_loan_completed') return `${entry.owner ?? 'A former member'} lent ${entry.title} to ${entry.borrower ?? 'a former member'}. The loan is complete.`;
  if (entry.kind === 'help_completed') return `${entry.owner ?? 'A former member'} completed help for ${entry.borrower ?? 'a former member'}: ${entry.title}.`;
  return `${entry.author ?? 'A former member'} thanked ${entry.recipient ?? 'a former member'}: “${entry.message}”`;
}
