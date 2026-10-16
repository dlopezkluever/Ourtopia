import { z } from 'zod';

export const categories = ['tools', 'outdoors', 'recreation', 'electronics', 'kitchen', 'transportation equipment', 'sports', 'creative', 'household', 'miscellaneous'] as const;
export const availabilitySchema = z.object({ starts_on: z.iso.date(), ends_on: z.iso.date() }).refine(value => value.starts_on <= value.ends_on, 'The end date must follow the start date.');
export const listingDetailsSchema = z.object({
  title: z.string().trim().min(2).max(120), description: z.string().min(1).max(5000), category: z.enum(categories),
  condition: z.string().min(1).max(1000), replacement_value: z.coerce.number().min(0).max(1000000),
  pickup_notes: z.string().max(2000), lending_conditions: z.string().max(2000), minimum_score: z.coerce.number().int().min(0).max(100),
  gratitude: z.string().max(1000), availability: z.array(availabilitySchema).min(1).max(24),
});
export const listingDraftSchema = listingDetailsSchema.extend({
  title: z.string(), description: z.string(), condition: z.string(),
  availability: z.array(z.object({ starts_on: z.string(), ends_on: z.string() })),
});
export const listingSchema = z.object({
  id: z.uuid(), community_id: z.uuid(), owner_id: z.uuid(), type: z.literal('item'), status: z.enum(['published', 'withdrawn']), version: z.number(),
  title: z.string(), description: z.string(), category: z.string(), condition: z.string(), replacement_value: z.coerce.number(),
  pickup_notes: z.string(), lending_conditions: z.string(), minimum_score: z.number(), gratitude: z.string(),
  listing_availability: z.array(availabilitySchema).default([]),
});
export const imageSchema = z.object({ id: z.uuid(), listing_id: z.uuid(), object_path: z.string(), mime_type: z.string(), byte_size: z.number(), state: z.enum(['pending', 'ready', 'removed']) });
export type Listing = z.infer<typeof listingSchema>;
export type ListingDetails = z.infer<typeof listingDetailsSchema>;
export type ListingImage = z.infer<typeof imageSchema>;
export function listingRoute(path: string) {
  const match = /^\/communities\/([0-9a-f-]{36})\/listings(?:\/([0-9a-f-]{36}))?\/?$/i.exec(path);
  return match ? { communityId: match[1], listingId: match[2] } : null;
}
export function errorMessage(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'The operation could not be confirmed. Retry with the same details.'; }
export function localDate(date: string) { return new Date(`${date}T12:00:00`).toLocaleDateString(); }
