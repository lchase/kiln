import type { JournalEnvelope, LoopStep, Step, StepFailure, StepId } from '../ir/types.js'

export type StepState = 'completed' | 'cached' | 'stale' | 'failed' | 'pending'

export interface StepStatus {
  stepId: StepId
  status: StepState
}

/**
 * `yak status`: per-step state read entirely from the journal, keyed by
 * whatever `step.completed`/`step.failed` last said about each step id — a
 * later `step.started` with nothing after it (interrupted mid-flight) leaves
 * the step `pending`, same as one that never ran.
 */
export function stepStatusesFromJournal(steps: Step[], events: JournalEnvelope[]): StepStatus[] {
  const stateByStep = new Map<StepId, StepState>()

  for (const event of events) {
    if (event.t === 'step.started') {
      stateByStep.set(event.stepId, 'pending')
    } else if (event.t === 'step.completed') {
      stateByStep.set(event.stepId, event.stale ? 'stale' : event.cached ? 'cached' : 'completed')
    } else if (event.t === 'step.failed') {
      stateByStep.set(event.stepId, 'failed')
    }
  }

  return steps.map((step) => ({ stepId: step.id, status: stateByStep.get(step.id) ?? 'pending' }))
}

/** `yak run`/`yak resume`: every `step.failed` a journal recorded, in order —
 * a run's `status: 'failed'` alone doesn't say why; this is the detail. */
export function failedStepsFromJournal(events: JournalEnvelope[]): { stepId: StepId; failure: StepFailure }[] {
  return events
    .filter((e) => e.t === 'step.failed')
    .map((e) => ({ stepId: e.stepId, failure: e.failure }))
}

/** `<detail> (<reason>)` — callers prefix the step id themselves, since
 * where it belongs (inline vs. its own indent level) differs by command. */
export function formatStepFailure(failure: StepFailure): string {
  return `${failure.detail} (${failure.reason})`
}

export type LoopState = 'pending' | 'running' | 'completed' | 'failed' | 'suspended'

export interface LoopStatusDetail {
  stepId: StepId
  state: LoopState
  /** Highest iteration any body step has started, 0 if none yet — the
   * loop's own step.started/step.completed don't carry an iteration, so
   * this reads the body steps' `step.started` events instead. */
  iteration: number
  maxIterations: number
  consumedTokens: number
  maxTokens?: number
  noProgressSignal?: unknown
}

/**
 * Ticket 09: `yak status` detail for a run currently (or having been) inside
 * a `loop` — current iteration, budget consumed vs. each configured
 * ceiling, and the latest `noProgress` signal value. All three are already
 * computed for enforcement (tickets 02/03); this only reads them back from
 * the journal.
 */
export function loopStatusFromJournal(step: LoopStep, events: JournalEnvelope[]): LoopStatusDetail {
  const bodyStepIds = new Set(step.body.map((s) => s.id))

  let state: LoopState = 'pending'
  for (const event of events) {
    if (event.t === 'step.started' && event.stepId === step.id) state = 'running'
    else if (event.t === 'step.completed' && event.stepId === step.id) state = 'completed'
    else if (event.t === 'step.failed' && event.stepId === step.id) state = 'failed'
    else if (event.t === 'run.suspended' && event.loopStepId === step.id) state = 'suspended'
  }

  const iteration = events
    .filter((e) => e.t === 'step.started' && bodyStepIds.has(e.stepId))
    .reduce((max, e) => Math.max(max, (e as { iteration?: number }).iteration ?? 0), 0)

  const consumedTokens = events
    .filter((e) => e.t === 'budget.consumed' && bodyStepIds.has(e.stepId))
    .reduce((sum, e) => sum + (e as { tokens: number }).tokens, 0)

  const lastIterationEvent = [...events].reverse().find((e) => e.t === 'loop.iteration' && e.stepId === step.id)
  const noProgressSignal =
    lastIterationEvent?.t === 'loop.iteration' ? lastIterationEvent.signal : undefined

  return {
    stepId: step.id,
    state,
    iteration,
    maxIterations: step.budget.maxIterations,
    consumedTokens,
    ...(step.budget.maxTokens !== undefined ? { maxTokens: step.budget.maxTokens } : {}),
    ...(noProgressSignal !== undefined ? { noProgressSignal } : {}),
  }
}

/** Shared by `yak status` and `yak watch` — the one-line iteration/budget
 * summary for a loop's current state. */
export function formatLoopBudget(detail: LoopStatusDetail): string {
  return detail.maxTokens !== undefined
    ? `iteration ${detail.iteration}/${detail.maxIterations}, tokens ${detail.consumedTokens}/${detail.maxTokens}`
    : `iteration ${detail.iteration}/${detail.maxIterations}, tokens ${detail.consumedTokens}`
}
