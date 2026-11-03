import path from 'node:path'
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
import { appendJournalEvent } from '../engine/journal.js'
import { inputNamesOf } from '../ir/graph.js'
import type { AgentStep, ArtifactName, MapStep } from '../ir/types.js'
import { commitAllIfDirty, createWorktree, WorktreeCreationError } from '../util/git.js'
import { AgentStepFailedError, runAgentStep } from './agent.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from './command.js'
import { runTransformStep } from './transform.js'

export interface MapRunContext {
  runId: string
  runDir: string
  cwd: string
  cacheDir: string
  semanticKey: string
  definitionKey: string
  /** Ticket 07: map items are scheduled through the same
   * eligibility/concurrency machinery as every other step — no second
   * independent worker pool. `step.concurrency` is a sub-limit inside this
   * cap, never above it. */
  globalConcurrency: number
  outerArtifactHashes: Map<ArtifactName, string>
  buildAdapter: (step: AgentStep, itemIndex: number) => AgentAdapter
}

/** Ticket 05: fixed at 2, hardcoded — no `MapStep` config field in M3. */
const RETRY_ATTEMPTS = 2

/** Ticket 05/06/07: runs a `map` step to completion — fans `step.over`'s
 * list out over `step.step`, one call per item, bounded by `concurrency`.
 * Never partially cancels in-flight items on a `'fail'` policy hit; all
 * items settle, then the aggregate failure policy decides the map step's
 * own outcome. */
export async function runMapStep(step: MapStep, ctx: MapRunContext): Promise<'ok' | 'failed'> {
  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey: ctx.semanticKey,
    definitionKey: ctx.definitionKey,
  })

  // Post-M5 gaps map, ticket 01: item worktrees fork off `HEAD` — commit
  // this run's own prior step output first, once, before any item forks,
  // so items don't fork from a stale tree. Only worktree-isolated items
  // fork at all; `isolation: 'none'` items share ctx.cwd directly and
  // need no commit.
  if (step.isolation === 'worktree') {
    await commitAllIfDirty(ctx.cwd, `yak: checkpoint before map ${step.id}`)
  }

  const items = (await readArtifactRaw(ctx.runDir, step.over)) as unknown[]
  const limit = pLimit(Math.min(step.concurrency ?? 4, ctx.globalConcurrency))

  const results: unknown[] = new Array(items.length)
  let anyFailed = false

  await Promise.all(
    items.map((item, index) =>
      limit(async () => {
        const outcome = await runMapItem(step, item, index, ctx)
        results[index] = outcome.result
        if (outcome.failed) anyFailed = true
      }),
    ),
  )

  if (anyFailed && (step.onItemFailure ?? 'skip') === 'fail') {
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.failed',
      stepId: step.id,
      failure: {
        reason: 'command-failed',
        detail: `map "${step.id}": at least one item failed under onItemFailure: 'fail'`,
        recoverable: false,
      },
    })
    return 'failed'
  }

  if (step.produces) {
    const written = await writeArtifact(ctx.runDir, step.produces, results, z.array(z.unknown()))
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'artifact.written',
      name: step.produces,
      hash: written.hash,
      bytes: written.bytes,
    })
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, { t: 'step.completed', stepId: step.id, cached: false })
  return 'ok'
}

interface MapItemOutcome {
  result: unknown
  failed: boolean
}

/** t03: `.yak/worktrees/<run-id>/<map-step-id>/<index>/` — sibling to the
 * run's own worktree (`run.ts`'s `worktreePathFor`), reconstructed from
 * `runDir` alone (`runDir` = `<runsDir>/<runId>`, and the `.yak` root is
 * `runsDir`'s own parent) so map.ts never needs a `runsDir` field on
 * `MapRunContext` just for this. */
function itemWorktreePath(runDir: string, runId: string, mapStepId: string, index: number): string {
  const runsDir = path.dirname(runDir)
  const yakRoot = path.dirname(runsDir)
  return path.join(yakRoot, '.yak', 'worktrees', runId, mapStepId, String(index))
}

/** t03: forks from `ctx.cwd` — which, whenever `step.isolation: 'worktree'`
 * legally appears (load-time validation requires the run itself to be
 * `--isolation worktree`), is already the run's own worktree, checked out
 * on the run's branch. `'HEAD'` there is that branch's own tip, matching
 * the map decision "an item sees whatever the run has already produced."
 *
 * The branch lives under `yak-item/`, a sibling namespace to the run's own
 * `yak/<run-id>` branch — never nested under it. Git refs are a directory
 * tree: `refs/heads/yak/<run-id>` is a leaf, so `refs/heads/yak/<run-id>/…`
 * can't also exist (`fatal: cannot lock ref … 'refs/heads/yak/<run-id>'
 * exists; cannot create …`). */
async function ensureItemWorktree(step: MapStep, index: number, ctx: MapRunContext): Promise<string> {
  const worktreePath = itemWorktreePath(ctx.runDir, ctx.runId, step.id, index)
  await createWorktree(ctx.cwd, `yak-item/${ctx.runId}/${step.id}/${index}`, 'HEAD', worktreePath)
  return worktreePath
}

/** Ticket 05: retries only apply under `onItemFailure: 'retry'` — `'skip'`
 * and `'fail'` never retry. Exhausting `RETRY_ATTEMPTS` falls back to
 * `'skip'`'s terminal state (`null` + the failure visible in the item's own
 * journal pair, per ticket 06) rather than escalating — `'retry'` is
 * "skip, but try twice more first," not a stricter policy than `'skip'`. */
