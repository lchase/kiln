import assert from 'node:assert/strict'
import pLimit from 'p-limit'
import { z } from 'zod'
import type { AgentAdapter } from '../adapters/types.js'
import { readArtifactRaw, writeArtifact } from '../engine/artifacts.js'
import {
  computeDefinitionKey,
  computeSemanticKey,
  decideCache,
  readCacheEntry,
  writeCacheEntry,
} from '../engine/cache.js'
import { appendJournalEvent, readJournal } from '../engine/journal.js'
import { writeLoopExhaustedRequest } from '../engine/suspend.js'
import { evalExpr } from '../expr/eval.js'
import { buildProducerMap, earlierProducerIds, inputNamesOf } from '../ir/graph.js'
import type { AgentStep, ArtifactName, LoopStep, Step, StepId } from '../ir/types.js'
import { AgentStepFailedError, runAgentStep } from './agent.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from './command.js'
import { runTransformStep } from './transform.js'

export interface LoopRunContext {
  runId: string
  runDir: string
  cwd: string
  cacheDir: string
  /** The loop step's own semantic/definition key — computed by the
   * scheduler the same way as any other step, so `step.started`/
   * `step.completed` on the loop id itself carry the same fields every
   * other step kind's do. */
  semanticKey: string
  definitionKey: string
  /** Same cap the top-level scheduler is running under. `step.concurrency`
   * (default 1) is a sub-limit inside this, never above it — the same
   * relationship `map` has with `globalConcurrency`. */
  globalConcurrency: number
  /** Hashes of artifacts produced outside this loop, already on disk under
   * their flat (non-iteration) path — an external need's contribution to a
   * body step's cache key. */
  outerArtifactHashes: Map<ArtifactName, string>
  buildAdapter: (step: AgentStep, iteration: number) => AgentAdapter
  /** M4 ticket 02/06: set by the scheduler from `ScheduleContext.loopContinuations`
   * when `yak resume` just validated a human's answer to this loop's
   * exhaustion request. Consumed once, at the top of `runLoopStep`. */
  loopContinuation?: { action: 'continue' | 'abort'; addIterations?: number }
}

interface ResumeFrom {
  startIteration: number
  priorValues: Map<ArtifactName, unknown>
  priorHashes: Map<ArtifactName, string>
  maxIterations: number
}

/** Ticket 01/02/03/04/10: runs a `loop` step to completion — success
 * (`until` satisfied), budget exhaustion (`onExhausted`), or a body step's
 * hard failure. Each round schedules the body as a subgraph: a step waits
 * only on producers of its inputs that appear earlier in the body (this
 * round's value — the same rule `runOneBodyStep` uses below). A producer
 * at the same or a later body position still resolves to the previous
 * round (`undefined` on round 1). The effective cap is
 * `min(concurrency ?? 1, globalConcurrency)`. When that cap is 1 the body
 * runs in declared order, including when `concurrency` is higher but the
 * global cap clips it to 1. When the cap is greater than 1, a step may
 * start before an earlier sibling that is not ready yet, if it does not
 * depend on that sibling. On the first body
 * failure nothing new starts; steps already running finish, then the
 * error is rethrown.
 *
 * Ticket 09: brackets the loop id itself with the same `step.started`/
 * `step.completed`-or-`step.failed` shape every other step kind gets, so
 * status tooling has something to key off besides the per-iteration
 * body-step and `run.suspended` events. A `'suspended'` outcome
 * deliberately leaves no `step.completed`/`step.failed` — the dangling
 * `step.started` reads as "pending", the same convention as any other step
 * interrupted mid-flight. */
export async function runLoopStep(step: LoopStep, ctx: LoopRunContext): Promise<'ok' | 'failed' | 'suspended'> {
  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey: ctx.semanticKey,
    definitionKey: ctx.definitionKey,
  })

  if (ctx.loopContinuation?.action === 'abort') {
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.failed',
      stepId: step.id,
      failure: {
        reason: 'budget-exhausted',
        detail: `loop "${step.id}" aborted by human after budget exhaustion`,
        recoverable: false,
      },
    })
    return 'failed'
  }

  const resumeFrom = ctx.loopContinuation?.action === 'continue' ? await buildResumeFrom(step, ctx) : undefined
  const result = await runLoopBody(step, ctx, resumeFrom)

  // `'failed'` already got its own, more specific `step.failed` journaled
  // at the point of failure (body-step hard failure or onExhausted: 'fail')
  // — this wrapper only needs to cover the success case.
  if (result.status === 'ok') {
    // yak#35: when the loop declares `produces`, write its own artifact once
    // the loop settles — the final `until`-context object (the last
    // iteration's body artifacts, keyed by name). Without it a step outside
    // the loop can't `needs` the loop and so can't be ordered after it.
    let artifact: { name: ArtifactName; hash: string } | undefined
    if (step.produces) {
      const written = await writeArtifact(ctx.runDir, step.produces, result.untilContext, z.unknown())
      artifact = { name: step.produces, hash: written.hash }
      // Same map instance the scheduler threads through every step — seeds
      // the loop's artifact hash into downstream steps' cache keys.
      ctx.outerArtifactHashes.set(step.produces, written.hash)
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'artifact.written',
        name: step.produces,
        hash: written.hash,
        bytes: written.bytes,
      })
    }
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.completed',
      stepId: step.id,
      ...(artifact ? { artifact: artifact.name, artifactHash: artifact.hash } : {}),
      cached: false,
    })
  }

  return result.status
}

