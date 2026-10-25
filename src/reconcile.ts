import type { JobSource, JobState } from "./schemas.js";

/**
 * One tick's decisions. Pure: the same observation always yields the same
 * actions.
 *
 * Observe reads job files and yak journals, decide chooses, apply performs.
 * A suspended or still-running job keeps its slot. At most one job is
 * launched per tick, and only when in-flight work is below maxConcurrent.
 * A job that already has a run is not launched again. A failed run stays
 * failed. A dead run, a rejected gate, an ok run with no readable approval,
 * and a launch that exited before writing a journal are terminal and do not
 * take a slot. `deliver=local` unblocks after-merged dependents on `done`
 * (run finished ok, gate decision approve). `deliver=pr` unblocks them when
 * that landed run's pull request has merged. A stacked job unblocks when its
 * one upstream has landed, including while that pull request is `in-review`.
 */

export type RunStatus = "alive" | "suspended" | "ok" | "failed" | "dead";

/** A short, secret-redacted reading of one yak artifact. */
export interface ObservedArtifact {
  name: string;
  summary: string;
}

export interface ObservedGate {
  stepId: string;
  /** First line of the gate prompt. */
  prompt: string;
  /** Full gate text yak wrote on the request, when it differs from the first line. */
  rendered?: string;
  /** Artifacts named on the gate request (`context.artifacts`). */
  artifacts?: ObservedArtifact[];
  /** Latest security, ux, ui, and code artifacts in the run. */
  reviews?: ObservedArtifact[];
  /** Required answer field, when the request schema names one. */
  answerField?: string;
  /** Enum values for that field, so status can print each variant. */
  choices?: string[];
}

export interface ObservedRun {
  runId: string;
  checkout: string;
  status: RunStatus;
  gates: ObservedGate[];
  /**
   * Set when `artifacts/approval.json` has a decision. On a finished ok run
   * this is the gate result. On a still-alive run it means the gate was
   * answered and the run has not finished.
   */
  gateDecision?: "approve" | "reject";
  /** From the run's input artifact, so a resume command can set KILN_TASK_TITLE. */
  title?: string;
}

export interface ObservedJob {
  jobId: string;
  repo: string;
  workflow: string;
  title: string;
  dependsOn: string[];
  /** Absolute path of the job spec. Status does not print it; the local UI links to it. */
  specPath?: string;
  /** Set from the job file. Status prints it. Decide ignores it. */
  source?: JobSource;
  /** Repo delivery mode. Omitted means `local`, which keeps land = `done`. */
  deliver?: "local" | "pr";
  /** Job file `stack`. Omitted means after-merged. */
  stack?: boolean;
  /**
   * Pull request Kiln opened for this run. `merged` comes from `gh pr view`
   * (`state` or `mergedAt`), not from git ancestry.
   */
  delivery?: {
    branch?: string;
    prNumber?: number;
    prUrl?: string;
    merged: boolean;
    prState?: "OPEN" | "MERGED" | "CLOSED";
    /** Last failure to push or open the pull request. Retried on the next tick. */
    error?: string;
    /** `gh pr view` failed. The job stays `in-review` when a number is known. */
    viewError?: string;
  };
  /** A launching breadcrumb exists, its child pid is alive, and no journal is visible yet. */
  launching: boolean;
  /** The child pid is dead and no journal was written. Terminal: do not relaunch. */
  launchFailed: boolean;
  /** Fetch or base selection failed. Status shows it. The next tick retries. */
  launchError?: string;
  logPath?: string;
  run?: ObservedRun;
  /** The job file could not be used. Decide skips it. */
  error?: string;
}

export interface Observation {
  maxConcurrent: number;
  /** createdAt order, then id. decide() launches the first queued job. */
  jobs: ObservedJob[];
  /** Breadcrumbs whose journal has since appeared. Apply deletes the files. */
  breadcrumbsToClear: { path: string }[];
}

export type Action =
  | { type: "clear-breadcrumb"; path: string }
  | { type: "launch"; jobId: string; repo: string }
  | { type: "deliver"; jobId: string; repo: string };

export function inFlightCount(observation: Observation): number {
  return observation.jobs.filter((job) => inFlight(job, observation)).length;
}

