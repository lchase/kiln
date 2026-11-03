import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'
import { readJournal } from '../../src/engine/journal.js'

let dir: string
let cwd: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yak-finally-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-finally-cwd-'))
  await mkdir(path.join(cwd, '.yak'), { recursive: true })
  await writeFile(
    path.join(cwd, '.yak', 'transforms.ts'),
    [
      'export function recordCleanup(inputs) {',
      "  return { sawBoomResult: inputs['boom-result'] !== undefined }",
      '}',
      'export function recordReport(inputs) {',
      "  return { okResultExitCode: inputs['ok-result'].exitCode }",
      '}',
    ].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

async function writeWorkflow(yaml: string): Promise<string> {
  const workflowPath = path.join(cwd, 'workflow.yaml')
  await writeFile(workflowPath, yaml, 'utf8')
  return workflowPath
}

describe('finally: true step scheduling', () => {
  it('runs a finally step after its dependency fails, and the run still reports failed', async () => {
    const workflowPath = await writeWorkflow(
      [
        'name: cleanup-after-failure',
        'version: "1"',
        'steps:',
        '  - id: boom',
        '    command: { run: "exit 3" }',
        '    produces: boom-result',
        '  - id: cleanup',
        '    needs: [boom-result]',
        '    finally: true',
        '    transform: { fn: recordCleanup }',
        '    produces: cleanup-result',
      ].join('\n'),
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs'), cwd })

    // the run as a whole is still failed — a finally step completing
    // cleanly never masks the upstream failure.
    expect(result.status).toBe('failed')

    const cleanupResult = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'cleanup-result.json'), 'utf8'),
    )
    // boom never wrote its artifact, so cleanup's `needs` entry resolves to
    // undefined rather than the read throwing.
    expect(cleanupResult).toEqual({ sawBoomResult: false })

    const events = await readJournal(result.runDir)
    const cleanupCompleted = events.find(
      (e) => e.t === 'step.completed' && (e as { stepId: string }).stepId === 'cleanup',
    )
    expect(cleanupCompleted).toBeDefined()
    const boomFailed = events.find((e) => e.t === 'step.failed' && (e as { stepId: string }).stepId === 'boom')
    expect(boomFailed).toBeDefined()
  })

  it('runs a finally step normally when nothing upstream failed', async () => {
    const workflowPath = await writeWorkflow(
      [
        'name: report-after-success',
        'version: "1"',
        'steps:',
        '  - id: ok',
        '    command: { run: "exit 0" }',
        '    produces: ok-result',
        '  - id: report',
        '    needs: [ok-result]',
        '    finally: true',
        '    transform: { fn: recordReport }',
        '    produces: report-result',
      ].join('\n'),
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir: path.join(dir, '.runs'), cwd })

    expect(result.status).toBe('ok')

    const reportResult = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'report-result.json'), 'utf8'),
    )
    expect(reportResult).toEqual({ okResultExitCode: 0 })
  })
})