type LoopBodyResult =
  | { status: 'ok'; untilContext: Record<string, unknown> }
  | { status: 'failed' | 'suspended' }

/** M4 ticket 06: reconstructs where a previously-suspended-for-exhaustion
 * loop left off, from the journal alone — the same "resume-correct for
 * free" approach ticket 03 (M3) used for budget accounting. Finds the
 * iteration the loop tripped at (its last `loop.iteration` event), then
 * reads each body step's per-iteration artifact at that iteration back off
 * disk to seed `priorValues`/`priorHashes` for the next one. */
async function buildResumeFrom(step: LoopStep, ctx: LoopRunContext): Promise<ResumeFrom> {
  const events = await readJournal(ctx.runDir)
  const bodyStepIds = new Set(step.body.map((s) => s.id))
  const trippedIteration = [...events]
    .reverse()
    .find((e) => e.t === 'loop.iteration' && e.stepId === step.id)

  const iteration = trippedIteration && trippedIteration.t === 'loop.iteration' ? trippedIteration.n : 0

  const priorValues = new Map<ArtifactName, unknown>()
  const priorHashes = new Map<ArtifactName, string>()
  for (const event of events) {
    if (event.t !== 'step.completed' || event.iteration !== iteration) continue
    if (!bodyStepIds.has(event.stepId) || !event.artifact) continue
    priorValues.set(event.artifact, await readArtifactRaw(ctx.runDir, event.artifact, iteration))
    if (event.artifactHash) priorHashes.set(event.artifact, event.artifactHash)
  }

  const addIterations = ctx.loopContinuation?.addIterations ?? 0
  return {
    startIteration: iteration + 1,
    priorValues,
    priorHashes,
    maxIterations: step.budget.maxIterations + addIterations,
  }
}

async function runLoopBody(
  step: LoopStep,
  ctx: LoopRunContext,
  resumeFrom?: ResumeFrom,
): Promise<LoopBodyResult> {
  const localProducerOf = buildProducerMap(step.body)
  const bodyOrderIndex = new Map(step.body.map((s, i) => [s.id, i]))
  const bodyStepIds = new Set(step.body.map((s) => s.id))
  const effectiveMaxIterations = resumeFrom?.maxIterations ?? step.budget.maxIterations

  let priorValues = resumeFrom?.priorValues ?? new Map<ArtifactName, unknown>()
  let priorHashes = resumeFrom?.priorHashes ?? new Map<ArtifactName, string>()
  let lastSignal: unknown
  // Ticket 07: scoped to this one `runLoopBody` call (one loop-step
  // execution), same process-local, non-journaled lifetime as the
  // top-level scheduler's own `context: { session }` map
  // (`src/engine/scheduler.ts`'s `agentSessionIds`) — not resume-safe,
  // matching that pre-existing limitation rather than fixing it here.
  const bodySessionIds = new Map<StepId, string>()

  for (let iteration = resumeFrom?.startIteration ?? 1; ; iteration++) {
    const thisValues = new Map<ArtifactName, unknown>()
    const thisHashes = new Map<ArtifactName, string>()

    try {
      await runLoopRound({
        step,
        iteration,
        ctx,
        localProducerOf,
        bodyOrderIndex,
        priorValues,
        priorHashes,
        thisValues,
        thisHashes,
        bodySessionIds,
      })
    } catch (err) {
      if (err instanceof CommandStepFailedError || err instanceof AgentStepFailedError) {
        // the body step's own step.failed was already journaled in
        // runBodyStepKind — this covers the loop step id itself.
        await appendJournalEvent(ctx.runDir, ctx.runId, {
          t: 'step.failed',
          stepId: step.id,
          failure: {
            reason: err.failure.reason,
            detail: `loop "${step.id}" body step failed: ${err.failure.detail}`,
            recoverable: false,
          },
        })
        return { status: 'failed' }
      }
      throw err
    }

    const untilContext = Object.fromEntries(thisValues)
    if (await evalExpr(step.until, untilContext, ctx.cwd)) return { status: 'ok', untilContext }

    let tripped: 'maxIterations' | 'maxTokens' | 'noProgress' | undefined
    if (step.budget.noProgress) {
      lastSignal = await evalExpr(step.budget.noProgress.signal, untilContext, ctx.cwd)
    }

    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'loop.iteration',
      stepId: step.id,
      n: iteration,
      ...(lastSignal !== undefined ? { signal: lastSignal } : {}),
    })

    if (step.budget.noProgress) {
      tripped = (await noProgressTripped(step, ctx, iteration)) ? 'noProgress' : tripped
    }
    if (!tripped && iteration >= effectiveMaxIterations) tripped = 'maxIterations'
    if (!tripped && step.budget.maxTokens !== undefined) {
      const tokensTotal = await sumBodyTokens(ctx.runDir, bodyStepIds)
      if (tokensTotal >= step.budget.maxTokens) tripped = 'maxTokens'
    }

    if (tripped) {
      const outcome = await handleExhausted(step, ctx, iteration, tripped)
      // `onExhausted: 'continue'` treats exhaustion as success — the loop's
      // artifact is the last iteration's context, same as a clean `until`.
      return outcome === 'ok' ? { status: 'ok', untilContext } : { status: outcome }
    }

    priorValues = thisValues
    priorHashes = thisHashes
  }
}

