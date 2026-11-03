import path from 'node:path'
import type { JournalEnvelope } from '../ir/types.js'
import { appendJournalEvent, readJournal } from './journal.js'
import { defaultRunsDir } from './run.js'

/** How long `yak cancel` waits for a SIGTERM'd process tree to exit before
 * escalating to SIGKILL, and how often it re-checks. */
const SIGKILL_GRACE_MS = 5_000
const LIVENESS_POLL_MS = 100
const LIVENESS_POLLS = Math.ceil(SIGKILL_GRACE_MS / LIVENESS_POLL_MS)

/** Injected in tests; the default signals real OS processes. A negative
 * `pid` addresses the process group (the detached-launch group leader), so
 * one signal reaches the agent subprocess tree too. Signal `0` is the
 * liveness probe — it delivers nothing, only throws when no such process
 * exists. */
export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void

const realSignal: SignalFn = (pid, signal) => {
  process.kill(pid, signal)
}

export interface CancelOptions {
  runsDir?: string
  signal?: SignalFn
  /** Overridable sleep, so the SIGKILL grace loop is instant under test. */
  sleep?: (ms: number) => Promise<void>
}

export type CancelOutcome =
  | { status: 'not-found'; runId: string }
  | { status: 'already-terminal'; runId: string; finishedStatus: 'ok' | 'failed' | 'suspended' }
  | { status: 'cancelled'; runId: string; signalled: 'sigterm' | 'sigkill' | 'no-pid' | 'not-running' }

/** The pid to signal: the most recent `run.resumed` if the run was resumed,
 * else the original `run.started`. Either may be absent (pre-yak#24
 * journal, or `run.started` never reached). */
function livePidFromJournal(events: JournalEnvelope[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.t === 'run.resumed') return event.pid
  }
  const started = events.find((e) => e.t === 'run.started')
  return started?.t === 'run.started' ? started.pid : undefined
}

function isAlive(signal: SignalFn, pid: number): boolean {
  try {
    signal(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still
    // alive, just not ours to signal. Only ESRCH ("no such process") is a
    // real "gone".
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** SIGTERM the group (falling back to the bare pid if it isn't a group
 * leader), then wait out a grace period and SIGKILL anything still alive. */
async function terminateProcessTree(
  signal: SignalFn,
  sleep: (ms: number) => Promise<void>,
  pid: number,
): Promise<'sigterm' | 'sigkill' | 'not-running'> {
  if (!isAlive(signal, pid)) return 'not-running'

  try {
    signal(-pid, 'SIGTERM')
  } catch {
    try {
      signal(pid, 'SIGTERM')
    } catch {
      // Raced us to exit between the liveness check and here.
      return 'sigterm'
    }
  }

  for (let poll = 0; poll < LIVENESS_POLLS; poll++) {
    if (!isAlive(signal, pid)) return 'sigterm'
    await sleep(LIVENESS_POLL_MS)
  }

  if (!isAlive(signal, pid)) return 'sigterm'
  try {
    signal(-pid, 'SIGKILL')
  } catch {
    try {
      signal(pid, 'SIGKILL')
    } catch {
      // Gone by the time we escalated.
    }
  }
  return 'sigkill'
}

/**
 * yak#24: clean engine-side termination of a live run. Signals the run's
 * process tree (SIGTERM, then SIGKILL after a grace period), then journals
 * a terminal `run.finished { status: 'failed', reason: 'cancelled' }` so
 * every journal reader (`yak pending`, `yak status`, `yak watch`, the
 * harness reconciler) sees a clean terminal state. The isolation worktree
 * and its branch are left in place for normal cleanup.
 *
 * Idempotent: a run whose journal already ends in `run.finished` is left
 * untouched. A run whose recorded process is already gone (stale pid,
 * pre-yak#24 journal) still gets the terminal `run.finished` written —
 * that is the whole point of a supported cancel over `kill(2)`.
 *
 * Known limitation: the recorded pid is trusted as-is. If the OS has
 * recycled it onto an unrelated process since `run.started`, that process
 * receives the signal. The journal-liveness model can't distinguish this;
 * a run that is genuinely still alive will not have written `run.finished`,
 * which is the strongest guard available without a pid-verifying sidecar.
 */
export async function cancelRun(runId: string, opts: CancelOptions = {}): Promise<CancelOutcome> {
  const runsDir = opts.runsDir ?? defaultRunsDir()
  const signal = opts.signal ?? realSignal
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const runDir = path.join(runsDir, runId)

  const events = await readJournal(runDir)
  if (!events.some((e) => e.t === 'run.started')) return { status: 'not-found', runId }

  const last = events.at(-1)
  if (last?.t === 'run.finished') {
    return { status: 'already-terminal', runId, finishedStatus: last.status }
  }

  const pid = livePidFromJournal(events)
  const signalled =
    pid === undefined ? 'no-pid' : await terminateProcessTree(signal, sleep, pid)

  // The run's own process appends a `run.finished` when it exits cleanly.
  // If it did so while we were signalling (it was already wrapping up, or
  // it caught the SIGTERM and shut down gracefully), that terminal state
  // stands — don't overwrite a real outcome with 'cancelled'.
  const settled = (await readJournal(runDir)).at(-1)
  if (settled?.t === 'run.finished') {
    return { status: 'already-terminal', runId, finishedStatus: settled.status }
  }

  await appendJournalEvent(runDir, runId, {
    t: 'run.finished',
    status: 'failed',
    reason: 'cancelled',
  })

  return { status: 'cancelled', runId, signalled }
}
