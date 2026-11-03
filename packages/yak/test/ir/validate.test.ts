import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateWorkflow, WorkflowValidationError } from '../../src/ir/validate.js'
import type { AgentStep, CommandStep, GateStep, LoopStep, MapStep, Step, Workflow } from '../../src/ir/types.js'

function workflow(steps: Step[]): Workflow {
  return { name: 'w', version: '1', steps }
}

function command(overrides: Partial<CommandStep> & Pick<CommandStep, 'id'>): CommandStep {
  return { kind: 'command', run: 'echo hi', ...overrides }
}

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id'>): AgentStep {
  return { kind: 'agent', prompt: { inline: 'hi' }, ...overrides }
}

function map(overrides: Partial<MapStep> & Pick<MapStep, 'id' | 'over' | 'step'>): MapStep {
  return { kind: 'map', isolation: 'none', ...overrides }
}

function gate(overrides: Partial<GateStep> & Pick<GateStep, 'id' | 'schema'>): GateStep {
  return { kind: 'gate', render: { inline: 'approve?' }, ...overrides }
}

describe('validateWorkflow', () => {
  it('accepts a valid acyclic graph', async () => {
    const wf = workflow([
      command({ id: 'a', produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    await expect(validateWorkflow(wf)).resolves.toBeUndefined()
  })

  it('rejects unknown step kinds', async () => {
    const wf = workflow([{ id: 'a', kind: 'bogus' } as unknown as Step])
    await expect(validateWorkflow(wf)).rejects.toThrow(WorkflowValidationError)
  })

  it('rejects duplicate step ids', async () => {
    const wf = workflow([command({ id: 'a' }), command({ id: 'a' })])
    await expect(validateWorkflow(wf)).rejects.toThrow(/duplicate step id/)
  })

  it('rejects needs referencing an artifact no step produces', async () => {
    const wf = workflow([command({ id: 'a', needs: ['missing'] })])
    await expect(validateWorkflow(wf)).rejects.toThrow(/needs artifact "missing"/)
  })

  it('accepts needs: [input] with no producer — the engine supplies it (yak#27)', async () => {
    const wf = workflow([command({ id: 'a', needs: ['input'], produces: 'a-out' })])
    await expect(validateWorkflow(wf)).resolves.toBeUndefined()
  })

  it('accepts needs: [input] inside a loop body', async () => {
    const wf = workflow([
      {
        kind: 'loop',
        id: 'l',
        until: 'true',
        budget: { maxIterations: 1 },
        body: [command({ id: 'a', needs: ['input'], produces: 'a-out' })],
      } as Step,
    ])
    await expect(validateWorkflow(wf)).resolves.toBeUndefined()
  })

  it('rejects a step that tries to produce the reserved "input" artifact', async () => {
    const wf = workflow([command({ id: 'a', produces: 'input' })])
    await expect(validateWorkflow(wf)).rejects.toThrow(/reserved artifact name/)
  })

  it('rejects cycles', async () => {
    const wf = workflow([
      command({ id: 'a', needs: ['b-out'], produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    await expect(validateWorkflow(wf)).rejects.toThrow(/cycle detected/)
  })

  it('rejects reading <step>.exitCode downstream of a step with failOn: exitCode', async () => {
    const loop: LoopStep = {
      id: 'retry',
      kind: 'loop',
      needs: ['testResult'],
      body: [],
      until: 'testResult.exitCode == 0',
      budget: { maxIterations: 3 },
    }
    const wf = workflow([command({ id: 'test', produces: 'testResult' }), loop])
    await expect(validateWorkflow(wf)).rejects.toThrow(/failOn: 'exitCode'/)
  })

  it('allows reading <step>.exitCode when the producing step has failOn: never', async () => {
    const loop: LoopStep = {
      id: 'retry',
      kind: 'loop',
      needs: ['testResult'],
      body: [],
      until: 'testResult.exitCode == 0',
      budget: { maxIterations: 3 },
    }
    const wf = workflow([
      command({ id: 'test', produces: 'testResult', failOn: 'never' }),
      loop,
    ])
    await expect(validateWorkflow(wf)).resolves.toBeUndefined()
  })

  describe('yak#36: expression refs to non-identifier artifact names', () => {
    it('rejects skipIf referencing a hyphenated artifact name (jexl reads it as subtraction)', async () => {
      const wf = workflow([
        command({ id: 'verify', produces: 'verify-result' }),
        command({
          id: 'checkpoint',
          needs: ['verify-result'],
          skipIf: 'verify-result.exitCode == 0',
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(
        /skipIf references artifact "verify-result".*Rename it to an identifier \(e\.g\. "verifyResult"\)/s,
      )
    })

    it("rejects a loop's until referencing a hyphenated body artifact", async () => {
      const loop: LoopStep = {
        id: 'retry',
        kind: 'loop',
        body: [command({ id: 'run-tests', produces: 'test-result', failOn: 'never' })],
        until: 'test-result.exitCode == 0',
        budget: { maxIterations: 3 },
      }
      await expect(validateWorkflow(workflow([loop]))).rejects.toThrow(
        /until references artifact "test-result"/,
      )
    })

    it("rejects a loop's noProgress.signal referencing a hyphenated body artifact", async () => {
      const loop: LoopStep = {
        id: 'retry',
        kind: 'loop',
        body: [command({ id: 'run-tests', produces: 'test-result', failOn: 'never' })],
        until: 'testResult.exitCode == 0',
        budget: { maxIterations: 3, noProgress: { signal: 'test-result.exitCode', rounds: 2 } },
      }
      await expect(validateWorkflow(workflow([loop]))).rejects.toThrow(
        /noProgress\.signal references artifact "test-result"/,
      )
    })

    it('accepts an identifier-safe artifact name referenced in an expression', async () => {
      const wf = workflow([
        command({ id: 'verify', produces: 'verifyResult', failOn: 'never' }),
        command({
          id: 'checkpoint',
          needs: ['verifyResult'],
          skipIf: 'verifyResult.exitCode == 0',
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('does not flag a hyphenated artifact name that no expression references', async () => {
      const wf = workflow([
        command({ id: 'a', produces: 'a-out' }),
        command({ id: 'b', needs: ['a-out'], produces: 'b-out', skipIf: 'true' }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })
  })

  describe('ticket 07: isolation: "none" write-race guardrail', () => {
    it('rejects concurrency > 1 with a write-capable tool (Edit) on the item step', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Read', 'Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(/isolation: 'none'.*concurrency.*write/is)
    })

    it('rejects concurrency > 1 with Bash on the item step — Bash counts as write-capable', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 2,
          step: agent({ id: 'review-one', tools: ['Bash'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(/isolation: 'none'/)
    })

    it('allows concurrency > 1 with only read-only tools on the item step', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Read', 'Grep'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('allows concurrency: 1 with write-capable tools — no concurrent writers to race', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 1,
          step: agent({ id: 'review-one', tools: ['Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('allows isolation: "worktree" with concurrency > 1 and write tools when the run itself is worktree-isolated', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          isolation: 'worktree',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf, undefined, 'worktree')).resolves.toBeUndefined()
    })

    it('rejects isolation: "worktree" on a map step when the run itself is not --isolation worktree', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          isolation: 'worktree',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(/isolation: 'worktree'.*requires the run itself/is)
    })
  })

  describe('agent step tool names', () => {
    it('accepts known tool names', async () => {
      const wf = workflow([agent({ id: 'code', tools: ['Read', 'Edit', 'Bash'] })])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects an unknown tool name', async () => {
      const wf = workflow([agent({ id: 'code', tools: ['Read', 'Frobnicate'] })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/unknown or unsupported tool "Frobnicate"/)
    })

    it('rejects AskUserQuestion — no canUseTool channel to resolve it', async () => {
      const wf = workflow([agent({ id: 'code', tools: ['AskUserQuestion'] })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/unknown or unsupported tool "AskUserQuestion"/)
    })
  })

  describe('agent step schema keys', () => {
    let cwd: string

    beforeEach(async () => {
      cwd = await mkdtemp(path.join(tmpdir(), 'yak-validate-'))
      await mkdir(path.join(cwd, '.yak'), { recursive: true })
      await writeFile(
        path.join(cwd, '.yak', 'schemas.ts'),
        `import { z } from 'zod'\nexport const PlanSchema = z.object({ summary: z.string() })\n`,
        'utf8',
      )
    })

    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true })
    })

    it('accepts a schema key that resolves to a ZodType', async () => {
      const wf = workflow([agent({ id: 'plan', schema: 'PlanSchema' })])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('rejects a schema key missing from .yak/schemas.ts', async () => {
      const wf = workflow([agent({ id: 'plan', schema: 'Nope' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/schema "Nope" not found/)
    })

    it('roadmap ticket 09: accepts a well-formed inline JSON Schema', async () => {
      const wf = workflow([
        agent({
          id: 'plan',
          schema: { inline: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('roadmap ticket 09: rejects a malformed inline JSON Schema at load time', async () => {
      const wf = workflow([agent({ id: 'plan', schema: { inline: { type: 'not-a-real-type' } } })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/could not resolve schema inline schema/)
    })
  })

  describe('M4: gate step schema keys, skipIf defaults, flat-schema, render placeholders', () => {
    let cwd: string

    async function withSchema(source: string): Promise<void> {
      await writeFile(path.join(cwd, '.yak', 'schemas.ts'), source, 'utf8')
    }

    beforeEach(async () => {
      cwd = await mkdtemp(path.join(tmpdir(), 'yak-validate-gate-'))
      await mkdir(path.join(cwd, '.yak'), { recursive: true })
      await withSchema(
        `import { z } from 'zod'\n` +
          `export const ApprovalSchema = z.object({ decision: z.enum(['approve','reject']) })\n` +
          `export const AutoApprovalSchema = z.object({ decision: z.enum(['approve','reject']).default('approve') })\n` +
          `export const NestedSchema = z.object({ inner: z.object({ x: z.string() }) })\n`,
      )
    })

    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true })
    })

    it('accepts a schema key that resolves to a ZodType', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'ApprovalSchema' })])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('rejects a schema key missing from .yak/schemas.ts', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'Nope' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/schema "Nope" not found/)
    })

    it('ticket 05: rejects skipIf when the schema does not default every field', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'ApprovalSchema', skipIf: 'true' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/doesn't default every field/)
    })

    it('ticket 05: accepts skipIf when every field defaults', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'AutoApprovalSchema', skipIf: 'true' })])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('ticket 04: rejects a nested (non-flat) answer schema at load time', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'NestedSchema' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/not a flat scalar\/enum type/)
    })

    it('accepts a render placeholder declared in needs', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'plan' }),
        gate({ id: 'approve', schema: 'ApprovalSchema', needs: ['plan'], render: { inline: '{{plan}}' } }),
      ])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('rejects a render placeholder not in needs', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'ApprovalSchema', render: { inline: '{{plan}}' } })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/"plan" is not in needs/)
    })

    it('roadmap ticket 09: accepts an inline JSON Schema with skipIf when every field defaults', async () => {
      const wf = workflow([
        gate({
          id: 'approve',
          schema: {
            inline: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['approve', 'reject'], default: 'approve' } },
            },
          },
          skipIf: 'true',
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('roadmap ticket 09: rejects skipIf on an inline schema that does not default every field', async () => {
      const wf = workflow([
        gate({
          id: 'approve',
          schema: {
            inline: { type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'reject'] } }, required: ['decision'] },
          },
          skipIf: 'true',
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/doesn't default every field/)
    })

    it('roadmap ticket 09: rejects a nested inline answer schema at load time', async () => {
      const wf = workflow([
        gate({
          id: 'approve',
          schema: { inline: { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'string' } } } } } },
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/not a flat scalar\/enum type/)
    })
  })

  describe('agent prompt placeholder roots', () => {
    it('accepts a placeholder root declared in needs', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'issue' }),
        agent({ id: 'plan', needs: ['issue'], prompt: { inline: 'title: {{issue.title}}' } }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('accepts a placeholder root declared via context.inherit', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'plan' }),
        agent({
          id: 'code',
          context: { inherit: ['plan'] },
          prompt: { inline: 'plan: {{plan}}' },
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects a placeholder root not in needs or context.inherit', async () => {
      const wf = workflow([agent({ id: 'plan', prompt: { inline: '{{issue.title}}' } })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/"issue" is not in needs or context.inherit/)
    })

    it('accepts null and undefined in a prompt when the artifact root is declared', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'verify' }),
        agent({ id: 'plan', needs: ['verify'], prompt: { inline: '{{ verify.exitCode == null }}' } }),
        command({ id: 'src2', produces: 'x' }),
        agent({ id: 'plan2', needs: ['x'], prompt: { inline: '{{ x || undefined }}' } }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('still rejects a typo root in a prompt that also mentions null', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'verify' }),
        agent({ id: 'plan', needs: ['verify'], prompt: { inline: '{{ verfy.exitCode == null }}' } }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(
        /prompt references "\{\{verfy\}\}" but "verfy" is not in needs or context.inherit/,
      )
    })
  })

  describe('context.session chain depth', () => {
    it('does not warn for a chain of depth 3 or fewer', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wf = workflow([
        agent({ id: 'a' }),
        agent({ id: 'b', context: { session: 'a' } }),
        agent({ id: 'c', context: { session: 'b' } }),
      ])
      await validateWorkflow(wf)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('warns when a chain exceeds depth 3', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wf = workflow([
        agent({ id: 'a' }),
        agent({ id: 'b', context: { session: 'a' } }),
        agent({ id: 'c', context: { session: 'b' } }),
        agent({ id: 'd', context: { session: 'c' } }),
        agent({ id: 'e', context: { session: 'd' } }),
      ])
      await validateWorkflow(wf)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exceeds depth 3/))
      warn.mockRestore()
    })
  })

  describe('sandbox: docker', () => {
    it('rejects a command step with sandbox: docker but no image', async () => {
      const wf = workflow([command({ id: 'a', sandbox: 'docker' })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/requires an "image" field/)
    })

    it('accepts a command step with sandbox: docker and an image, when docker is on PATH', async () => {
      const wf = workflow([command({ id: 'a', sandbox: 'docker', image: 'node:22' })])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects sandbox: docker workflows when the docker binary is not on PATH', async () => {
      const wf = workflow([command({ id: 'a', sandbox: 'docker', image: 'node:22' })])
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        await expect(validateWorkflow(wf)).rejects.toThrow(/"docker" binary was not found on PATH/)
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('does not check for docker when no step uses sandbox: docker', async () => {
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        const wf = workflow([command({ id: 'a' })])
        await expect(validateWorkflow(wf)).resolves.toBeUndefined()
      } finally {
        process.env.PATH = originalPath
      }
    })

    // Ticket 07/08: unlike `command`, an `agent` step's `image` is optional
    // (yak ships a default) — only the docker-on-PATH check applies.
    it('accepts an agent step with sandbox: docker and no image, when docker is on PATH', async () => {
      const wf = workflow([agent({ id: 'a', sandbox: 'docker' })])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects sandbox: docker on an agent step when the docker binary is not on PATH', async () => {
      const wf = workflow([agent({ id: 'a', sandbox: 'docker' })])
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        await expect(validateWorkflow(wf)).rejects.toThrow(/"docker" binary was not found on PATH/)
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('accepts a hostname allowlist without requiring docker when the step is not sandboxed', async () => {
      const wf = workflow([
        agent({
          id: 'a',
          allowedDomains: ['api.anthropic.com', 'registry.npmjs.org', 'objects.githubusercontent.com'],
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects a non-hostname allowlist entry before the docker check', async () => {
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        const wf = workflow([
          agent({ id: 'a', sandbox: 'docker', allowedDomains: ['https://api.anthropic.com', 'github.com'] }),
        ])
        await expect(validateWorkflow(wf)).rejects.toThrow(
          /allowedDomains entry "https:\/\/api\.anthropic\.com" is not a hostname/,
        )
      } finally {
        process.env.PATH = originalPath
      }
    })

    it.each([
      'api.anthropic.com/v1',
      'api.anthropic.com:443',
      '*.anthropic.com',
      '.anthropic.com',
      'localhost',
      'not a host',
      '',
    ])('rejects allowlist entry %j', async (domain) => {
      const wf = workflow([agent({ id: 'a', allowedDomains: [domain] })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/is not a hostname/)
    })

    it('rejects an empty allowlist', async () => {
      const wf = workflow([agent({ id: 'a', allowedDomains: [] })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/allowedDomains must list at least one hostname/)
    })
  })
})
