import { randomBytes } from 'node:crypto'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { flattenSteps } from '../ir/graph.js'
import { loadWorkflowYaml } from '../ir/load.js'
import { normalizeWorkflow } from '../ir/normalize.js'
import { INPUT_ARTIFACT } from '../ir/types.js'
import type { AdapterId, ArtifactName, RunIsolation, StepId, Workflow } from '../ir/types.js'
import { validateWorkflow } from '../ir/validate.js'
import { completeGate } from '../steps/gate.js'
import { resolveSchemaSpec } from '../ir/schema-resolve.js'
import { attachWorktree, createWorktree, localBranchExists, resolveCommit } from '../util/git.js'
import { sha256 } from '../util/hash.js'
import { readArtifactRawOrUndefined, writeArtifact } from './artifacts.js'
import { appendJournalEvent, completedStepsFromJournal, readJournal } from './journal.js'
import { runEligibleSteps } from './scheduler.js'
import { openRequestStepIds, resolveAnswer } from './suspend.js'

const DEFAULT_ADAPTER: AdapterId = 'claude-code'

/** A `yak run --input` value that does not satisfy the workflow's
 * `inputSchema` — user error, surfaced before the run directory is
 * created, exactly like a malformed workflow. */
export class InputValidationError extends Error {
  override name = 'InputValidationError'
}

export interface ExecuteOptions {
  runsDir?: string
  cwd?: string
  cacheDir?: string
  adapter?: AdapterId
  isolation?: RunIsolation
  /** The `yak run --input key=value` map (yak#27). Validated against the
   * workflow's `inputSchema` and written as the reserved `input` artifact. */
  input?: Record<string, unknown>
  /** `yak run --tag <string>` (yak#22): an opaque caller-supplied
   * correlation tag, stored verbatim on `run.started` and echoed by `yak
   * pending`/`yak status`. No engine semantics attached. */
  tag?: string
  /** `yak run --isolation worktree --from <ref>`: revision to fork the
   * run worktree from. Resolved with `git rev-parse --verify <ref>^{commit}`
   * before the run starts; the commit SHA is stored on `run.started` as
   * `worktreeBase`. Requires `isolation: 'worktree'`. Omit to fork from
   * HEAD. Resume ignores this field and uses the journaled commit. */
  from?: string
  /** yak#23: invoked once, immediately after `run.started` is journalled
   * and before any step executes, so an out-of-process launcher can
   * capture the run id without waiting for a terminal state or diffing
   * `.runs/`. The engine writes nothing to stdout/stderr itself — the CLI
   * layer owns that. Awaited before the first step runs, so an async
   * launcher can finish recording the mapping first. */
  onStart?: (info: RunStartInfo) => void | Promise<void>
}

export interface RunStartInfo {
  runId: string
  runDir: string
  /** The isolation worktree's branch, `yak/<run-id>`, only when the run
   * is `--isolation worktree`. */
  worktreeBranch?: string
}

/**
 * Resolves the run input (yak#27) before any disk state exists. Returns
 * `undefined` when the workflow neither declares an `inputSchema` nor has
 * a step that `needs: ['input']` and no `--input` was passed — nothing to
 * write. Otherwise returns the value to store as the `input` artifact,
 * schema-validated (and coerced) when an `inputSchema` is declared.
 */
async function resolveRunInput(
  workflow: Workflow,
  rawInput: Record<string, unknown> | undefined,
  cwd: string,
): Promise<unknown | undefined> {
  const stepNeedsInput = flattenSteps(workflow.steps).some((s) => (s.needs ?? []).includes(INPUT_ARTIFACT))
  if (rawInput === undefined && workflow.inputSchema === undefined && !stepNeedsInput) {
    return undefined
  }

  const provided = rawInput ?? {}
  if (workflow.inputSchema === undefined) return provided

  const schema = await resolveSchemaSpec(workflow.inputSchema, cwd)
  const parsed = schema.safeParse(provided)
  if (!parsed.success) {
    throw new InputValidationError(
      `--input does not satisfy the workflow's inputSchema:\n${parsed.errorSummary}`,
    )
  }
  return parsed.data
}

/** Recompute the `input` artifact's hash on resume so it seeds cache keys
 * identically to the original run — the on-disk file is exactly what
 * `writeArtifact` serialized, so hashing its bytes matches. */
