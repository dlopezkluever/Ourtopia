import { z } from 'zod';
import { helpExchangeStateSchema } from '../exchanges/model';
import { standingSchema } from '../reputation/model';

export const helpCategories = {
  moving: 'Moving', repairs: 'Repairs', yard_garden: 'Yard & garden', tech: 'Tech help', tutoring: 'Tutoring',
  cooking: 'Cooking', care: 'Care', errands: 'Errands', other: 'Other',
} as const;
export type HelpCategory = keyof typeof helpCategories;
const categorySchema = z.enum(Object.keys(helpCategories) as [HelpCategory, ...HelpCategory[]]);

export const skillLevels = { beginner: 'Beginner', intermediate: 'Intermediate', experienced: 'Experienced', professional: 'Professional' } as const;
export type SkillLevel = keyof typeof skillLevels;
const skillLevelSchema = z.enum(Object.keys(skillLevels) as [SkillLevel, ...SkillLevel[]]);

export type PostKind = 'listing' | 'need_post';
export const postKindLabels: Record<PostKind, string> = { listing: 'Help offer', need_post: 'Help need' };

const postBase = {
  id: z.uuid(), communityId: z.uuid(), ownerId: z.uuid(), ownerEmail: z.string(), title: z.string(), description: z.string(),
  category: categorySchema, status: z.enum(['open', 'withdrawn']), createdAt: z.string(), updatedAt: z.string(),
};
export const helpPostSchema = z.discriminatedUnion('postKind', [
  z.object({ ...postBase, postKind: z.literal('listing'), skill: z.string(), skillLevel: skillLevelSchema, availability: z.string(), geographicConstraints: z.string(), schedulingPreferences: z.string() }),
  z.object({ ...postBase, postKind: z.literal('need_post'), startsAt: z.string(), durationMinutes: z.number().int(), location: z.string(), helpersNeeded: z.number().int(), openPlaces: z.number().int() }),
]);
export type HelpPost = z.infer<typeof helpPostSchema>;
export type HelpListing = Extract<HelpPost, { postKind: 'listing' }>;
export type HelpNeedPost = Extract<HelpPost, { postKind: 'need_post' }>;

export const helpCompletionSchema = z.object({ exchangeId: z.uuid(), state: helpExchangeStateSchema, communityId: z.uuid(), helperId: z.uuid(), requesterId: z.uuid(), revision: z.number().int(), firstConfirmedBy: z.uuid().nullable(), firstConfirmedAt: z.string().nullable(), helperConfirmedAt: z.string().nullable(), requesterConfirmedAt: z.string().nullable(), disputedBy: z.uuid().nullable(), disagreement: z.string().nullable(), reminderDueAt: z.string().nullable(), reviewDueAt: z.string().nullable(), completedAt: z.string().nullable(), openDispute: z.boolean(), standing: standingSchema, history: z.array(z.object({ participantId: z.uuid() })), awards: z.array(z.object({ recipientId: z.uuid(), rule: z.string(), points: z.number().int() })) });

export const helpExchangeSchema = z.object({
  id: z.uuid(), communityId: z.uuid(), communityName: z.string(), state: helpExchangeStateSchema,
  sourceKind: z.enum(['listing', 'need_post']), sourceId: z.uuid(), sourceTitle: z.string(),
  helperId: z.uuid(), helperEmail: z.string(), requesterId: z.uuid(), requesterEmail: z.string(), commitmentId: z.uuid(),
  place: z.number().int().nullable(), placeStatus: z.enum(['active', 'closed']).nullable(),
  startsAt: z.string().nullable(), durationMinutes: z.number().int().nullable(), meetingPoint: z.string().nullable(),
  cancelReason: z.string().nullable(), cancelledBy: z.uuid().nullable(), cancelledAt: z.string().nullable(), createdAt: z.string(),
  completion: helpCompletionSchema.nullable().optional(),
});
export type HelpExchange = z.infer<typeof helpExchangeSchema>;

export const helpCommitmentSchema = z.object({
  id: z.uuid(), memberId: z.uuid(), memberEmail: z.string(), note: z.string(), status: z.enum(['pending', 'accepted', 'withdrawn']),
  exchangeId: z.uuid().nullable(), createdAt: z.string(),
});
export type HelpCommitment = z.infer<typeof helpCommitmentSchema>;

export const helpPostDetailSchema = z.object({
  post: helpPostSchema, viewerIsOwner: z.boolean(), viewerActive: z.boolean(),
  commitments: z.array(helpCommitmentSchema), exchanges: z.array(helpExchangeSchema),
});
export type HelpPostDetail = z.infer<typeof helpPostDetailSchema>;

export const commitResultSchema = z.object({ id: z.uuid(), status: z.literal('pending'), member_id: z.uuid() });

export type HelpRoute = { communityId?: string; post?: { kind: PostKind; id: string } };
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function helpRoute(path: string): HelpRoute | null {
  if (path === '/help') return {};
  const match = new RegExp(`^/help/(${uuid})(?:/(listing|need)/(${uuid}))?$`).exec(path);
  if (!match) return null;
  return { communityId: match[1], post: match[2] ? { kind: match[2] === 'listing' ? 'listing' : 'need_post', id: match[3] } : undefined };
}
export const postPath = (communityId: string, kind: PostKind, id: string) => `/help/${communityId}/${kind === 'listing' ? 'listing' : 'need'}/${id}`;

const text = (label: string, min: number, max: number) => z.string().trim().min(min, min ? `${label} needs at least ${min} characters.` : undefined).max(max, `${label} can be up to ${max} characters.`);
const whole = (label: string, min: number, max: number) => z.coerce.number().int(`${label} must be a whole number.`).min(min, `${label} must be at least ${min}.`).max(max, `${label} can be at most ${max}.`);
const future = (label: string) => z.string().min(1, `Choose a ${label}.`).transform((value, context) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) { context.addIssue({ code: 'custom', message: `Choose a ${label} in the future.` }); return z.NEVER; }
  return date.toISOString();
});

export const listingFields = z.object({
  title: text('Title', 3, 120), description: text('Description', 0, 2000), category: categorySchema,
  skill: text('Skill', 2, 120), skill_level: skillLevelSchema, availability: text('Availability', 2, 500),
  geographic_constraints: text('Area', 2, 500), scheduling_preferences: text('Scheduling preferences', 0, 500),
});
export const needPostFields = z.object({
  title: text('Title', 3, 120), description: text('Description', 0, 2000), category: categorySchema,
  starts_at: future('requested time'), duration_minutes: whole('Duration', 15, 1440), location: text('Location', 2, 300),
  helpers_needed: whole('Helpers needed', 1, 20),
});
export const scheduleFields = z.object({ starts_at: future('start time'), duration_minutes: whole('Duration', 15, 1440), meeting_point: text('Meeting point', 2, 300) });

export function localInput(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One intent per distinct payload: a retry of the same details replays, edited details get a fresh identity.
export function intentFor(memory: { current: { payload: string; id: string } | null }, payload: unknown) {
  const serialized = JSON.stringify(payload);
  if (memory.current?.payload !== serialized) memory.current = { payload: serialized, id: crypto.randomUUID() };
  return memory.current.id;
}

export function errorMessage(error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (error instanceof TypeError || /failed to fetch|network|load failed/i.test(message)) return 'The connection dropped before the change was confirmed. Retry to safely recover it.';
  return message || 'The request could not be confirmed.';
}
