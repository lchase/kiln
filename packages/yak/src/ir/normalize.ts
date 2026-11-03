import { z } from 'zod'
import type { AgentStep, Budget, CommandStep, Expr, GateStep, LoopStep, MapStep, Step, TransformStep, Workflow } from './types.js'

const rawSandboxSchema = z.enum(['docker', 'none'])

const rawCommandSchema = z.object({
  run: z.string(),
  cwd: z.string().optional(),
  failOn: z.enum(['exitCode', 'never']).optional(),
  capture: z.array(z.enum(['stdout', 'stderr', 'exitCode'])).optional(),
  sandbox: rawSandboxSchema.optional(),
  image: z.string().min(1).optional(),
})

const rawTransformSchema = z.object({
  fn: z.string(),
})

const rawAgentContextSchema = z.union([
  z.literal('fresh'),
  z.object({ inherit: z.array(z.string()) }),
  z.object({ session: z.string() }),
])

// AgentStep/GateStep.schema: a key in .yak/schemas.ts, or an inline JSON
// Schema (roadmap map ticket 09 / M1 ticket 08).
const rawSchemaSpecSchema = z.union([z.string(), z.object({ inline: z.record(z.string(), z.unknown()) })])

const rawAgentSchema = z.object({
  prompt: z.union([z.object({ file: z.string() }), z.object({ inline: z.string() })]),
  schema: rawSchemaSpecSchema.optional(),
  context: rawAgentContextSchema.optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  repairAttempts: z.number().optional(),
  sandbox: rawSandboxSchema.optional(),
  image: z.string().min(1).optional(),
  allowedDomains: z.array(z.string()).optional(),
})

const rawExprSchema: z.ZodType<Expr> = z.union([z.string(), z.object({ fn: z.string() })])

const rawGateSchema = z.object({
  schema: rawSchemaSpecSchema,
  render: z.union([z.object({ file: z.string() }), z.object({ inline: z.string() })]),
})

const rawBudgetSchema: z.ZodType<Budget> = z.object({
  maxIterations: z.number(),
  maxTokens: z.number().optional(),
  maxUsd: z.number().optional(),
  noProgress: z.object({ signal: rawExprSchema, rounds: z.number() }).optional(),
})

interface RawStep {
  id: string
  needs?: string[]
  produces?: string
  cache?: 'strict' | 'loose'
  skipIf?: Expr                        // BaseStep-level: applies to command/transform/agent/gate.
  finally?: boolean                    // BaseStep-level: applies to command/transform/agent/gate.
  command?: z.infer<typeof rawCommandSchema>
  transform?: z.infer<typeof rawTransformSchema>
  agent?: z.infer<typeof rawAgentSchema>
  gate?: z.infer<typeof rawGateSchema>
  loop?: {
    until: Expr
    budget: Budget
    concurrency?: number
    onExhausted?: 'suspend' | 'fail' | 'continue'
    freshContext?: boolean
    body: RawStep[]
  }
  map?: {
    over: string
    step: RawStep
    concurrency?: number
    isolation?: 'worktree' | 'none'
    onItemFailure?: 'skip' | 'fail' | 'retry'
  }
}

/** Recursive — a loop's `body` is itself a list of raw steps — so the schema
 * must be self-referential via `z.lazy`. */
const rawStepSchema: z.ZodType<RawStep> = z.lazy(() =>
  z.object({
    id: z.string(),
    needs: z.array(z.string()).optional(),
    produces: z.string().optional(),
    cache: z.enum(['strict', 'loose']).optional(),
    skipIf: rawExprSchema.optional(),
    finally: z.boolean().optional(),
    command: rawCommandSchema.optional(),
    transform: rawTransformSchema.optional(),
    agent: rawAgentSchema.optional(),
    gate: rawGateSchema.optional(),
    loop: z
      .object({
        until: rawExprSchema,
        budget: rawBudgetSchema,
        concurrency: z.number().int().positive().optional(),
        onExhausted: z.enum(['suspend', 'fail', 'continue']).optional(),
        freshContext: z.boolean().optional(),
        body: z.array(rawStepSchema),
      })
      .optional(),
    map: z
      .object({
        over: z.string(),
        step: rawStepSchema,
        concurrency: z.number().optional(),
        isolation: z.enum(['worktree', 'none']).optional(),
        onItemFailure: z.enum(['skip', 'fail', 'retry']).optional(),
      })
      .optional(),
  }),
)

