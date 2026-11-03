import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile, resumeRun } from '../../src/engine/run.js'
import { readPendingRequest } from '../../src/engine/suspend.js'

const GATE_SUSPEND = path.join(process.cwd(), 'test', 'workflows', 'gate-suspend.yaml')
const GATE_SKIP = path.join(process.cwd(), 'test', 'workflows', 'gate-skip.yaml')
const GATE_SKIP_INLINE = path.join(process.cwd(), 'test', 'workflows', 'gate-skip-inline.yaml')
const GATE_MULTI = path.join(process.cwd(), 'test', 'workflows', 'gate-multi.yaml')

async function readArtifact(runDir: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(runDir, 'artifacts', `${name}.json`), 'utf8'))
}

describe('gate step: suspend + resume', () => {
  it('suspends, opens a pending request, and answers on resume (ticket 06/08)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-gate-'))
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(GATE_SUSPEND, { runsDir })
    expect(result.status).toBe('suspended')

    const request = await readPendingRequest(result.runDir, 'approve')
    expect(request).toMatchObject({ kind: 'gate', stepId: 'approve', rendered: 'Approve this change?' })

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'approve', notes: 'looks good' }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir })
    expect(resumed.status).toBe('ok')

    const decision = await readArtifact(result.runDir, 'decision')
    expect(decision).toEqual({ decision: 'approve', notes: 'looks good' })

    const events = await readJournal(result.runDir)
    expect(events.some((e) => e.t === 'gate.answered' && e.stepId === 'approve' && !e.skipped)).toBe(true)
  })

  it('leaves the run suspended, untouched, on an invalid answer (ticket 06)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-gate-'))
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(GATE_SUSPEND, { runsDir })
    expect(result.status).toBe('suspended')

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'not-a-valid-choice' }),
      'utf8',
    )

    await expect(resumeRun(result.runId, { runsDir })).rejects.toThrow(/approve.*invalid answer/is)

    const events = await readJournal(result.runDir)
    expect(events.some((e) => e.t === 'gate.answered')).toBe(false)
  })

  it('errors listing what is still missing when no answer file exists (ticket 06)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-gate-'))
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(GATE_SUSPEND, { runsDir })
    expect(result.status).toBe('suspended')

    await expect(resumeRun(result.runId, { runsDir })).rejects.toThrow(/approve.*no answer file/is)
  })
})

describe('gate step: skipIf (ticket 05)', () => {
  it('auto-answers from schema defaults, journals gate.answered{skipped:true}, never suspends', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-gate-'))
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(GATE_SKIP, { runsDir })
    expect(result.status).toBe('ok')

    const decision = await readArtifact(result.runDir, 'decision')
    expect(decision).toEqual({ decision: 'approve' })

    const events = await readJournal(result.runDir)
    const opened = events.find((e) => e.t === 'gate.opened')
    const answered = events.find((e) => e.t === 'gate.answered')
    expect(opened).toMatchObject({ stepId: 'approve' })
    expect(answered).toMatchObject({ stepId: 'approve', skipped: true })
  })

  it('roadmap ticket 09: auto-answers from an inline JSON Schema default (ajv useDefaults)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-gate-inline-'))
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(GATE_SKIP_INLINE, { runsDir })
    expect(result.status).toBe('ok')

    const decision = await readArtifact(result.runDir, 'decision')
    expect(decision).toEqual({ decision: 'approve' })
  })
})

describe('gate step: multiple gates open in one round (ticket 01)', () => {
  it('opens every eligible gate before suspending, not just the first', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-gate-'))
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(GATE_MULTI, { runsDir })
    expect(result.status).toBe('suspended')

    const requestA = await readPendingRequest(result.runDir, 'approve-a')
    const requestB = await readPendingRequest(result.runDir, 'approve-b')
    expect(requestA).toBeDefined()
    expect(requestB).toBeDefined()
  })
})
