import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelCommand } from '../../src/cli/commands/cancel.js'
import { appendJournalEvent, readJournal } from '../../src/engine/journal.js'
import type { JournalEvent } from '../../src/ir/types.js'

const STARTED: JournalEvent = {
  t: 'run.started',
  runId: 'run-1',
  workflow: 'wf',
  inputHash: 'h',
  adapter: 'mock',
  isolation: 'none',
  pid: 999999999, // implausibly high — never a live process
}

describe('yak cancel (CLI)', () => {
  let logs: string[]
  let errs: string[]

  beforeEach(() => {
    logs = []
    errs = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l))
    vi.spyOn(console, 'error').mockImplementation((l: string) => void errs.push(l))
  })
  afterEach(() => vi.restoreAllMocks())

  async function runsDirWith(events: JournalEvent[]): Promise<string> {
    const runsDir = path.join(await mkdtemp(path.join(tmpdir(), 'yak-cancel-cli-')), '.runs')
    for (const e of events) await appendJournalEvent(path.join(runsDir, 'run-1'), 'run-1', e)
    return runsDir
  }

  it('exits 1 and complains for an unknown run', async () => {
    const runsDir = await runsDirWith([])
    expect(await cancelCommand('run-1', { runsDir })).toBe(1)
    expect(errs[0]).toBe('run run-1 not found')
  })

  it('cancels a live run, writes the terminal event, exits 0', async () => {
    const runsDir = await runsDirWith([STARTED])
    const code = await cancelCommand('run-1', { runsDir })
    expect(code).toBe(0)
    expect(logs[0]).toMatch(/^run run-1 cancelled/)
    expect((await readJournal(path.join(runsDir, 'run-1'))).at(-1)).toMatchObject({
      t: 'run.finished',
      status: 'failed',
      reason: 'cancelled',
    })
  })

  it('is a no-op on an already-finished run', async () => {
    const runsDir = await runsDirWith([STARTED, { t: 'run.finished', status: 'ok' }])
    expect(await cancelCommand('run-1', { runsDir })).toBe(0)
    expect(logs[0]).toBe('run run-1 already finished: ok — nothing to cancel')
  })
})
