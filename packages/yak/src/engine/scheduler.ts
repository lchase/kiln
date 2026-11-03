import path from 'node:path'
import pLimit from 'p-limit'
import { z } from 'zod'
import { ClaudeCodeAdapter } from '../adapters/claude-code.js'
import { MockAdapter } from '../adapters/mock.js'
import type { AgentAdapter } from '../adapters/types.js'
import { agentInputNames, buildProducerMap, dependenciesOf, inputNamesOf } from '../ir/graph.js'
import { evalExpr } from '../expr/eval.js'
import type { AdapterId, AgentStep, ArtifactName, Step, StepId, Workflow } from '../ir/types.js'
import { AgentStepFailedError, runAgentStep } from '../steps/agent.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from '../steps/command.js'
import { runGateStep } from '../steps/gate.js'
import { runLoopStep } from '../steps/loop.js'
import { runMapStep } from '../steps/map.js'
import { runTransformStep } from '../steps/transform.js'
import { readArtifactRaw, readArtifactRawOrUndefined, writeArtifact } from './artifacts.js'
import {
  computeDefinitionKey,
  computeSemanticKey,
  decideCache,
  readCacheEntry,
  writeCacheEntry,
} from './cache.js'
import { appendJournalEvent } from './journal.js'
import type { ReplayedStep } from './journal.js'

const DEFAULT_CONCURRENCY = 4

export interface ScheduleContext {
  runId: string
  runDir: string
  cwd: string
  cacheDir: string
  adapter: AdapterId
  concurrency?: number
  /** M4 ticket 02/06: a validated `{ action, addIterations? }` answer for a
   * loop step resuming from exhaustion, keyed by the loop step's id —
   * populated by `resumeRun` from a `pending/<step>.answer.json` it just
   * validated, consumed once by `runLoopStep`. */
  loopContinuations?: Map<StepId, { action: 'continue' | 'abort'; addIterations?: number }>
  /** Artifact hashes known before any step runs — the reserved `input`
   * artifact (yak#27), written by the engine from `yak run --input`.
   * Seeded into `artifactHashes` so `needs: ['input']` resolves and the
   * input's hash participates in downstream cache keys. */
  seedArtifactHashes?: Map<ArtifactName, string>
}

/** Ticket 09: `mock` is fixture-driven (keyed by workflow name + step id
 * under `test/fixtures`), so it's only useful when fixtures exist for the
 * exact workflow — still CLI-reachable for manual smoke-testing and the
 * eventual M2 acceptance run (ticket 08), not test-harness-only. */
function buildAdapter(
  adapterId: AdapterId,
  ctx: ScheduleContext,
  workflowName: string,
  step: AgentStep,
  iteration?: number,
): AgentAdapter {
  if (adapterId === 'mock') {
    const fixturesDir = path.join(ctx.cwd, 'test', 'fixtures')
    return new MockAdapter(fixturesDir, workflowName, step.id, iteration)
  }
  // Ticket 07/08 (roadmap map): `image` is passed through even when
  // `undefined` — `ClaudeCodeAdapter`'s docker path falls back to the
  // yak-shipped default image in that case, but the *presence* of the
  // `{ image }` object (vs. `undefined`) is what turns containment on.
  return new ClaudeCodeAdapter(
    ctx.runDir,
    step.id,
    step.sandbox === 'docker'
      ? {
          image: step.image,
          ...(step.allowedDomains !== undefined ? { allowedDomains: step.allowedDomains } : {}),
        }
      : undefined,
  )
}

function collectInputHashes(
  step: Step,
  artifactHashes: Map<ArtifactName, string>,
): Record<ArtifactName, string> {
  const inputArtifactHashes: Record<ArtifactName, string> = {}
  for (const need of inputNamesOf(step)) {
    const hash = artifactHashes.get(need)
    if (hash) inputArtifactHashes[need] = hash
  }
  return inputArtifactHashes
}

