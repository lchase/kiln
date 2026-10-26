import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import {
  inFlightCount,
  isDone,
  isLanded,
  jobState,
  type Action,
  type Observation,
  type ObservedGate,
  type ObservedJob,
} from "./reconcile.js";
import type { JobState } from "./schemas.js";

export interface LaunchReport {
  jobId: string;
  repo: string;
  output: string;
}

export interface DeliverReport {
  jobId: string;
  repo: string;
  ok: boolean;
  detail: string;
}

export interface FindingsReport {
  jobId: string;
  status: "wrote" | "missing";
  path?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Absolute path of the yak CLI, from the installed package's `bin.yak`. */
export function yakCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@lchase/yak/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.yak;
  if (!relative) {
    throw new Error(`${pkgPath} has no "yak" bin.`);
  }
  return join(dirname(pkgPath), relative);
}

export function yakInvocation(subcommand: "resume" | "cancel", runId: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(yakCliPath())} ${subcommand} ${shellQuote(runId)}`;
}

/** One variant of the command that answers an open gate and continues the run. */
export function gateAnswerCommand(
  checkout: string,
  runId: string,
  gate: ObservedGate,
  choice: string,
  title?: string,
): string {
  const pendingDir = shellQuote(`.runs/${runId}/pending`);
  const answerFile = shellQuote(`.runs/${runId}/pending/${gate.stepId}.answer.json`);
  const field = gate.answerField ?? "decision";
  const answer = JSON.stringify({ [field]: choice });
  const titlePrefix = title ? `KILN_TASK_TITLE=${shellQuote(title)} ` : "";
  return `cd ${shellQuote(checkout)} && mkdir -p ${pendingDir} && printf '%s\\n' ${shellQuote(answer)} > ${answerFile} && ${titlePrefix}${yakInvocation("resume", runId)}`;
}

export type StatusState = JobState | "invalid";

export type StepPhase = "done" | "current" | "pending" | "failed";

export interface StepProgress {
  id: string;
  phase: StepPhase;
}

export interface StepEvent {
  t: "step.started" | "step.completed" | "step.failed";
  stepId: string;
  detail?: string;
}

/**
 * Mark a workflow's leaf steps from yak journal events.
 * A later `step.started` reopens a step that already completed (the next loop round).
 * Events whose id is not in the plan are ignored when the plan is non-empty,
 * so a loop container does not sit beside its body. An empty plan uses
 * first-seen event order.
 */
export function stepProgress(plan: string[], events: StepEvent[]): StepProgress[] {
  const order = [...plan];
  const phase = new Map<string, StepPhase>();
  for (const id of order) phase.set(id, "pending");
  for (const event of events) {
    if (!event.stepId) continue;
    if (!phase.has(event.stepId)) {
      if (plan.length > 0) continue;
      order.push(event.stepId);
      phase.set(event.stepId, "pending");
    }
    if (event.t === "step.started") phase.set(event.stepId, "current");
    else if (event.t === "step.completed") phase.set(event.stepId, "done");
    else if (event.t === "step.failed") phase.set(event.stepId, "failed");
  }
  return order.map((id) => ({ id, phase: phase.get(id) ?? "pending" }));
}

/** Detail of the latest step that failed and has not started or completed since. */
export function latestStepFailure(events: StepEvent[]): string | undefined {
  const settled = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.t === "step.started" || event.t === "step.completed") {
      settled.add(event.stepId);
      continue;
    }
    if (event.t === "step.failed" && !settled.has(event.stepId) && event.detail) return event.detail;
  }
  return undefined;
}

export interface StatusArtifactView {
  name: string;
  summary: string;
}

export interface StatusGateView {
  stepId: string;
  /** First line, the same text `kiln status` prints. */
  prompt: string;
  /** Full gate text yak stored, when the request has it. */
  rendered?: string;
  choices: string[];
  artifacts: StatusArtifactView[];
  reviews: StatusArtifactView[];
}

export interface StatusDependency {
  jobId: string;
  state: StatusState | "missing";
  /** Set when `kiln status` prints a blocked-on line for this dependency. */
  blockedDetail?: string;
}

/**
 * One job, as `kiln status` derives it. Nothing here is stored.
 * The CLI prints it; `kiln serve` renders the same object.
 */
export interface StatusJobView {
  jobId: string;
  title: string;
  repo: string;
  workflow: string;
  state: StatusState;
  dependsOn: StatusDependency[];
  stack: boolean;
  source?: { kind: string; ref: string };
  runId?: string;
  /** `yak/<run-id>` when status would print the branch (`done` or `in-review`). */
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  logPath?: string;
  specPath?: string;
  /** Absolute path of the approved findings file. Set for an investigation once that file exists. */
  findingsPath?: string;
  launchFailed: boolean;
  launchError?: string;
  deliveryError?: string;
  viewError?: string;
  invalidReason?: string;
  prPending: boolean;
  prClosedUnmerged: boolean;
  noReadableApproval: boolean;
  /** The cancel line status prints for a dead run, without the leading indent. */
  cancelCommand?: string;
  gates: StatusGateView[];
  canApprove: boolean;
  canReject: boolean;
  /** Leaf steps with phases taken from yak run events. Empty when the workflow has no steps. */
  steps: StepProgress[];
  /** Job file `createdAt`. */
  createdAt?: string;
  /** Yak `run.started` time. */
  startedAt?: string;
  /** Yak `run.finished` time. */
  finishedAt?: string;
  /** Last lines of the launch log. */
  logTail?: string;
  /** Worktree diff stat, or the build summary when the tree is clean. */
  diffSummary?: string;
  /** Latest open step failure, from a `step.failed` event. */
  failureDetail?: string;
}

export interface StatusView {
  jobs: StatusJobView[];
}

/**
 * Derived state for every job, or for one id.
 * Throws `No job <id>` when that id is not on disk, same as `kiln status`.
 */
export function statusView(observation: Observation, jobId?: string): StatusView {
  const selected = jobId ? observation.jobs.filter((job) => job.jobId === jobId) : observation.jobs;
  if (jobId && selected.length === 0) {
    throw new Error(`No job ${jobId}.`);
  }
  return { jobs: selected.map((job) => toStatusJob(job, observation)) };
}

export function renderStatus(view: StatusView): string {
  if (view.jobs.length === 0) return "no jobs\n";
  const lines: string[] = [];
  for (const job of view.jobs) {
    lines.push(statusHeader(job));
    if (job.state === "invalid") continue;
    for (const detail of statusDetails(job)) lines.push(`  ${detail}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Extra lines `kiln status` prints under the job header, without the indent. */
