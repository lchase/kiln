import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile, InputValidationError, resumeRun } from '../../src/engine/run.js'

let dir: string
let cwd: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yak-input-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-input-cwd-'))
  await mkdir(path.join(cwd, '.yak'), { recursive: true })
  await writeFile(
    path.join(cwd, '.yak', 'transforms.ts'),
    [
      'export function echoInput(inputs) {',
      "  return { got: inputs['input'] }",
      '}',
    ].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

async function writeWorkflow(lines: string[]): Promise<string> {
  const workflowPath = path.join(cwd, 'workflow.yaml')
  await writeFile(workflowPath, lines.join('\n'), 'utf8')
  return workflowPath
}

const READS_INPUT = [
  'name: reads-input',
  'version: "1"',
  'inputSchema:',
  '  inline:',
  '    type: object',
  '    properties:',
  '      issueRef: { type: string }',
  '    required: [issueRef]',
  'steps:',
  '  - id: echo',
  '    needs: [input]',
  '    transform: { fn: echoInput }',
  '    produces: echoed',
]

describe('yak run --input (yak#27)', () => {
  it('writes the validated input as the reserved `input` artifact and a step reads it', async () => {
    const workflowPath = await writeWorkflow(READS_INPUT)

    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd,
      adapter: 'mock',
      input: { issueRef: 'lchase/yak-kanban-sandbox#1' },
    })

    expect(result.status).toBe('ok')

    const inputArtifact = JSON.parse(await readFile(path.join(result.runDir, 'artifacts', 'input.json'), 'utf8'))
    expect(inputArtifact).toEqual({ issueRef: 'lchase/yak-kanban-sandbox#1' })

    const echoed = JSON.parse(await readFile(path.join(result.runDir, 'artifacts', 'echoed.json'), 'utf8'))
    expect(echoed).toEqual({ got: { issueRef: 'lchase/yak-kanban-sandbox#1' } })
  })

  it('journals `artifact.written` for input and puts its hash on run.started', async () => {
    const workflowPath = await writeWorkflow(READS_INPUT)
    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd,
      adapter: 'mock',
      input: { issueRef: 'x/y#1' },
    })

    const events = await readJournal(result.runDir)
    const started = events.find((e) => e.t === 'run.started')
    const written = events.find((e) => e.t === 'artifact.written' && e.name === 'input')
    expect(started?.t).toBe('run.started')
    expect(written?.t).toBe('artifact.written')
    if (started?.t !== 'run.started' || written?.t !== 'artifact.written') throw new Error('unreachable')
    expect(started.inputHash).toBe(written.hash)
  })

  it('rejects an input that violates the schema — before any run directory exists', async () => {
    const workflowPath = await writeWorkflow(READS_INPUT)
    const runsDir = path.join(dir, '.runs')

    await expect(
      executeWorkflowFile(workflowPath, { runsDir, cwd, adapter: 'mock', input: { attempt: '2' } }),
    ).rejects.toBeInstanceOf(InputValidationError)

    await expect(readdir(runsDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('needs no --input and writes no input artifact when the workflow declares none', async () => {
    const workflowPath = await writeWorkflow([
      'name: no-input',
      'version: "1"',
      'steps:',
      '  - id: greet',
      '    command: { run: "echo hi" }',
      '    produces: greeting',
    ])
    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      cwd,
      adapter: 'mock',
    })
    expect(result.status).toBe('ok')
    await expect(readFile(path.join(result.runDir, 'artifacts', 'input.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const events = await readJournal(result.runDir)
    expect(events.some((e) => e.t === 'artifact.written' && e.name === 'input')).toBe(false)
  })

  it('the input value participates in the cache key', async () => {
    const workflowPath = await writeWorkflow(READS_INPUT)
    const runsDir = path.join(dir, '.runs')
    const cacheDir = path.join(dir, '.cache')
    const echoCached = async (input: Record<string, unknown>) => {
      const r = await executeWorkflowFile(workflowPath, { runsDir, cacheDir, cwd, adapter: 'mock', input })
      const events = await readJournal(r.runDir)
      return (events.find((e) => e.t === 'step.completed' && e.stepId === 'echo') as { cached: boolean }).cached
    }

    expect(await echoCached({ issueRef: 'x/y#1' })).toBe(false)
    // same input → cache hit
    expect(await echoCached({ issueRef: 'x/y#1' })).toBe(true)
    // different input → cache miss, echo re-runs
    expect(await echoCached({ issueRef: 'x/y#2' })).toBe(false)
  })

  it('resume re-seeds the input hash so a completed input-reading step is not re-run', async () => {
    const workflowPath = await writeWorkflow(READS_INPUT)
    const runsDir = path.join(dir, '.runs')

    const first = await executeWorkflowFile(workflowPath, { runsDir, cwd, adapter: 'mock', input: { issueRef: 'x/y#7' } })
    expect(first.status).toBe('ok')

    const resumed = await resumeRun(first.runId, { runsDir, cwd, adapter: 'mock' })
    expect(resumed.status).toBe('ok')

    // `echo` started exactly once (the original run). A hash-seed mismatch
    // on resume would fail the cache-key match and start it a second time.
    const echoStarts = (await readJournal(resumed.runDir)).filter(
      (e) => e.t === 'step.started' && e.stepId === 'echo',
    )
    expect(echoStarts).toHaveLength(1)
  })
})
