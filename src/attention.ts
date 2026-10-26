import { createHash } from "node:crypto";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import type { StatusJobView, StatusState, StatusView } from "./report.js";

/**
 * Attention order for `kiln serve`. Built from the same derived jobs as
 * `kiln status`. The console renders this and does not classify jobs again.
 *
 * Needs you: a person has to act, or a run is broken, or a pull request is open.
 * In flight: work is moving, waiting to launch, or waiting on another job.
 * Done recently: finished or rejected, collapsed in the page.
 */

const NEEDS_YOU: readonly StatusState[] = ["needs-human", "dead", "failed", "in-review", "invalid"];
const IN_FLIGHT: readonly StatusState[] = ["running", "approved", "queued", "blocked"];
const SETTLED: readonly StatusState[] = ["done", "rejected"];

export interface AttentionItem {
  job: StatusJobView;
  /** One line, why this job is in this section. */
  reason: string;
  /** Failed and dead jobs. Launch error, step failure, and the log tail. */
  errorTail?: string;
  /** Investigation gate body, the findings markdown yak rendered. */
  findings?: string;
  /** Failed or dead: the console posts Retry. */
  retry: boolean;
  /** ISO time the run started, or the job was created when it has not. */
  since?: string;
}

export interface GraphNode {
  jobId: string;
  title: string;
  repo: string;
  state: StatusState | "missing";
}

export interface GraphEdge {
  /** Upstream job id (`dependsOn`). */
  from: string;
  /** Dependent job id. */
  to: string;
  /** The dependent was added with `--stack`. */
  stack: boolean;
}

export interface AttentionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AttentionView {
  needsYou: AttentionItem[];
  inFlight: AttentionItem[];
  doneRecently: AttentionItem[];
  graph: AttentionGraph;
  needsYouCount: number;
  /** Changes when membership, state, reason, or step phase changes. Not when a log tail grows. */
  revision: string;
}

export interface KilnStatus extends StatusView {
  attention: AttentionView;
}

export function buildAttention(jobs: StatusJobView[]): AttentionView {
  const indexed = jobs.map((job, index) => ({ job, index }));
  const needsYou = indexed
    .filter((entry) => NEEDS_YOU.includes(entry.job.state))
    .sort((left, right) => byRank(NEEDS_YOU, left, right))
    .map((entry) => toItem(entry.job));
  const inFlight = indexed
    .filter((entry) => IN_FLIGHT.includes(entry.job.state))
    .sort((left, right) => byRank(IN_FLIGHT, left, right))
    .map((entry) => toItem(entry.job));
  const doneRecently = indexed
    .filter((entry) => SETTLED.includes(entry.job.state))
    .sort(byRecent)
    .map((entry) => toItem(entry.job));
  const graph = attentionGraph(jobs);
  const revision = attentionRevision(needsYou, inFlight, doneRecently, graph);
  return {
    needsYou,
    inFlight,
    doneRecently,
    graph,
    needsYouCount: needsYou.length,
    revision,
  };
}

export function attentionGraph(jobs: StatusJobView[]): AttentionGraph {
  const nodes: GraphNode[] = jobs.map((job) => ({
    jobId: job.jobId,
    title: job.title || job.jobId,
    repo: job.repo,
    state: job.state,
  }));
  const known = new Set(nodes.map((node) => node.jobId));
  const edges: GraphEdge[] = [];
  for (const job of jobs) {
    for (const dep of job.dependsOn) {
      if (!known.has(dep.jobId)) {
        known.add(dep.jobId);
        nodes.push({
          jobId: dep.jobId,
          title: dep.jobId,
          repo: "",
          state: dep.state,
        });
      }
      edges.push({ from: dep.jobId, to: job.jobId, stack: job.stack });
    }
  }
  return { nodes, edges };
}

function toItem(job: StatusJobView): AttentionItem {
  const tail = job.state === "failed" || job.state === "dead" ? errorTail(job) : undefined;
  const findings = findingsOf(job);
  const since = job.startedAt ?? job.createdAt;
  return {
    job,
    reason: attentionReason(job, tail),
    ...(tail ? { errorTail: tail } : {}),
    ...(findings ? { findings } : {}),
    retry: job.state === "failed" || job.state === "dead",
    ...(since ? { since } : {}),
  };
}

