import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class WorktreeCreationError extends Error {}

/** `git rev-parse --verify <ref>^{commit}` failed: the ref is missing or
 * does not peel to a commit. Callers must not create a worktree or start
 * a run after this. */
export class UnknownRefError extends Error {
  override name = 'UnknownRefError'
}

/** Fixed engine identity for auto-commits — distinct from whatever the
 * repo's own `user.name`/`user.email` are configured to, per the post-M5
 * gaps map's worktree-auto-commit-strategy decision
 * (`.scratch/yak-post-m5/issues/01-worktree-commit-strategy.md`). */
const ENGINE_AUTHOR = ['-c', 'user.name=yak', '-c', 'user.email=engine@yak.local']

/** Stages and commits every change in `repoRoot` under a fixed engine
 * identity, or does nothing if the tree is already clean. Called right
 * before a worktree-isolated `map` step forks its item worktrees off
 * `HEAD`, so those forks see this run's own prior step output — never
 * after every step, and never for anything but that one trigger point. */
export async function commitAllIfDirty(repoRoot: string, message: string): Promise<void> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot })
  if (stdout.trim() === '') return

  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot })
  await execFileAsync('git', [...ENGINE_AUTHOR, 'commit', '-m', message], { cwd: repoRoot })
}

const WORKTREE_ADD_RETRIES = 5
const WORKTREE_ADD_RETRY_DELAY_MS = 50

function isLockContention(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('index.lock') || message.includes('.git/worktrees') && message.includes('lock')
}

/** Creates a git worktree at `worktreePath` on a new branch `branchName`,
 * forked from `baseRef`. `map` steps with `concurrency > 1` call this from
 * several items at once (same `repoRoot`, different branches/paths) — git
 * takes its own short-lived lock on `.git/worktrees` per `add`, so a
 * transient "already locked" failure between concurrent calls is expected,
 * not a real conflict. Retried with a small delay; anything else fails
 * immediately. */
export async function createWorktree(
  repoRoot: string,
  branchName: string,
  baseRef: string,
  worktreePath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= WORKTREE_ADD_RETRIES; attempt++) {
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], { cwd: repoRoot })
      return
    } catch (err) {
      if (attempt < WORKTREE_ADD_RETRIES && isLockContention(err)) {
        await new Promise((resolve) => setTimeout(resolve, WORKTREE_ADD_RETRY_DELAY_MS))
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      throw new WorktreeCreationError(
        `failed to create worktree at "${worktreePath}" on branch "${branchName}" from "${baseRef}": ${message}`,
      )
    }
  }
}

/** Resolves `ref` to one commit SHA. `^{commit}` peels tags and refuses
 * anything that is not a commit. The SHA is what gets stored and later
 * passed to `git worktree add` — callers must not keep the ref name and
 * look it up again, because a branch or `origin/main` can move. */
export async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot })
    const sha = stdout.trim()
    if (sha === '') throw new UnknownRefError(`unknown ref "${ref}"`)
    return sha
  } catch (err) {
    if (err instanceof UnknownRefError) throw err
    throw new UnknownRefError(`unknown ref "${ref}"`)
  }
}

/** True when `refs/heads/<branchName>` already exists. A missing ref is
 * false, not an error — resume uses that to decide whether to reattach
 * the run branch or create it from the recorded commit. */
export async function localBranchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: repoRoot,
    })
    return true
  } catch {
    return false
  }
}

/** Checks out an existing local branch into a new worktree. Unlike
 * `createWorktree`, this does not move the branch: resume reattaches
 * `yak/<run-id>` so commits the run already made stay put. */
export async function attachWorktree(repoRoot: string, branchName: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], { cwd: repoRoot })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new WorktreeCreationError(
      `failed to attach worktree at "${worktreePath}" on existing branch "${branchName}": ${message}`,
    )
  }
}
