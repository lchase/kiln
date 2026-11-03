import { execFile } from 'node:child_process'
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { commitAllIfDirty, createWorktree, WorktreeCreationError } from '../../src/util/git.js'

const execFileAsync = promisify(execFile)

async function initRepoWithCommit(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'yak-git-'))
  await execFileAsync('git', ['init'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoRoot })
  return repoRoot
}

describe('createWorktree', () => {
  it('creates a worktree at the given path on a new branch forked from baseRef', async () => {
    const repoRoot = await initRepoWithCommit()
    const worktreePath = path.join(repoRoot, '.yak', 'worktrees', 'run-1')

    await createWorktree(repoRoot, 'yak/run-1', 'HEAD', worktreePath)

    const stats = await stat(worktreePath)
    expect(stats.isDirectory()).toBe(true)

    const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    })
    expect(branch.trim()).toBe('yak/run-1')

    const { stdout: worktreeList } = await execFileAsync('git', ['worktree', 'list'], { cwd: repoRoot })
    expect(worktreeList).toContain(worktreePath)
  })

  it('forks from an arbitrary non-HEAD ref, not just the checked-out HEAD', async () => {
    const repoRoot = await initRepoWithCommit()
    const { stdout: firstSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'second'], { cwd: repoRoot })

    const worktreePath = path.join(repoRoot, '.yak', 'worktrees', 'run-1')
    await createWorktree(repoRoot, 'yak/run-1', firstSha.trim(), worktreePath)

    const { stdout: worktreeHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
    expect(worktreeHead.trim()).toBe(firstSha.trim())
  })

  it('two concurrent createWorktree calls against the same repo both succeed without corrupting each other', async () => {
    const repoRoot = await initRepoWithCommit()
    const pathA = path.join(repoRoot, '.yak', 'worktrees', 'run-a')
    const pathB = path.join(repoRoot, '.yak', 'worktrees', 'run-b')

    await Promise.all([
      createWorktree(repoRoot, 'yak/run-a', 'HEAD', pathA),
      createWorktree(repoRoot, 'yak/run-b', 'HEAD', pathB),
    ])

    expect((await stat(pathA)).isDirectory()).toBe(true)
    expect((await stat(pathB)).isDirectory()).toBe(true)

    const { stdout: worktreeList } = await execFileAsync('git', ['worktree', 'list'], { cwd: repoRoot })
    expect(worktreeList).toContain(pathA)
    expect(worktreeList).toContain(pathB)
  })

  it('throws a catchable error on branch name collision, without leaving a partial worktree', async () => {
    const repoRoot = await initRepoWithCommit()
    const worktreePath = path.join(repoRoot, '.yak', 'worktrees', 'run-1')
    await createWorktree(repoRoot, 'yak/run-1', 'HEAD', worktreePath)

    const secondPath = path.join(repoRoot, '.yak', 'worktrees', 'run-1-again')
    await expect(createWorktree(repoRoot, 'yak/run-1', 'HEAD', secondPath)).rejects.toThrow(WorktreeCreationError)

    await expect(stat(secondPath)).rejects.toThrow()
  })

  it('leaves the parent worktrees directory containing only the successfully created worktree', async () => {
    const repoRoot = await initRepoWithCommit()
    const worktreesDir = path.join(repoRoot, '.yak', 'worktrees')
    const worktreePath = path.join(worktreesDir, 'run-1')

    await createWorktree(repoRoot, 'yak/run-1', 'HEAD', worktreePath)

    const entries = await readdir(worktreesDir)
    expect(entries).toEqual(['run-1'])
  })
})

describe('commitAllIfDirty', () => {
  it('stages and commits every change under a fixed engine identity, distinct from the repo committer', async () => {
    const repoRoot = await initRepoWithCommit()
    await execFileAsync('git', ['config', 'user.email', 'human@example.com'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.name', 'Human'], { cwd: repoRoot })
    await writeFile(path.join(repoRoot, 'new.txt'), 'hi\n', 'utf8')

    await commitAllIfDirty(repoRoot, 'yak: checkpoint before map review')

    const { stdout: log } = await execFileAsync('git', ['log', '-1', '--format=%an <%ae> %s'], { cwd: repoRoot })
    expect(log.trim()).toBe('yak <engine@yak.local> yak: checkpoint before map review')

    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot })
    expect(status.trim()).toBe('')
  })

  it('does nothing on a clean tree — no empty commit', async () => {
    const repoRoot = await initRepoWithCommit()
    const { stdout: before } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })

    await commitAllIfDirty(repoRoot, 'yak: checkpoint before map review')

    const { stdout: after } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    expect(after.trim()).toBe(before.trim())
  })
})