export function statusDetails(job: StatusJobView): string[] {
  const lines: string[] = [];
  if (job.source) lines.push(`source ${job.source.kind} ${job.source.ref}`);
  if (job.findingsPath) lines.push(`findings ${job.findingsPath}`);
  else if (job.workflow === INVESTIGATION_WORKFLOW && job.state === "done") lines.push("findings missing");
  if (job.prPending) lines.push("pull request not opened yet");
  if (job.state === "failed" && job.deliveryError) lines.push(job.deliveryError);
  if (job.state === "failed" && job.prClosedUnmerged && job.prNumber) {
    lines.push(`pull request #${job.prNumber} was closed without merging`);
  }
  if (job.viewError && (job.state === "in-review" || job.state === "done")) {
    lines.push(`could not read pull request: ${job.viewError}`);
  }
  if (job.state === "failed" && job.launchFailed && job.logPath) lines.push(`log ${job.logPath}`);
  if (job.state === "failed" && job.launchError) lines.push(job.launchError);
  if (job.noReadableApproval) lines.push("no readable approval decision");
  if (job.cancelCommand) lines.push(job.cancelCommand);
  if (job.state === "blocked") {
    for (const dep of job.dependsOn) {
      if (dep.blockedDetail) lines.push(dep.blockedDetail);
    }
  }
  if (job.state === "needs-human") {
    for (const gate of job.gates) {
      lines.push(`gate ${gate.stepId}: ${gate.prompt}`);
      if (gate.choices.includes("approve")) lines.push(`approve: kiln approve ${job.jobId}`);
      if (gate.choices.includes("reject")) lines.push(`reject: kiln reject ${job.jobId}`);
    }
  }
  return lines;
}