/**
 * Spec §4.4 `yak resume`: for each step the journal already marked complete,
 * recompute its cache keys against the current step definition and the
 * (possibly just-reused) input artifact hashes. A match trusts the artifact
 * already on disk in `runDir/artifacts` and skips re-running the step; a
 * mismatch leaves it (and so, transitively, everything downstream) out of
 * `completed`, so the normal scheduler loop re-runs it.
 *
 * Walks to a fixpoint since trusting an upstream step can unlock trusting
 * the one after it, in whatever order `remaining` iterates.
 */
function trustResumedSteps(
  remaining: Map<StepId, Step>,
  producerOf: Map<ArtifactName, StepId>,
  resumeState: Map<StepId, ReplayedStep>,
  completed: Set<StepId>,
  artifactHashes: Map<ArtifactName, string>,
): void {
  let progressed = true
  while (progressed) {
    progressed = false
    for (const step of remaining.values()) {
      const info = resumeState.get(step.id)
      if (!info) continue
      if (!dependenciesOf(step, producerOf).every((dep) => completed.has(dep))) continue

      // Ticket 07: a gate step never computes semantic/definitionKey, so
      // there's nothing to match — a completed gate found in the journal
      // (`resume.ts` only appends `step.completed` for one after its answer
      // validated) is trusted unconditionally, never re-suspended.
      if (step.kind !== 'gate') {
        const semanticKey = computeSemanticKey(step, collectInputHashes(step, artifactHashes))
        const definitionKey = computeDefinitionKey(step)
        if (semanticKey !== info.semanticKey || definitionKey !== info.definitionKey) continue
      }

      completed.add(step.id)
      remaining.delete(step.id)
      if (info.artifact && info.artifactHash) artifactHashes.set(info.artifact, info.artifactHash)
      progressed = true
    }
  }
}

/**
 * Spec §4.3: any step whose `needs` are all satisfied is eligible; run
 * eligible steps up to a concurrency cap, and re-evaluate eligibility on
 * every completion (not just once a whole batch drains) so a step can start
 * the moment its dependencies are met.
 *
 * `resumeState` (spec §13 engine loop: "replay journal -> completed set")
 * seeds already-completed steps from a prior, interrupted run of the same
 * workflow — see `trustResumedSteps`.
 */
export async function runEligibleSteps(
  workflow: Workflow,
  ctx: ScheduleContext,
  resumeState?: Map<StepId, ReplayedStep>,
): Promise<'ok' | 'failed' | 'suspended'> {
  const limit = pLimit(ctx.concurrency ?? DEFAULT_CONCURRENCY)
  const producerOf = buildProducerMap(workflow.steps)
  const remaining = new Map(workflow.steps.map((s) => [s.id, s]))
  const completed = new Set<StepId>()
  const failedSteps = new Set<StepId>()
  const inFlight = new Map<StepId, Promise<'ok' | 'failed' | 'suspended'>>()
  const artifactHashes = new Map<ArtifactName, string>(ctx.seedArtifactHashes ?? [])
  let failed = false
  let suspended = false

  if (resumeState) trustResumedSteps(remaining, producerOf, resumeState, completed, artifactHashes)

  const agentSessionIds = new Map<StepId, string>()

  // Ticket 06: a `finally: true` step is eligible once its own deps have
  // *settled* (completed OR failed), independent of the global `failed`
  // flag — every other step still stops being launched the instant
  // anything fails (the pre-existing halt-on-first-failure behavior).
  // Suspension blocks everything, `finally` included: a suspended run
  // hasn't reached a terminal state yet, so nothing downstream should
  // fire until it resumes.
  function launchEligible(): void {
    if (suspended) return
    for (const step of remaining.values()) {
      if (inFlight.has(step.id)) continue
      const deps = dependenciesOf(step, producerOf)
      if (step.finally) {
        if (deps.every((dep) => completed.has(dep) || failedSteps.has(dep))) {
          inFlight.set(
            step.id,
            limit(() => runStep(step, ctx, artifactHashes, workflow.name, agentSessionIds)),
          )
        }
        continue
      }
      if (failed) continue
      if (deps.every((dep) => completed.has(dep))) {
        inFlight.set(
          step.id,
          limit(() => runStep(step, ctx, artifactHashes, workflow.name, agentSessionIds)),
        )
      }
    }
  }

  launchEligible()

  while (inFlight.size > 0) {
    const [doneId, status] = await Promise.race(
      [...inFlight.entries()].map(async ([id, p]) => [id, await p] as const),
    )
    inFlight.delete(doneId)
    remaining.delete(doneId)
    if (status === 'failed') {
      failed = true
      failedSteps.add(doneId)
    } else if (status === 'suspended') suspended = true
    else completed.add(doneId)
    launchEligible()
  }

  if (!failed && !suspended && remaining.size > 0) {
    const stuck = [...remaining.keys()].join(', ')
    throw new Error(`workflow stalled: step(s) [${stuck}] never became eligible`)
  }

  return failed ? 'failed' : suspended ? 'suspended' : 'ok'
}