async function seedInputHash(runDir: string): Promise<Map<ArtifactName, string> | undefined> {
  const value = await readArtifactRawOrUndefined(runDir, INPUT_ARTIFACT)
  if (value === undefined) return undefined
  return new Map([[INPUT_ARTIFACT, sha256(JSON.stringify(value, null, 2))]])
}

export interface ExecuteResult {
  runId: string
  runDir: string
  status: 'ok' | 'failed' | 'suspended'
}

export function defaultRunsDir(): string {
  return path.join(process.cwd(), '.runs')
}

function resolveDirs(runsDir: string | undefined, cwd: string | undefined, cacheDir: string | undefined) {
  const resolvedRunsDir = runsDir ?? defaultRunsDir()
  return {
    runsDir: resolvedRunsDir,
    cwd: cwd ?? process.cwd(),
    cacheDir: cacheDir ?? path.join(path.dirname(resolvedRunsDir), '.yak', 'cache'),
  }
}

/** `.yak/worktrees/<run-id>/` — sibling to `.yak/cache`, deterministic from
 * `runsDir` and `runId` alone so a resumed run can recompute the same path
 * without re-reading anything. */
function worktreePathFor(runsDir: string, runId: string): string {
  return path.join(path.dirname(runsDir), '.yak', 'worktrees', runId)
}

