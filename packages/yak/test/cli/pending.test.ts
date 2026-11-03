import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pendingCommand } from '../../src/cli/commands/pending.js'
import { executeWorkflowFile } from '../../src/engine/run.js'

const GATE_SUSPEND = path.join(process.cwd(), 'test', 'workflows', 'gate-suspend.yaml')
const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

describe('yak pending (CLI)', () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logs = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line)
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('lists a suspended run and its open gate (ticket 03)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-pending-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(GATE_SUSPEND, { runsDir })
    expect(result.status).toBe('suspended')

    const exitCode = await pendingCommand({ runsDir })

    expect(exitCode).toBe(0)
    expect(logs[0]).toBe(`run ${result.runId} suspended:`)
    expect(logs[1]).toContain('approve (gate): Approve this change?')
  })

  it('echoes the run --tag on the suspended-run line (yak#22)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-pending-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(GATE_SUSPEND, { runsDir, tag: 'issue-42' })
    expect(result.status).toBe('suspended')

    const exitCode = await pendingCommand({ runsDir })

    expect(exitCode).toBe(0)
    expect(logs[0]).toBe(`run ${result.runId} suspended (tag: issue-42):`)
  })

  it('does not list a finished run (ticket 03: journal, not file presence)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-pending-'))
    const runsDir = path.join(dir, '.runs')
    await executeWorkflowFile(CI_WORKFLOW, { runsDir })

    const exitCode = await pendingCommand({ runsDir })

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['nothing pending'])
  })
})
