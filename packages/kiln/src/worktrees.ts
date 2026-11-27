import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { readDelivery } from "./delivery.js";
import { appendEvent } from "./events.js";
import { isLanded, jobState, type Observation, type ObservedJob, type ObservedRun } from "./reconcile.js";
import { isPidAlive, safeRunId } from "./reliability.js";
import type { JobState } from "./schemas.js";

/**
 * Worktree cleanup. One rule set for the tick and `kiln clean`.
 *
 * Every directory under `<repo>/.yak/worktrees/` is planned. A name that no
 * Kiln job owns is `unowned` and never touched. An owned worktree is kept
 * while anything may still use it (a live run, a gate, an open fix round,
 * a run still in flight, a landed pull request not pushed yet) and removed
 * once its run is over. A dirty tree is first committed to its own branch.
 */

export type WorktreeAction = "remove" | "snapshot-remove" | "keep" | "unowned";

export interface WorktreeEntry {
  repo: string;
  runId: string;
  path: string;
  jobId?: string;
  state?: JobState;
  action: WorktreeAction;
  reason: string;
  /** Branch deletion also checks ancestry against this ref (delivery base). */
  base?: string;
  /** A stacked job that has not launched yet cuts its worktree from this run's branch. */
  branchNeeded?: boolean;
}

export interface WorktreeOutcome {
  entry: WorktreeEntry;
  outcome: "cleaned" | "kept";
  branch?: "deleted" | "kept";
  snapshot?: string;
  detail?: string;
}

const SNAPSHOT_SUBJECT = "kiln: snapshot uncommitted changes before removing worktree";

/** Owner of each `.yak/worktrees/<run id>` from the job tag map `scanRuns` builds. */
export function planWorktrees(
  config: LoadedKilnConfig,
  observation: Observation,
  runs: ReadonlyMap<string, readonly ObservedRun[]>,
  repo?: string,
): WorktreeEntry[] {
  const owners = new Map<string, { job: ObservedJob; run: ObservedRun }>();
  for (const job of observation.jobs) {
    for (const run of runs.get(`kiln:${job.jobId}`) ?? []) {
      owners.set(`${resolve(run.checkout)}\0${run.runId}`, { job, run });
    }
  }
  const entries: WorktreeEntry[] = [];
  for (const [name, entry] of Object.entries(config.repos)) {
    if (repo !== undefined && name !== repo) continue;
    const checkout = resolve(entry.path);
    const root = resolve(checkout, ".yak", "worktrees");
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();
    for (const runId of dirs) {
      const path = resolve(root, runId);
      const owner = safeRunId(runId) && path.startsWith(`${root}${sep}`) ? owners.get(`${checkout}\0${runId}`) : undefined;
      if (!owner) {
        entries.push({ repo: name, runId, path, action: "unowned", reason: "no Kiln job owns this run" });
        continue;
      }
      entries.push(planOne(config, observation, name, path, owner.job, owner.run));
    }
  }
  return entries;
}

function planOne(
  config: LoadedKilnConfig,
  observation: Observation,
  repo: string,
  path: string,
  job: ObservedJob,
  run: ObservedRun,
): WorktreeEntry {
  const state = jobState(job, observation);
  const base: Omit<WorktreeEntry, "action" | "reason"> = { repo, runId: run.runId, path, jobId: job.jobId, state };
  const selected = job.run?.runId === run.runId;
  const keep = (reason: string): WorktreeEntry => ({ ...base, action: "keep", reason });
  const remove = (reason: string): WorktreeEntry => {
    const delivery = job.deliver === "pr" ? readDelivery(config.kilnDir, job.jobId) : undefined;
    const branchNeeded = selected && observation.jobs.some(
      (other) => other.stack && !other.cancelled && !other.run && other.dependsOn.includes(job.jobId),
    );
    return {
      ...base,
      action: worktreeDirty(path) ? "snapshot-remove" : "remove",
      reason,
      ...(delivery?.base ? { base: delivery.base } : {}),
      ...(branchNeeded ? { branchNeeded: true } : {}),
    };
  };

  if (job.error) return keep(`job file unusable: ${job.error}`);
  // `alive` already means the journal pid is alive (`classify` in driver.ts).
  if (run.status === "alive") return keep("run is alive");
  if (run.status === "suspended") return keep("run is waiting on a gate");
  if (selected && job.launching && job.launchPid !== undefined && isPidAlive(job.launchPid)) {
    return keep("job is launching");
  }
  if (selected && (job.fixInProgress || job.fixAwaitingPublish)) return keep("fix round in progress");

  if (state === "cancelled") return remove("job cancelled");
  if (state === "done") return remove("job done");
  if (state === "rejected") return remove("gate rejected");
  if (!selected) return remove("run replaced by a later run");
  if (state === "running" || state === "queued" || state === "approved") return keep(`job is ${state}`);
  if (run.status === "failed" || run.status === "dead") return remove(`run ${run.status}`);
  if (isLanded(job) && job.deliver === "pr") {
    const record = readDelivery(config.kilnDir, job.jobId);
    if (record?.runId === run.runId && (record.pushed || record.prNumber)) return remove("landed and pushed");
    return keep("landed, waiting for delivery");
  }
  return keep(`job is ${state}`);
}

