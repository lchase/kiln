import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { readJournal } from '../../src/engine/journal.js'

const WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'agent-fixture-workflow.yaml')

async function readArtifact(runDir: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(runDir, 'artifacts', `${name}.json`), 'utf8'))
}

describe('M1 acceptance workflow: agent -> agent -> command -> transform (mock adapter)', () => {
  it('runs deterministically: repeated runs produce identical artifacts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))

    const first = await executeWorkflowFile(WORKFLOW, { runsDir: path.join(dir, 'run1', '.runs'), adapter: 'mock' })
    const second = await executeWorkflowFile(WORKFLOW, { runsDir: path.join(dir, 'run2', '.runs'), adapter: 'mock' })

    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    expect(await readArtifact(first.runDir, 'summary')).toEqual(await readArtifact(second.runDir, 'summary'))
    expect(await readArtifact(first.runDir, 'plan')).toEqual(await readArtifact(second.runDir, 'plan'))
  })

  it('exercises fresh context on triage and context.inherit on plan, interpolating triage into the prompt', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))

    const result = await executeWorkflowFile(WORKFLOW, { runsDir: path.join(dir, '.runs'), adapter: 'mock' })

    expect(result.status).toBe('ok')
    const triage = (await readArtifact(result.runDir, 'triage')) as { summary: string; confidence: number }
    expect(triage.summary).toBe('Login form throws on empty password')

    const plan = (await readArtifact(result.runDir, 'plan')) as { summary: string; steps: string[] }
    expect(plan.steps).toEqual([
      'Guard the password field against an empty string',
      'Add a regression test',
    ])

    const summary = await readArtifact(result.runDir, 'summary')
    expect(summary).toEqual({ planSummary: plan.summary, stepCount: 2, checked: true })
  })

  it('repairs plan once (invalid then valid) with no .rejected file and one budget.consumed per call', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))

    const result = await executeWorkflowFile(WORKFLOW, { runsDir: path.join(dir, '.runs'), adapter: 'mock' })

    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const planBudgetEvents = events.filter(
      (e) => e.t === 'budget.consumed' && (e as { stepId: string }).stepId === 'plan',
    )
    expect(planBudgetEvents).toHaveLength(2)

    await expect(
      readFile(path.join(result.runDir, 'artifacts', '.rejected', 'plan.2.txt'), 'utf8'),
    ).rejects.toThrow()
  })
})
