import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { graphCommand } from '../../src/cli/commands/graph.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

describe('yak graph (CLI)', () => {
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

  it('prints the Mermaid output of a workflow to stdout', async () => {
    const exitCode = await graphCommand(CI_WORKFLOW)

    expect(exitCode).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^flowchart TD\n/)
    expect(logs[0]).toContain('install[install]')
    expect(logs[0]).toContain('install -->|install-result| lint')
  })
})