async function runMapItem(step: MapStep, item: unknown, index: number, ctx: MapRunContext): Promise<MapItemOutcome> {
  const onItemFailure = step.onItemFailure ?? 'skip'
  const maxAttempts = onItemFailure === 'retry' ? RETRY_ATTEMPTS + 1 : 1

  // Memoized rather than created once up front — a successfully-created
  // worktree is reused across retries (a second `add` for the same
  // branch/path would collide), but a *failed* creation attempt goes
  // through the same retry/journal machinery as any other item failure
  // instead of crashing the whole map step.
  let itemCwd: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (step.isolation === 'worktree' && itemCwd === undefined) {
        itemCwd = await ensureItemWorktree(step, index, ctx)
      }
      const result = await runOneItemAttempt(step, item, index, ctx, itemCwd ?? ctx.cwd)
      return { result, failed: false }
    } catch (rawErr) {
      const err =
        rawErr instanceof WorktreeCreationError
          ? new CommandStepFailedError({ reason: 'command-failed', detail: rawErr.message, recoverable: false })
          : rawErr
      if (!(err instanceof CommandStepFailedError || err instanceof AgentStepFailedError)) throw err

      if (attempt < maxAttempts) {
        await appendJournalEvent(ctx.runDir, ctx.runId, {
          t: 'map.item.retried',
          mapStepId: step.id,
          itemIndex: index,
          attempt,
          error: err.failure.detail,
        })
      }
    }
  }

  if (onItemFailure === 'fail') return { result: null, failed: true }

  // 'skip', or 'retry' exhausted — terminal 'skip' state: null in the
  // output array, the failure itself already visible via the item's own
  // step.failed journal pair (journaled inside runOneItemAttempt).
  return { result: null, failed: false }
}

/** Ticket 06: one item's own `step.started`/`step.completed`(-or-`failed`)
 * pair under a synthetic sub-step id (`review-files[3]`), and its own
 * per-item cache key/artifact path (`artifacts/<produces>.<index>.json`) —
 * the same machinery ticket 10 gave loop iterations, reused here for item
 * index instead. The item step implicitly receives the current item as an
 * input named after `over` (spec's TS-shape `step: (file) => ...` made
 * concrete for the YAML IR, which has no per-item closure). */
async function runOneItemAttempt(
  step: MapStep,
  item: unknown,
  index: number,
  ctx: MapRunContext,
  itemCwd: string,
): Promise<unknown> {
  const itemStep = step.step
  const syntheticId = `${step.id}[${index}]`

  const inputs: Record<string, unknown> = { [step.over]: item }
  const inputHashesForKey: Record<string, string> = {}
  for (const name of inputNamesOf(itemStep)) {
    if (name === step.over) continue
    inputs[name] = await readArtifactRaw(ctx.runDir, name)
    const hash = ctx.outerArtifactHashes.get(name)
    if (hash) inputHashesForKey[name] = hash
  }

  const semanticKey = computeSemanticKey(itemStep, inputHashesForKey, index)
  const definitionKey = computeDefinitionKey(itemStep)

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: syntheticId,
    iteration: index,
    semanticKey,
    definitionKey,
  })

  const cacheMode = itemStep.cache ?? 'strict'
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
    try {
      if (itemStep.kind === 'command') {
        result = await runCommandStep(itemStep, itemCwd, {
          MAP_ITEM_INDEX: String(index),
          MAP_ITEM: JSON.stringify(item),
        })
      } else if (itemStep.kind === 'transform') {
        result = await runTransformStep(itemStep, inputs, itemCwd)
      } else if (itemStep.kind === 'agent') {
        const adapter = ctx.buildAdapter(itemStep, index)
        result = await runAgentStep(itemStep, inputs, { runId: ctx.runId, runDir: ctx.runDir, cwd: itemCwd, adapter })
      } else {
        throw new Error(`step "${itemStep.id}": kind "${itemStep.kind}" not supported as a map item step in M3`)
      }
    } catch (err) {
      if (err instanceof CommandStepFailedError || err instanceof AgentStepFailedError) {
        await appendJournalEvent(ctx.runDir, ctx.runId, {
          t: 'step.failed',
          stepId: syntheticId,
          iteration: index,
          failure: err.failure,
        })
      }
      throw err
    }
  }

  // Ticket 06: the per-item file is named after the *map step's* own
  // `produces` (e.g. `findings.3.json`), not the item step's — the item
  // step's own `produces` (if any) is irrelevant here; the map step is
  // what names the assembled array, and each item's file is an indexed
  // slice of that same name.
  let artifactHash: string | undefined
  if (step.produces) {
    const schema = itemStep.kind === 'command' ? CommandResultSchema : z.unknown()
    const written = await writeArtifact(ctx.runDir, step.produces, result, schema, index)
    artifactHash = written.hash
    if (!cached) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'artifact.written',
        name: step.produces,
        hash: artifactHash,
        bytes: written.bytes,
      })
    }
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.completed',
    stepId: syntheticId,
    iteration: index,
    ...(step.produces ? { artifact: step.produces, artifactHash } : {}),
    cached,
    ...(stale ? { stale: true } : {}),
  })

  if (!cached) {
    await writeCacheEntry(ctx.cacheDir, {
      semanticKey,
      definitionKey,
      ...(step.produces ? { artifactName: step.produces, artifactHash, artifact: result } : {}),
    })
  }

  return result
}
