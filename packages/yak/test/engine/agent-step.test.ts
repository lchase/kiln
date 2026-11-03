import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { readJournal } from '../../src/engine/journal.js'

async function setUpWorkflowDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yak-agent-e2e-'))
  await mkdir(path.join(dir, '.yak'), { recursive: true })
  await writeFile(
    path.join(dir, '.yak', 'schemas.ts'),
    `import { z } from 'zod'\nexport const PlanSchema = z.object({ summary: z.string() })\n`,
    'utf8',
  )
  return dir
}

async function writeFixture(dir: string, workflow: string, stepId: string, entries: unknown[]): Promise<void> {
  const fixtureDir = path.join(dir, 'test', 'fixtures', workflow)
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(path.join(fixtureDir, `${stepId}.json`), JSON.stringify(entries), 'utf8')
}

describe('agent step end to end (mock adapter)', () => {
  it('runs a single agent step and writes its validated output as the artifact', async () => {
    const dir = await setUpWorkflowDir()
    await writeFixture(dir, 'agent-e2e', 'plan', [{ output: { summary: 'do the thing' } }])
    const workflowPath = path.join(dir, 'workflow.yaml')
    await writeFile(
      workflowPath,
      [
        'name: agent-e2e',
        'version: "1"',
        'steps:',
        '  - id: plan',
        '    agent:',
        '      prompt: { inline: "plan it" }',
        '      schema: PlanSchema',
        '    produces: plan',
      ].join('\n'),
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd: dir,
      adapter: 'mock',
    })

    expect(result.status).toBe('ok')
    const artifact = JSON.parse(await readFile(path.join(result.runDir, 'artifacts', 'plan.json'), 'utf8'))
    expect(artifact).toEqual({ summary: 'do the thing' })

    const events = await readJournal(result.runDir)
    expect(events.map((e) => e.t)).toEqual([
      'run.started',
      'step.started',
      'budget.consumed',
      'artifact.written',
      'step.completed',
      'run.finished',
    ])
  })

  it('threads needs and context.inherit artifacts into the prompt via a second agent step', async () => {
    const dir = await setUpWorkflowDir()
    await writeFixture(dir, 'agent-chain', 'triage', [{ output: 'needs work' }])
    await writeFixture(dir, 'agent-chain', 'plan', [{ output: { summary: 'needs work: fix it' } }])
    await writeFile(path.join(dir, 'plan-prompt.md'), 'triage said: {{triage}}', 'utf8')
    const workflowPath = path.join(dir, 'workflow.yaml')
    await writeFile(
      workflowPath,
      [
        'name: agent-chain',
        'version: "1"',
        'steps:',
        '  - id: triage',
        '    agent:',
        '      prompt: { inline: "triage it" }',
        '    produces: triage',
        '  - id: plan',
        '    agent:',
        '      prompt: { file: "plan-prompt.md" }',
        '      schema: PlanSchema',
        '      context: { inherit: [triage] }',
        '    produces: plan',
      ].join('\n'),
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd: dir,
      adapter: 'mock',
    })

    expect(result.status).toBe('ok')
    const artifact = JSON.parse(await readFile(path.join(result.runDir, 'artifacts', 'plan.json'), 'utf8'))
    expect(artifact).toEqual({ summary: 'needs work: fix it' })
  })

  it('fails the run and writes .rejected on schema-repair exhaustion', async () => {
    const dir = await setUpWorkflowDir()
    await writeFixture(dir, 'agent-fail', 'plan', [
      { output: { wrong: 1 } },
      { output: { wrong: 2 } },
      { output: { wrong: 3 } },
    ])
    const workflowPath = path.join(dir, 'workflow.yaml')
    await writeFile(
      workflowPath,
      [
        'name: agent-fail',
        'version: "1"',
        'steps:',
        '  - id: plan',
        '    agent:',
        '      prompt: { inline: "plan it" }',
        '      schema: PlanSchema',
        '    produces: plan',
      ].join('\n'),
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd: dir,
      adapter: 'mock',
    })

    expect(result.status).toBe('failed')

    const events = await readJournal(result.runDir)
    const failedEvent = events.find((e) => e.t === 'step.failed')
    expect(failedEvent).toMatchObject({ failure: { reason: 'schema-invalid', recoverable: false } })

    const rejected = await readFile(path.join(result.runDir, 'artifacts', '.rejected', 'plan.3.txt'), 'utf8')
    expect(JSON.parse(rejected)).toEqual({ wrong: 3 })
  })

  it('roadmap ticket 09: validates against an inline JSON Schema (no .yak/schemas.ts entry needed)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-agent-inline-'))
    await writeFixture(dir, 'agent-inline', 'plan', [{ output: { summary: 'do the thing' } }])
    const workflowPath = path.join(dir, 'workflow.yaml')
    await writeFile(
      workflowPath,
      [
        'name: agent-inline',
        'version: "1"',
        'steps:',
        '  - id: plan',
        '    agent:',
        '      prompt: { inline: "plan it" }',
        '      schema:',
        '        inline:',
        '          type: object',
        '          properties:',
        '            summary: { type: string }',
        '          required: [summary]',
        '    produces: plan',
      ].join('\n'),
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd: dir,
      adapter: 'mock',
    })

    expect(result.status).toBe('ok')
    const artifact = JSON.parse(await readFile(path.join(result.runDir, 'artifacts', 'plan.json'), 'utf8'))
    expect(artifact).toEqual({ summary: 'do the thing' })
  })

  it('roadmap ticket 09: repairs against an inline JSON Schema using ajv error formatting', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-agent-inline-repair-'))
    await writeFixture(dir, 'agent-inline-repair', 'plan', [
      { output: { wrong: 1 } },
      { output: { summary: 'fixed on retry' } },
    ])
    const workflowPath = path.join(dir, 'workflow.yaml')
    await writeFile(
      workflowPath,
      [
        'name: agent-inline-repair',
        'version: "1"',
        'steps:',
        '  - id: plan',
        '    agent:',
        '      prompt: { inline: "plan it" }',
        '      schema:',
        '        inline:',
        '          type: object',
        '          properties:',
        '            summary: { type: string }',
        '          required: [summary]',
        '    produces: plan',
      ].join('\n'),
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd: dir,
      adapter: 'mock',
    })

    expect(result.status).toBe('ok')
    const artifact = JSON.parse(await readFile(path.join(result.runDir, 'artifacts', 'plan.json'), 'utf8'))
    expect(artifact).toEqual({ summary: 'fixed on retry' })
  })
})
