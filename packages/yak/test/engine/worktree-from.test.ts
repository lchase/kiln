import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile, resumeRun } from '../../src/engine/run.js'

const execFileAsync = promisify(execFile)
const yakRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsxBin = path.join(yakRoot, 'node_modules', '.bin', 'tsx')
const cliEntry = path.join(yakRoot, 'src', 'cli', 'index.ts')

const SCHEMAS =
  "import { z } from 'zod'\nexport const ApprovalSchema = z.object({ decision: z.enum(['approve', 'reject']) })\n"
const TRANSFORMS = "export function threeItems() { return ['a', 'b', 'c'] }\n"

interface CheckoutSnapshot {
  head: string
  branch: string
  status: string
}

interface DivergedRepo {
  repo: string
  workflowPath: string
  runsDir: string
  baseSha: string
  headSha: string
  before: CheckoutSnapshot
}

async function rev(cwd: string, ref = 'HEAD'): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd })
  return stdout.trim()
}

async function snapshotCheckout(repo: string): Promise<CheckoutSnapshot> {
  const head = await rev(repo)
  const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })
  return { head, branch: branch.trim(), status }
}

function commandWorkflow(): string {
  return [
    'name: write-marker',
    'version: "1"',
    'steps:',
    '  - id: write',
    '    command: { run: "echo marker > wrote.txt" }',
    '    produces: write-result',
  ].join('\n')
}

function gateWorkflow(): string {
  return [
    'name: gate-then-write',
    'version: "1"',
    'steps:',
    '  - id: approve',
    '    gate: { schema: ApprovalSchema, render: { inline: "Approve?" } }',
    '    produces: decision',
    '  - id: write',
    '    needs: [decision]',
    '    command: { run: "echo marker > wrote.txt" }',
    '    produces: write-result',
  ].join('\n')
}

function mapWorkflow(): string {
  return [
    'name: map-from-run-worktree',
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
    '      step:',
    '        id: review-one',
    '        command: { run: "cat marker.txt > seen.txt" }',
    '    produces: findings',
  ].join('\n')
}

/** Checkout is one commit ahead of branch `upstream`. `upstream` (and only
 * that branch) has `marker.txt` = base and no `head-only.txt`. */
async function divergedRepo(kind: 'command' | 'gate' | 'map'): Promise<DivergedRepo> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yak-from-'))
  await execFileAsync('git', ['init'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  // The agent environment signs commits and enables fsmonitor globally.
  // Local repos opt out so a parallel suite cannot block in gpg or the
  // fsmonitor daemon.
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  await execFileAsync('git', ['config', 'core.fsmonitor', 'false'], { cwd: repo })

  await mkdir(path.join(repo, '.yak'), { recursive: true })
  await writeFile(path.join(repo, '.yak', 'schemas.ts'), SCHEMAS, 'utf8')
  await writeFile(path.join(repo, '.yak', 'transforms.ts'), TRANSFORMS, 'utf8')
  await writeFile(path.join(repo, 'marker.txt'), 'base\n', 'utf8')
  await writeFile(path.join(repo, 'base-only.txt'), 'base\n', 'utf8')
  await execFileAsync('git', ['add', '--', '.yak', 'marker.txt', 'base-only.txt'], { cwd: repo })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo })
  const baseSha = await rev(repo)
  await execFileAsync('git', ['branch', 'upstream'], { cwd: repo })

  await writeFile(path.join(repo, 'marker.txt'), 'head\n', 'utf8')
  await writeFile(path.join(repo, 'head-only.txt'), 'head\n', 'utf8')
  await execFileAsync('git', ['add', '--', 'marker.txt', 'head-only.txt'], { cwd: repo })
  await execFileAsync('git', ['commit', '-m', 'head'], { cwd: repo })
  const headSha = await rev(repo)
  expect(headSha).not.toBe(baseSha)
  expect(await rev(repo, 'upstream')).toBe(baseSha)

  const workflowPath = path.join(repo, 'workflow.yaml')
  const body = kind === 'gate' ? gateWorkflow() : kind === 'map' ? mapWorkflow() : commandWorkflow()
  await writeFile(workflowPath, body, 'utf8')
  await writeFile(path.join(repo, 'dirty.txt'), 'dirty\n', 'utf8')

  return {
    repo,
    workflowPath,
    runsDir: path.join(repo, '.runs'),
    baseSha,
    headSha,
    before: await snapshotCheckout(repo),
  }
}