/**
 * Snapshot (when dirty), remove the worktree, and delete its branch when the
 * tip is on a remote or in the base. An absent worktree does nothing and
 * records nothing. A failure keeps the tree and records `worktree.kept`.
 */
export function applyWorktrees(config: LoadedKilnConfig, entries: readonly WorktreeEntry[]): WorktreeOutcome[] {
  const outcomes: WorktreeOutcome[] = [];
  for (const entry of entries) {
    if (entry.action !== "remove" && entry.action !== "snapshot-remove") continue;
    if (!entry.jobId || !safeRunId(entry.runId) || !existsSync(entry.path)) continue;
    const repo = config.repos[entry.repo];
    if (!repo) continue;
    const outcome = applyOne(resolve(repo.path), entry);
    appendEvent(config.kilnDir, {
      job_id: entry.jobId,
      run_id: entry.runId,
      event: outcome.outcome === "cleaned" ? "worktree.cleaned" : "worktree.kept",
      properties: {
        once: `worktree.${outcome.outcome}:${entry.runId}`,
        reason: outcome.detail ?? entry.reason,
        ...(outcome.snapshot ? { snapshot: outcome.snapshot } : {}),
        ...(outcome.branch ? { branch: outcome.branch } : {}),
      },
    });
    outcomes.push(outcome);
  }
  return outcomes;
}

function applyOne(checkout: string, entry: WorktreeEntry): WorktreeOutcome {
  const root = resolve(checkout, ".yak", "worktrees");
  if (!entry.path.startsWith(`${root}${sep}`) || resolve(root, entry.runId) !== entry.path) {
    return { entry, outcome: "kept", detail: "path is not under .yak/worktrees" };
  }
  let snapshot: string | undefined;
  if (worktreeDirty(entry.path)) {
    const added = git(entry.path, ["add", "-A"]);
    const committed =
      added.status === 0 &&
      git(entry.path, [
        "-c",
        "user.name=kiln",
        "-c",
        "user.email=kiln@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-q",
        "-m",
        SNAPSHOT_SUBJECT,
        "-m",
        `Run ${entry.runId}, job ${entry.jobId}: ${entry.reason}. Made by Kiln, not pushed.`,
      ]).status === 0;
    if (!committed || worktreeDirty(entry.path)) {
      return { entry, outcome: "kept", detail: "snapshot commit failed" };
    }
    snapshot = git(entry.path, ["rev-parse", "HEAD"]).stdout.trim() || undefined;
  }
  if (git(checkout, ["worktree", "remove", entry.path]).status !== 0 || existsSync(entry.path)) {
    return { entry, outcome: "kept", detail: "git worktree remove failed", ...(snapshot ? { snapshot } : {}) };
  }
  const branch = deleteBranchIfSafe(checkout, entry);
  return { entry, outcome: "cleaned", ...(snapshot ? { snapshot } : {}), ...(branch ? { branch } : {}) };
}

/** `git branch -D` only when no commit is lost: the tip is on a remote or in the base (or HEAD). */
function deleteBranchIfSafe(checkout: string, entry: WorktreeEntry): "deleted" | "kept" | undefined {
  const ref = `refs/heads/yak/${entry.runId}`;
  const tip = git(checkout, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim();
  if (!tip) return undefined;
  if (entry.branchNeeded || checkedOutAnywhere(checkout, ref)) return "kept";
  const onRemote = (() => {
    const result = git(checkout, ["branch", "-r", "--contains", tip]);
    return result.status === 0 && result.stdout.trim().length > 0;
  })();
  // Delivery base is a branch name from a Kiln-written file; refuse anything git could read as an option.
  const bases = [entry.base, "HEAD"].filter((value): value is string => typeof value === "string" && value.length > 0 && !value.startsWith("-"));
  const inBase = bases.some((base) => git(checkout, ["merge-base", "--is-ancestor", tip, base]).status === 0);
  if (!onRemote && !inBase) return "kept";
  return git(checkout, ["branch", "-D", `yak/${entry.runId}`]).status === 0 ? "deleted" : "kept";
}

function checkedOutAnywhere(checkout: string, ref: string): boolean {
  const result = git(checkout, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return true;
  return result.stdout.split("\n").some((line) => line === `branch ${ref}`);
}

function worktreeDirty(path: string): boolean {
  if (!existsSync(path)) return false;
  const result = git(path, ["status", "--porcelain"]);
  return result.status !== 0 || result.stdout.trim().length > 0;
}

/** `du -sk`, or undefined when du fails. */
export function worktreeSizeKb(path: string): number | undefined {
  const result = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const kb = Number((result.stdout ?? "").split(/\s/)[0]);
  return Number.isFinite(kb) ? kb : undefined;
}

export function renderCleanPlan(entries: readonly WorktreeEntry[]): string {
  if (entries.length === 0) return "no worktrees\n";
  const lines = entries.map((entry) => {
    const size = worktreeSizeKb(entry.path);
    const sizeText = size === undefined ? "?" : formatKb(size);
    return `${entry.runId}  ${entry.repo}  ${entry.jobId ?? "-"}  ${entry.state ?? "-"}  ${sizeText}  ${entry.action}: ${entry.reason}`;
  });
  return `run  repo  job  state  size  action: reason\n${lines.join("\n")}\n`;
}

function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}G`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}M`;
  return `${kb}K`;
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}
