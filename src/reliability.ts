import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { LoadedKilnConfig } from "./config.js";
import { jobBasename } from "./paths.js";
import type { FailureReason, ObservedJob } from "./reconcile.js";
import { FAILURE_REASONS } from "./reconcile.js";

/**
 * Attempt ledger under `<kilnDir>/attempts/<jobId>.json`.
 * Job files stay free of stored state. Tick, startup, and `kiln retry` are
 * the only writers. A second pass that sees the same run id does not append.
 *
 * Failure backoff follows Symphony's failure rule, adapted to kiln attempts:
 * `min(10s × 2^(n-1), 5 minutes)` where n is the attempt that just failed.
 */

export const RETRY_BASE_MS = 10_000;
export const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

const AttemptSchema = z.object({
  n: z.number().int().min(1),
  at: z.string().min(1),
  reason: z.enum(FAILURE_REASONS),
  runId: z.string().min(1).optional(),
  pid: z.number().int().nonnegative().optional(),
  detail: z.string().min(1).optional(),
});

const LedgerSchema = z.object({
  jobId: z.string().min(1),
  attempts: z.array(AttemptSchema),
  nextRetryAt: z.string().min(1).optional(),
  /** Runs a manual retry has retired. Observe skips them. */
  ignoredRunIds: z.array(z.string().min(1)).optional(),
});

export type AttemptLedger = z.infer<typeof LedgerSchema>;

export interface ReliabilityNote {
  jobId: string;
  kind: "stall" | "orphan" | "crash" | "fail";
  reason: FailureReason;
  attempt: number;
  nextRetryAt?: string;
}

export interface RecoverOptions {
  /** True on process start (`kiln tick`, `kiln serve`). A dead in-progress run is `orphaned`. */
  startup: boolean;
  now: Date;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Elapsed time must be strictly greater than the timeout. `<= 0` disables stall detection. */
export function isStalled(activityMs: number | undefined, nowMs: number, timeoutMs: number): boolean {
  if (timeoutMs <= 0 || activityMs === undefined) return false;
  return nowMs - activityMs > timeoutMs;
}

/** Delay before the next launch after `attempt` failures. Attempt 1 waits 10s. */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const shift = Math.min(n - 1, 20);
  return Math.min(RETRY_BASE_MS * 2 ** shift, MAX_RETRY_BACKOFF_MS);
}

export function attemptLedgerPath(kilnDir: string, jobId: string): string {
  return join(kilnDir, "attempts", `${jobBasename(jobId)}.json`);
}

export function readAttemptLedger(kilnDir: string, jobId: string): AttemptLedger | "corrupt" | undefined {
  const path = attemptLedgerPath(kilnDir, jobId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = LedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.jobId !== jobId) return "corrupt";
    return parsed;
  } catch {
    return "corrupt";
  }
}

/**
 * Clear the attempt budget and hide `runId` so the next tick can launch.
 * A corrupt ledger is replaced: this is the explicit recovery path.
 */
export function resetAttemptLedger(kilnDir: string, jobId: string, runId?: string): AttemptLedger {
  const current = readAttemptLedger(kilnDir, jobId);
  const ignored = new Set<string>(current && current !== "corrupt" ? (current.ignoredRunIds ?? []) : []);
  if (runId) ignored.add(runId);
  const ledger: AttemptLedger = {
    jobId,
    attempts: [],
    ...(ignored.size > 0 ? { ignoredRunIds: [...ignored] } : {}),
  };
  writeLedger(kilnDir, ledger);
  return ledger;
}

/**
 * Stall, orphan, crash, and non-zero-exit handling for one observation.
 * Caller holds the tick lock. Safe to run twice: a run id is recorded once,
 * and worktree cleanup no-ops once the tree is gone or must be kept.
 */
export function recoverRuns(
  config: LoadedKilnConfig,
  jobs: readonly ObservedJob[],
  options: RecoverOptions,
): ReliabilityNote[] {
  const notes: ReliabilityNote[] = [];
  for (const job of jobs) {
    if (job.error) continue;
    const existing = readAttemptLedger(config.kilnDir, job.jobId);
    if (existing === "corrupt") continue;
    const pending = pendingFailure(job, config, options);
    if (!pending) continue;
    if (pending.killPid !== undefined && !killTree(pending.killPid)) continue;
    const recorded = recordFailure(config, job.jobId, existing, pending, options.now);
    if (recorded.created) {
      appendLog(job.logPath, recorded.ledger.attempts.at(-1));
      notes.push({
        jobId: job.jobId,
        kind: kindFor(pending.reason),
        reason: pending.reason,
        attempt: recorded.ledger.attempts.length,
        ...(recorded.ledger.nextRetryAt ? { nextRetryAt: recorded.ledger.nextRetryAt } : {}),
      });
    }
    const checkout = job.run?.checkout ?? config.repos[job.repo]?.path;
    const runId = pending.runId ?? job.run?.runId;
    if (checkout && runId) cleanupRunWorktree(checkout, runId);
  }
  return notes;
}