/** Engine run state (`.runs/`, cache, worktrees) shows up as untracked in a
 * temp repo that does not carry yak's gitignore. Those paths are the run,
 * not edits to the checkout. Anything else in the status — a tracked-file
 * modification, or a new untracked user file — is a real change. */
const ENGINE_UNTRACKED = new Set(['?? .runs/', '?? .yak/cache/', '?? .yak/worktrees/'])

function statusWithoutEngineState(status: string): string {
  return status
    .split('\n')
    .filter((line) => line !== '' && !ENGINE_UNTRACKED.has(line))
    .join('\n')
}

async function assertCheckoutUnchanged(repo: DivergedRepo): Promise<void> {
  const after = await snapshotCheckout(repo.repo)
  expect(after.head).toBe(repo.before.head)
  expect(after.branch).toBe(repo.before.branch)
  expect(statusWithoutEngineState(after.status)).toBe(statusWithoutEngineState(repo.before.status))
  const { stdout: tracked } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repo.repo,
  })
  expect(tracked).toBe('')
  expect(await readFile(path.join(repo.repo, 'marker.txt'), 'utf8')).toBe('head\n')
  expect(await readFile(path.join(repo.repo, 'dirty.txt'), 'utf8')).toBe('dirty\n')
  expect(await readFile(path.join(repo.repo, 'head-only.txt'), 'utf8')).toBe('head\n')
}

function worktreePath(repo: string, runId: string): string {
  return path.join(repo, '.yak', 'worktrees', runId)
}

async function assertNoRunCreated(repo: string): Promise<void> {
  await expect(stat(path.join(repo, '.runs'))).rejects.toThrow()
  await expect(stat(path.join(repo, '.yak', 'worktrees'))).rejects.toThrow()
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
  const worktrees = stdout.split('\n').filter((line) => line.startsWith('worktree '))
  expect(worktrees).toHaveLength(1)
  const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'yak/*'], { cwd: repo })
  expect(branches.trim()).toBe('')
}

