import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentAdapterRequest, AgentAdapterResponse } from '../../src/adapters/types.js'
import { readJournal } from '../../src/engine/journal.js'
import type { AgentStep } from '../../src/ir/types.js'
import {
  agentInputNames,
  AgentStepFailedError,
  buildPrompt,
  callAgentOnce,
  resolveSchemaSpec,
  runAgentStep,
} from '../../src/steps/agent.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-agent-'))
  await mkdir(path.join(cwd, '.yak'), { recursive: true })
  await writeFile(
    path.join(cwd, '.yak', 'schemas.ts'),
    `import { z } from 'zod'\nexport const PlanSchema = z.object({ summary: z.string() })\nexport const notASchema = 42\n`,
    'utf8',
  )
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('resolveSchemaSpec (named ref)', () => {
  it('resolves a named ZodType export', async () => {
    const schema = await resolveSchemaSpec('PlanSchema', cwd)
    expect(schema.safeParse({ summary: 'x' })).toMatchObject({ success: true, data: { summary: 'x' } })
  })

  it('throws when the export is not a ZodType', async () => {
    await expect(resolveSchemaSpec('notASchema', cwd)).rejects.toThrow(/not found/)
  })

  it('throws when the key does not exist', async () => {
    await expect(resolveSchemaSpec('Nope', cwd)).rejects.toThrow(/not found/)
  })
})

describe('resolveSchemaSpec (inline)', () => {
  it('resolves and validates an inline JSON Schema', async () => {
    const schema = await resolveSchemaSpec(
      { inline: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
      cwd,
    )
    expect(schema.safeParse({ summary: 'x' })).toMatchObject({ success: true, data: { summary: 'x' } })
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('throws when the inline document is not a well-formed JSON Schema', async () => {
    await expect(resolveSchemaSpec({ inline: { type: 'not-a-real-type' } }, cwd)).rejects.toThrow()
  })
})

describe('toJsonSchema', () => {
  it('converts a resolved named-ref ZodType into JSON Schema', async () => {
    const schema = await resolveSchemaSpec('PlanSchema', cwd)
    expect(schema.toJsonSchema()).toMatchObject({
      type: 'object',
      required: ['summary'],
    })
  })

  it('returns an inline schema as-is', async () => {
    const inline = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
    const schema = await resolveSchemaSpec({ inline }, cwd)
    expect(schema.toJsonSchema()).toEqual(inline)
  })
})

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id' | 'prompt'>): AgentStep {
  return { kind: 'agent', ...overrides }
}

describe('agentInputNames', () => {
  it('returns needs when context is fresh', () => {
    const step = agent({ id: 'a', prompt: { inline: '' }, needs: ['issue'] })
    expect(agentInputNames(step)).toEqual(['issue'])
  })

  it('adds context.inherit artifacts to needs', () => {
    const step = agent({
      id: 'a',
      prompt: { inline: '' },
      needs: ['issue'],
      context: { inherit: ['plan'] },
    })
    expect(agentInputNames(step)).toEqual(['issue', 'plan'])
  })

  it('dedupes an artifact present in both needs and context.inherit', () => {
    const step = agent({
      id: 'a',
      prompt: { inline: '' },
      needs: ['plan'],
      context: { inherit: ['plan'] },
    })
    expect(agentInputNames(step)).toEqual(['plan'])
  })
})

describe('buildPrompt', () => {
  it('renders an inline prompt against inputs', async () => {
    const step = agent({ id: 'a', prompt: { inline: 'title: {{issue.title}}' } })
    const rendered = await buildPrompt(step, { issue: { title: 'Fix bug' } }, cwd)
    expect(rendered).toBe('title: Fix bug')
  })

  it('renders a file prompt resolved relative to cwd', async () => {
    await writeFile(path.join(cwd, 'prompt.md'), 'plan: {{plan}}', 'utf8')
    const step = agent({ id: 'a', prompt: { file: 'prompt.md' } })
    const rendered = await buildPrompt(step, { plan: 'do it' }, cwd)
    expect(rendered).toBe('plan: do it')
  })
})

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  lastRequest?: AgentAdapterRequest

  constructor(private readonly response: AgentAdapterResponse) {}

  async run(req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    this.lastRequest = req
    return this.response
  }
}

describe('callAgentOnce', () => {
  it('calls the adapter with the built prompt and resolved JSON schema, journaling budget.consumed', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'yak-agent-run-'))
    const adapter = new FakeAdapter({
      output: { summary: 'done' },
      sessionId: 'sess-1',
      tokens: { input: 10, output: 20 },
      filesChanged: [],
      stopReason: 'complete',
    })
    const step = agent({ id: 'plan', prompt: { inline: '{{issue.title}}' }, schema: 'PlanSchema' })

    const result = await callAgentOnce(
      step,
      { issue: { title: 'Fix bug' } },
      { runId: 'r1', runDir, cwd, adapter },
    )

    expect(result).toEqual({ output: { summary: 'done' }, sessionId: 'sess-1' })
    expect(adapter.lastRequest?.prompt).toBe('Fix bug')
    expect(adapter.lastRequest?.schema).toMatchObject({ type: 'object', required: ['summary'] })

    const events = await readJournal(runDir)
    expect(events).toContainEqual(
      expect.objectContaining({ t: 'budget.consumed', stepId: 'plan', tokens: 30 }),
    )

    await rm(runDir, { recursive: true, force: true })
  })

  it('passes sessionId through when resuming a prior session', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'yak-agent-run-'))
    const adapter = new FakeAdapter({
      output: 'ok',
      sessionId: 'sess-2',
      tokens: { input: 0, output: 0 },
      filesChanged: [],
      stopReason: 'complete',
    })
    const step = agent({ id: 'code', prompt: { inline: 'go' } })

    await callAgentOnce(step, {}, { runId: 'r1', runDir, cwd, adapter, sessionId: 'sess-1' })

    expect(adapter.lastRequest?.sessionId).toBe('sess-1')
    await rm(runDir, { recursive: true, force: true })
  })
})