const rawWorkflowSchema = z.object({
  name: z.string(),
  version: z.string(),
  inputSchema: rawSchemaSpecSchema.optional(),
  steps: z.array(rawStepSchema),
})

function normalizeStep(raw: RawStep): Step {
  if (raw.command) {
    const step: CommandStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'command',
      run: raw.command.run,
      failOn: raw.command.failOn ?? 'exitCode',
      capture: raw.command.capture ?? ['stdout', 'stderr', 'exitCode'],
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
      ...(raw.command.cwd !== undefined ? { cwd: raw.command.cwd } : {}),
      ...(raw.command.sandbox !== undefined ? { sandbox: raw.command.sandbox } : {}),
      ...(raw.command.image !== undefined ? { image: raw.command.image } : {}),
      ...(raw.skipIf !== undefined ? { skipIf: raw.skipIf } : {}),
      ...(raw.finally !== undefined ? { finally: raw.finally } : {}),
    }
    return step
  }

  if (raw.transform) {
    const step: TransformStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'transform',
      fn: raw.transform.fn,
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
      ...(raw.skipIf !== undefined ? { skipIf: raw.skipIf } : {}),
      ...(raw.finally !== undefined ? { finally: raw.finally } : {}),
    }
    return step
  }

  if (raw.agent) {
    const step: AgentStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'agent',
      prompt: raw.agent.prompt,
      ...(raw.agent.schema !== undefined ? { schema: raw.agent.schema } : {}),
      ...(raw.agent.context !== undefined ? { context: raw.agent.context } : {}),
      ...(raw.agent.tools !== undefined ? { tools: raw.agent.tools } : {}),
      ...(raw.agent.model !== undefined ? { model: raw.agent.model } : {}),
      ...(raw.agent.repairAttempts !== undefined ? { repairAttempts: raw.agent.repairAttempts } : {}),
      ...(raw.agent.sandbox !== undefined ? { sandbox: raw.agent.sandbox } : {}),
      ...(raw.agent.image !== undefined ? { image: raw.agent.image } : {}),
      // Kiln searches the installed bundle for the text `raw.agent.allowedDomains`
      // (`YAK_ALLOWLIST_MARKER`). Keep this property access intact.
      ...(raw.agent.allowedDomains !== undefined ? { allowedDomains: raw.agent.allowedDomains } : {}),
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
      ...(raw.skipIf !== undefined ? { skipIf: raw.skipIf } : {}),
      ...(raw.finally !== undefined ? { finally: raw.finally } : {}),
    }
    return step
  }

  if (raw.gate) {
    const step: GateStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'gate',
      schema: raw.gate.schema,
      render: raw.gate.render,
      ...(raw.skipIf !== undefined ? { skipIf: raw.skipIf } : {}),
      ...(raw.finally !== undefined ? { finally: raw.finally } : {}),
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
    }
    return step
  }

  if (raw.loop) {
    const step: LoopStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'loop',
      body: raw.loop.body.map(normalizeStep),
      until: raw.loop.until,
      budget: raw.loop.budget,
      concurrency: raw.loop.concurrency ?? 1,
      onExhausted: raw.loop.onExhausted ?? 'suspend',
      freshContext: raw.loop.freshContext ?? true,
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
    }
    return step
  }

  if (raw.map) {
    const step: MapStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'map',
      over: raw.map.over,
      step: normalizeStep(raw.map.step),
      concurrency: raw.map.concurrency ?? 4,
      // Ticket 07: the M3 loader default is 'none', not 'worktree' — real
      // worktree isolation is M5's job, and requesting it explicitly is a
      // load-time error (checked in ir/validate.ts), never a silent no-op.
      isolation: raw.map.isolation ?? 'none',
      onItemFailure: raw.map.onItemFailure ?? 'skip',
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
    }
    return step
  }

  throw new Error(
    `step "${raw.id}": only "command", "transform", "agent", "gate", "loop", and "map" steps are supported`,
  )
}

export function normalizeWorkflow(raw: unknown): Workflow {
  const parsed = rawWorkflowSchema.parse(raw)
  return {
    name: parsed.name,
    version: parsed.version,
    ...(parsed.inputSchema !== undefined ? { inputSchema: parsed.inputSchema } : {}),
    steps: parsed.steps.map(normalizeStep),
  }
}
