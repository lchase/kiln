import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { readJournal } from '../../src/engine/journal.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

function completedEvents(events: Awaited<ReturnType<typeof readJournal>>) {
  return events
    .filter((e) => e.t === 'step.completed')
    .map((e) => e as { stepId: string; cached: boolean; stale?: boolean })
}

describe('content-addressed cache — acceptance behavior #1', () => {
  it('running the same workflow twice reports every step cached on the second run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')

    const first = await executeWorkflowFile(CI_WORKFLOW, { runsDir })
    expect(first.status).toBe('ok')
    const firstCompleted = completedEvents(await readJournal(first.runDir))
    expect(firstCompleted.every((e) => e.cached === false)).toBe(true)

    const start = Date.now()
    const second = await executeWorkflowFile(CI_WORKFLOW, { runsDir })
    const elapsedMs = Date.now() - start

    expect(second.status).toBe('ok')
    const secondCompleted = completedEvents(await readJournal(second.runDir))
    expect(secondCompleted).toHaveLength(4)
    expect(secondCompleted.every((e) => e.cached === true)).toBe(true)
    expect(elapsedMs).toBeLessThan(1000)
  })
})

describe('content-addressed cache — acceptance behavior #2', () => {
  it('re-running after a source change keeps install cached and re-runs lint/test/summarize', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')

    const first = await executeWorkflowFile(CI_WORKFLOW, { runsDir })
    expect(first.status).toBe('ok')

    // Simulate a source-file edit that changes what `lint` and `test` do,
    // without touching `install` — same shape as spec §14 acceptance #2.
    const changedWorkflow = [
      'name: ci',
      'version: "1"',
      'steps:',
      '  - id: install',
      '    command: { run: "echo installing" }',
      '    produces: install-result',
      '',
      '  - id: lint',
      '    needs: [install-result]',
      '    command: { run: "sleep 0.2 && echo linted-again", capture: [stdout, exitCode], failOn: never }',
      '    produces: lint-result',
      '',
      '  - id: test',
      '    needs: [install-result]',
      '    command: { run: "sleep 0.2 && echo tested-again", capture: [stdout, exitCode], failOn: never }',
      '    produces: test-result',
      '',
      '  - id: summarize',
      '    needs: [lint-result, test-result]',
      '    transform: { fn: summarizeChecks }',
      '    produces: summary',
    ].join('\n')
    const workflowPath = path.join(dir, 'ci-changed.yaml')
    await writeFile(workflowPath, changedWorkflow, 'utf8')

    const second = await executeWorkflowFile(workflowPath, { runsDir })
    expect(second.status).toBe('ok')

    const byStep = new Map(completedEvents(await readJournal(second.runDir)).map((e) => [e.stepId, e]))
    expect(byStep.get('install')?.cached).toBe(true)
    expect(byStep.get('lint')?.cached).toBe(false)
    expect(byStep.get('test')?.cached).toBe(false)
    expect(byStep.get('summarize')?.cached).toBe(false)
  })

  it('cache: loose reuses the artifact and marks the step stale when only the definition moved', async () => {
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

    const first = await executeWorkflowFile(pathV1, { runsDir })
    expect(first.status).toBe('ok')

    const second = await executeWorkflowFile(pathV2, { runsDir })
    expect(second.status).toBe('ok')

    const completed = completedEvents(await readJournal(second.runDir))
    expect(completed[0]?.cached).toBe(true)
    expect(completed[0]?.stale).toBe(true)
  })
})