async function runYak(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, [cliEntry, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const failed = err as { code?: number | string; stdout?: string; stderr?: string }
    const code = typeof failed.code === 'number' ? failed.code : 1
    return { code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

describe('yak run --isolation worktree --from <ref>', () => {
  it('starts the worktree at the given branch commit while checkout HEAD and working tree are unchanged', async () => {
    const repo = await divergedRepo('command')
    const result = await executeWorkflowFile(repo.workflowPath, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      isolation: 'worktree',
      from: 'upstream',
    })

    expect(result.status).toBe('ok')
    const tree = worktreePath(repo.repo, result.runId)
    expect(await rev(tree)).toBe(repo.baseSha)
    expect(await readFile(path.join(tree, 'marker.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(path.join(tree, 'wrote.txt'), 'utf8')).toBe('marker\n')
    await expect(stat(path.join(tree, 'head-only.txt'))).rejects.toThrow()
    await assertCheckoutUnchanged(repo)

    const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tree })
    expect(branch.trim()).toBe(`yak/${result.runId}`)

    const started = (await readJournal(result.runDir)).find((event) => event.t === 'run.started')
    if (started?.t !== 'run.started') throw new Error('unreachable')
    expect(started.worktreeBase).toBe(repo.baseSha)
  })

  it('resolves a remote-tracking ref (origin/main) and a raw commit the same way', async () => {
    const remote = await divergedRepo('command')
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', remote.baseSha], { cwd: remote.repo })
    const fromRemote = await executeWorkflowFile(remote.workflowPath, {
      runsDir: remote.runsDir,
      cwd: remote.repo,
      isolation: 'worktree',
      from: 'origin/main',
    })
    expect(fromRemote.status).toBe('ok')
    expect(await rev(worktreePath(remote.repo, fromRemote.runId))).toBe(remote.baseSha)
    await assertCheckoutUnchanged(remote)

    const pinned = await divergedRepo('command')
    const fromSha = await executeWorkflowFile(pinned.workflowPath, {
      runsDir: pinned.runsDir,
      cwd: pinned.repo,
      isolation: 'worktree',
      from: pinned.baseSha,
    })
    expect(fromSha.status).toBe('ok')
    expect(await rev(worktreePath(pinned.repo, fromSha.runId))).toBe(pinned.baseSha)
    const started = (await readJournal(fromSha.runDir)).find((event) => event.t === 'run.started')
    if (started?.t !== 'run.started') throw new Error('unreachable')
    expect(started.worktreeBase).toBe(pinned.baseSha)
    await assertCheckoutUnchanged(pinned)
  })

  it('errors on an unknown ref and creates no worktree and no run', async () => {
    const repo = await divergedRepo('command')
    await expect(
      executeWorkflowFile(repo.workflowPath, {
        runsDir: repo.runsDir,
        cwd: repo.repo,
        isolation: 'worktree',
        from: 'no-such-ref',
      }),
    ).rejects.toThrow(/unknown ref "no-such-ref"/)
    await assertNoRunCreated(repo.repo)
    await assertCheckoutUnchanged(repo)
  })

  it('errors when --from is set without worktree isolation and creates nothing', async () => {
    const repo = await divergedRepo('command')
    await expect(
      executeWorkflowFile(repo.workflowPath, {
        runsDir: repo.runsDir,
        cwd: repo.repo,
        from: 'upstream',
      }),
    ).rejects.toThrow(/--from requires --isolation worktree/)
    await expect(
      executeWorkflowFile(repo.workflowPath, {
        runsDir: repo.runsDir,
        cwd: repo.repo,
        isolation: 'none',
        from: 'upstream',
      }),
    ).rejects.toThrow(/--from requires --isolation worktree/)
    await assertNoRunCreated(repo.repo)
    await assertCheckoutUnchanged(repo)
  })

  it('resume after the ref moves uses the original commit, not the ref', async () => {
    const repo = await divergedRepo('gate')
    const suspended = await executeWorkflowFile(repo.workflowPath, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      isolation: 'worktree',
      from: 'upstream',
    })
    expect(suspended.status).toBe('suspended')
    const tree = worktreePath(repo.repo, suspended.runId)
    expect(await rev(tree)).toBe(repo.baseSha)
    await assertCheckoutUnchanged(repo)

    // Drop the worktree and the run branch so resume has to materialize
    // from the journaled SHA. Point the original ref at the checkout tip
    // and pass that same ref back into resume — it must not be resolved.
    await execFileAsync('git', ['worktree', 'remove', tree], { cwd: repo.repo })
    await execFileAsync('git', ['branch', '-D', `yak/${suspended.runId}`], { cwd: repo.repo })
    await execFileAsync('git', ['branch', '-f', 'upstream', repo.headSha], { cwd: repo.repo })
    expect(await rev(repo.repo, 'upstream')).toBe(repo.headSha)

    await mkdir(path.join(suspended.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(suspended.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'approve' }),
      'utf8',
    )

    const resumed = await resumeRun(suspended.runId, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      from: 'upstream',
    })
    expect(resumed.status).toBe('ok')
    expect(await rev(tree)).toBe(repo.baseSha)
    expect(await readFile(path.join(tree, 'marker.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(path.join(tree, 'wrote.txt'), 'utf8')).toBe('marker\n')
    await expect(stat(path.join(tree, 'head-only.txt'))).rejects.toThrow()
    await assertCheckoutUnchanged(repo)

    const started = (await readJournal(resumed.runDir)).find((event) => event.t === 'run.started')
    if (started?.t !== 'run.started') throw new Error('unreachable')
    expect(started.worktreeBase).toBe(repo.baseSha)
  })

  it('resume reattaches the run branch when the worktree is gone, without following the moved ref', async () => {
    const repo = await divergedRepo('gate')
    const suspended = await executeWorkflowFile(repo.workflowPath, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      isolation: 'worktree',
      from: 'upstream',
    })
    expect(suspended.status).toBe('suspended')
    const tree = worktreePath(repo.repo, suspended.runId)

    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'progress'], { cwd: tree })
    const progress = await rev(tree)
    expect(progress).not.toBe(repo.baseSha)

    await execFileAsync('git', ['worktree', 'remove', tree], { cwd: repo.repo })
    await execFileAsync('git', ['branch', '-f', 'upstream', repo.headSha], { cwd: repo.repo })

    await mkdir(path.join(suspended.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(suspended.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'approve' }),
      'utf8',
    )

    const resumed = await resumeRun(suspended.runId, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      from: 'upstream',
    })
    expect(resumed.status).toBe('ok')
    expect(await rev(tree)).toBe(progress)
    await expect(stat(path.join(tree, 'head-only.txt'))).rejects.toThrow()
    expect(await readFile(path.join(tree, 'wrote.txt'), 'utf8')).toBe('marker\n')
    await assertCheckoutUnchanged(repo)
  })

  it('without --from, forks HEAD and does not record a start commit', async () => {
    const repo = await divergedRepo('command')
    const result = await executeWorkflowFile(repo.workflowPath, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      isolation: 'worktree',
    })

    expect(result.status).toBe('ok')
    const tree = worktreePath(repo.repo, result.runId)
    expect(await rev(tree)).toBe(repo.headSha)
    expect(await readFile(path.join(tree, 'marker.txt'), 'utf8')).toBe('head\n')
    expect(await readFile(path.join(tree, 'head-only.txt'), 'utf8')).toBe('head\n')
    await assertCheckoutUnchanged(repo)

    const started = (await readJournal(result.runDir)).find((event) => event.t === 'run.started')
    if (started?.t !== 'run.started') throw new Error('unreachable')
    expect('worktreeBase' in started).toBe(false)
  })

  it('map item worktrees still fork from the run worktree, which is the --from commit', async () => {
    const repo = await divergedRepo('map')
    const result = await executeWorkflowFile(repo.workflowPath, {
      runsDir: repo.runsDir,
      cwd: repo.repo,
      isolation: 'worktree',
      from: 'upstream',
    })

    expect(result.status).toBe('ok')
    const runTree = worktreePath(repo.repo, result.runId)
    expect(await rev(runTree)).toBe(repo.baseSha)

    const itemTree = path.join(runTree, 'review', '0')
    expect(await rev(itemTree)).toBe(repo.baseSha)
    expect(await readFile(path.join(itemTree, 'seen.txt'), 'utf8')).toBe('base\n')
    await expect(stat(path.join(itemTree, 'head-only.txt'))).rejects.toThrow()
    const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: itemTree })
    expect(branch.trim()).toBe(`yak-item/${result.runId}/review/0`)
    await assertCheckoutUnchanged(repo)
  })
})

