import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { wrapZodSchema, type ResolvedSchema } from '../ir/schema-resolve.js'
import type { GateStep, JournalEnvelope, StepId } from '../ir/types.js'
import { appendJournalEvent } from './journal.js'

/**
 * M4 ticket 08: the pending request envelope is discriminated by `kind`
 * rather than forcing a gate-exhaustion suspend into the gate-shaped
 * `rendered`/`answerSchema` fields spec §4.5 only wrote an example of for a
 * `gate`. `engine/suspend.ts` and `--interactive` (ticket 09) both branch
 * on `kind`.
 */
export interface GatePendingRequest {
  kind: 'gate'
  stepId: StepId
  runId: string
  rendered: string
  answerSchema: object
  context: { artifacts: StepId[] }
  openedAt: string
}

export interface LoopExhaustedPendingRequest {
  kind: 'loop-exhausted'
  stepId: StepId
  runId: string
  tripped: 'maxIterations' | 'maxTokens' | 'noProgress'
  iteration: number
  answerSchema: object
  openedAt: string
}

export type PendingRequest = GatePendingRequest | LoopExhaustedPendingRequest

/** M4 ticket 02: fixed built-in answer schema for an exhausted loop — not
 * per-workflow-declared, since `LoopStep` has no `schema` field to
 * duplicate on every loop. `continue` re-enters the loop body, optionally
 * bumping `maxIterations` by `addIterations`; `abort` fails the step with
 * `budget-exhausted`. */
export const LoopExhaustionAnswerSchema = z.object({
  action: z.enum(['continue', 'abort']),
  addIterations: z.number().optional(),
})

function requestPath(runDir: string, stepId: StepId): string {
  return path.join(runDir, 'pending', `${stepId}.request.json`)
}

function answerPath(runDir: string, stepId: StepId): string {
  return path.join(runDir, 'pending', `${stepId}.answer.json`)
}

async function writeRequest(runDir: string, runId: string, request: PendingRequest): Promise<void> {
  await mkdir(path.join(runDir, 'pending'), { recursive: true })
  await writeFile(requestPath(runDir, request.stepId), JSON.stringify(request, null, 2), 'utf8')
  await appendJournalEvent(runDir, runId, {
    t: 'gate.opened',
    stepId: request.stepId,
    requestPath: requestPath(runDir, request.stepId),
  })
}

export async function writeGateRequest(
  runDir: string,
  runId: string,
  step: GateStep,
  rendered: string,
  answerSchema: object,
): Promise<void> {
  await writeRequest(runDir, runId, {
    kind: 'gate',
    stepId: step.id,
    runId,
    rendered,
    answerSchema,
    context: { artifacts: step.needs ?? [] },
    openedAt: new Date().toISOString(),
  })
}

export async function writeLoopExhaustedRequest(
  runDir: string,
  runId: string,
  stepId: StepId,
  iteration: number,
  tripped: 'maxIterations' | 'maxTokens' | 'noProgress',
): Promise<void> {
  await writeRequest(runDir, runId, {
    kind: 'loop-exhausted',
    stepId,
    runId,
    tripped,
    iteration,
    answerSchema: loopExhaustionJsonSchema(),
    openedAt: new Date().toISOString(),
  })
}

/** Small, fixed schema — not worth pulling in zod-to-json-schema's full
 * machinery for one constant shape. */
function loopExhaustionJsonSchema(): object {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['continue', 'abort'] },
      addIterations: { type: 'number' },
    },
    required: ['action'],
  }
}

export async function readPendingRequest(runDir: string, stepId: StepId): Promise<PendingRequest | undefined> {
  const raw = await readFile(requestPath(runDir, stepId), 'utf8').catch(() => undefined)
  return raw === undefined ? undefined : (JSON.parse(raw) as PendingRequest)
}

export async function readAnswerRaw(runDir: string, stepId: StepId): Promise<unknown> {
  const raw = await readFile(answerPath(runDir, stepId), 'utf8').catch(() => undefined)
  return raw === undefined ? undefined : JSON.parse(raw)
}

export async function writeAnswer(runDir: string, stepId: StepId, answer: unknown): Promise<void> {
  await mkdir(path.join(runDir, 'pending'), { recursive: true })
  await writeFile(answerPath(runDir, stepId), JSON.stringify(answer, null, 2), 'utf8')
}

/** M4 ticket 03: a request is "open" if its most recent event is
 * `gate.opened` with no later `gate.answered` — the journal is
 * authoritative, not file presence on disk (`yak pending` reuses this). */
export function openRequestStepIds(events: JournalEnvelope[]): StepId[] {
  const open = new Map<StepId, boolean>()
  for (const event of events) {
    if (event.t === 'gate.opened') open.set(event.stepId, true)
    else if (event.t === 'gate.answered') open.set(event.stepId, false)
  }
  return [...open.entries()].filter(([, isOpen]) => isOpen).map(([stepId]) => stepId)
}

export type AnswerResolution =
  | { status: 'missing'; stepId: StepId }
  | { status: 'invalid'; stepId: StepId; errors: string }
  | { status: 'ok'; stepId: StepId; request: PendingRequest; answer: unknown }

/**
 * M4 ticket 06: read+validate one step's answer file against the
 * appropriate schema (the fixed loop-exhaustion schema, or the caller-
 * resolved gate schema — either branch of `SchemaSpec`, roadmap map ticket
 * 09). Never writes anything — a `'missing'` or `'invalid'` result means
 * the caller leaves the run suspended untouched.
 */
export async function resolveAnswer(
  runDir: string,
  stepId: StepId,
  gateAnswerSchema: (request: GatePendingRequest) => Promise<ResolvedSchema>,
): Promise<AnswerResolution> {
  const request = await readPendingRequest(runDir, stepId)
  if (!request) throw new Error(`no pending request found for step "${stepId}"`)

  const answerRaw = await readAnswerRaw(runDir, stepId)
  if (answerRaw === undefined) return { status: 'missing', stepId }

  const schema =
    request.kind === 'loop-exhausted' ? wrapZodSchema(LoopExhaustionAnswerSchema) : await gateAnswerSchema(request)
  const parsed = schema.safeParse(answerRaw)
  if (!parsed.success) return { status: 'invalid', stepId, errors: parsed.errorSummary ?? '' }

  return { status: 'ok', stepId, request, answer: parsed.data }
}
