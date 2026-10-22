import { z } from 'zod';

const sourceRecordSchema = z.object({
  id: z.string().uuid().optional(),
  status: z.string().optional(),
  kind: z.string().optional(),
  issueType: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  participantKey: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  completedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const sourceList = z.array(sourceRecordSchema);

export const pilotMetricsSchema = z.object({
  communityId: z.string().uuid(),
  communityName: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  counts: z.object({
    invitesIssued: z.number().int().nonnegative(),
    applicationsSubmitted: z.number().int().nonnegative(),
    applicationsApproved: z.number().int().nonnegative(),
    activeMembers: z.number().int().nonnegative(),
    itemListings: z.number().int().nonnegative(),
    helpOffers: z.number().int().nonnegative(),
    itemNeedPosts: z.number().int().nonnegative(),
    helpNeedPosts: z.number().int().nonnegative(),
    borrowRequestsSubmitted: z.number().int().nonnegative(),
    borrowRequestsApproved: z.number().int().nonnegative(),
    exchangesStarted: z.number().int().nonnegative(),
    exchangesCompleted: z.number().int().nonnegative(),
    repeatParticipants: z.number().int().nonnegative(),
    completedContributions: z.number().int().nonnegative(),
    receivingOnlyParticipants: z.number().int().nonnegative(),
    disputes: z.number().int().nonnegative(),
    unresolvedCases: z.number().int().nonnegative(),
    verifiedDamageEvents: z.number().int().nonnegative(),
    verifiedDamageCorrections: z.number().int().nonnegative(),
    vouches: z.number().int().nonnegative(),
    thankYous: z.number().int().nonnegative(),
    testSubscriptions: z.number().int().nonnegative(),
  }),
  billing: z.object({
    mode: z.literal('simulated_test_billing'),
    statuses: z.record(z.string(), z.number().int().nonnegative()),
  }),
  sources: z.object({
    activeMembers: z.array(sourceRecordSchema.extend({ status: z.string(), participantKey: z.string().regex(/^[0-9a-f]{16}$/) })),
    invitations: sourceList,
    applications: sourceList,
    itemListings: sourceList,
    helpOffers: sourceList,
    itemNeedPosts: sourceList,
    helpNeedPosts: sourceList,
    borrowRequests: sourceList,
    exchanges: z.array(sourceRecordSchema.extend({ kind: z.string() })),
    completedParticipation: z.array(sourceRecordSchema.extend({ id: z.string().uuid(), status: z.enum(['contributor', 'receiver']), participantKey: z.string().regex(/^[0-9a-f]{16}$/), completedAt: z.string().datetime({ offset: true }) })),
    completedExchanges: z.array(sourceRecordSchema.extend({ kind: z.string(), completedAt: z.string().datetime({ offset: true }) })),
    disputes: z.array(sourceRecordSchema.extend({ issueType: z.string() })),
    verifiedDamageEvents: sourceList,
    verifiedDamageCorrections: sourceList,
    vouches: sourceList,
    thankYous: sourceList,
    testSubscriptions: z.array(sourceRecordSchema.extend({ id: z.string().regex(/^sub_/), status: z.string() })),
  }),
});

export type PilotMetrics = z.infer<typeof pilotMetricsSchema>;

export const pilotMetricSections = [
  { title: 'Invitations and approvals', metrics: [['Invitations issued', 'invitesIssued'], ['Applications received', 'applicationsSubmitted'], ['Applications approved', 'applicationsApproved'], ['Active members', 'activeMembers']] },
  { title: 'Sharing and requests', metrics: [['Item Listings', 'itemListings'], ['Help offers', 'helpOffers'], ['Item Need Posts', 'itemNeedPosts'], ['Help Need Posts', 'helpNeedPosts'], ['Borrow Requests submitted', 'borrowRequestsSubmitted'], ['Borrow Requests approved', 'borrowRequestsApproved']] },
  { title: 'Exchanges and participation', metrics: [['Exchanges started', 'exchangesStarted'], ['Verified completed Exchanges', 'exchangesCompleted'], ['Repeat participants', 'repeatParticipants'], ['Completed contributions', 'completedContributions'], ['Receiving-only participants', 'receivingOnlyParticipants']] },
  { title: 'Trust and gratitude', metrics: [['Disputes', 'disputes'], ['Unresolved cases', 'unresolvedCases'], ['Effective verified damage events', 'verifiedDamageEvents'], ['Verified damage corrections', 'verifiedDamageCorrections'], ['Vouches', 'vouches'], ['Thank-yous', 'thankYous']] },
] as const satisfies readonly { title: string; metrics: readonly (readonly [string, keyof PilotMetrics['counts']])[] }[];

export function pilotMetricsCsv(metrics: PilotMetrics) {
  const rows: string[][] = [['Community', metrics.communityName], ['Generated at', metrics.generatedAt], ['Billing mode', 'Simulated Stripe test billing'], ['Metric', 'Count']];
  for (const section of pilotMetricSections) {
    for (const [label, key] of section.metrics) rows.push([label, String(metrics.counts[key])]);
  }
  rows.push(['Test subscriptions', String(metrics.counts.testSubscriptions)]);
  for (const [status, count] of Object.entries(metrics.billing.statuses)) rows.push([`Test subscription status: ${status}`, String(count)]);
  rows.push([], ['Source records', 'Record ID', 'Status or kind', 'Date', 'Participant key']);
  for (const [sourceName, records] of Object.entries(metrics.sources)) {
    for (const record of records) rows.push([sourceName, record.id ?? '', record.status ?? record.kind ?? record.issueType ?? '', record.completedAt ?? record.createdAt ?? '', record.participantKey ?? '']);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