export function attentionReason(job: StatusJobView, tail = errorTail(job)): string {
  switch (job.state) {
    case "needs-human": {
      const question = gateQuestion(job);
      return question ? `Gate: ${oneLine(question)}` : "Waiting on a person";
    }
    case "dead":
      return "Run died before it finished";
    case "failed": {
      const why = firstLine(job.launchError) || firstLine(job.deliveryError) || firstLine(job.failureDetail) || firstLine(tail) || "Run failed";
      return `Failed: ${oneLine(why)}`;
    }
    case "in-review":
      if (job.prNumber) return `Pull request #${job.prNumber} is open`;
      if (job.prPending) return "Pull request not opened yet";
      return "In review";
    case "invalid":
      return job.invalidReason ? `Invalid: ${oneLine(job.invalidReason)}` : "Job file is invalid";
    case "blocked":
      return oneLine(waitingOn(job));
    case "running": {
      const current = job.steps.find((step) => step.phase === "current" || step.phase === "failed");
      return current ? `Running ${current.id}` : "Running";
    }
    case "approved":
      return "Approved, still finishing";
    case "queued":
      return "Queued, ready to launch";
    case "done":
      return job.prUrl ? "Merged" : "Done";
    case "rejected":
      return "Rejected";
    default:
      return job.state;
  }
}

function waitingOn(job: StatusJobView): string {
  const details = job.dependsOn.map((dep) => dep.blockedDetail).filter((detail): detail is string => Boolean(detail));
  if (details.length > 0) return details.join("; ");
  if (job.dependsOn.length === 0) return "Blocked";
  return `Waiting on ${job.dependsOn.map((dep) => `${dep.jobId} (${dep.state})`).join(", ")}`;
}

function gateQuestion(job: StatusJobView): string | undefined {
  const gate = job.gates[0];
  if (!gate) return undefined;
  const first = gate.rendered?.split("\n")[0]?.trim();
  return first || gate.prompt;
}

function findingsOf(job: StatusJobView): string | undefined {
  if (job.state !== "needs-human" || job.workflow !== INVESTIGATION_WORKFLOW) return undefined;
  const rendered = job.gates.map((gate) => gate.rendered).find((text) => text && text.includes("\n"));
  if (!rendered) return undefined;
  const body = rendered.split("\n").slice(1).join("\n").trim();
  return body || undefined;
}

function errorTail(job: StatusJobView): string | undefined {
  const parts: string[] = [];
  if (job.launchError?.trim()) parts.push(job.launchError.trim());
  if (job.deliveryError?.trim()) parts.push(job.deliveryError.trim());
  if (job.failureDetail?.trim()) parts.push(job.failureDetail.trim());
  if (job.prClosedUnmerged && job.prNumber) {
    parts.push(`Pull request #${job.prNumber} was closed without merging`);
  }
  if (job.noReadableApproval) parts.push("No readable approval decision");
  if (job.logTail?.trim() && !parts.includes(job.logTail.trim())) parts.push(job.logTail.trim());
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function byRank(
  order: readonly StatusState[],
  left: { job: StatusJobView; index: number },
  right: { job: StatusJobView; index: number },
): number {
  const rank = order.indexOf(left.job.state) - order.indexOf(right.job.state);
  if (rank !== 0) return rank;
  return left.index - right.index;
}

function byRecent(
  left: { job: StatusJobView; index: number },
  right: { job: StatusJobView; index: number },
): number {
  const leftAt = left.job.finishedAt ?? "";
  const rightAt = right.job.finishedAt ?? "";
  if (leftAt !== rightAt) {
    if (!leftAt) return 1;
    if (!rightAt) return -1;
    return rightAt < leftAt ? -1 : 1;
  }
  return right.index - left.index;
}

function attentionRevision(
  needsYou: AttentionItem[],
  inFlight: AttentionItem[],
  doneRecently: AttentionItem[],
  graph: AttentionGraph,
): string {
  const body = JSON.stringify({
    needsYou: needsYou.map((item) => [
      item.job.jobId,
      item.job.state,
      item.reason,
      item.job.attemptCount,
      item.job.lastFailureReason ?? "",
      item.job.nextRetryAt ?? "",
    ]),
    inFlight: inFlight.map((item) => [
      item.job.jobId,
      item.job.state,
      item.reason,
      item.job.steps.map((step) => `${step.id}:${step.phase}`).join(","),
    ]),
    doneRecently: doneRecently.map((item) => [item.job.jobId, item.job.state]),
    edges: graph.edges.map((edge) => [edge.from, edge.to, edge.stack]),
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function oneLine(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line?.trim();
}