interface PendingFailure {
  reason: FailureReason;
  runId?: string;
  pid?: number;
  detail: string;
  /** Set only when this pass must kill a live process (stall). */
  killPid?: number;
}

function pendingFailure(job: ObservedJob, config: LoadedKilnConfig, options: RecoverOptions): PendingFailure | undefined {
  if (job.run?.gateDecision === "reject") return undefined;
  if (job.run?.status === "ok") return undefined;
  if (job.run?.status === "suspended") return undefined;
  if (job.run?.status === "failed" && job.run.finishedReason === "cancelled") return undefined;

  const now = options.now.getTime();
  const launchingLive = job.launching && job.launchPid !== undefined && isPidAlive(job.launchPid);
  if (launchingLive && job.launchPid !== undefined && isStalled(job.launchActivityMs, now, config.stallTimeoutMs)) {
    return {
      reason: "stalled",
      pid: job.launchPid,
      killPid: job.launchPid,
      detail: "no yak event or log output",
    };
  }
  if (launchingLive) return undefined;

  const run = job.run;
  const runLive = run?.status === "alive" && run.gateDecision !== "approve" && run.pid !== undefined && isPidAlive(run.pid);
  if (runLive && run?.pid !== undefined && isStalled(run.activityMs, now, config.stallTimeoutMs)) {
    return {
      reason: "stalled",
      runId: run.runId,
      pid: run.pid,
      killPid: run.pid,
      detail: "no yak event or log output",
    };
  }
  if (runLive) return undefined;

  if (run && (run.status === "dead" || (run.status === "alive" && run.pid !== undefined && !isPidAlive(run.pid)))) {
    return options.startup
      ? { reason: "orphaned", runId: run.runId, pid: run.pid, detail: "process gone at startup" }
      : { reason: "crashed", runId: run.runId, pid: run.pid, detail: "process exited" };
  }
  if (run?.status === "failed") {
    return { reason: "failed", runId: run.runId, pid: run.pid, detail: "non-zero exit" };
  }
  if (job.launchFailed) {
    return {
      reason: "crashed",
      ...(job.launchPid !== undefined ? { pid: job.launchPid } : {}),
      detail: "launch exited before a journal",
    };
  }
  return undefined;
}

function recordFailure(
  config: LoadedKilnConfig,
  jobId: string,
  existing: AttemptLedger | undefined,
  pending: PendingFailure,
  now: Date,
): { ledger: AttemptLedger; created: boolean } {
  const ledger = existing ?? { jobId, attempts: [] };
  if (alreadyRecorded(ledger, pending)) return { ledger, created: false };
  const attempt = {
    n: ledger.attempts.length + 1,
    at: now.toISOString(),
    reason: pending.reason,
    ...(pending.runId ? { runId: pending.runId } : {}),
    ...(pending.pid !== undefined ? { pid: pending.pid } : {}),
    detail: pending.detail,
  };
  const attempts = [...ledger.attempts, attempt];
  const exhausted = attempts.length >= config.maxAttempts;
  const next = exhausted ? undefined : new Date(now.getTime() + retryDelayMs(attempts.length)).toISOString();
  const written: AttemptLedger = {
    jobId,
    attempts,
    ...(next ? { nextRetryAt: next } : {}),
    ...(ledger.ignoredRunIds && ledger.ignoredRunIds.length > 0 ? { ignoredRunIds: ledger.ignoredRunIds } : {}),
  };
  writeLedger(config.kilnDir, written);
  return { ledger: written, created: true };
}

function alreadyRecorded(ledger: AttemptLedger, pending: PendingFailure): boolean {
  if (pending.runId) return ledger.attempts.some((attempt) => attempt.runId === pending.runId);
  if (pending.pid !== undefined) {
    return ledger.attempts.some((attempt) => attempt.runId === undefined && attempt.pid === pending.pid);
  }
  return ledger.attempts.some((attempt) => attempt.runId === undefined && attempt.pid === undefined && attempt.reason === pending.reason);
}

function kindFor(reason: FailureReason): ReliabilityNote["kind"] {
  if (reason === "stalled") return "stall";
  if (reason === "orphaned") return "orphan";
  if (reason === "crashed") return "crash";
  return "fail";
}

function appendLog(logPath: string | undefined, attempt: AttemptLedger["attempts"][number] | undefined): void {
  if (!logPath || !attempt) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `[kiln] ${attempt.reason}: ${attempt.detail ?? "failed"}\n`);
  } catch {
    // The ledger is the record. A missing log must not drop the attempt.
  }
}

