import { describe, expect, it, vi } from 'vitest'
import { snapshotFromJournal, watchRun } from '../../src/engine/watch.js'
import type { CommandStep, JournalEnvelope, JournalEvent, LoopStep, Workflow } from '../../src/ir/types.js'

function envelope(event: JournalEvent): JournalEnvelope {
  return { ...event, at: '2026-08-08T00:00:00.000Z', runId: 'run-1' }
}

function command(id: string): CommandStep {
  return { id, kind: 'command', run: 'echo x' }
}

function workflow(steps: Workflow['steps']): Workflow {
  return { name: 'w', version: '1', steps }
}

describe('snapshotFromJournal', () => {
  it('reports step statuses and no run status while the run is in progress', () => {
    const wf = workflow([command('install'), command('test')])
    const events = [
      envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem', definitionKey: 'def' }),
      envelope({ t: 'step.completed', stepId: 'install', cached: false }),
    ]

    const snapshot = snapshotFromJournal(wf, events)

    expect(snapshot.stepStatuses).toEqual([
      { stepId: 'install', status: 'completed' },
      { stepId: 'test', status: 'pending' },
    ])
    expect(snapshot.runStatus).toBeUndefined()
  })

  it('surfaces the run status once run.finished appears', () => {
    const wf = workflow([command('install')])
    const events = [
      envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem', definitionKey: 'def' }),
      envelope({ t: 'step.completed', stepId: 'install', cached: false }),
      envelope({ t: 'run.finished', status: 'ok' }),
    ]

    expect(snapshotFromJournal(wf, events).runStatus).toBe('ok')
  })

  it('lists a step with an open gate.opened/no gate.answered pair under openGateIds', () => {
    const wf = workflow([{ id: 'approve', kind: 'gate', schema: 'S', render: { inline: 'ok?' } }])
    const events = [envelope({ t: 'gate.opened', stepId: 'approve', requestPath: 'pending/approve.json' })]

    expect(snapshotFromJournal(wf, events).openGateIds).toEqual(['approve'])
  })

  it('reports loop iteration/budget for a loop step', () => {
    const loopStep: LoopStep = {
      id: 'fix-until-green',
      kind: 'loop',
      until: 'done',
      budget: { maxIterations: 5 },
      body: [command('implement')],
    }
    const wf = workflow([loopStep])
    const events = [
      envelope({ t: 'step.started', stepId: 'fix-until-green', semanticKey: 'sem', definitionKey: 'def' }),
      envelope({
        t: 'step.started',
        stepId: 'implement',
        iteration: 2,
        semanticKey: 'sem',
        definitionKey: 'def',
      }),
    ]

    const [loopStatus] = snapshotFromJournal(wf, events).loopStatuses
    expect(loopStatus).toMatchObject({ stepId: 'fix-until-green', state: 'running', iteration: 2, maxIterations: 5 })
  })
})

describe('watchRun', () => {
  function fakeDeps(journalsByCall: JournalEnvelope[][]) {
    let call = 0
    const readJournal = vi.fn(async () => {
      const events = journalsByCall[Math.min(call, journalsByCall.length - 1)] ?? []
      call += 1
      return events
    })
    const sleep = vi.fn(async () => {})
    return { readJournal, sleep }
  }

  it('calls onSnapshot only when the snapshot actually changed, and exits once run.finished appears', async () => {
    const wf = workflow([command('install')])
    const started = [envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem', definitionKey: 'def' })]
    const finished = [...started, envelope({ t: 'run.finished', status: 'ok' })]

    const deps = fakeDeps([started, started, finished])
    const onSnapshot = vi.fn()

    const result = await watchRun('run-dir', wf, onSnapshot, 0, deps)

    expect(result.runStatus).toBe('ok')
    // Ticks: started (new -> call 1), started again (unchanged -> no call),
    // finished (new -> call 2) — the repeated identical tick is deduped.
    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
  })

  it('exits when the run suspends, not just when it succeeds', async () => {
    const wf = workflow([{ id: 'approve', kind: 'gate', schema: 'S', render: { inline: 'ok?' } }])
    const opened = [envelope({ t: 'gate.opened', stepId: 'approve', requestPath: 'p' })]
    const suspended = [...opened, envelope({ t: 'run.finished', status: 'suspended' })]

    const deps = fakeDeps([opened, suspended])
    const result = await watchRun('run-dir', wf, vi.fn(), 0, deps)

    expect(result.runStatus).toBe('suspended')
  })

  it('exits when the run fails, not just when it succeeds or suspends', async () => {
    const wf = workflow([command('install')])
    const started = [envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem', definitionKey: 'def' })]
    const failed = [
      ...started,
      envelope({
        t: 'step.failed',
        stepId: 'install',
        failure: { reason: 'command-failed', detail: 'boom', recoverable: false },
      }),
      envelope({ t: 'run.finished', status: 'failed' }),
    ]

    const deps = fakeDeps([started, failed])
    const result = await watchRun('run-dir', wf, vi.fn(), 0, deps)

    expect(result.runStatus).toBe('failed')
  })

  it('keeps polling — never resolves — while the journal never reaches run.finished', async () => {
    const wf = workflow([command('install')])
    const running = [envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem', definitionKey: 'def' })]
    const readJournal = vi.fn(async () => running)
    const onSnapshot = vi.fn()

    // A real "never finishes" run would poll forever; a fake `sleep` that
    // throws after a bounded number of ticks stops the loop deterministically
    // instead of leaving an uncancellable promise running in the background.
    let ticks = 0
    const sleep = vi.fn(async () => {
      ticks += 1
      if (ticks >= 3) throw new Error('stop-after-3-ticks')
    })

    await expect(watchRun('run-dir', wf, onSnapshot, 0, { readJournal, sleep })).rejects.toThrow(
      'stop-after-3-ticks',
    )

    expect(readJournal).toHaveBeenCalledTimes(3)
    // Every tick reads the same unchanged snapshot, so onSnapshot fires once.
    expect(onSnapshot).toHaveBeenCalledTimes(1)
  })
})
