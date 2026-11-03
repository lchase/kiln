import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { readJournal } from '../../src/engine/journal.js'

async function writeWorkflow(dir: string, yaml: string): Promise<string> {
  const workflowPath = path.join(dir, 'workflow.yaml')
  await writeFile(workflowPath, yaml, 'utf8')
  return workflowPath
}

describe('single-step command run', () => {
  it('runs a one-step command workflow end to end', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const workflowPath = await writeWorkflow(
      dir,
      [
        'name: hello',
        'version: "1"',
        'steps:',
        '  - id: greet',
        '    command: { run: "echo hello" }',
        '    produces: greeting',
      ].join('\n'),
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs') })

    expect(result.status).toBe('ok')

    const artifact = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'greeting.json'), 'utf8'),
    )
    expect(artifact.stdout.trim()).toBe('hello')
    expect(artifact.exitCode).toBe(0)

    const frozen = JSON.parse(await readFile(path.join(result.runDir, 'workflow.json'), 'utf8'))
    expect(frozen.steps[0].kind).toBe('command')
    expect(frozen.steps[0].failOn).toBe('exitCode')

    const events = await readJournal(result.runDir)
    expect(events.map((e) => e.t)).toEqual([
      'run.started',
      'step.started',
      'artifact.written',
      'step.completed',
      'run.finished',
    ])
    expect(events.every((e) => e.runId === result.runId)).toBe(true)
  })

  it('fails the run when the command exits non-zero and failOn is exitCode', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const workflowPath = await writeWorkflow(
      dir,
      [
        'name: boom',
        'version: "1"',
        'steps:',
        '  - id: boom',
        '    command: { run: "exit 3" }',
        '    produces: boom-result',
      ].join('\n'),
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs') })

    expect(result.status).toBe('failed')

    const events = await readJournal(result.runDir)
    expect(events.map((e) => e.t)).toEqual([
      'run.started',
      'step.started',
      'step.failed',
      'run.finished',
    ])
  })

  it('honors failOn: never, capturing a non-zero exit code as data', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const workflowPath = await writeWorkflow(
      dir,
      [
        'name: soft-fail',
        'version: "1"',
        'steps:',
        '  - id: check',
        '    command: { run: "exit 2", failOn: never }',
        '    produces: check-result',
      ].join('\n'),
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs') })

    expect(result.status).toBe('ok')
    const artifact = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'check-result.json'), 'utf8'),
    )
    expect(artifact.exitCode).toBe(2)
  })

  it('stores --tag verbatim on run.started, and omits the field without one (yak#22)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const workflowPath = await writeWorkflow(
      dir,
      [
        'name: tagged',
        'version: "1"',
        'steps:',
        '  - id: greet',
        '    command: { run: "echo hi" }',
        '    produces: greeting',
      ].join('\n'),
    )

    const tagged = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      tag: 'gh-issue/22',
    })
    const startedTagged = (await readJournal(tagged.runDir)).find((e) => e.t === 'run.started')
    expect(startedTagged?.t === 'run.started' && startedTagged.tag).toBe('gh-issue/22')

    const untagged = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs2') })
    const startedUntagged = (await readJournal(untagged.runDir)).find((e) => e.t === 'run.started')
    if (startedUntagged?.t !== 'run.started') throw new Error('unreachable')
    expect('tag' in startedUntagged).toBe(false)
  })

  it('records this process pid on run.started (yak#24)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const workflowPath = await writeWorkflow(
      dir,
      [
        'name: pidded',
        'version: "1"',
        'steps:',
        '  - id: greet',
        '    command: { run: "echo hi" }',
        '    produces: greeting',
      ].join('\n'),
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs') })
    const started = (await readJournal(result.runDir)).find((e) => e.t === 'run.started')
    expect(started?.t === 'run.started' && started.pid).toBe(process.pid)
  })

  it('fires onStart after run.started and before any step runs (yak#23)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const workflowPath = await writeWorkflow(
      dir,
      [
        'name: hooked',
        'version: "1"',
        'steps:',
        '  - id: greet',
        '    command: { run: "echo hi" }',
        '    produces: greeting',
      ].join('\n'),
    )

    let seen: { runId: string; worktreeBranch?: string } | undefined
    let journalAtStart: string[] = []
    const result = await executeWorkflowFile(workflowPath, {
      runsDir: path.join(dir, '.runs'),
      onStart: async (info) => {
        seen = info
        journalAtStart = (await readJournal(info.runDir)).map((e) => e.t)
      },
    })

    expect(seen?.runId).toBe(result.runId)
    expect(seen?.worktreeBranch).toBeUndefined()
    expect(journalAtStart).toEqual(['run.started'])
  })
})
