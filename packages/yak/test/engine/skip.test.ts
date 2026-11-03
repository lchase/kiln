import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile, resumeRun } from '../../src/engine/run.js'

const COMMAND_SKIP = path.join(process.cwd(), 'test', 'workflows', 'command-skip.yaml')

async function artifactExists(runDir: string, name: string): Promise<boolean> {
  return readFile(path.join(runDir, 'artifacts', `${name}.json`), 'utf8').then(
    () => true,
    () => false,
  )
}

describe('generalized skipIf (cookbook ticket 05): non-gate steps skip outright', () => {
  it('skips the command step, writes no artifact, journals step.completed{skipped:true} — on rejection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-skip-'))
    const runsDir = path.join(dir, '.runs')

    const started = await executeWorkflowFile(COMMAND_SKIP, { runsDir })
    expect(started.status).toBe('suspended')

    await mkdir(path.join(started.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(started.runDir, 'pending', 'decide.answer.json'),
      JSON.stringify({ decision: 'reject' }),
      'utf8',
    )

    const resumed = await resumeRun(started.runId, { runsDir })
    expect(resumed.status).toBe('ok')

    expect(await artifactExists(started.runDir, 'release-result')).toBe(false)

    const events = await readJournal(started.runDir)
    expect(
      events.some((e) => e.t === 'step.completed' && e.stepId === 'release' && e.skipped === true),
    ).toBe(true)
  })

  it('runs the command step for real on approval', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-skip-'))
    const runsDir = path.join(dir, '.runs')

    const started = await executeWorkflowFile(COMMAND_SKIP, { runsDir })
    expect(started.status).toBe('suspended')

    await mkdir(path.join(started.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(started.runDir, 'pending', 'decide.answer.json'),
      JSON.stringify({ decision: 'approve' }),
      'utf8',
    )

    const resumed = await resumeRun(started.runId, { runsDir })
    expect(resumed.status).toBe('ok')

    expect(await artifactExists(started.runDir, 'release-result')).toBe(true)

    const events = await readJournal(started.runDir)
    expect(
      events.some((e) => e.t === 'step.completed' && e.stepId === 'release' && !e.skipped),
    ).toBe(true)
  })
})
