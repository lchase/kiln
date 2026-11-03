import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { readJournal } from '../../src/engine/journal.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

describe('multi-step DAG execution', () => {
  it('runs install -> lint || test -> summarize end to end', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))

    const result = await executeWorkflowFile(CI_WORKFLOW, { runsDir: path.join(dir, '.runs') })

    expect(result.status).toBe('ok')

    const summary = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'summary.json'), 'utf8'),
    )
    expect(summary).toEqual({ lintPassed: true, testPassed: true, ok: true })

    const lintResult = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'lint-result.json'), 'utf8'),
    )
    expect(lintResult.exitCode).toBe(0)

    const events = await readJournal(result.runDir)
    const completedIds = events
      .filter((e) => e.t === 'step.completed')
      .map((e) => (e as { stepId: string }).stepId)
    // lint/test finish in a nondeterministic order relative to each other
    // since they run concurrently; install must lead and summarize must trail.
    expect(completedIds[0]).toBe('install')
    expect(completedIds[3]).toBe('summarize')
    expect(new Set(completedIds.slice(1, 3))).toEqual(new Set(['lint', 'test']))
  })

  it('proves lint and test are scheduled concurrently, not sequentially', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))

    const result = await executeWorkflowFile(CI_WORKFLOW, { runsDir: path.join(dir, '.runs') })
    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const indexOf = (t: string, stepId: string) =>
      events.findIndex((e) => e.t === t && (e as { stepId?: string }).stepId === stepId)

    const lintStarted = indexOf('step.started', 'lint')
    const testStarted = indexOf('step.started', 'test')
    const lintCompleted = indexOf('step.completed', 'lint')
    const testCompleted = indexOf('step.completed', 'test')

    // both steps are dispatched (step.started) before either one finishes —
    // proof that the scheduler treated them as a single concurrent batch
    // rather than running one fully before starting the other.
    expect(lintStarted).toBeLessThan(Math.min(lintCompleted, testCompleted))
    expect(testStarted).toBeLessThan(Math.min(lintCompleted, testCompleted))
  })
})