/** Ticket 02: noProgress is a non-decreasing (not strict-equality) signal —
 * `rounds` consecutive iterations where the signal never improved (never
 * decreased) trips it. Recomputed from the journal's `loop.iteration`
 * events each check, so it's resume-consistent with ticket 03's budget
 * accounting rather than tracked only in this function's local state. */
async function noProgressTripped(step: LoopStep, ctx: LoopRunContext, iteration: number): Promise<boolean> {
  const rounds = step.budget.noProgress!.rounds
  const events = await readJournal(ctx.runDir)
  const signals = events
    .filter((e) => e.t === 'loop.iteration' && e.stepId === step.id && e.n <= iteration)
    .map((e) => (e as { signal?: unknown }).signal)
    .filter((s): s is number => typeof s === 'number')

  if (signals.length < rounds) return false
  const recent = signals.slice(-rounds)
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! < recent[i - 1]!) return false // an improvement anywhere in the window resets it
  }
  return true
}

/** Ticket 03: running totals are summed from `budget.consumed` journal
 * events scoped to this loop instance's body step ids — no separate
 * counter, resume-correct for free. */
async function sumBodyTokens(runDir: string, bodyStepIds: Set<StepId>): Promise<number> {
  const events = await readJournal(runDir)
  return events
    .filter((e) => e.t === 'budget.consumed' && bodyStepIds.has(e.stepId))
    .reduce((sum, e) => sum + (e as { tokens: number }).tokens, 0)
}

/** `onExhausted` policy. `'suspend'` writes a real pending request (M4
 * ticket 02/08 — supersedes the M3 stub that only journaled
 * `run.suspended` with nothing to answer) and returns `'suspended'`,
 * which the scheduler propagates to `EX_SUSPEND` (exit 78). `'fail'`
 * journals `step.failed` on the loop step itself. `'continue'` treats
 * exhaustion as acceptable. */
async function handleExhausted(
  step: LoopStep,
  ctx: LoopRunContext,
  iteration: number,
  tripped: 'maxIterations' | 'maxTokens' | 'noProgress',
): Promise<'ok' | 'failed' | 'suspended'> {
  const onExhausted = step.onExhausted ?? 'suspend'

  if (onExhausted === 'continue') return 'ok'

  if (onExhausted === 'fail') {
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.failed',
      stepId: step.id,
      failure: {
        reason: 'budget-exhausted',
        detail: `loop "${step.id}" exhausted (${tripped}) after ${iteration} iterations`,
        recoverable: false,
      },
    })
    return 'failed'
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'run.suspended',
    reason: 'exhausted',
    loopStepId: step.id,
    iteration,
    tripped,
  })
  await writeLoopExhaustedRequest(ctx.runDir, ctx.runId, step.id, iteration, tripped)
  return 'suspended'
}

