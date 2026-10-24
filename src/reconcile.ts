import type { Plan, Repo } from "./schemas.js";

/**
 * One tick's decisions. Pure: the same observation always yields the same
 * actions.
 *
 * The shape follows the yak-harness reconciler (design decisions 02 and 03):
 * observe reads, plan decides, apply performs. Kiln's store is plan files
 * and yak journals, not GitHub labels. A suspended or still-running task
 * keeps its slot. At most one task is launched per tick, and only when
 * in-flight work is below maxConcurrent. A task that already has a run is
 * not launched again. A failed run stays failed.
 */

export type RunStatus = "alive" | "suspended" | "ok" | "failed";

export type TaskPhase =
  | "unapproved"
  | "blocked"
  | "ready"
  | "launching"
  | "running"
  | "suspended"
  | "ok"
  | "failed";

export interface ObservedGate {
  stepId: string;
  /** First line of the gate prompt. */
  prompt: string;
  /** A schema-valid answer, when one can be derived from the request. */
  answerJson?: string;
}

export interface ObservedRun {
  runId: string;
  checkout: string;
  status: RunStatus;
  gates: ObservedGate[];
}

export interface ObservedTask {
  planId: string;
  taskId: string;
  repo: Repo;
  title: string;
  dependsOn: string[];
  approved: boolean;
  /** A launching breadcrumb exists and no journal for this task is visible yet. */
  launching: boolean;
  breadcrumbPath?: string;
  run?: ObservedRun;
}

export interface ObservedPlan {
  planId: string;
  approved: boolean;
  error?: string;
}

export interface Observation {
  maxConcurrent: number;
  plans: ObservedPlan[];
  /** Plan order, then task order. plan() launches the first ready task. */
  tasks: ObservedTask[];
  /**
   * `${planId}/${contractId}` → the task id that publishes that contract
   * (the owner-repo task that does not depend on it).
   */
  publishers: Record<string, string>;
  /** Breadcrumbs whose journal has since appeared. Apply deletes the files. */
  breadcrumbsToClear: { path: string }[];
}

export type Action =
  | { type: "clear-breadcrumb"; path: string }
  | { type: "launch"; planId: string; taskId: string; repo: Repo };

/** One launch per tick, so a crash window covers a single spawn. */
const LAUNCHES_PER_TICK = 1;

export function publisherKey(planId: string, contractId: string): string {
  return `${planId}/${contractId}`;
}

/** The owner task that lands each contract: it lives in `owner` and does not depend on the contract. */
export function contractPublishers(planId: string, plan: Plan): Record<string, string> {
  const publishers: Record<string, string> = {};
  for (const contract of plan.contracts) {
    const found = plan.tasks.filter(
      (task) => task.repo === contract.owner && !task.dependsOn.includes(contract.id),
    );
    const publisher = found.length === 1 ? found[0] : undefined;
    if (publisher) publishers[publisherKey(planId, contract.id)] = publisher.id;
  }
  return publishers;
}

export function inFlightCount(observation: Observation): number {
  return observation.tasks.filter(
    (task) => task.launching || task.run?.status === "alive" || task.run?.status === "suspended",
  ).length;
}

export function taskPhase(task: ObservedTask, observation: Observation): TaskPhase {
  if (task.launching && !task.run) return "launching";
  if (task.run) return task.run.status === "alive" ? "running" : task.run.status;
  if (!task.approved) return "unapproved";
  return dependenciesMet(task, observation) ? "ready" : "blocked";
}

/**
 * A contract dependency is met when the task that publishes it finished ok.
 * A task dependency is met when that task's run finished ok.
 */
export function dependenciesMet(task: ObservedTask, observation: Observation): boolean {
  return task.dependsOn.every((dep) => {
    const publisherId = observation.publishers[publisherKey(task.planId, dep)];
    const upstreamId = publisherId ?? dep;
    const upstream = observation.tasks.find(
      (candidate) => candidate.planId === task.planId && candidate.taskId === upstreamId,
    );
    return upstream?.run?.status === "ok";
  });
}

export function plan(observation: Observation): Action[] {
  const actions: Action[] = observation.breadcrumbsToClear.map((crumb) => ({
    type: "clear-breadcrumb",
    path: crumb.path,
  }));

  if (inFlightCount(observation) >= observation.maxConcurrent) return actions;

  let launches = 0;
  for (const task of observation.tasks) {
    if (launches >= LAUNCHES_PER_TICK) break;
    if (taskPhase(task, observation) !== "ready") continue;
    actions.push({ type: "launch", planId: task.planId, taskId: task.taskId, repo: task.repo });
    launches += 1;
  }
  return actions;
}
