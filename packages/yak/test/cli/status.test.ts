import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statusCommand } from '../../src/cli/commands/status.js'
import { appendJournalEvent } from '../../src/engine/journal.js'
import { executeWorkflowFile } from '../../src/engine/run.js'
import type { Workflow } from '../../src/ir/types.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

const MINIMAL_WORKFLOW: Workflow = {
  name: 'minimal',
  version: '1',
  steps: [{ id: 'greet', kind: 'command', run: 'echo hi', produces: 'greeting' }],
}

/** Writes a bare completed run under a caller-chosen run id, so tests can
 * control lexicographic run-id ordering instead of racing real timestamps. */
async function writeCompletedRun(runsDir: string, runId: string): Promise<void> {
  const runDir = path.join(runsDir, runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'workflow.json'), JSON.stringify(MINIMAL_WORKFLOW, null, 2), 'utf8')
  await appendJournalEvent(runDir, runId, {
    t: 'run.started',
    runId,
    workflow: 'minimal',
    inputHash: 'irrelevant',
    adapter: 'mock',
    isolation: 'none',
  })
  await appendJournalEvent(runDir, runId, {
    t: 'step.started',
    stepId: 'greet',
    semanticKey: 'sem',
    definitionKey: 'def',
  })
  await appendJournalEvent(runDir, runId, { t: 'step.completed', stepId: 'greet', cached: false })
  await appendJournalEvent(runDir, runId, { t: 'run.finished', status: 'ok' })
}

describe('yak status (CLI)', () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logs = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('reports the most recent run when no run-id is given', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')

    await writeCompletedRun(runsDir, '2026-01-01T00-00-00Z-aaaa')
    await writeCompletedRun(runsDir, '2026-01-02T00-00-00Z-bbbb')

    const exitCode = await statusCommand(undefined, { runsDir })

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['run 2026-01-02T00-00-00Z-bbbb:', '  greet: completed'])
  })

  it('reports a specific run-id when given', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(CI_WORKFLOW, { runsDir })

    const exitCode = await statusCommand(result.runId, { runsDir })

    expect(exitCode).toBe(0)
    expect(logs[0]).toBe(`run ${result.runId}:`)
    expect(logs.slice(1)).toEqual([
      '  install: completed',
      '  lint: completed',
      '  test: completed',
      '  summarize: completed',
    ])
  })

  it('echoes the run --tag on the header line (yak#22)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(CI_WORKFLOW, { runsDir, tag: 'issue-42' })

    const exitCode = await statusCommand(result.runId, { runsDir })

    expect(exitCode).toBe(0)
    expect(logs[0]).toBe(`run ${result.runId} (tag: issue-42):`)
  })

  it('exits 1 when no runs exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')

    const exitCode = await statusCommand(undefined, { runsDir })

    expect(exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('no runs found')
  })

  it('exits 1 when the given run-id does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')
    await executeWorkflowFile(CI_WORKFLOW, { runsDir })

    const exitCode = await statusCommand('no-such-run', { runsDir })

    expect(exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('run no-such-run not found')
  })
})