async function runStep(
  step: Step,
  ctx: ScheduleContext,
  artifactHashes: Map<ArtifactName, string>,
  workflowName: string,
  agentSessionIds: Map<StepId, string>,
): Promise<'ok' | 'failed' | 'suspended'> {
  if (step.kind === 'loop') {
    const semanticKey = computeSemanticKey(step, collectInputHashes(step, artifactHashes))
    const definitionKey = computeDefinitionKey(step)
    return runLoopStep(step, {
      runId: ctx.runId,
      runDir: ctx.runDir,
      cwd: ctx.cwd,
      cacheDir: ctx.cacheDir,
      semanticKey,
      definitionKey,
      outerArtifactHashes: artifactHashes,
      globalConcurrency: ctx.concurrency ?? DEFAULT_CONCURRENCY,
      buildAdapter: (step, iteration) => buildAdapter(ctx.adapter, ctx, workflowName, step, iteration),
      loopContinuation: ctx.loopContinuations?.get(step.id),
    })
  }

  if (step.kind === 'gate') {
    const inputs: Record<string, unknown> = {}
    for (const need of step.needs ?? []) {
      inputs[need] = step.finally
        ? await readArtifactRawOrUndefined(ctx.runDir, need)
        : await readArtifactRaw(ctx.runDir, need)
    }
    return runGateStep(step, inputs, { runId: ctx.runId, runDir: ctx.runDir, cwd: ctx.cwd })
  }

  if (step.kind === 'map') {
    const semanticKey = computeSemanticKey(step, collectInputHashes(step, artifactHashes))
    const definitionKey = computeDefinitionKey(step)
    return runMapStep(step, {
      runId: ctx.runId,
      runDir: ctx.runDir,
      cwd: ctx.cwd,
      cacheDir: ctx.cacheDir,
      semanticKey,
      definitionKey,
      globalConcurrency: ctx.concurrency ?? DEFAULT_CONCURRENCY,
      outerArtifactHashes: artifactHashes,
      buildAdapter: (step, itemIndex) => buildAdapter(ctx.adapter, ctx, workflowName, step, itemIndex),
    })
  }

  // Every other kind (loop/gate/map) already returned above — TS narrows
  // `step` to command | transform | agent here.
  const semanticKey = computeSemanticKey(step, collectInputHashes(step, artifactHashes))
  const definitionKey = computeDefinitionKey(step)

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey,
    definitionKey,
  })

  if (step.skipIf) {
    const skipInputs: Record<string, unknown> = {}
    for (const name of inputNamesOf(step)) {
      skipInputs[name] = step.finally
        ? await readArtifactRawOrUndefined(ctx.runDir, name)
        : await readArtifactRaw(ctx.runDir, name)
    }
    const skip = Boolean(await evalExpr(step.skipIf, skipInputs, ctx.cwd))
    if (skip) {
      // Generalized from the gate-only skipIf (M4 ticket 05): command/
      // transform/agent steps skip outright — no artifact, no cache write.
      // A downstream step that `needs` this one's `produces` simply never
      // becomes eligible, same as any other step that never ran.
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'step.completed',
        stepId: step.id,
        cached: false,
        skipped: true,
      })
      return 'ok'
    }
  }

  const cacheMode = step.cache ?? 'strict'
  const existingEntry = await readCacheEntry(ctx.cacheDir, semanticKey)
  const decision = decideCache(cacheMode, definitionKey, existingEntry)

  if (decision.kind === 'hit') {
    const { entry } = decision
    let artifactHash: string | undefined
    if (entry.artifactName) {
      const artifactSchema = step.kind === 'command' ? CommandResultSchema : z.unknown()
      const written = await writeArtifact(ctx.runDir, entry.artifactName, entry.artifact, artifactSchema)
      artifactHash = written.hash
      artifactHashes.set(entry.artifactName, artifactHash)
    }
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.completed',
      stepId: step.id,
      ...(entry.artifactName ? { artifact: entry.artifactName, artifactHash } : {}),
      cached: true,
      ...(decision.stale ? { stale: true } : {}),
    })
    return 'ok'
  }

  let result: unknown
  try {
    if (step.kind === 'command') {
      result = await runCommandStep(step, ctx.cwd)
    } else if (step.kind === 'transform') {
      const inputs: Record<string, unknown> = {}
      for (const need of step.needs ?? []) {
        inputs[need] = step.finally
          ? await readArtifactRawOrUndefined(ctx.runDir, need)
          : await readArtifactRaw(ctx.runDir, need)
      }
      result = await runTransformStep(step, inputs, ctx.cwd)
    } else {
      const inputs: Record<string, unknown> = {}
      for (const name of agentInputNames(step)) {
        inputs[name] = step.finally
          ? await readArtifactRawOrUndefined(ctx.runDir, name)
          : await readArtifactRaw(ctx.runDir, name)
      }
      const sessionId =
        typeof step.context === 'object' && 'session' in step.context
          ? agentSessionIds.get(step.context.session)
          : undefined
      const adapter = buildAdapter(ctx.adapter, ctx, workflowName, step)
      result = await runAgentStep(
        step,
        inputs,
        { runId: ctx.runId, runDir: ctx.runDir, cwd: ctx.cwd, adapter, sessionId },
        (nextSessionId) => agentSessionIds.set(step.id, nextSessionId),
      )
    }
  } catch (err) {
    if (err instanceof CommandStepFailedError || err instanceof AgentStepFailedError) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'step.failed',
        stepId: step.id,
        failure: err.failure,
      })
      return 'failed'
    }
    throw err
  }

  let artifactName: ArtifactName | undefined
  let artifactHash: string | undefined
  if (step.produces) {
    const artifact =
      step.kind === 'command'
        ? await writeArtifact(ctx.runDir, step.produces, result, CommandResultSchema)
        : await writeArtifact(ctx.runDir, step.produces, result, z.unknown())
    artifactName = artifact.name
    artifactHash = artifact.hash
    artifactHashes.set(artifact.name, artifact.hash)
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'artifact.written',
      name: artifact.name,
      hash: artifact.hash,
      bytes: artifact.bytes,
    })
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.completed',
    stepId: step.id,
    ...(artifactName ? { artifact: artifactName, artifactHash } : {}),
    cached: false,
  })

  await writeCacheEntry(ctx.cacheDir, {
    semanticKey,
    definitionKey,
    ...(artifactName ? { artifactName, artifactHash, artifact: result } : {}),
  })

  return 'ok'
}
