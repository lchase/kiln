import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cancelRun } from '../../src/engine/cancel.js'
import type { SignalFn } from '../../src/engine/cancel.js'
import { appendJournalEvent, readJournal } from '../../src/engine/journal.js'
import type { JournalEvent } from '../../src/ir/types.js'

async function makeRun(events: JournalEvent[]): Promise<{ runsDir: string; runId: string; runDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yak-cancel-'))
  const runsDir = path.join(dir, '.runs')
  const runId = 'run-1'
  const runDir = path.join(runsDir, runId)
  for (const event of events) await appendJournalEvent(runDir, runId, event)
  return { runsDir, runId, runDir }
}

const STARTED = (pid?: number): JournalEvent => ({
  t: 'run.started',
  runId: 'run-1',
  workflow: 'wf',
  inputHash: 'h',
  adapter: 'mock',
  isolation: 'none',
  ...(pid !== undefined ? { pid } : {}),
})

/** A fake process that is alive until it receives SIGTERM (or SIGKILL). */
function fakeProcess(pid: number): { signal: SignalFn; calls: Array<[number, string]> } {
  let alive = true
  const calls: Array<[number, string]> = []
  return {
    calls,
    signal: (target, sig) => {
      calls.push([target, String(sig)])
      if (sig === 0) {
        if (!alive) throw new Error('ESRCH')
        return
      }
      if (Math.abs(target) === pid) alive = false
    },
  }
}

const instantSleep = () => Promise.resolve()

describe('cancelRun (yak#24)', () => {
  it('returns not-found when the run has no run.started', async () => {
    const { runsDir } = await makeRun([])
    expect(await cancelRun('run-1', { runsDir })).toEqual({ status: 'not-found', runId: 'run-1' })
  })

  it('SIGTERMs the process group and journals a cancelled terminal state', async () => {
    const { runsDir, runDir } = await makeRun([
      STARTED(4242),
      { t: 'step.started', stepId: 'build', semanticKey: 's', definitionKey: 'd' },
    ])
    const proc = fakeProcess(4242)

    const outcome = await cancelRun('run-1', { runsDir, signal: proc.signal, sleep: instantSleep })

    expect(outcome).toEqual({ status: 'cancelled', runId: 'run-1', signalled: 'sigterm' })
    expect(proc.calls).toContainEqual([-4242, 'SIGTERM'])

    const last = (await readJournal(runDir)).at(-1)
    expect(last).toMatchObject({ t: 'run.finished', status: 'failed', reason: 'cancelled' })
  })

  it('falls back to the bare pid when the group signal fails', async () => {
    const { runsDir } = await makeRun([STARTED(4242)])
    const calls: Array<[number, string]> = []
    let alive = true
    const signal: SignalFn = (target, sig) => {
      if (sig === 0) {
        if (!alive) throw new Error('ESRCH')
        return
      }
      if (target < 0) throw new Error('ESRCH') // no process group
      calls.push([target, String(sig)])
      alive = false
    }

    const outcome = await cancelRun('run-1', { runsDir, signal, sleep: instantSleep })

    expect(outcome.status).toBe('cancelled')
    expect(calls).toEqual([[4242, 'SIGTERM']])
  })

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const { runsDir } = await makeRun([STARTED(4242)])
    const calls: Array<[number, string]> = []
    const signal: SignalFn = (target, sig) => {
      calls.push([target, String(sig)])
      if (sig === 0) return // always alive
    }
    const sleep = vi.fn(instantSleep)

    const outcome = await cancelRun('run-1', { runsDir, signal, sleep })

    expect(outcome).toMatchObject({ status: 'cancelled', signalled: 'sigkill' })
    expect(calls).toContainEqual([-4242, 'SIGTERM'])
    expect(calls).toContainEqual([-4242, 'SIGKILL'])
    expect(sleep).toHaveBeenCalled()
  })

  it('still journals a cancelled state when the recorded process is already gone', async () => {
    const { runsDir, runDir } = await makeRun([STARTED(4242)])
    const signal: SignalFn = () => {
      throw new Error('ESRCH')
    }

    const outcome = await cancelRun('run-1', { runsDir, signal, sleep: instantSleep })

    expect(outcome).toEqual({ status: 'cancelled', runId: 'run-1', signalled: 'not-running' })
    expect((await readJournal(runDir)).at(-1)).toMatchObject({ status: 'failed', reason: 'cancelled' })
  })

  it('handles a pre-yak#24 journal with no pid — marks cancelled without signalling', async () => {
    const { runsDir, runDir } = await makeRun([STARTED()])
    const signal = vi.fn<SignalFn>()

    const outcome = await cancelRun('run-1', { runsDir, signal, sleep: instantSleep })

    expect(outcome).toEqual({ status: 'cancelled', runId: 'run-1', signalled: 'no-pid' })
    expect(signal).not.toHaveBeenCalled()
    expect((await readJournal(runDir)).at(-1)).toMatchObject({ status: 'failed', reason: 'cancelled' })
  })

  it('signals the resume process pid, not the stale original run pid', async () => {
    const { runsDir } = await makeRun([STARTED(1111), { t: 'run.resumed', pid: 2222 }])
    const proc = fakeProcess(2222)

    const outcome = await cancelRun('run-1', { runsDir, signal: proc.signal, sleep: instantSleep })

    expect(outcome.status).toBe('cancelled')
    expect(proc.calls.map(([target]) => Math.abs(target))).toContain(2222)
    expect(proc.calls.map(([target]) => Math.abs(target))).not.toContain(1111)
  })

  it('defers to a real terminal state the run wrote while shutting down', async () => {
    const { runsDir, runDir } = await makeRun([STARTED(4242)])
    // Process stays up through SIGTERM; on the first grace-loop tick it
    // finishes its own journal and (still) doesn't exit until SIGKILL.
    const signal: SignalFn = (_target, sig) => {
      if (sig === 0) return // always "alive"
    }
    let wroteTerminal = false
    const sleep = async () => {
      if (wroteTerminal) return
      wroteTerminal = true
      await appendJournalEvent(runDir, 'run-1', { t: 'run.finished', status: 'failed' })
    }

    const outcome = await cancelRun('run-1', { runsDir, signal, sleep })

    expect(outcome).toEqual({ status: 'already-terminal', runId: 'run-1', finishedStatus: 'failed' })
    const finishes = (await readJournal(runDir)).filter((e) => e.t === 'run.finished')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).not.toMatchObject({ reason: 'cancelled' })
  })

  it('is idempotent — a run already ending in run.finished is left untouched', async () => {
    const { runsDir, runDir } = await makeRun([STARTED(4242), { t: 'run.finished', status: 'ok' }])
    const signal = vi.fn<SignalFn>()

    const outcome = await cancelRun('run-1', { runsDir, signal, sleep: instantSleep })

    expect(outcome).toEqual({ status: 'already-terminal', runId: 'run-1', finishedStatus: 'ok' })
    expect(signal).not.toHaveBeenCalled()
    expect(await readJournal(runDir)).toHaveLength(2)
  })
})
