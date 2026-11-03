import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artifactsCommand } from '../../src/cli/commands/artifacts.js'
import { executeWorkflowFile } from '../../src/engine/run.js'

const MAP_SUCCESS_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'map-success.yaml')

describe('yak artifacts (CLI)', () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let cwd: string

  beforeEach(async () => {
    logs = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    cwd = await mkdtemp(path.join(tmpdir(), 'yak-artifacts-cli-'))
    await mkdir(path.join(cwd, '.yak'), { recursive: true })
    await writeFile(
      path.join(cwd, '.yak', 'transforms.ts'),
      'export function threeItems() { return [0, 1, 2] }\n',
      'utf8',
    )
  })

  afterEach(async () => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    const { rm } = await import('node:fs/promises')
    await rm(cwd, { recursive: true, force: true })
  })

  it('lists a completed map step\'s item indices', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(MAP_SUCCESS_WORKFLOW, { runsDir, cwd })

    const exitCode = await artifactsCommand(result.runId, { runsDir })

    expect(exitCode).toBe(0)
    expect(logs).toEqual([`run ${result.runId}:`, '  review (findings): items [0, 1, 2]'])
  })

  it('shows only the items that landed so far for a partial fan-out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(MAP_SUCCESS_WORKFLOW, { runsDir, cwd })

    // simulate an interrupted run: item 1's file never landed
    const { rm } = await import('node:fs/promises')
    await rm(path.join(result.runDir, 'artifacts', 'findings.1.json'))

    const exitCode = await artifactsCommand(result.runId, { runsDir })

    expect(exitCode).toBe(0)
    expect(logs).toEqual([`run ${result.runId}:`, '  review (findings): items [0, 2]'])
  })

  it('exits 1 when the given run-id does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const runsDir = path.join(dir, '.runs')

    const exitCode = await artifactsCommand('no-such-run', { runsDir })

    expect(exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('run no-such-run not found')
  })
})
