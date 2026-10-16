import { z } from 'zod';

export const exchangeKindSchema = z.enum(['item', 'help']);
export type ExchangeKind = z.infer<typeof exchangeKindSchema>;

export const exchangeKindLabels: Record<ExchangeKind, string> = { item: 'Item Exchange', help: 'Help Exchange' };

export const emptyExchangeHistory = 'No completed Exchanges yet. Item loans and help Exchanges appear here after both participants confirm completion.';
