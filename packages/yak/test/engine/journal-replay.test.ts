import { describe, expect, it } from 'vitest'
import { completedStepsFromJournal } from '../../src/engine/journal.js'
import type { JournalEnvelope, JournalEvent } from '../../src/ir/types.js'

function envelope(event: JournalEvent): JournalEnvelope {
  return { ...event, at: '2026-08-08T00:00:00.000Z', runId: 'run-1' }
}

describe('completedStepsFromJournal', () => {
  it('marks a step completed when step.started is followed by step.completed', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem-1', definitionKey: 'def-1' }),
      envelope({
        t: 'step.completed',
        stepId: 'install',
        artifact: 'install-result',
        artifactHash: 'hash-1',
        cached: false,
      }),
    ]

    const completed = completedStepsFromJournal(events)

    expect(completed.get('install')).toEqual({
      stepId: 'install',
      semanticKey: 'sem-1',
      definitionKey: 'def-1',
      artifact: 'install-result',
      artifactHash: 'hash-1',
    })
  })

  it('does not mark a step completed when it was interrupted mid-flight', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'test', semanticKey: 'sem-2', definitionKey: 'def-2' }),
      // process died here — no step.completed, no step.failed
    ]

    const completed = completedStepsFromJournal(events)

    expect(completed.has('test')).toBe(false)
  })

  it('does not mark a step completed when it failed', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'lint', semanticKey: 'sem-3', definitionKey: 'def-3' }),
      envelope({
        t: 'step.failed',
        stepId: 'lint',
        failure: { reason: 'command-failed', detail: 'boom', recoverable: false },
      }),
    ]

    const completed = completedStepsFromJournal(events)

    expect(completed.has('lint')).toBe(false)
  })

  it('a later step.started resets an earlier completion', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'test', semanticKey: 'sem-old', definitionKey: 'def-old' }),
      envelope({ t: 'step.completed', stepId: 'test', cached: false }),
      envelope({ t: 'step.started', stepId: 'test', semanticKey: 'sem-new', definitionKey: 'def-new' }),
      // interrupted again before completing this time
    ]

    const completed = completedStepsFromJournal(events)

    expect(completed.has('test')).toBe(false)
  })
})
