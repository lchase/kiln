import { z } from 'zod'

export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
})

// M4 gate-step fixtures (test/workflows/gate-*.yaml, test/ir/validate.test.ts).
export const ApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
})

// Every field defaults, so `skipIf` can synthesize an answer (ticket 05).
export const AutoApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']).default('approve'),
})
