import { z } from 'zod';
import { categories, listingDetailsSchema } from '../listings/model';
import { helpCategories, listingFields, needPostFields, skillLevels } from '../help/model';

export const kinds = { item: 'Item Listing', help_offer: 'Help offer', help_need: 'Help Need Post' } as const;
export type DraftKind = keyof typeof kinds;
export const draftSchema = z.object({ owner_id: z.uuid(), community_id: z.uuid(), kind: z.enum(['item', 'help_offer', 'help_need']), fields: z.record(z.string(), z.json()), revision: z.number().int(), status: z.enum(['editing', 'published', 'discarded']) });
export const resultSchema = z.object({ draft: draftSchema, published: z.object({ id: z.uuid() }).passthrough().nullable() });
export type Draft = z.infer<typeof draftSchema>;
type Field = { name: string; label: string; type?: string; options?: readonly string[] | Record<string, string>; optional?: boolean; max?: number };
const common: Field[] = [{ name: 'title', label: 'Title', max: 120 }, { name: 'description', label: 'Description', type: 'textarea', max: 2000 }];
export const fields: Record<DraftKind, Field[]> = {
  item: [...common, { name: 'category', label: 'Category', options: categories }, { name: 'condition', label: 'Condition', type: 'textarea', max: 1000 }, { name: 'replacement_value', label: 'Estimated replacement value ($)', type: 'number' }, { name: 'starts_on', label: 'Available from', type: 'date' }, { name: 'ends_on', label: 'Available through', type: 'date' }, { name: 'pickup_notes', label: 'Pickup notes', type: 'textarea', optional: true }, { name: 'lending_conditions', label: 'Lending conditions', type: 'textarea', optional: true }, { name: 'minimum_score', label: 'Minimum Community Solidarity Score', type: 'number' }, { name: 'gratitude', label: 'Optional gratitude suggestion', type: 'textarea', optional: true }],
  help_offer: [...common, { name: 'category', label: 'Category', options: helpCategories }, { name: 'skill', label: 'Skill', max: 120 }, { name: 'skill_level', label: 'Skill level', options: skillLevels }, { name: 'availability', label: 'Availability', max: 500 }, { name: 'geographic_constraints', label: 'Area you can help in', max: 500 }, { name: 'scheduling_preferences', label: 'Scheduling preferences', optional: true, max: 500 }],
  help_need: [...common, { name: 'category', label: 'Category', options: helpCategories }, { name: 'starts_at', label: 'Date and time', type: 'datetime-local' }, { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number' }, { name: 'location', label: 'Location', max: 300 }, { name: 'helpers_needed', label: 'Helpers needed', type: 'number' }],
};
export function initialValues(kind: DraftKind, draft?: Draft) {
  const values: Record<string, string> = Object.fromEntries(fields[kind].map(field => [field.name, field.options ? Array.isArray(field.options) ? field.options[0] : Object.keys(field.options)[0] : field.type === 'number' ? field.name === 'helpers_needed' ? '1' : '0' : '']));
  if (draft?.status === 'editing') {
    for (const [key, value] of Object.entries(draft.fields)) if (typeof value === 'string' || typeof value === 'number') values[key] = String(value);
    const ranges = draft.fields.availability;
    if (kind === 'item' && Array.isArray(ranges) && ranges[0] && typeof ranges[0] === 'object') {
      const range = ranges[0] as Record<string, string>; values.starts_on = range.starts_on; values.ends_on = range.ends_on;
    }
  }
  return values;
}
export function draftFields(kind: DraftKind, values: Record<string, string>) {
  if (kind !== 'item') return values;
  const { starts_on, ends_on, ...rest } = values;
  return { ...rest, availability: [{ starts_on, ends_on }] };
}
export function publishFields(kind: DraftKind, values: Record<string, string>) {
  const data = draftFields(kind, values);
  return kind === 'item' ? listingDetailsSchema.parse(data) : kind === 'help_offer' ? listingFields.parse(data) : needPostFields.parse(data);
}