function inFlight(job: ObservedJob, observation: Observation): boolean {
  if (job.error) return false;
  const state = jobState(job, observation);
  return state === "running" || state === "needs-human" || state === "approved";
}

/**
 * `deliver=local`: `done` is a finished run whose gate says approve.
 * `deliver=pr`: that landed run is `in-review` while the pull request is open
 * (and in the gap before tick opens it) and `done` only once it has merged.
 * `approved` is the approve decision while the run is still alive. It holds
 * a slot and does not unblock dependents. An ok run with no readable
 * decision is `failed`, so a missing artifact cannot unblock the next job.
 */
export function jobState(job: ObservedJob, observation: Observation): JobState {
  if (job.launchFailed && !job.run) return "failed";
  if (job.run) {
    if (isLanded(job)) return landedState(job);
    if (job.run.status === "ok" && job.run.gateDecision === "reject") return "rejected";
    if (job.run.status === "ok") return "failed";
    if (job.run.status === "failed") return "failed";
    if (job.run.status === "dead") return "dead";
    if (job.run.status === "suspended") return "needs-human";
    if (job.run.gateDecision === "approve") return "approved";
    return "running";
  }
  if (job.launching) return "running";
  if (!dependenciesMet(job, observation)) return "blocked";
  if (job.launchError) return "failed";
  return "queued";
}

/**
 * After-merged (the default) needs every upstream `done`.
 * Stacked needs its one upstream landed (approved and the run finished ok),
 * which is true for `in-review` as well as `done`.
 */
export function dependenciesMet(job: ObservedJob, observation: Observation): boolean {
  return job.dependsOn.every((dep) => {
    const upstream = observation.jobs.find((candidate) => candidate.jobId === dep);
    if (!upstream) return false;
    return job.stack ? isLanded(upstream) : isDone(upstream);
  });
}

/** Run finished ok and the gate says approve. The branch `yak/<run-id>` has landed. */
export function isLanded(job: ObservedJob): boolean {
  return job.run?.status === "ok" && job.run.gateDecision === "approve";
}

/** `deliver=local`: landed. `deliver=pr`: landed and the pull request has merged. */
export function isDone(job: ObservedJob): boolean {
  if (!isLanded(job)) return false;
  if ((job.deliver ?? "local") !== "pr") return true;
  return job.delivery?.merged === true || job.delivery?.prState === "MERGED";
}

function landedState(job: ObservedJob): JobState {
  if ((job.deliver ?? "local") !== "pr") return "done";
  const delivery = job.delivery;
  if (delivery?.merged || delivery?.prState === "MERGED") return "done";
  if (delivery?.prState === "CLOSED") return "failed";
  if (delivery?.prNumber) return "in-review";
  if (delivery?.error) return "failed";
  return "in-review";
}

function needsDelivery(job: ObservedJob): boolean {
  if (job.error) return false;
  if ((job.deliver ?? "local") !== "pr") return false;
  if (!isLanded(job)) return false;
  if (job.delivery?.merged || job.delivery?.prState === "MERGED") return false;
  if (job.delivery?.prState === "CLOSED") return false;
  if (job.delivery?.prNumber) return false;
  return true;
}

function canLaunch(job: ObservedJob, observation: Observation): boolean {
  if (job.error || job.run || job.launching || job.launchFailed) return false;
  return dependenciesMet(job, observation);
}

export function decide(observation: Observation): Action[] {
  const actions: Action[] = observation.breadcrumbsToClear.map((crumb) => ({
    type: "clear-breadcrumb",
    path: crumb.path,
  }));

  for (const job of observation.jobs) {
    if (!needsDelivery(job)) continue;
    actions.push({ type: "deliver", jobId: job.jobId, repo: job.repo });
  }

  if (inFlightCount(observation) >= observation.maxConcurrent) return actions;

  const ready = observation.jobs.filter((job) => canLaunch(job, observation));
  const healthy = ready.filter((job) => !job.launchError);
  const picked = healthy[0] ?? ready[0];
  if (picked) actions.push({ type: "launch", jobId: picked.jobId, repo: picked.repo });
  return actions;
}
