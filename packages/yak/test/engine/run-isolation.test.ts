import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile, resumeRun } from '../../src/engine/run.js'

const execFileAsync = promisify(execFile)

async function initRepoWithCommit(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'yak-isolation-'))
  await execFileAsync('git', ['init'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoRoot })
  return repoRoot
}

function writeMarkerWorkflow(dir: string): Promise<string> {
  const workflowPath = path.join(dir, 'workflow.yaml')
  return writeFile(
    workflowPath,
    [
      'name: write-marker',
      'version: "1"',
      'steps:',
      '  - id: write',
      '    command: { run: "echo marker > marker.txt" }',
      '    produces: write-result',
    ].join('\n'),
    'utf8',
  ).then(() => workflowPath)
}

async function writeGateThenWriteWorkflow(dir: string): Promise<string> {
  // A worktree checkout only contains committed content, same as any git
  // worktree — schemas.ts must be committed for gate-step schema resolution
  // (which runs against ctx.cwd, the worktree) to find it there.
  await mkdir(path.join(dir, '.yak'), { recursive: true })
  await writeFile(
    path.join(dir, '.yak', 'schemas.ts'),
    "import { z } from 'zod'\nexport const ApprovalSchema = z.object({ decision: z.enum(['approve', 'reject']) })\n",
    'utf8',
  )
  await execFileAsync('git', ['add', '.yak/schemas.ts'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'add schemas'], { cwd: dir })

  const workflowPath = path.join(dir, 'workflow.yaml')
  await writeFile(
    workflowPath,
    [
      'name: gate-then-write',
      'version: "1"',
      'steps:',
      '  - id: approve',
      '    gate: { schema: ApprovalSchema, render: { inline: "Approve?" } }',
      '    produces: decision',
      '  - id: write',
      '    needs: [decision]',
      '    command: { run: "echo marker > marker.txt" }',
      '    produces: write-result',
    ].join('\n'),
    'utf8',
  )
  return workflowPath
}

describe('yak run --isolation worktree, resumed after a suspend', () => {
  it('a step running after resume still lands in the same worktree created on first execution', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeGateThenWriteWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const suspended = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })
    expect(suspended.status).toBe('suspended')

    await mkdir(path.join(suspended.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(suspended.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'approve' }),
      'utf8',
    )

    const resumed = await resumeRun(suspended.runId, { runsDir, cwd: repoRoot })
    expect(resumed.status).toBe('ok')

    const worktreePath = path.join(repoRoot, '.yak', 'worktrees', suspended.runId)
    const marker = await readFile(path.join(worktreePath, 'marker.txt'), 'utf8')
    expect(marker.trim()).toBe('marker')
  })

  it('rejects resuming a worktree-isolated run with a conflicting --isolation override', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeGateThenWriteWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const suspended = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })
    expect(suspended.status).toBe('suspended')

    await mkdir(path.join(suspended.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(suspended.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'approve' }),
      'utf8',
    )

    await expect(
      resumeRun(suspended.runId, { runsDir, cwd: repoRoot, isolation: 'none' }),
    ).rejects.toThrow(/isolation "worktree".*cannot resume with isolation "none"/is)
  })
})

describe('yak run --isolation worktree', () => {
  it('executes steps inside a fresh worktree, leaving the real cwd untouched', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMarkerWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })

    expect(result.status).toBe('ok')

    const worktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId)
    const markerInWorktree = await readFile(path.join(worktreePath, 'marker.txt'), 'utf8')
    expect(markerInWorktree.trim()).toBe('marker')

    await expect(readFile(path.join(repoRoot, 'marker.txt'), 'utf8')).rejects.toThrow()

    const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    })
    expect(branch.trim()).toBe(`yak/${result.runId}`)
  })

  it('reports the worktree branch to onStart (yak#23)', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMarkerWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    let seen: { runId: string; worktreeBranch?: string } | undefined
    const result = await executeWorkflowFile(workflowPath, {
      runsDir,
      cwd: repoRoot,
      isolation: 'worktree',
      onStart: (info) => {
        seen = info
      },
    })

    expect(seen?.worktreeBranch).toBe(`yak/${result.runId}`)
  })

  it('keeps runsDir and cacheDir anchored to the original repo, not the worktree', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMarkerWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })

    expect((await stat(result.runDir)).isDirectory()).toBe(true)
    expect(result.runDir.startsWith(runsDir)).toBe(true)

    const cacheDir = path.join(repoRoot, '.yak', 'cache')
    const cacheEntries = await readdir(cacheDir)
    expect(cacheEntries.length).toBeGreaterThan(0)
  })

  it('never removes the worktree after the run finishes', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMarkerWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })

    const worktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId)
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
  })

  it('defaults to isolation "none" — steps execute directly in the given cwd', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMarkerWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot })

    expect(result.status).toBe('ok')
    const marker = await readFile(path.join(repoRoot, 'marker.txt'), 'utf8')
    expect(marker.trim()).toBe('marker')
  })

  it('a worktree-creation failure (e.g. non-git cwd) surfaces as an ordinary failed status, not a thrown exception', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-isolation-non-git-'))
    const workflowPath = await writeMarkerWorkflow(dir)
    const runsDir = path.join(dir, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: dir, isolation: 'worktree' })

    expect(result.status).toBe('failed')
  })

  it('runs five concurrent isolated runs with no file conflicts between their worktrees', async () => {
    const repoRoot = await initRepoWithCommit()
    const runsDir = path.join(repoRoot, '.runs')

    // Each run's workflow content is unique (distinct marker text) so the
    // content-addressed cache — intentionally shared across worktree-isolated
    // runs — can't serve one run's step from a concurrently-finishing
    // sibling's cache entry; each genuinely executes in its own worktree.
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const workflowPath = path.join(repoRoot, `workflow-${i}.yaml`)
        await writeFile(
          workflowPath,
          [
            'name: write-marker',
            'version: "1"',
            'steps:',
            '  - id: write',
            `    command: { run: "echo marker-${i} > marker.txt" }`,
            '    produces: write-result',
          ].join('\n'),
          'utf8',
        )
        return executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })
      }),
    )

    expect(results.every((r) => r.status === 'ok')).toBe(true)
    const runIds = results.map((r) => r.runId)
    expect(new Set(runIds).size).toBe(5)

    for (const [i, runId] of runIds.entries()) {
      const worktreePath = path.join(repoRoot, '.yak', 'worktrees', runId)
      const marker = await readFile(path.join(worktreePath, 'marker.txt'), 'utf8')
      expect(marker.trim()).toBe(`marker-${i}`)
    }
  })
})