function statusHeader(job: StatusJobView): string {
  if (job.state === "invalid") return `${job.jobId}  invalid: ${job.invalidReason ?? "invalid"}`;
  const run = job.runId ? `  run ${job.runId}` : "";
  const branch = job.branch ? `  branch ${job.branch}` : "";
  const pr =
    job.prUrl && (job.state === "in-review" || job.state === "done" || job.state === "failed")
      ? `  pr ${job.prUrl}`
      : "";
  return `${job.jobId}  ${job.repo}  ${job.workflow}  ${job.state}${run}${branch}${pr}`;
}

function toStatusJob(job: ObservedJob, observation: Observation): StatusJobView {
  if (job.error) {
    return {
      jobId: job.jobId,
      title: job.title,
      repo: job.repo,
      workflow: job.workflow,
      state: "invalid",
      dependsOn: dependencyViews(job, observation),
      stack: job.stack === true,
      ...(job.source ? { source: { kind: job.source.kind, ref: job.source.ref } } : {}),
      ...(job.specPath ? { specPath: job.specPath } : {}),
      ...(job.logPath ? { logPath: job.logPath } : {}),
      ...(job.findingsPath ? { findingsPath: job.findingsPath } : {}),
      launchFailed: job.launchFailed,
      invalidReason: job.error,
      prPending: false,
      prClosedUnmerged: false,
      noReadableApproval: false,
      gates: [],
      canApprove: false,
      canReject: false,
      steps: progressFor(job),
      ...(job.createdAt ? { createdAt: job.createdAt } : {}),
      ...(job.logTail ? { logTail: job.logTail } : {}),
    };
  }

  const state = jobState(job, observation);
  const gates = state === "needs-human" && job.run ? job.run.gates.map(toGateView) : [];
  const prNumber = job.delivery?.prNumber;
  const runId = job.run?.runId;
  const showBranch = (state === "done" || state === "in-review") && runId !== undefined;
  const failureDetail = job.run?.stepEvents ? latestStepFailure(job.run.stepEvents) : undefined;
  return {
    jobId: job.jobId,
    title: job.title,
    repo: job.repo,
    workflow: job.workflow,
    state,
    dependsOn: dependencyViews(job, observation),
    stack: job.stack === true,
    ...(job.source ? { source: { kind: job.source.kind, ref: job.source.ref } } : {}),
    ...(runId ? { runId } : {}),
    ...(showBranch ? { branch: `yak/${runId}` } : {}),
    ...(job.delivery?.prUrl ? { prUrl: job.delivery.prUrl } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(job.logPath ? { logPath: job.logPath } : {}),
    ...(job.specPath ? { specPath: job.specPath } : {}),
    ...(job.findingsPath ? { findingsPath: job.findingsPath } : {}),
    launchFailed: job.launchFailed,
    ...(job.launchError ? { launchError: job.launchError } : {}),
    ...(job.delivery?.error ? { deliveryError: job.delivery.error } : {}),
    ...(job.delivery?.viewError ? { viewError: job.delivery.viewError } : {}),
    prPending: state === "in-review" && !prNumber,
    prClosedUnmerged: job.delivery?.prState === "CLOSED",
    noReadableApproval: state === "failed" && job.run?.status === "ok" && !job.run.gateDecision,
    ...(state === "dead" && job.run
      ? { cancelCommand: `fix: cd ${shellQuote(job.run.checkout)} && ${yakInvocation("cancel", job.run.runId)}` }
      : {}),
    gates,
    canApprove: gates.some((gate) => gate.choices.includes("approve")),
    canReject: gates.some((gate) => gate.choices.includes("reject")),
    steps: progressFor(job),
    ...(job.createdAt ? { createdAt: job.createdAt } : {}),
    ...(job.run?.startedAt ? { startedAt: job.run.startedAt } : {}),
    ...(job.run?.finishedAt ? { finishedAt: job.run.finishedAt } : {}),
    ...(job.logTail ? { logTail: job.logTail } : {}),
    ...(job.diffSummary ? { diffSummary: job.diffSummary } : {}),
    ...(failureDetail ? { failureDetail } : {}),
  };
}

function progressFor(job: ObservedJob): StepProgress[] {
  const plan = job.run?.stepPlan?.length ? job.run.stepPlan : (job.stepPlan ?? []);
  return stepProgress(plan, job.run?.stepEvents ?? []);
}

function toGateView(gate: ObservedGate): StatusGateView {
  const choices = gate.choices?.length ? gate.choices : ["approve", "reject"];
  return {
    stepId: gate.stepId,
    prompt: gate.prompt,
    ...(gate.rendered ? { rendered: gate.rendered } : {}),
    choices,
    artifacts: gate.artifacts ?? [],
    reviews: gate.reviews ?? [],
  };
}

function dependencyViews(job: ObservedJob, observation: Observation): StatusDependency[] {
  const reasons = blockReasons(job, observation);
  return job.dependsOn.map((dep) => {
    const upstream = observation.jobs.find((candidate) => candidate.jobId === dep);
    const state: StatusDependency["state"] = !upstream ? "missing" : upstream.error ? "invalid" : jobState(upstream, observation);
    const blockedDetail = reasons.find((reason) => reason.dep === dep)?.detail;
    return {
      jobId: dep,
      state,
      ...(blockedDetail ? { blockedDetail } : {}),
    };
  });
}

function blockReasons(job: ObservedJob, observation: Observation): { dep: string; detail: string }[] {
  const reasons: { dep: string; detail: string }[] = [];
  for (const dep of job.dependsOn) {
    const upstream = observation.jobs.find((candidate) => candidate.jobId === dep);
    if (!upstream) {
      reasons.push({ dep, detail: `blocked on missing job ${dep}` });
      continue;
    }
    if (job.stack) {
      if (!isLanded(upstream)) reasons.push({ dep, detail: `waiting for ${dep} to land` });
      continue;
    }
    if (isDone(upstream)) continue;
    const number = upstream.delivery?.prNumber;
    if (number && !upstream.delivery?.merged && upstream.delivery?.prState !== "CLOSED") {
      reasons.push({ dep, detail: `waiting for PR #${number} to merge` });
      continue;
    }
    if ((upstream.deliver ?? "local") === "pr" && isLanded(upstream)) {
      reasons.push({ dep, detail: `waiting for ${dep} to open a pull request` });
    }
  }
  return reasons;
}

export function renderTick(
  observation: Observation,
  actions: Action[],
  launches: LaunchReport[],
  delivers: DeliverReport[] = [],
  findings: FindingsReport[] = [],
): string {
  const lines = [`tick  inFlight=${inFlightCount(observation)}  maxConcurrent=${observation.maxConcurrent}`];
  for (const job of observation.jobs) {
    if (job.error) lines.push(`skip ${job.jobId} (invalid: ${job.error})`);
  }
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") lines.push(`clear breadcrumb ${action.path}`);
  }
  for (const deliver of delivers) {
    lines.push(
      deliver.ok
        ? `deliver ${deliver.jobId}  ${deliver.repo}  ${deliver.detail}`
        : `deliver ${deliver.jobId}  ${deliver.repo}  failed: ${deliver.detail}`,
    );
  }
  for (const recorded of findings) {
    lines.push(
      recorded.status === "wrote"
        ? `findings ${recorded.jobId}  ${recorded.path}`
        : `findings ${recorded.jobId}  missing`,
    );
  }
  for (const launch of launches) {
    lines.push(`launch ${launch.jobId}  ${launch.repo}`);
    for (const line of launch.output.split("\n")) {
      if (line.trim()) lines.push(`  ${line}`);
    }
  }
  if (
    !actions.some((action) => action.type === "launch") &&
    launches.length === 0 &&
    delivers.length === 0 &&
    findings.length === 0
  ) {
    lines.push("nothing to launch");
  }
  return `${lines.join("\n")}\n`;
}
