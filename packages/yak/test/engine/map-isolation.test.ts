import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { executeWorkflowFile } from '../../src/engine/run.js'

const execFileAsync = promisify(execFile)

async function initRepoWithCommit(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'yak-map-isolation-'))
  await execFileAsync('git', ['init'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoRoot })
  return repoRoot
}

/** Both the top-level `items` transform step and the workflow itself run
 * inside the run's own worktree (run-level isolation is required for
 * map-item isolation to be legal at all) — `.yak/transforms.ts` must be
 * committed, same reasoning as schemas.ts for a gate step. */
async function writeMapIsolationWorkflow(dir: string): Promise<string> {
  await mkdir(path.join(dir, '.yak'), { recursive: true })
  await writeFile(
    path.join(dir, '.yak', 'transforms.ts'),
    "export function threeItems() { return ['a', 'b', 'c'] }\n",
    'utf8',
  )
  await execFileAsync('git', ['add', '.yak/transforms.ts'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'add transforms'], { cwd: dir })

  const workflowPath = path.join(dir, 'workflow.yaml')
  await writeFile(
    workflowPath,
    [
      'name: map-isolation',
      'version: "1"',
      'steps:',
      '  - id: items',
      '    transform: { fn: threeItems }',
      '    produces: items',
      '  - id: review',
      '    needs: [items]',
      '    map:',
      '      over: items',
      '      isolation: worktree',
      '      concurrency: 3',
      '      step:',
      '        id: review-one',
      '        command: { run: "echo item=$MAP_ITEM_INDEX > marker.txt" }',
      '    produces: findings',
    ].join('\n'),
    'utf8',
  )
  return workflowPath
}

describe('map step isolation: worktree', () => {
  it('gives each item its own worktree, forked from the run branch, instead of sharing ctx.cwd', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMapIsolationWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })

    expect(result.status).toBe('ok')

    for (let index = 0; index < 3; index++) {
      const itemWorktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId, 'review', String(index))
      const marker = await readFile(path.join(itemWorktreePath, 'marker.txt'), 'utf8')
      expect(marker.trim()).toBe(`item=${index}`)

      const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: itemWorktreePath,
      })
      expect(branch.trim()).toBe(`yak-item/${result.runId}/review/${index}`)
    }

    // The run's own worktree never receives an item's marker file — items
    // wrote into their own separate worktrees, not the shared run cwd.
    const runWorktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId)
    await expect(readFile(path.join(runWorktreePath, 'marker.txt'), 'utf8')).rejects.toThrow()
  })

  it('leaves item worktrees on disk after the run finishes, same as the run worktree', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMapIsolationWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })

    const itemWorktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId, 'review', '0')
    expect((await stat(itemWorktreePath)).isDirectory()).toBe(true)
  })

  it('commits prior step output before forking item worktrees, so items see it', async () => {
    const repoRoot = await initRepoWithCommit()
    await writeFile(path.join(repoRoot, 'tracked.txt'), 'original\n', 'utf8')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'seed tracked.txt'], { cwd: repoRoot })

    await mkdir(path.join(repoRoot, '.yak'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.yak', 'transforms.ts'),
      "export function threeItems() { return ['a', 'b', 'c'] }\n",
      'utf8',
    )
    await execFileAsync('git', ['add', '.yak/transforms.ts'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'add transforms'], { cwd: repoRoot })

    const workflowPath = path.join(repoRoot, 'workflow.yaml')
    await writeFile(
      workflowPath,
      [
        'name: map-isolation-sees-prior-output',
        'version: "1"',
        'steps:',
        '  - id: modify',
        // Deliberately not committed by the workflow itself — only the
        // engine's checkpoint-before-fan-out should commit this.
        '    command: { run: "echo modified-by-yak > tracked.txt", capture: [exitCode] }',
        '    produces: modifyResult',
        '  - id: items',
        '    needs: [modifyResult]',
        '    transform: { fn: threeItems }',
        '    produces: items',
        '  - id: review',
        '    needs: [items]',
        '    map:',
        '      over: items',
        '      isolation: worktree',
        '      step:',
        '        id: review-one',
        '        command: { run: "cat tracked.txt > marker.txt" }',
        '    produces: findings',
      ].join('\n'),
      'utf8',
    )
    const runsDir = path.join(repoRoot, '.runs')

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot, isolation: 'worktree' })

    expect(result.status).toBe('ok')

    const itemWorktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId, 'review', '0')
    const marker = await readFile(path.join(itemWorktreePath, 'marker.txt'), 'utf8')
    expect(marker.trim()).toBe('modified-by-yak')

    // The commit landed on the run's own branch, under the fixed engine
    // identity, not the repo's configured committer.
    const runWorktreePath = path.join(repoRoot, '.yak', 'worktrees', result.runId)
    const { stdout: log } = await execFileAsync('git', ['log', '-1', '--format=%an <%ae> %s'], {
      cwd: runWorktreePath,
    })
    expect(log.trim()).toBe('yak <engine@yak.local> yak: checkpoint before map review')
  })

  it('rejects at load time when isolation: worktree is set on a map step but the run itself is not', async () => {
    const repoRoot = await initRepoWithCommit()
    const workflowPath = await writeMapIsolationWorkflow(repoRoot)
    const runsDir = path.join(repoRoot, '.runs')

    await expect(executeWorkflowFile(workflowPath, { runsDir, cwd: repoRoot })).rejects.toThrow(
      /isolation: 'worktree'.*requires the run itself/is,
    )
  })
})