function writeLedger(kilnDir: string, ledger: AttemptLedger): void {
  const path = attemptLedgerPath(kilnDir, ledger.jobId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(LedgerSchema.parse(ledger), null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Drop a failed run's worktree only when that loses no commits.
 * A branch with commits that are not on HEAD and not on a remote is kept,
 * and so is a dirty worktree. The checkout's own worktree is not removed.
 */
export function cleanupRunWorktree(checkout: string, runId: string): "kept" | "removed" | "absent" {
  if (!safeRunId(runId)) return "kept";
  const root = resolve(checkout);
  const branch = `yak/${runId}`;
  const worktree = resolve(root, ".yak", "worktrees", runId);
  const worktreeRoot = resolve(root, ".yak", "worktrees");
  if (worktree === root || !worktree.startsWith(`${worktreeRoot}${sep}`)) return "kept";

  const branchExists = gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const worktreeExists = existsSync(worktree);
  if (!branchExists && !worktreeExists) return "absent";
  if (checkedOut(root, branch)) return "kept";
  if (branchExists && hasUnpushedCommits(root, branch)) return "kept";
  if (worktreeExists && worktreeDirty(worktree)) return "kept";

  if (worktreeExists && worktreeListed(root, worktree)) {
    gitOk(root, ["worktree", "remove", worktree]);
  }
  if (existsSync(worktree)) return "kept";
  if (branchExists) gitOk(root, ["branch", "-D", branch]);
  const stillBranch = gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return existsSync(worktree) || stillBranch ? "kept" : "removed";
}

function safeRunId(runId: string): boolean {
  return RUN_ID.test(runId) && !runId.includes("..");
}

function checkedOut(checkout: string, branch: string): boolean {
  const result = git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.status === 0 && result.stdout.trim() === branch;
}

/** Commits on the branch that are neither in HEAD nor on any remote. Failure keeps the branch. */
function hasUnpushedCommits(checkout: string, branch: string): boolean {
  const result = git(checkout, ["rev-list", "--count", branch, "--not", "HEAD", "--not", "--remotes"]);
  if (result.status !== 0) return true;
  const count = Number(result.stdout.trim());
  return !Number.isInteger(count) || count > 0;
}

function worktreeDirty(worktree: string): boolean {
  const result = git(worktree, ["status", "--porcelain"]);
  if (result.status !== 0) return true;
  return result.stdout.trim().length > 0;
}

function worktreeListed(checkout: string, worktree: string): boolean {
  const result = git(checkout, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === worktree);
}

function gitOk(cwd: string, args: string[]): boolean {
  return git(cwd, args).status === 0;
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

const PROTECTED = new Set([process.pid, process.ppid].filter((pid) => Number.isInteger(pid) && pid > 1));
const KILL_WAIT_MS = 2_000;
const KILL_POLL_MS = 20;

/**
 * Kill `pid` and its children. Returns true once the pid is gone or a zombie.
 * SIGKILL is not instant: a single check can still see the old state, and a
 * zombie answers `kill(pid, 0)` until it is reaped, so this polls.
 */
export function killTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || PROTECTED.has(pid)) return false;
  const deadline = Date.now() + KILL_WAIT_MS;
  do {
    signalTree(pid);
    if (!isPidAlive(pid)) return true;
    sleepMs(KILL_POLL_MS);
  } while (Date.now() < deadline);
  signalTree(pid);
  return !isPidAlive(pid);
}

function signalTree(pid: number): void {
  const victims = new Set<number>();
  const stack = [pid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || victims.has(current) || PROTECTED.has(current) || current <= 1) continue;
    victims.add(current);
    for (const child of childPids(current)) stack.push(child);
  }
  const group = processGroup(pid);
  if (group === pid && !PROTECTED.has(group)) signal(-pid, "SIGKILL");
  for (const victim of victims) signal(victim, "SIGKILL");
}

function childPids(pid: number): number[] {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (text) {
      return text
        .split(/\s+/)
        .map((part) => Number(part))
        .filter((child) => Number.isInteger(child) && child > 1);
    }
  } catch {
    // Fall through to a PPid scan. Some kernels leave `children` empty.
  }
  return childrenByPpid(pid);
}

function childrenByPpid(parent: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const child = Number(entry);
    if (child <= 1 || child === parent) continue;
    if (Number(statusValue(child, "PPid")) === parent) found.push(child);
  }
  return found;
}

function processGroup(pid: number): number | undefined {
  const state = procFields(pid);
  const group = state ? Number(state[2]) : Number.NaN;
  return Number.isInteger(group) ? group : undefined;
}

function procState(pid: number): string | undefined {
  return procFields(pid)?.[0] ?? statusValue(pid, "State")?.slice(0, 1);
}

function statusValue(pid: number, key: string): string | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const line = text.split("\n").find((entry) => entry.startsWith(`${key}:`));
    return line?.slice(key.length + 1).trim();
  } catch {
    return undefined;
  }
}

/** Fields of `/proc/pid/stat` after the comm, starting at `state`. */
function procFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    return stat.slice(end + 2).split(" ");
  } catch {
    return undefined;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not our process group.
  }
}

/**
 * True when `pid` is still running. A zombie is not alive: `kill(pid, 0)`
 * succeeds until the parent reaps it, which would keep a killed run in flight.
 * EPERM means the pid exists and we cannot inspect it, so it still counts.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isErrno(error, "EPERM");
  }
  const state = procState(pid);
  return state !== "Z" && state !== "X";
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Latest mtime, folded with journal event times by the driver. */
export function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
