import { z } from 'zod';
import { categories } from '../listings/model';

export const urgencies = { flexible: 'Flexible', soon: 'Needed soon', urgent: 'Urgent' } as const;
export type Urgency = keyof typeof urgencies;
const urgencySchema = z.enum(Object.keys(urgencies) as [Urgency, ...Urgency[]]);

const money = z.union([z.number(), z.string()]).nullable().transform(value => value === null ? null : Number(value));
export const itemNeedSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), author_id: z.uuid(), status: z.enum(['open', 'withdrawn']), version: z.number().int(),
  title: z.string(), description: z.string(), category: z.enum(categories), starts_on: z.iso.date(), ends_on: z.iso.date(),
  urgency: urgencySchema, value_min: money, value_max: money, created_at: z.string(), updated_at: z.string(),
});
export type ItemNeed = z.infer<typeof itemNeedSchema>;

export const needImageSchema = z.object({ id: z.uuid(), need_id: z.uuid(), object_path: z.string(), mime_type: z.string(), byte_size: z.number(), state: z.enum(['pending', 'ready', 'removed']) });
export type NeedImage = z.infer<typeof needImageSchema>;

export const needResponseSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), need_id: z.uuid(), listing_id: z.uuid(), responder_id: z.uuid(),
  status: z.enum(['offered', 'withdrawn']), note: z.string(), created_at: z.string(), withdrawn_at: z.string().nullable(),
});
export type NeedResponse = z.infer<typeof needResponseSchema>;

const optionalMoney = z.preprocess(value => value === '' || value === undefined ? null : value, z.coerce.number().min(0, 'Values start at $0.').max(1000000, 'Values can be at most $1,000,000.').nullable());
export const needFieldsSchema = z.object({
  title: z.string().trim().min(2, 'Title needs at least 2 characters.').max(120, 'Title can be up to 120 characters.'),
  description: z.string().min(1, 'Describe what you need.').max(2000, 'Description can be up to 2000 characters.'),
  category: z.enum(categories), urgency: urgencySchema,
  starts_on: z.iso.date('Choose the first day you need it.'), ends_on: z.iso.date('Choose the last day you need it.'),
  value_min: optionalMoney, value_max: optionalMoney,
}).refine(value => value.starts_on <= value.ends_on, 'The last day must be on or after the first day.')
  .refine(value => (value.value_min === null) === (value.value_max === null), 'Give both ends of the value range, or leave both empty.')
  .refine(value => value.value_min === null || value.value_max === null || value.value_min <= value.value_max, 'The lowest value must not exceed the highest.');
export type NeedFields = z.infer<typeof needFieldsSchema>;

export type NeedRoute = { communityId: string; needId?: string };
export function needRoute(path: string): NeedRoute | null {
  const match = /^\/communities\/([0-9a-f-]{36})\/needs(?:\/([0-9a-f-]{36}))?\/?$/i.exec(path);
  return match ? { communityId: match[1], needId: match[2] } : null;
}
export function communityHomeRoute(path: string) {
  return /^\/communities\/([0-9a-f-]{36})\/?$/i.exec(path)?.[1] ?? null;
}
export const needPath = (communityId: string, needId?: string) => `/communities/${communityId}/needs${needId ? `/${needId}` : ''}`;

const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
export function valueRange(need: Pick<ItemNeed, 'value_min' | 'value_max'>) {
  return need.value_min === null || need.value_max === null ? 'No value range given' : `${usd.format(need.value_min)} to ${usd.format(need.value_max)}`;
}

