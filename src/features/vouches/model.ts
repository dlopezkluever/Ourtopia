import { z } from 'zod';

export const vouchSchema = z.object({ id: z.uuid(), community_id: z.uuid(), application_id: z.uuid(), applicant_id: z.uuid(), sponsor_id: z.uuid(), statement: z.string(), created_at: z.string() });
export const applicantStatementSchema = vouchSchema.extend({ sponsorEmail: z.string() });
export const workspaceSchema = z.object({
  name: z.string(), administrator: z.boolean(), eligible: z.boolean(), annualLimit: z.number(), used: z.number(),
  members: z.array(z.object({ id: z.uuid(), email: z.string(), eligible: z.boolean() })),
  applications: z.array(z.object({ id: z.uuid(), email: z.string() })),
  history: z.array(vouchSchema.extend({ applicantEmail: z.string(), sponsorEmail: z.string() })),
  requests: z.array(z.object({ id: z.uuid(), applicationId: z.uuid(), applicantEmail: z.string(), status: z.string() })),
});