class QueueAdapter implements AgentAdapter {
  readonly id = 'queue'
  requests: AgentAdapterRequest[] = []

  constructor(private readonly responses: AgentAdapterResponse[]) {}

  async run(req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    this.requests.push(req)
    const response = this.responses[this.requests.length - 1]
    if (!response) throw new Error('QueueAdapter: no more responses queued')
    return response
  }
}

function okResponse(output: unknown, sessionId: string): AgentAdapterResponse {
  return { output, sessionId, tokens: { input: 1, output: 1 }, filesChanged: [], stopReason: 'complete' }
}

describe('runAgentStep', () => {
  let runDir: string

  beforeEach(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), 'yak-agent-run-'))
  })

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true })
  })

  it('returns raw output unvalidated when the step has no schema', async () => {
    const adapter = new QueueAdapter([okResponse('unstructured', 's1')])
    const step = agent({ id: 'triage', prompt: { inline: 'go' } })

    const output = await runAgentStep(step, {}, { runId: 'r', runDir, cwd, adapter })

    expect(output).toBe('unstructured')
    expect(adapter.requests).toHaveLength(1)
  })

  it('returns parsed output on the first call when it already validates', async () => {
    const adapter = new QueueAdapter([okResponse({ summary: 'ok' }, 's1')])
    const step = agent({ id: 'plan', prompt: { inline: 'go' }, schema: 'PlanSchema' })

    const output = await runAgentStep(step, {}, { runId: 'r', runDir, cwd, adapter })

    expect(output).toEqual({ summary: 'ok' })
    expect(adapter.requests).toHaveLength(1)
  })

  it('retries in the same session on validation failure, then succeeds', async () => {
    const adapter = new QueueAdapter([
      okResponse({ wrong: 'shape' }, 's1'),
      okResponse({ summary: 'fixed' }, 's1'),
    ])
    const step = agent({ id: 'plan', prompt: { inline: 'go' }, schema: 'PlanSchema' })

    const output = await runAgentStep(step, {}, { runId: 'r', runDir, cwd, adapter })

    expect(output).toEqual({ summary: 'fixed' })
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.sessionId).toBe('s1')
    expect(adapter.requests[1]?.prompt).toContain('Validation errors')
    expect(adapter.requests[1]?.prompt).toContain('summary')

    const rejectedDir = path.join(runDir, 'artifacts', '.rejected')
    await expect(readFile(path.join(rejectedDir, 'plan.2.txt'), 'utf8')).rejects.toThrow()
  })

  it('exhausts repairAttempts, writes .rejected, and fails with reason schema-invalid', async () => {
    const adapter = new QueueAdapter([
      okResponse({ wrong: 1 }, 's1'),
      okResponse({ wrong: 2 }, 's1'),
      okResponse({ wrong: 3 }, 's1'),
    ])
    const step = agent({ id: 'plan', prompt: { inline: 'go' }, schema: 'PlanSchema' })

    await expect(runAgentStep(step, {}, { runId: 'r', runDir, cwd, adapter })).rejects.toThrow(
      AgentStepFailedError,
    )

    expect(adapter.requests).toHaveLength(3)

    const rejectedContent = await readFile(path.join(runDir, 'artifacts', '.rejected', 'plan.3.txt'), 'utf8')
    expect(JSON.parse(rejectedContent)).toEqual({ wrong: 3 })

    const events = await readJournal(runDir)
    expect(events.filter((e) => e.t === 'budget.consumed')).toHaveLength(3)
  })

  it('honors a custom repairAttempts', async () => {
    const adapter = new QueueAdapter([
      okResponse({ wrong: 1 }, 's1'),
      okResponse({ wrong: 2 }, 's1'),
    ])
    const step = agent({ id: 'plan', prompt: { inline: 'go' }, schema: 'PlanSchema', repairAttempts: 1 })

    await expect(runAgentStep(step, {}, { runId: 'r', runDir, cwd, adapter })).rejects.toThrow(
      AgentStepFailedError,
    )
    expect(adapter.requests).toHaveLength(2)
  })
})
