import { z } from 'zod';

export const exchangeKindSchema = z.enum(['item', 'help']);
export type ExchangeKind = z.infer<typeof exchangeKindSchema>;

export const exchangeKindLabels: Record<ExchangeKind, string> = { item: 'Item Exchange', help: 'Help Exchange' };

export const emptyExchangeHistory = 'No completed Exchanges yet. Item loans and help Exchanges appear here after both participants confirm completion.';

export const helpExchangeStateSchema = z.enum(['committed', 'scheduled', 'completion_pending', 'completed', 'cancelled', 'closed_without_completion']);
export type HelpExchangeState = z.infer<typeof helpExchangeStateSchema>;
export const helpExchangeStateLabels: Record<HelpExchangeState, string> = {
  committed: 'Committed', scheduled: 'Scheduled', completion_pending: 'Awaiting confirmation', completed: 'Completed',
  cancelled: 'Cancelled', closed_without_completion: 'Closed without completion',
};