describe('yak run CLI --from', () => {
  it('documents --from on yak run --help', async () => {
    const { stdout } = await execFileAsync(tsxBin, [cliEntry, 'run', '--help'], { cwd: yakRoot })
    expect(stdout).toContain('--from <ref>')
    expect(stdout).toContain('requires --isolation worktree')
  })

  it('forks from the flag and leaves the checkout where it was', async () => {
    const repo = await divergedRepo('command')
    const result = await runYak(
      ['run', repo.workflowPath, '--isolation', 'worktree', '--from', 'upstream', '--adapter', 'mock'],
      repo.repo,
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/worktree branch yak\//)
    expect(result.stdout).toMatch(/finished: ok/)

    const { stdout: listed } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo.repo })
    const trees = listed
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    const runTree = trees.find((tree) => tree.includes(`${path.sep}.yak${path.sep}worktrees${path.sep}`))
    expect(runTree).toBeDefined()
    expect(await rev(runTree ?? '')).toBe(repo.baseSha)
    await assertCheckoutUnchanged(repo)
  })

  it('unknown --from exits non-zero and creates nothing', async () => {
    const repo = await divergedRepo('command')
    const result = await runYak(
      ['run', repo.workflowPath, '--isolation', 'worktree', '--from', 'no-such-ref', '--adapter', 'mock'],
      repo.repo,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/unknown ref "no-such-ref"/)
    await assertNoRunCreated(repo.repo)
    await assertCheckoutUnchanged(repo)
  })

  it('--from without --isolation worktree exits non-zero and creates nothing', async () => {
    const repo = await divergedRepo('command')
    const result = await runYak(['run', repo.workflowPath, '--from', 'upstream', '--adapter', 'mock'], repo.repo)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/--from requires --isolation worktree/)
    await assertNoRunCreated(repo.repo)
    await assertCheckoutUnchanged(repo)
  })
})
