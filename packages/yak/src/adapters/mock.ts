import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, AgentAdapterRequest, AgentAdapterResponse } from './types.js'

interface MockResponseEntry {
  output: unknown
  stopReason?: AgentAdapterResponse['stopReason']
  tokens?: { input: number; output: number }
  filesChanged?: string[]
}

/**
 * One instance per step id — the call counter that drives fixture-sequence
 * lookup (§3.5 schema repair retries) is scoped to a single step's calls,
 * so it just increments per run() rather than needing a session-keyed map.
 */
export class MockAdapter implements AgentAdapter {
  readonly id = 'mock'

  private callIndex = 0
  private readonly responses: MockResponseEntry[]

  /** Ticket 08: `iteration` (1-based) picks the starting fixture entry for a
   * step inside a loop body — e.g. iteration 3's `run()` starts at
   * `responses[2]`, so a fixture can script "iteration 1 fails, iteration 3
   * passes." Schema-repair retries within that same call still advance the
   * index normally from there. Omitted for non-loop steps, unchanged from
   * always starting at 0. */
  constructor(
    fixturesDir: string,
    workflowName: string,
    private readonly stepId: string,
    iteration?: number,
  ) {
    const fixturePath = path.join(fixturesDir, workflowName, `${stepId}.json`)
    const raw = readFileSync(fixturePath, 'utf8')
    this.responses = JSON.parse(raw) as MockResponseEntry[]
    this.callIndex = iteration !== undefined ? iteration - 1 : 0
  }

  async run(_req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    const lastIndex = this.responses.length - 1
    const entry = this.responses[Math.min(this.callIndex, lastIndex)]
    if (!entry) {
      throw new Error(`mock fixture for step "${this.stepId}" has no response entries`)
    }
    const callIndex = this.callIndex
    this.callIndex += 1

    return {
      output: entry.output,
      sessionId: `mock:${this.stepId}:${callIndex}`,
      tokens: entry.tokens ?? { input: 0, output: 0 },
      filesChanged: entry.filesChanged ?? [],
      stopReason: entry.stopReason ?? 'complete',
    }
  }
}
