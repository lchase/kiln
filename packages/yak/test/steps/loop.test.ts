import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentAdapterRequest, AgentAdapterResponse } from '../../src/adapters/types.js'
import { readJournal } from '../../src/engine/journal.js'
import type { AgentStep, JournalEnvelope, LoopStep } from '../../src/ir/types.js'
import { runLoopStep, type LoopRunContext } from '../../src/steps/loop.js'

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id' | 'prompt'>): AgentStep {
  return { kind: 'agent', ...overrides }
}

class QueueAdapter implements AgentAdapter {
  readonly id = 'queue'
  requests: AgentAdapterRequest[] = []
  private callIndex = 0

  async run(req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    this.requests.push(req)
    const callIndex = this.callIndex
    this.callIndex += 1
    return {
      output: 'ok',
      sessionId: `sess-${callIndex}`,
      tokens: { input: 1, output: 1 },
      filesChanged: [],
      stopReason: 'complete',
    }
  }
}

let runDir: string
let cacheDir: string

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'yak-loop-run-'))
  cacheDir = await mkdtemp(path.join(tmpdir(), 'yak-loop-cache-'))
})

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

function baseCtx(adapter: AgentAdapter): LoopRunContext {
  return {
    runId: 'r1',
    runDir,
    cwd: process.cwd(),
    cacheDir,
    semanticKey: 'sk',
    definitionKey: 'dk',
    globalConcurrency: 4,
    outerArtifactHashes: new Map(),
    buildAdapter: () => adapter,
  }
}

describe('ticket 07: loop-body agent session persistence (freshContext)', () => {
  it('passes the same sessionId to the adapter on every iteration when freshContext is false', async () => {
    const adapter = new QueueAdapter()
    const step: LoopStep = {
      id: 'converse',
      kind: 'loop',
      body: [agent({ id: 'ask', prompt: { inline: 'go' }, produces: 'answer' })],
      until: 'false',
      budget: { maxIterations: 3 },
      onExhausted: 'continue',
      freshContext: false,
    }

    const status = await runLoopStep(step, baseCtx(adapter))

    expect(status).toBe('ok')
    expect(adapter.requests).toHaveLength(3)
    // iteration 1 has no prior session yet
    expect(adapter.requests[0]?.sessionId).toBeUndefined()
    // iterations 2 and 3 resume the session the previous iteration's call returned
    expect(adapter.requests[1]?.sessionId).toBe('sess-0')
    expect(adapter.requests[2]?.sessionId).toBe('sess-1')
  })

  it('never passes a sessionId across iterations when freshContext is true (default)', async () => {
    const adapter = new QueueAdapter()
    const step: LoopStep = {
      id: 'converse',
      kind: 'loop',
      body: [agent({ id: 'ask', prompt: { inline: 'go' }, produces: 'answer' })],
      until: 'false',
      budget: { maxIterations: 3 },
      onExhausted: 'continue',
      freshContext: true,
    }

    const status = await runLoopStep(step, baseCtx(adapter))

    expect(status).toBe('ok')
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests.every((r) => r.sessionId === undefined)).toBe(true)
  })
})

describe('yak#35: loop `produces` on the onExhausted: "continue" path', () => {
  it('writes the loop artifact from the last iteration context when exhaustion is treated as success', async () => {
    const { readFile } = await import('node:fs/promises')
    const adapter = new QueueAdapter()
    const step: LoopStep = {
      id: 'converse',
      kind: 'loop',
      produces: 'summary',
      body: [agent({ id: 'ask', prompt: { inline: 'go' }, produces: 'answer' })],
      until: 'false',
      budget: { maxIterations: 2 },
      onExhausted: 'continue',
    }

    const ctx = baseCtx(adapter)
    const status = await runLoopStep(step, ctx)

    expect(status).toBe('ok')
    const raw = await readFile(path.join(runDir, 'artifacts', 'summary.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ answer: 'ok' })
    // hash was seeded into the shared map for downstream cache keys
    expect(ctx.outerArtifactHashes.get('summary')).toBeTruthy()
  })
})

describe('effective concurrency cap of 1', () => {
  it('keeps [a, b needs a, c] in declared order when step.concurrency is higher', async () => {
    const adapter = new QueueAdapter()
    const step: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 4,
      until: 'true',
      budget: { maxIterations: 1 },
      body: [
        { id: 'a', kind: 'command', run: 'echo a', produces: 'a' },
        { id: 'b', kind: 'command', run: 'echo b', needs: ['a'], produces: 'b' },
        { id: 'c', kind: 'command', run: 'echo c', produces: 'c' },
      ],
    }

    const status = await runLoopStep(step, { ...baseCtx(adapter), globalConcurrency: 1 })
    expect(status).toBe('ok')

    const events = await readJournal(runDir)
    const index = (t: JournalEnvelope['t'], stepId: string) =>
      events.findIndex((event) => event.t === t && 'stepId' in event && event.stepId === stepId)
    const order = ['a', 'b', 'c'].flatMap((id) => [index('step.started', id), index('step.completed', id)])
    expect(order.every((n) => n >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(new Set(order).size).toBe(order.length)
  })
})
