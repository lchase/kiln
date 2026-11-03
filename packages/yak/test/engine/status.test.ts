import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { stepStatusesFromJournal } from '../../src/engine/status.js'
import type { CommandStep, JournalEnvelope, JournalEvent, Step } from '../../src/ir/types.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

function step(id: string): CommandStep {
  return { id, kind: 'command', run: 'echo x' }
}

function envelope(event: JournalEvent): JournalEnvelope {
  return { ...event, at: '2026-08-08T00:00:00.000Z', runId: 'run-1' }
}

describe('stepStatusesFromJournal', () => {
  it('reports pending for a step with no journal activity', () => {
    const statuses = stepStatusesFromJournal([step('install')], [])
    expect(statuses).toEqual([{ stepId: 'install', status: 'pending' }])
  })

  it('reports pending for a step interrupted mid-flight (started, no completed/failed)', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'test', semanticKey: 'sem', definitionKey: 'def' }),
    ]
    const statuses = stepStatusesFromJournal([step('test')], events)
    expect(statuses).toEqual([{ stepId: 'test', status: 'pending' }])
  })

  it('reports completed for a fresh, non-cached run', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'install', semanticKey: 'sem', definitionKey: 'def' }),
      envelope({ t: 'step.completed', stepId: 'install', cached: false }),
    ]
    const statuses = stepStatusesFromJournal([step('install')], events)
    expect(statuses).toEqual([{ stepId: 'install', status: 'completed' }])
  })

  it('reports cached for a cache hit and stale for a loose cache hit', () => {
    const events = [
      envelope({ t: 'step.completed', stepId: 'install', cached: true }),
      envelope({ t: 'step.completed', stepId: 'lint', cached: true, stale: true }),
    ]
    const statuses = stepStatusesFromJournal([step('install'), step('lint')], events)
    expect(statuses).toEqual([
      { stepId: 'install', status: 'cached' },
      { stepId: 'lint', status: 'stale' },
    ])
  })

  it('reports failed for a step whose last event was step.failed', () => {
    const events = [
      envelope({ t: 'step.started', stepId: 'lint', semanticKey: 'sem', definitionKey: 'def' }),
      envelope({
        t: 'step.failed',
        stepId: 'lint',
        failure: { reason: 'command-failed', detail: 'boom', recoverable: false },
      }),
    ]
    const statuses = stepStatusesFromJournal([step('lint')], events)
    expect(statuses).toEqual([{ stepId: 'lint', status: 'failed' }])
  })
})

describe('yak status — matches journal state after a partial/suspended run', () => {
  it('reports completed for finished steps and pending for the rest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')

    // ci.yaml's `install` and `lint` succeed immediately (failOn: never), but
    // `test` runs a command that fails, so `summarize` (needs test-result)
    // never becomes eligible: install/lint completed, test failed, summarize pending.
    const workflow = [
      'name: ci',
      'version: "1"',
      'steps:',
      '  - id: install',
      '    command: { run: "echo installing" }',
      '    produces: install-result',
      '',
      '  - id: lint',
      '    needs: [install-result]',
      '    command: { run: "echo linted" }',
      '    produces: lint-result',
      '',
      '  - id: test',
      '    needs: [install-result]',
      '    command: { run: "exit 1" }',
      '    produces: test-result',
      '',
      '  - id: summarize',
      '    needs: [lint-result, test-result]',
      '    transform: { fn: summarizeChecks }',
      '    produces: summary',
    ].join('\n')
    const workflowPath = path.join(dir, 'ci.yaml')
    await writeFile(workflowPath, workflow, 'utf8')

    const result = await executeWorkflowFile(workflowPath, { runsDir })
    expect(result.status).toBe('failed')

    const events = await readJournal(result.runDir)
    const workflowSteps: Step[] = [step('install'), step('lint'), step('test'), step('summarize')]
    const statuses = stepStatusesFromJournal(workflowSteps, events)

    expect(statuses).toEqual([
      { stepId: 'install', status: 'completed' },
      { stepId: 'lint', status: 'completed' },
      { stepId: 'test', status: 'failed' },
      { stepId: 'summarize', status: 'pending' },
    ])
  })

  it('reports cached and stale statuses from a loose-cache reuse', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')
    const workflowV1 = [
      'name: loose-demo',
      'version: "1"',
      'steps:',
      '  - id: greet',
      '    cache: loose',
      '    command: { run: "echo hello" }',
      '    produces: greeting',
    ].join('\n')
    const workflowV2 = [
      'name: loose-demo',
      'version: "1"',
      'steps:',
      '  - id: greet',
      '    cache: loose',
      '    command: { run: "echo hello # cosmetic comment" }',
      '    produces: greeting',
    ].join('\n')
    const pathV1 = path.join(dir, 'v1.yaml')
    const pathV2 = path.join(dir, 'v2.yaml')
    await writeFile(pathV1, workflowV1, 'utf8')
    await writeFile(pathV2, workflowV2, 'utf8')

    await executeWorkflowFile(pathV1, { runsDir })
    const second = await executeWorkflowFile(pathV2, { runsDir })

    const events = await readJournal(second.runDir)
    const statuses = stepStatusesFromJournal([step('greet')], events)
    expect(statuses).toEqual([{ stepId: 'greet', status: 'stale' }])
  })
})
