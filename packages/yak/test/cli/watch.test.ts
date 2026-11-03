import { Console } from 'node:console'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { watchCommand } from '../../src/cli/commands/watch.js'
import { executeWorkflowFile } from '../../src/engine/run.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

describe('yak watch (CLI)', () => {
  // vitest 5 swaps in a console without `Console`, which ink's patchConsole constructs.
  beforeAll(() => {
    console.Console ??= Console
  })

  it('exits 0 for an already-finished run — the first read already has run.finished', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-watch-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(CI_WORKFLOW, { runsDir })

    const exitCode = await watchCommand(result.runId, { runsDir })

    expect(exitCode).toBe(0)
  })

  it("mounts the very first frame from the run's actual current state, not an empty journal", async () => {
    vi.resetModules()
    const renderCalls: unknown[] = []
    vi.doMock('ink', async () => {
      const actual = await vi.importActual<typeof import('ink')>('ink')
      return {
        ...actual,
        render: vi.fn((node: Parameters<typeof actual.render>[0]) => {
          renderCalls.push(node)
          return actual.render(node)
        }),
      }
    })
    const { watchCommand } = await import('../../src/cli/commands/watch.js')

    const dir = await mkdtemp(path.join(tmpdir(), 'yak-watch-'))
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(CI_WORKFLOW, { runsDir })

    await watchCommand(result.runId, { runsDir })

    expect(renderCalls).toHaveLength(1)
    const props = (renderCalls[0] as { props: { snapshot: { stepStatuses: { status: string }[] } } }).props
    expect(props.snapshot.stepStatuses.every((s) => s.status === 'completed')).toBe(true)

    vi.doUnmock('ink')
    vi.resetModules()
  })

  it('exits 1 when no runs exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-watch-'))
    const runsDir = path.join(dir, '.runs')

    const exitCode = await watchCommand(undefined, { runsDir })

    expect(exitCode).toBe(1)
  })

  it('exits 1 when the given run-id does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-watch-'))
    const runsDir = path.join(dir, '.runs')
    await executeWorkflowFile(CI_WORKFLOW, { runsDir })

    const exitCode = await watchCommand('no-such-run', { runsDir })

    expect(exitCode).toBe(1)
  })
})