/** The branch an `--isolation worktree` run's worktree is checked out on. */
function worktreeBranchFor(runId: string): string {
  return `yak/${runId}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Recreates a missing run worktree from the commit recorded at start.
 * An existing worktree is left alone — resume never resets it. An existing
 * `yak/<run-id>` branch is reattached, so commits the run already made stay
 * on that branch. Only when the branch is gone do we fork again, and then
 * from `worktreeBase` (a SHA), never from the caller's original ref. */
async function materializeRunWorktree(
  repoRoot: string,
  runsDir: string,
  runId: string,
  worktreeBase: string | undefined,
): Promise<void> {
  const worktreePath = worktreePathFor(runsDir, runId)
  if (await pathExists(worktreePath)) return
  if (worktreeBase === undefined) return

  const branchName = worktreeBranchFor(runId)
  if (await localBranchExists(repoRoot, branchName)) {
    await attachWorktree(repoRoot, branchName, worktreePath)
    return
  }
  await createWorktree(repoRoot, branchName, worktreeBase, worktreePath)
}

function generateRunId(): string {
  const iso = new Date().toISOString() // e.g. 2026-08-08T14:03:11.123Z
  const [datePart, timePart] = iso.split('T')
  const time = (timePart ?? '').replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const suffix = randomBytes(2).toString('hex')
  return `${datePart}T${time}Z-${suffix}`
}

export async function executeWorkflowFile(
  workflowPath: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const { runsDir, cwd, cacheDir } = resolveDirs(opts.runsDir, opts.cwd, opts.cacheDir)
  const adapter = opts.adapter ?? DEFAULT_ADAPTER
  const isolation = opts.isolation ?? 'none'

  // `--from` only applies to the run worktree. Item worktrees fork from
  // that worktree's HEAD later; they never see this ref.
  if (opts.from !== undefined && isolation !== 'worktree') {
    throw new Error('--from requires --isolation worktree')
  }

  const raw = await loadWorkflowYaml(workflowPath)
  const workflow = normalizeWorkflow(raw)
  await validateWorkflow(workflow, cwd, isolation)

  // yak#27: resolve + validate `--input` before any run state exists.
  const inputValue = await resolveRunInput(workflow, opts.input, cwd)

  // Pin `--from` before any run state exists. An unknown ref throws here:
  // no worktree, no run directory, no `run.started`. The stored value is
  // the commit SHA, not the ref name, so a later move of the ref cannot
  // change where this run started.
  const worktreeBase = opts.from !== undefined ? await resolveCommit(cwd, opts.from) : undefined

  const runId = generateRunId()
  const runDir = path.join(runsDir, runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8')

  // The `input` artifact file is written before `run.started` so its hash
  // can go on that event; its `artifact.written` journal line follows.
  let seedArtifactHashes: Map<ArtifactName, string> | undefined
  let inputWritten: Awaited<ReturnType<typeof writeArtifact>> | undefined
  if (inputValue !== undefined) {
    inputWritten = await writeArtifact(runDir, INPUT_ARTIFACT, inputValue, z.unknown())
    seedArtifactHashes = new Map([[INPUT_ARTIFACT, inputWritten.hash]])
  }

  await appendJournalEvent(runDir, runId, {
    t: 'run.started',
    runId,
    workflow: workflow.name,
    inputHash: inputWritten?.hash ?? sha256(JSON.stringify(workflow)),
    adapter,
    isolation,
    pid: process.pid,
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
    ...(worktreeBase !== undefined ? { worktreeBase } : {}),
  })

  if (inputWritten) {
    await appendJournalEvent(runDir, runId, {
      t: 'artifact.written',
      name: inputWritten.name,
      hash: inputWritten.hash,
      bytes: inputWritten.bytes,
    })
  }

  await opts.onStart?.({
    runId,
    runDir,
    ...(isolation === 'worktree' ? { worktreeBranch: worktreeBranchFor(runId) } : {}),
  })

  // `runsDir`/`cacheDir` stay anchored to the original repo regardless of
  // isolation — only the step-execution cwd swaps into the worktree.
  let stepCwd = cwd
  if (isolation === 'worktree') {
    const worktreePath = worktreePathFor(runsDir, runId)
    try {
      await createWorktree(cwd, worktreeBranchFor(runId), worktreeBase ?? 'HEAD', worktreePath)
    } catch {
      // A worktree-add failure (e.g. a race against another concurrent run)
      // is an ordinary run failure, not an uncaught exception — it goes
      // through the same run.finished/'failed' path every other failure
      // does, so callers only ever see the ExecuteResult status contract.
      await appendJournalEvent(runDir, runId, { t: 'run.finished', status: 'failed' })
      return { runId, runDir, status: 'failed' }
    }
    stepCwd = worktreePath
  }

  const status = await runEligibleSteps(workflow, {
    runId,
    runDir,
    cwd: stepCwd,
    cacheDir,
    adapter,
    seedArtifactHashes,
  })

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}

/** Run ids sort lexicographically by their leading ISO timestamp, so the
 * latest run is just the last directory name — no need to read journals. */
export async function findLatestRunId(runsDir: string): Promise<string | undefined> {
  const entries = await readdir(runsDir).catch(() => [] as string[])
  return entries.sort().at(-1)
}

/** Reads back the workflow a run was started with — the frozen copy
 * `executeWorkflowFile` writes to `runDir/workflow.json`, shared by resume
 * and status so both agree on run-directory layout in one place. */
export async function readRunWorkflow(runDir: string): Promise<Workflow> {
  return JSON.parse(await readFile(path.join(runDir, 'workflow.json'), 'utf8')) as Workflow
}

/**
 * M4 ticket 06: resolves every currently-open pending request (a gate or a
 * loop-exhaustion suspend, ticket 03's journal-based "open" test) against
 * whatever answer file a human has written. A missing or schema-invalid
 * answer throws — the run is left exactly as it was, no journal writes,
 * per ticket 06's "leave suspended, fix and retry" resolution; `yak
 * resume` surfaces the message and exits non-zero. Every request answered
 * validly gets consumed: a gate writes its artifact (`completeGate`), a
 * loop-exhaustion answer is folded into the returned `loopContinuations`
 * map for `runLoopStep` to act on.
 */
async function resolveOpenRequests(
  runId: string,
  runDir: string,
  workflow: Workflow,
  cwd: string,
  events: Awaited<ReturnType<typeof readJournal>>,
): Promise<Map<StepId, { action: 'continue' | 'abort'; addIterations?: number }>> {
  const loopContinuations = new Map<StepId, { action: 'continue' | 'abort'; addIterations?: number }>()
  const openIds = openRequestStepIds(events)
  if (openIds.length === 0) return loopContinuations

  const flatSteps = flattenSteps(workflow.steps)
  const gateAnswerSchema = async (request: { stepId: StepId }) => {
    const step = flatSteps.find((s) => s.id === request.stepId)
    if (!step || step.kind !== 'gate') {
      throw new Error(`pending request for step "${request.stepId}" but no gate step with that id exists`)
    }
    return resolveSchemaSpec(step.schema, cwd)
  }

  const resolutions = await Promise.all(openIds.map((stepId) => resolveAnswer(runDir, stepId, gateAnswerSchema)))

  const missing = resolutions.filter((r) => r.status === 'missing')
  const invalid = resolutions.filter((r) => r.status === 'invalid')
  if (missing.length > 0 || invalid.length > 0) {
    const lines = [
      ...missing.map((r) => `  ${r.stepId}: no answer file written yet`),
      ...invalid.map((r) => `  ${r.stepId}: invalid answer\n${r.errors.replace(/^/gm, '    ')}`),
    ]
    throw new Error(`run ${runId} still has unresolved pending requests:\n${lines.join('\n')}`)
  }

  for (const resolution of resolutions) {
    if (resolution.status !== 'ok') continue
    const { request, answer } = resolution

    if (request.kind === 'loop-exhausted') {
      loopContinuations.set(request.stepId, answer as { action: 'continue' | 'abort'; addIterations?: number })
      await appendJournalEvent(runDir, runId, { t: 'gate.answered', stepId: request.stepId })
      continue
    }

    const step = flatSteps.find((s) => s.id === request.stepId)
    if (!step || step.kind !== 'gate') {
      throw new Error(`pending request for step "${request.stepId}" but no gate step with that id exists`)
    }
    await completeGate(step, { runId, runDir, cwd }, answer, { skipped: false })
  }

  return loopContinuations
}

/**
 * Spec §4.4 `yak resume <run-id>`: replay the journal of an interrupted run,
 * mark completed steps, and continue — reusing cache-valid artifacts and
 * re-running only what wasn't (and everything downstream of a mismatch).
 */
export async function resumeRun(runId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { runsDir, cwd, cacheDir } = resolveDirs(opts.runsDir, opts.cwd, opts.cacheDir)
  const runDir = path.join(runsDir, runId)

  const workflow = await readRunWorkflow(runDir)

  // yak#24: record this resume process's pid so `yak cancel` signals the
  // live process, not the (long-gone) one from the original `yak run`.
  await appendJournalEvent(runDir, runId, { t: 'run.resumed', pid: process.pid })

  let events = await readJournal(runDir)
  const loopContinuations = await resolveOpenRequests(runId, runDir, workflow, cwd, events)

  events = await readJournal(runDir)
  const resumeState = completedStepsFromJournal(events)

  // Ticket 09: the adapter choice is a per-run constant, persisted on
  // `run.started` — resuming under a different adapter than the run
  // started with would mix real/fake steps in one journal, so an explicit
  // conflicting override is rejected rather than silently honored.
  const startedEvent = events.find((e) => e.t === 'run.started')
  const persistedAdapter = startedEvent?.adapter ?? DEFAULT_ADAPTER
  if (opts.adapter !== undefined && opts.adapter !== persistedAdapter) {
    throw new Error(
      `run ${runId} started with adapter "${persistedAdapter}" — cannot resume with adapter "${opts.adapter}"`,
    )
  }

  // Isolation is a per-run constant persisted on `run.started`, so a
  // conflicting override is rejected rather than silently honored.
  // `opts.from` is ignored: resume must not re-resolve a ref that may
  // have moved. It reuses the worktree, or recreates it from the
  // journaled `worktreeBase` commit when that worktree is gone.
  const persistedIsolation = startedEvent?.isolation ?? 'none'
  if (opts.isolation !== undefined && opts.isolation !== persistedIsolation) {
    throw new Error(
      `run ${runId} started with isolation "${persistedIsolation}" — cannot resume with isolation "${opts.isolation}"`,
    )
  }
  if (persistedIsolation === 'worktree') {
    await materializeRunWorktree(cwd, runsDir, runId, startedEvent?.worktreeBase)
  }
  const stepCwd = persistedIsolation === 'worktree' ? worktreePathFor(runsDir, runId) : cwd

  // yak#27: re-seed the `input` artifact hash so resumed steps recompute
  // the same cache keys the original run did.
  const seedArtifactHashes = await seedInputHash(runDir)

  const status = await runEligibleSteps(
    workflow,
    {
      runId,
      runDir,
      cwd: stepCwd,
      cacheDir,
      adapter: persistedAdapter,
      loopContinuations,
      seedArtifactHashes,
    },
    resumeState,
  )

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}