interface RunLoopRoundArgs {
  step: LoopStep
  iteration: number
  ctx: LoopRunContext
  localProducerOf: Map<ArtifactName, StepId>
  bodyOrderIndex: Map<StepId, number>
  priorValues: Map<ArtifactName, unknown>
  priorHashes: Map<ArtifactName, string>
  thisValues: Map<ArtifactName, unknown>
  thisHashes: Map<ArtifactName, string>
  bodySessionIds: Map<StepId, string>
}

/** One round of the body. Eligibility is "every this-round producer has
 * finished", and a this-round producer is one that sits earlier in the
 * body — the same `producerPos < posIndex` test `runOneBodyStep` uses to
 * decide whether an input is this round's value or the previous round's.
 * Steps that don't wait on each other are queued together, bounded by
 * `min(step.concurrency ?? 1, globalConcurrency)`.
 *
 * When that effective cap is 1, the scan stops at the first body step that
 * is still waiting. A later sibling does not start while an earlier one
 * has not finished, so the round matches the old sequential loop: `[a, b
 * needs a, c]` runs a, then b, then c. The same holds when `concurrency`
 * is above 1 but the global cap clips the round to 1.
 *
 * When the cap is greater than 1, a step may overtake an earlier sibling
 * it does not depend on, while that sibling is still waiting. `[a, b needs
 * a, c]` at cap 2 starts `c` alongside `a`; `b` still waits for `a`.
 *
 * The first failure stops further launches; work already inside the limit
 * finishes, then the original error is rethrown into `runLoopBody`'s
 * handler. */
async function runLoopRound(args: RunLoopRoundArgs): Promise<void> {
  const {
    step,
    iteration,
    ctx,
    localProducerOf,
    bodyOrderIndex,
    priorValues,
    priorHashes,
    thisValues,
    thisHashes,
    bodySessionIds,
  } = args

  const cap = Math.min(step.concurrency ?? 1, ctx.globalConcurrency)
  const limit = pLimit(cap)
  const remaining = new Set(step.body.map((bodyStep) => bodyStep.id))
  const completed = new Set<StepId>()
  const inFlight = new Map<StepId, Promise<'ok' | 'skipped' | 'error'>>()
  let firstError: unknown

  const thisRoundDeps = (bodyStep: Step, posIndex: number): StepId[] =>
    earlierProducerIds(bodyStep, posIndex, localProducerOf, bodyOrderIndex)

  const launchEligible = (): void => {
    if (firstError !== undefined) return
    for (const [posIndex, bodyStep] of step.body.entries()) {
      if (!remaining.has(bodyStep.id) || inFlight.has(bodyStep.id)) continue
      const ready = thisRoundDeps(bodyStep, posIndex).every((dep) => completed.has(dep))
      if (!ready) {
        // Cap 1 is the sequential body: do not look past a step that has
        // not finished. Cap > 1 may start a later step that does not wait
        // on this one.
        if (cap === 1) break
        continue
      }
      inFlight.set(
        bodyStep.id,
        limit(async () => {
          // A slot freeing after a failure must not start the queued step.
          if (firstError !== undefined) return 'skipped' as const
          try {
            await runOneBodyStep({
              bodyStep,
              posIndex,
              iteration,
              ctx,
              localProducerOf,
              bodyOrderIndex,
              priorValues,
              priorHashes,
              thisValues,
              thisHashes,
              freshContext: step.freshContext ?? true,
              bodySessionIds,
            })
            return 'ok' as const
          } catch (err) {
            if (firstError === undefined) firstError = err
            return 'error' as const
          }
        }),
      )
    }
  }

  launchEligible()

  while (inFlight.size > 0) {
    const [doneId, status] = await Promise.race(
      [...inFlight.entries()].map(async ([id, p]) => [id, await p] as const),
    )
    inFlight.delete(doneId)
    remaining.delete(doneId)
    if (status === 'ok') completed.add(doneId)
    launchEligible()
  }

  if (firstError !== undefined) throw firstError

  // This-round edges only point at earlier positions, so a round with no
  // failure always drains. A leftover here is a scheduler bug.
  assert.equal(
    remaining.size,
    0,
    `loop "${step.id}" stalled: body step(s) [${[...remaining].join(', ')}] never became eligible`,
  )
}

interface RunOneBodyStepArgs {
  bodyStep: Step
  posIndex: number
  iteration: number
  ctx: LoopRunContext
  localProducerOf: Map<ArtifactName, StepId>
  bodyOrderIndex: Map<StepId, number>
  priorValues: Map<ArtifactName, unknown>
  priorHashes: Map<ArtifactName, string>
  thisValues: Map<ArtifactName, unknown>
  thisHashes: Map<ArtifactName, string>
  freshContext: boolean
  bodySessionIds: Map<StepId, string>
}

