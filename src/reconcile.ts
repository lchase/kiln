import type { JobState } from "./schemas.js";

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
 * take a slot. Only `done` (run finished ok, gate decision approve) unblocks
 * dependents.
 */

export type RunStatus = "alive" | "suspended" | "ok" | "failed" | "dead";

export interface ObservedGate {
  stepId: string;
  /** First line of the gate prompt. */
  prompt: string;
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
  /** A launching breadcrumb exists, its child pid is alive, and no journal is visible yet. */
  launching: boolean;
  /** The child pid is dead and no journal was written. Terminal: do not relaunch. */
  launchFailed: boolean;
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
  | { type: "launch"; jobId: string; repo: string };

/** One launch per tick, so a crash window covers a single spawn. */
const LAUNCHES_PER_TICK = 1;

export function inFlightCount(observation: Observation): number {
  return observation.jobs.filter((job) => inFlight(job, observation)).length;
}

function inFlight(job: ObservedJob, observation: Observation): boolean {
  if (job.error) return false;
  const state = jobState(job, observation);
  return state === "running" || state === "needs-human" || state === "approved";
}

/**
 * `done` is a finished run whose gate says approve.
 * `approved` is that same decision while the run is still alive (the resume
 * has not finished). It holds a slot and does not unblock dependents.
 * An ok run with no readable decision is `failed`, so a missing artifact
 * cannot unblock the next job.
 */
export function jobState(job: ObservedJob, observation: Observation): JobState {
  if (job.launchFailed && !job.run) return "failed";
  if (job.run) {
    if (job.run.status === "ok" && job.run.gateDecision === "approve") return "done";
    if (job.run.status === "ok" && job.run.gateDecision === "reject") return "rejected";
    if (job.run.status === "ok") return "failed";
    if (job.run.status === "failed") return "failed";
    if (job.run.status === "dead") return "dead";
    if (job.run.status === "suspended") return "needs-human";
    if (job.run.gateDecision === "approve") return "approved";
    return "running";
  }
  if (job.launching) return "running";
  return dependenciesMet(job, observation) ? "queued" : "blocked";
}

/** A dependency is met only when that job is `done`. */
export function dependenciesMet(job: ObservedJob, observation: Observation): boolean {
  return job.dependsOn.every((dep) => {
    const upstream = observation.jobs.find((candidate) => candidate.jobId === dep);
    return upstream !== undefined && isDone(upstream);
  });
}

function isDone(job: ObservedJob): boolean {
  return job.run?.status === "ok" && job.run.gateDecision === "approve";
}

export function decide(observation: Observation): Action[] {
  const actions: Action[] = observation.breadcrumbsToClear.map((crumb) => ({
    type: "clear-breadcrumb",
    path: crumb.path,
  }));

  if (inFlightCount(observation) >= observation.maxConcurrent) return actions;

  let launches = 0;
  for (const job of observation.jobs) {
    if (launches >= LAUNCHES_PER_TICK) break;
    if (job.error) continue;
    if (jobState(job, observation) !== "queued") continue;
    actions.push({ type: "launch", jobId: job.jobId, repo: job.repo });
    launches += 1;
  }
  return actions;
}