/** Ticket 01's within-iteration ordering: a need resolved via the loop-local
 * producer map takes *this* iteration's value if its producer already ran
 * this round (earlier body position); otherwise the *prior* iteration's
 * value (`undefined` on iteration 1). A need resolved via the outer scope
 * is external and already on disk before the loop started. */
async function runOneBodyStep(args: RunOneBodyStepArgs): Promise<void> {
  const {
    bodyStep,
    posIndex,
    iteration,
    ctx,
    localProducerOf,
    bodyOrderIndex,
    priorValues,
    priorHashes,
    thisValues,
    thisHashes,
    freshContext,
    bodySessionIds,
  } = args

  const inputs: Record<string, unknown> = {}
  const inputHashesForKey: Record<string, string> = {}

  for (const name of inputNamesOf(bodyStep)) {
    const producerId = localProducerOf.get(name)
    if (producerId !== undefined) {
      const producerPos = bodyOrderIndex.get(producerId)!
      const fromThisRound = producerPos < posIndex
      inputs[name] = fromThisRound ? thisValues.get(name) : priorValues.get(name)
      const hash = fromThisRound ? thisHashes.get(name) : priorHashes.get(name)
      if (hash) inputHashesForKey[name] = hash
    } else {
      inputs[name] = await readArtifactRaw(ctx.runDir, name)
      const hash = ctx.outerArtifactHashes.get(name)
      if (hash) inputHashesForKey[name] = hash
    }
  }

  const semanticKey = computeSemanticKey(bodyStep, inputHashesForKey, iteration)
  const definitionKey = computeDefinitionKey(bodyStep)

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: bodyStep.id,
    iteration,
    semanticKey,
    definitionKey,
  })

  const cacheMode = bodyStep.cache ?? 'strict'
  const existingEntry = await readCacheEntry(ctx.cacheDir, semanticKey)
  const decision = decideCache(cacheMode, definitionKey, existingEntry)

  let result: unknown
  let cached = false
  let stale = false

  if (decision.kind === 'hit') {
    result = decision.entry.artifact
    cached = true
    stale = decision.stale
  } else {
    result = await runBodyStepKind(bodyStep, inputs, ctx, iteration, freshContext, bodySessionIds)
  }

  let artifactHash: string | undefined
  if (bodyStep.produces) {
    const schema = bodyStep.kind === 'command' ? CommandResultSchema : z.unknown()
    const written = await writeArtifact(ctx.runDir, bodyStep.produces, result, schema, iteration)
    artifactHash = written.hash
    thisValues.set(bodyStep.produces, result)
    thisHashes.set(bodyStep.produces, artifactHash)
    if (!cached) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'artifact.written',
        name: bodyStep.produces,
        hash: artifactHash,
        bytes: written.bytes,
      })
    }
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.completed',
    stepId: bodyStep.id,
    iteration,
    ...(bodyStep.produces ? { artifact: bodyStep.produces, artifactHash } : {}),
    cached,
    ...(stale ? { stale: true } : {}),
  })

  if (!cached) {
    await writeCacheEntry(ctx.cacheDir, {
      semanticKey,
      definitionKey,
      ...(bodyStep.produces ? { artifactName: bodyStep.produces, artifactHash, artifact: result } : {}),
    })
  }
}

async function runBodyStepKind(
  bodyStep: Step,
  inputs: Record<string, unknown>,
  ctx: LoopRunContext,
  iteration: number,
  freshContext: boolean,
  bodySessionIds: Map<StepId, string>,
): Promise<unknown> {
  try {
    if (bodyStep.kind === 'command') return await runCommandStep(bodyStep, ctx.cwd)
    if (bodyStep.kind === 'transform') return await runTransformStep(bodyStep, inputs, ctx.cwd)
    if (bodyStep.kind === 'agent') {
      const adapter = ctx.buildAdapter(bodyStep, iteration)
      const sessionId = freshContext ? undefined : bodySessionIds.get(bodyStep.id)
      return await runAgentStep(
        bodyStep,
        inputs,
        { runId: ctx.runId, runDir: ctx.runDir, cwd: ctx.cwd, adapter, sessionId },
        freshContext ? undefined : (nextSessionId) => bodySessionIds.set(bodyStep.id, nextSessionId),
      )
    }
  } catch (err) {
    if (err instanceof CommandStepFailedError || err instanceof AgentStepFailedError) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'step.failed',
        stepId: bodyStep.id,
        iteration,
        failure: err.failure,
      })
    }
    throw err
  }
  throw new Error(`step "${bodyStep.id}": kind "${bodyStep.kind}" not supported inside a loop body in M3`)
}
