import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { buildAttention, type KilnStatus } from "./attention.js";
import type { LoadedKilnConfig } from "./config.js";
import {
  clearLaunchError,
  deliverJob,
  readDelivery,
  readLaunchError,
  resolveLaunchBase,
  writeDelivery,
  writeLaunchError,
  isMerged,
} from "./delivery.js";
import {
  feedbackSpec,
  openFeedbackRound,
  planFeedback,
  readFeedbackLedger,
  writeFeedbackLedger,
  type FeedbackLedger,
  type PullRequestFeedback,
} from "./feedback.js";
import {
  appendInvestigationFindings,
  existingFindingsPath,
  findingsFilePath,
  INVESTIGATION_WORKFLOW,
  readFindingsMarkdown,
  writeFindings,
} from "./findings.js";
import { defaultHost, type AgentStart, type KilnHost, type PullRequestState } from "./host.js";
import { readJobSpec, resolveJobSpec } from "./jobs.js";
import { jobBasename, packageRoot } from "./paths.js";
import {
  decide,
  isLanded,
  jobState,
  type Observation,
  type ObservedArtifact,
  type ObservedGate,
  type ObservedJob,
  type ObservedRun,
  type RunStatus,
} from "./reconcile.js";
import {
  fileMtimeMs,
  isPidAlive,
  readAttemptLedger,
  recoverRuns,
  resetAttemptLedger,
  type AttemptLedger,
  type ReliabilityNote,
} from "./reliability.js";
import {
  gateAnswerCommand,
  renderStatus,
  renderTick,
  statusView,
  yakCliPath,
  sandboxFailureDetail,
  type DeliverReport,
  type FindingsReport,
  type LaunchReport,
  type StepEvent,
} from "./report.js";
import {
  AGENT_SANDBOX_IMAGE,
  injectAgentSandbox,
  jobIsSandboxed,
  probeSandboxEnvironment,
  PROXY_SANDBOX_IMAGE,
  requiredSandboxImages,
  resolveSandbox,
  sandboxIsEnabled,
  sandboxPreflight,
  sandboxPreflightFor,
  type SandboxFacts,
} from "./sandbox.js";
import { JobSchema, type Job } from "./schemas.js";
import { leafStepIds, materializeWorkflow, workflowInputs, workflowNeedsTestCommand, workflowStepPlan } from "./workflow.js";

interface JournalEvent {
  t: string;
  at?: string;
  tag?: string;
  status?: string;
  stepId?: string;
  pid?: number;
  reason?: string;
  failure?: { detail?: unknown; reason?: unknown };
}

interface Breadcrumb {
  path: string;
  jobId: string;
  pid: number;
  logPath: string;
}

interface World {
  observation: Observation;
  jobs: Map<string, Job>;
}

const TAG_PREFIX = "kiln:";

export function jobTag(jobId: string): string {
  return `${TAG_PREFIX}${jobId}`;
}

export function parseJobTag(tag: string): string | undefined {
  if (!tag.startsWith(TAG_PREFIX)) return undefined;
  const id = tag.slice(TAG_PREFIX.length);
  if (!id || id.includes("/")) return undefined;
  return id;
}

/** The derived view `kiln status` prints and `kiln serve` renders. */
export function readStatus(config: LoadedKilnConfig, jobId?: string, host: KilnHost = defaultHost()): KilnStatus {
  const view = statusView(observe(config, host).observation, jobId);
  return { ...view, attention: buildAttention(view.jobs) };
}

export interface TickOptions {
  /**
   * Process start (`kiln tick`, or `kiln serve` before it listens).
   * A run that still looks in progress but whose process is gone is `orphaned`.
   * Later ticks in the same serve process pass false so a crash stays `crashed`.
   * Default true.
   */
  startup?: boolean;
  /** Clock for stall detection and retry backoff. Defaults to the current time. */
  now?: Date;
  /** Docker, image, yak, and credential facts. Tests pass this; tick probes otherwise. */
  sandboxFacts?: SandboxFacts;
}

export function runStatus(config: LoadedKilnConfig, jobId?: string, host: KilnHost = defaultHost()): string {
  return renderStatus(readStatus(config, jobId, host));
}

export function runTick(
  config: LoadedKilnConfig,
  host: KilnHost = defaultHost(),
  options: TickOptions = {},
): string {
  const startup = options.startup ?? true;
  const now = options.now ?? new Date();
  return withTickLock(config.kilnDir, () => {
    const notes = recoverRuns(config, observe(config, host).observation.jobs, { startup, now });
    const facts = sandboxIsEnabled(config)
      ? (options.sandboxFacts ?? probeSandboxEnvironment(process.env, requiredSandboxImages(config)))
      : undefined;
    const midway = observe(config, host);
    bindOpenFixRuns(config, midway);
    const published = publishReadyFixes(config, host, midway);
    const world = observe(config, host);
    const feedbackNotes = watchPullRequests(config, world, host);
    const actions = decide(world.observation, now);
    const body = apply(config, world, actions, host, notes, now, [...published, ...feedbackNotes], facts);
    const problem = facts ? sandboxPreflight(config, facts) : undefined;
    return problem ? `${problem}\n${body}` : body;
  });
}

/** Startup pass shared by `kiln tick` (via `runTick`) and `kiln serve`. Idempotent. */
export function startupRecovery(config: LoadedKilnConfig, host: KilnHost = defaultHost(), now = new Date()): void {
  withTickLock(config.kilnDir, () => {
    recoverRuns(config, observe(config, host).observation.jobs, { startup: true, now });
  });
}

export function answerJob(
  config: LoadedKilnConfig,
  jobId: string,
  choice: "approve" | "reject",
  host: KilnHost = defaultHost(),
): string {
  const world = observe(config, host);
  const job = world.observation.jobs.find((candidate) => candidate.jobId === jobId);
  if (!job) {
    throw new Error(`No job ${jobId}.`);
  }
  if (job.error) {
    throw new Error(`Job ${jobId} is invalid: ${job.error}`);
  }
  const state = jobState(job, world.observation);
  if (state !== "needs-human" || !job.run) {
    throw new Error(`Job ${jobId} is ${state}, not needs-human.`);
  }
  const gate = gateForChoice(job.run.gates, choice);
  if (!gate) {
    throw new Error(`Job ${jobId} has no open gate that accepts ${choice}.`);
  }
  const command = gateAnswerCommand(job.run.checkout, job.run.runId, gate, choice, job.run.title ?? job.title);
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(output.trim() || `Could not ${choice} job ${jobId}.`);
  }
  if (choice === "approve") {
    recordInvestigationFindings(config, observe(config, host), jobId);
  }
  return output.endsWith("\n") || output.length === 0 ? output : `${output}\n`;
}

/**
 * Run a failed or dead job again. The board Retry button and `kiln retry`
 * both call this.
 * A landed job whose only failure is opening the pull request is handed to
 * the same deliver path tick uses. Everything else is a new `yak run`, the
 * same launch tick uses. The attempt ledger is cleared either way, and the
 * current run id is ignored so a dead job is not stuck on the old journal.
 * A dead journal is cancelled first.
 */
export function retryJob(config: LoadedKilnConfig, jobId: string, host: KilnHost = defaultHost()): string {
  return withTickLock(config.kilnDir, () => {
    const world = observe(config, host);
    const observed = world.observation.jobs.find((candidate) => candidate.jobId === jobId);
    if (!observed) throw new Error(`No job ${jobId}.`);
    if (observed.error) throw new Error(`Job ${jobId} is invalid: ${observed.error}`);
    const state = jobState(observed, world.observation);
    if (state !== "failed" && state !== "dead") {
      throw new Error(`Job ${jobId} is ${state}, not failed or dead.`);
    }
    const job = world.jobs.get(jobId);
    if (!job) throw new Error(`No job ${jobId}.`);
    const crumb = readBreadcrumbs(config.kilnDir).find((candidate) => candidate.jobId === jobId);
    if (crumb && pidAlive(crumb.pid)) {
      throw new Error(`Job ${jobId} is already launching.`);
    }
    const cleared = observed.attemptCount ?? 0;
    resetAttemptLedger(config.kilnDir, jobId, observed.run?.runId);
    rmSync(breadcrumbPath(config.kilnDir, jobId), { force: true });
    clearLaunchError(config.kilnDir, jobId);
    const noun = cleared === 1 ? "attempt" : "attempts";
    const clearedLine = `cleared ${cleared} ${noun}\n`;
    if (shouldRedeliver(observed)) {
      const report = deliverObserved(config, world, jobId, host);
      if (!report.ok) throw new Error(report.detail);
      const detail = report.detail.endsWith("\n") || report.detail.length === 0 ? report.detail : `${report.detail}\n`;
      return `retry ${jobId}  ${job.repo}\n${clearedLine}${detail}`;
    }
    if (state === "dead" && observed.run) {
      try {
        spawnSync(process.execPath, [yakCliPath(), "cancel", observed.run.runId], {
          cwd: observed.run.checkout,
          encoding: "utf8",
          timeout: 20_000,
        });
      } catch {
        // Cancel is the same cleanup status prints. The new run still supersedes the journal.
      }
    }
    const logPath = join(config.kilnDir, "logs", `${jobBasename(job.id)}.log`);
    if (existsSync(logPath)) writeFileSync(logPath, "");
    const report = launchJob(config, world, job, host);
    const output = report.output.endsWith("\n") || report.output.length === 0 ? report.output : `${report.output}\n`;
    return `retry ${report.jobId}  ${report.repo}\n${clearedLine}${output}`;
  });
}

function shouldRedeliver(job: ObservedJob): boolean {
  if (!isLanded(job)) return false;
  if (job.delivery?.prState === "CLOSED") return false;
  return Boolean(job.delivery?.error) && !job.delivery?.prNumber;
}

function gateForChoice(gates: ObservedGate[], choice: "approve" | "reject"): ObservedGate | undefined {
  return (
    gates.find((gate) => gate.choices?.includes(choice)) ??
    gates.find((gate) => !gate.choices?.length)
  );
}

function observe(config: LoadedKilnConfig, host: KilnHost): World {
  const loaded = loadJobs(config);
  const runs = scanRuns(config);
  const breadcrumbs = readBreadcrumbs(config.kilnDir);
  const jobs: ObservedJob[] = [];
  const records = new Map<string, Job>();
  const breadcrumbsToClear: Observation["breadcrumbsToClear"] = [];

  const ordered = [...loaded].sort((left, right) => {
    const byTime = (left.job?.createdAt ?? "").localeCompare(right.job?.createdAt ?? "");
    if (byTime !== 0) return byTime;
    return left.meta.jobId.localeCompare(right.meta.jobId);
  });

  for (const entry of ordered) {
    if (entry.job) records.set(entry.job.id, entry.job);
    const tag = jobTag(entry.meta.jobId);
    const ledgerResult = readAttemptLedger(config.kilnDir, entry.meta.jobId);
    const ledger = ledgerResult && ledgerResult !== "corrupt" ? ledgerResult : undefined;
    const feedbackResult = readFeedbackLedger(config.kilnDir, entry.meta.jobId);
    const feedback = feedbackResult && feedbackResult !== "corrupt" ? feedbackResult : undefined;
    const repoKnown = entry.job ? Boolean(config.repos[entry.job.repo]) : false;
    const repo = entry.job ? config.repos[entry.job.repo] : undefined;
    const deliver = repo?.deliver ?? "local";
    const deliveryRecord =
      entry.job && repo && deliver === "pr" ? readDelivery(config.kilnDir, entry.job.id) : undefined;
    const picked = selectJobRun(runs.get(tag) ?? [], ledger, feedback, deliveryRecord?.runId);
    const run = picked.run;
    const crumb = breadcrumbs.find((candidate) => candidate.jobId === entry.meta.jobId);
    if (crumb && run && !picked.retired) breadcrumbsToClear.push({ path: crumb.path });
    const childAlive = crumb ? pidAlive(crumb.pid) : false;
    const hideBase = picked.fixInProgress && !run;
    const launching = Boolean(crumb) && childAlive && (hideBase || !run || picked.retired);
    const launchFailed = Boolean(crumb) && !childAlive && (hideBase || !run || picked.retired);
    const repoError =
      entry.job && !repoKnown ? `Repo ${entry.job.repo} is not registered.` : undefined;
    const deliveryRunId = picked.fixInProgress ? deliveryRecord?.runId : run?.runId;
    const delivery =
      entry.job && repo && deliver === "pr"
        ? observedDelivery(config.kilnDir, host, repo.path, entry.job.id, deliveryRunId)
        : undefined;
    const launchError = entry.job && !run ? readLaunchError(config.kilnDir, entry.job.id) : undefined;
    const stackError =
      entry.job?.stack && (entry.job.dependsOn?.length ?? 0) !== 1
        ? "stack needs exactly one dependency."
        : undefined;
    const logPath = crumb?.logPath || existingLog(config.kilnDir, entry.meta.jobId);
    if (run && logPath) run.activityMs = later(run.activityMs, fileMtimeMs(logPath));
    const launchActivityMs = later(crumb ? fileMtimeMs(crumb.path) : undefined, logPath ? fileMtimeMs(logPath) : undefined);
    const attemptCount = ledger?.attempts.length ?? 0;
    const lastFailure = ledger?.attempts.at(-1);
    const exhausted =
      attemptCount >= config.maxAttempts &&
      attemptCount > 0 &&
      !launching &&
      (picked.retired || !run || run.status === "dead" || run.status === "failed");
    const specPath = entry.job ? resolveJobSpec(config.kilnDir, entry.job.spec) : undefined;
    const findingsPath =
      entry.job?.workflow === INVESTIGATION_WORKFLOW
        ? existingFindingsPath(config.kilnDir, entry.job.id)
        : undefined;
    const logTail = readLogTail(logPath);
    const stepPlan = entry.job ? workflowStepPlan(entry.job.workflow) : undefined;
    const diffSummary =
      run &&
      run.status === "suspended" &&
      entry.job?.workflow !== INVESTIGATION_WORKFLOW
        ? readDiffSummary(run.checkout, run.runId)
        : undefined;
    jobs.push({
      jobId: entry.meta.jobId,
      repo: entry.job?.repo ?? "",
      workflow: entry.job?.workflow ?? "",
      title: entry.job?.title ?? "",
      dependsOn: entry.job?.dependsOn ?? [],
      ...(entry.job?.source ? { source: entry.job.source } : {}),
      ...(specPath ? { specPath } : {}),
      deliver,
      ...(entry.job?.stack ? { stack: true } : {}),
      ...(delivery ? { delivery } : {}),
      ...(findingsPath ? { findingsPath } : {}),
      launching,
      launchFailed,
      ...(launchError ? { launchError } : {}),
      ...(crumb ? { launchPid: crumb.pid } : {}),
      ...(launchActivityMs !== undefined ? { launchActivityMs } : {}),
      ...(logPath ? { logPath } : {}),
      ...(entry.job?.createdAt ? { createdAt: entry.job.createdAt } : {}),
      ...(logTail ? { logTail } : {}),
      ...(diffSummary ? { diffSummary } : {}),
      ...(stepPlan && stepPlan.length > 0 ? { stepPlan } : {}),
      ...(run ? { run } : {}),
      attemptCount,
      ...(lastFailure ? { lastFailureReason: lastFailure.reason } : {}),
      ...(ledger?.nextRetryAt && !exhausted ? { nextRetryAt: ledger.nextRetryAt } : {}),
      ...(exhausted ? { retriesExhausted: true } : {}),
      ...(picked.retired ? { runRetired: true } : {}),
      ...(ledgerResult === "corrupt" ? { ledgerError: "attempt ledger is unreadable" } : {}),
      ...(entry.job ? { sandboxed: jobIsSandboxed(config, entry.job.id, entry.job.workflow) } : {}),
      ...(feedback?.rounds.length ? { feedbackRounds: feedback.rounds } : {}),
      ...(feedback?.exhausted ? { feedbackExhausted: true } : {}),
      ...(feedback?.ambiguous ? { feedbackAmbiguous: true } : {}),
      ...(feedbackResult === "corrupt" ? { feedbackLedgerError: "feedback ledger is unreadable" } : {}),
      ...(picked.fixInProgress ? { fixInProgress: true } : {}),
      ...(picked.fixAwaitingPublish ? { fixAwaitingPublish: true } : {}),
      ...(entry.meta.error || repoError || stackError
        ? { error: entry.meta.error ?? repoError ?? stackError }
        : {}),
    });
  }

  return {
    observation: {
      maxConcurrent: config.maxConcurrent,
      maxAttempts: config.maxAttempts,
      jobs,
      breadcrumbsToClear,
    },
    jobs: records,
  };
}

function apply(
  config: LoadedKilnConfig,
  world: World,
  actions: ReturnType<typeof decide>,
  host: KilnHost,
  notes: ReliabilityNote[] = [],
  now = new Date(),
  feedbackNotes: string[] = [],
  sandboxFacts?: SandboxFacts,
): string {
  const launches: LaunchReport[] = [];
  const delivers: DeliverReport[] = [];
  const findings: FindingsReport[] = [];
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") {
      rmSync(action.path, { force: true });
      continue;
    }
    if (action.type === "deliver") {
      delivers.push(deliverObserved(config, world, action.jobId, host));
      continue;
    }
    if (action.type === "record-findings") {
      const recorded = recordInvestigationFindings(config, world, action.jobId);
      if (recorded.status !== "skip") findings.push(recorded);
      continue;
    }
    if (action.type === "mark-feedback") {
      markFeedback(config.kilnDir, action.jobId, action.reason);
      feedbackNotes.push(`${action.reason} ${action.jobId}`);
      continue;
    }
    if (action.type === "start-fix") {
      const job = world.jobs.get(action.jobId);
      if (!job) {
        throw new Error(`Tick planned a fix for ${action.jobId}, which is not in the observed jobs.`);
      }
      const blocked = sandboxBlock(config, "fix", sandboxFacts);
      if (blocked) {
        feedbackNotes.push(`fix ${action.jobId} not started\n${blocked}`);
        continue;
      }
      const report = startFix(config, world, job, host, now, sandboxFacts);
      launches.push({ ...report, kind: "fix" });
      continue;
    }
    const job = world.jobs.get(action.jobId);
    if (!job) {
      throw new Error(`Tick planned a launch for ${action.jobId}, which is not in the observed jobs.`);
    }
    const report = launchJob(config, world, job, host, sandboxFacts);
    launches.push(action.type === "retry" ? { ...report, retry: true } : report);
  }
  return renderTick(world.observation, actions, launches, delivers, findings, notes, feedbackNotes);
}

/**
 * Copy an approved investigation's markdown into `<kilnDir>/findings`.
 * A file that is already present is left as it is. A missing or incomplete
 * artifact is reported and does not fail the tick.
 */
function recordInvestigationFindings(
  config: LoadedKilnConfig,
  world: World,
  jobId: string,
): FindingsReport | { status: "skip"; jobId: string } {
  const job = world.jobs.get(jobId);
  const observed = world.observation.jobs.find((candidate) => candidate.jobId === jobId);
  if (!job || job.workflow !== INVESTIGATION_WORKFLOW || !observed?.run || !isLanded(observed)) {
    return { status: "skip", jobId };
  }
  if (observed.findingsPath) return { status: "skip", jobId };
  const markdown = readFindingsMarkdown(observed.run.checkout, observed.run.runId);
  if (!markdown) return { status: "missing", jobId };
  const path = writeFindings(config.kilnDir, job.id, markdown);
  return { status: "wrote", jobId, path };
}

function deliverObserved(
  config: LoadedKilnConfig,
  world: World,
  jobId: string,
  host: KilnHost,
): DeliverReport {
  const job = world.jobs.get(jobId);
  const observed = world.observation.jobs.find((candidate) => candidate.jobId === jobId);
  const repo = job ? config.repos[job.repo] : undefined;
  if (!job || !observed?.run || !repo) {
    const detail = `Job ${jobId} is not ready to open a pull request.`;
    return { jobId, repo: job?.repo ?? "", ok: false, detail };
  }
  try {
    const baseBranch = pullRequestBase(world, job, repo, host);
    const outcome = deliverJob({
      config,
      job,
      checkout: repo.path,
      runId: observed.run.runId,
      baseBranch,
      host,
    });
    return { jobId, repo: job.repo, ok: outcome.ok, detail: outcome.detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeDelivery(config.kilnDir, {
      jobId,
      runId: observed.run.runId,
      branch: `yak/${observed.run.runId}`,
      base: repo.base ?? "unknown",
      pushed: false,
      error: message,
    });
    return { jobId, repo: job.repo, ok: false, detail: message };
  }
}

/** Stacked jobs target the upstream branch. Everyone else targets the repo base. */
function pullRequestBase(
  world: World,
  job: Job,
  repo: { path: string; base?: string },
  host: KilnHost,
): string {
  if (job.stack) {
    const branch = upstreamBranch(world, job);
    if (!branch) {
      throw new Error(`Job ${job.id} is stacked but its upstream has no branch to target.`);
    }
    return branch;
  }
  if (repo.base) return repo.base;
  host.git.fetch(repo.path);
  return host.git.defaultBranch(repo.path);
}

function assertStackTarget(world: World, job: Job): void {
  if (!job.stack) return;
  const upstreamId = job.dependsOn?.[0];
  if (!upstreamId) return;
  const upstream = world.jobs.get(upstreamId);
  if (upstream?.workflow !== INVESTIGATION_WORKFLOW) return;
  throw new Error(
    `stack cannot target investigation job ${upstream.id}. An investigation does not land a branch.`,
  );
}

/** Spec text for this launch. Investigation dependencies append their findings. */
function specHandedToYak(config: LoadedKilnConfig, world: World, job: Job): string {
  const base = readJobSpec(config.kilnDir, job);
  const sections: { title: string; markdown: string }[] = [];
  for (const depId of job.dependsOn ?? []) {
    const dep = world.jobs.get(depId);
    if (!dep || dep.workflow !== INVESTIGATION_WORKFLOW) continue;
    const path = findingsFilePath(config.kilnDir, dep.id);
    if (!existsSync(path)) {
      throw new Error(
        `Job ${job.id} depends on investigation ${dep.id} (${dep.title}), which has no findings file at ${path}.`,
      );
    }
    sections.push({ title: dep.title, markdown: readFileSync(path, "utf8") });
  }
  return appendInvestigationFindings(base, sections);
}

function upstreamBranch(world: World, job: Job): string | undefined {
  const upstreamId = job.dependsOn?.[0];
  if (!upstreamId) return undefined;
  const upstream = world.observation.jobs.find((candidate) => candidate.jobId === upstreamId);
  if (!upstream?.run) return undefined;
  return upstream.delivery?.branch ?? `yak/${upstream.run.runId}`;
}

function observedDelivery(
  kilnDir: string,
  host: KilnHost,
  checkout: string,
  jobId: string,
  runId: string | undefined,
): ObservedJob["delivery"] | undefined {
  const record = readDelivery(kilnDir, jobId);
  if (!record) return undefined;
  if (runId && record.runId !== runId) return undefined;
  let prState: PullRequestState | undefined;
  let merged = false;
  let viewError: string | undefined;
  if (record.prNumber) {
    try {
      const viewed = host.github.view(checkout, record.prNumber);
      prState = viewed.state;
      merged = isMerged(viewed);
    } catch (error) {
      viewError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    branch: record.branch,
    ...(record.prNumber ? { prNumber: record.prNumber } : {}),
    ...(record.prUrl ? { prUrl: record.prUrl } : {}),
    merged,
    ...(prState ? { prState } : {}),
    ...(record.error && !record.prNumber ? { error: record.error } : {}),
    ...(viewError ? { viewError } : {}),
  };
}

/**
 * Attach a fix run id to an open round once its journal exists.
 * A fix run that the attempt ledger has already recorded is replaced by a
 * newer journal, so a retry does not stay pointed at the failed run.
 */
function bindOpenFixRuns(config: LoadedKilnConfig, world: World): void {
  const runs = scanRuns(config);
  for (const job of world.observation.jobs) {
    const ledger = readFeedbackLedger(config.kilnDir, job.jobId);
    if (!ledger || ledger === "corrupt") continue;
    const open = openFeedbackRound(ledger);
    if (!open) continue;
    const attempts = readAttemptLedger(config.kilnDir, job.jobId);
    const retired = new Set<string>();
    if (attempts && attempts !== "corrupt") {
      for (const id of attempts.ignoredRunIds ?? []) retired.add(id);
      for (const attempt of attempts.attempts) {
        if (attempt.runId) retired.add(attempt.runId);
      }
    }
    if (open.fixRunId && !retired.has(open.fixRunId)) continue;
    const baseRunId = readDelivery(config.kilnDir, job.jobId)?.runId;
    const settled = new Set(
      ledger.rounds.flatMap((round) =>
        (round.outcome === "pushed" || round.outcome === "fixed") && round.fixRunId ? [round.fixRunId] : [],
      ),
    );
    const candidates = (runs.get(jobTag(job.jobId)) ?? []).filter((run) => {
      if (run.runId === baseRunId || settled.has(run.runId) || retired.has(run.runId)) return false;
      return true;
    });
    candidates.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0));
    const next = candidates[0];
    if (!next) continue;
    open.fixRunId = next.runId;
    writeFeedbackLedger(config.kilnDir, ledger);
  }
}

/**
 * Fast-forward the open pull request branch to a fix run that finished ok.
 * A missing branch or a history that is not a descendant is ambiguous.
 * A rejected push that is not a fast-forward is ambiguous. Any other push
 * error is left for the next tick. Kiln does not force-push.
 */
function publishReadyFixes(config: LoadedKilnConfig, host: KilnHost, world: World): string[] {
  const notes: string[] = [];
  for (const job of world.observation.jobs) {
    if (!job.fixAwaitingPublish || !job.run) continue;
    const ledger = readFeedbackLedger(config.kilnDir, job.jobId);
    if (!ledger || ledger === "corrupt") continue;
    const open = openFeedbackRound(ledger);
    if (!open || open.fixRunId !== job.run.runId) continue;
    const record = readDelivery(config.kilnDir, job.jobId);
    const checkout = job.run.checkout;
    const source = `yak/${job.run.runId}`;
    if (!record?.branch) {
      notes.push(`feedback ${job.jobId} failed: no pull request branch to publish`);
      continue;
    }
    let sha: string;
    try {
      sha = host.git.revParse(checkout, source);
    } catch (error) {
      markFeedback(config.kilnDir, job.jobId, "feedback-ambiguous");
      notes.push(`feedback-ambiguous ${job.jobId}  ${errorMessage(error)}`);
      continue;
    }
    if (sha === open.headSha) {
      open.outcome = "fixed";
      writeFeedbackLedger(config.kilnDir, ledger);
      notes.push(`fixed ${job.jobId}  ${sha}`);
      continue;
    }
    const ancestor = host.git.isAncestor(checkout, open.headSha, sha);
    if (!ancestor) {
      markFeedback(config.kilnDir, job.jobId, "feedback-ambiguous");
      notes.push(`feedback-ambiguous ${job.jobId}  ${source} is not based on ${open.headSha}`);
      continue;
    }
    try {
      host.git.publishBranch(checkout, source, record.branch, record.base);
    } catch (error) {
      const message = errorMessage(error);
      if (isNonFastForward(message)) {
        markFeedback(config.kilnDir, job.jobId, "feedback-ambiguous");
        notes.push(`feedback-ambiguous ${job.jobId}  ${message}`);
      } else {
        notes.push(`feedback ${job.jobId} failed: ${message}`);
      }
      continue;
    }
    writeDelivery(config.kilnDir, {
      jobId: record.jobId,
      runId: record.runId,
      branch: record.branch,
      base: record.base,
      sha,
      pushed: true,
      ...(record.prNumber ? { prNumber: record.prNumber } : {}),
      ...(record.prUrl ? { prUrl: record.prUrl } : {}),
    });
    open.outcome = "pushed";
    writeFeedbackLedger(config.kilnDir, ledger);
    notes.push(`pushed ${job.jobId}  ${record.branch}  ${sha}`);
  }
  return notes;
}

function isNonFastForward(message: string): boolean {
  return /non-fast-forward|\[rejected\]|failed to push some refs/i.test(message);
}

/**
 * Read each open pull request once per tick and attach a plan.
 * `readStatus` does not call this. A host with no feedback reader does not watch.
 */
function watchPullRequests(config: LoadedKilnConfig, world: World, host: KilnHost): string[] {
  const notes: string[] = [];
  if (!host.feedback) return notes;
  for (const job of world.observation.jobs) {
    if (job.feedbackLedgerError && job.deliver === "pr" && job.delivery?.prNumber) {
      notes.push(`${job.feedbackLedgerError} ${job.jobId}`);
    }
    if (!shouldWatch(job) || !job.run) continue;
    const ledger = readFeedbackLedger(config.kilnDir, job.jobId);
    if (ledger === "corrupt") continue;
    let snapshot: PullRequestFeedback;
    try {
      snapshot = host.feedback.read(job.run.checkout, job.delivery?.prNumber ?? 0);
    } catch (error) {
      notes.push(`feedback ${job.jobId} failed: ${errorMessage(error)}`);
      continue;
    }
    job.feedbackPlan = planFeedback({
      maxFixRounds: config.maxFixRounds,
      ledger,
      snapshot,
    });
  }
  return notes;
}

function shouldWatch(job: ObservedJob): boolean {
  if (job.deliver !== "pr" || job.workflow === INVESTIGATION_WORKFLOW) return false;
  if (job.error || job.feedbackLedgerError || job.feedbackExhausted || job.feedbackAmbiguous) return false;
  if (job.fixInProgress || job.fixAwaitingPublish || job.launching) return false;
  if (!job.delivery?.prNumber) return false;
  if (job.delivery.merged || job.delivery.prState === "MERGED" || job.delivery.prState === "CLOSED") return false;
  return isLanded(job);
}

function markFeedback(
  kilnDir: string,
  jobId: string,
  reason: "feedback-exhausted" | "feedback-ambiguous",
): void {
  const existing = readFeedbackLedger(kilnDir, jobId);
  const ledger: FeedbackLedger = existing && existing !== "corrupt" ? existing : { jobId, rounds: [] };
  if (reason === "feedback-exhausted") ledger.exhausted = true;
  else ledger.ambiguous = true;
  writeFeedbackLedger(kilnDir, ledger);
}

/**
 * Open one feedback round and start the fix workflow on the pull request head.
 * The round is written only after that commit resolves, so a missing sha
 * retries on the next tick without consuming a round.
 */
function startFix(
  config: LoadedKilnConfig,
  world: World,
  job: Job,
  host: KilnHost,
  now: Date,
  sandboxFacts?: SandboxFacts,
): LaunchReport {
  const observed = world.observation.jobs.find((candidate) => candidate.jobId === job.id);
  const plan = observed?.feedbackPlan;
  const repo = config.repos[job.repo];
  if (!repo || !plan || plan.action !== "fix") {
    return { jobId: job.id, repo: job.repo, output: `Job ${job.id} has no fix to start.` };
  }
  let headSha: string;
  try {
    headSha = resolveCommit(host, repo.path, plan.headSha);
  } catch (error) {
    return { jobId: job.id, repo: job.repo, output: errorMessage(error) };
  }
  const existing = readFeedbackLedger(config.kilnDir, job.id);
  const ledger: FeedbackLedger = existing && existing !== "corrupt" ? existing : { jobId: job.id, rounds: [] };
  if (openFeedbackRound(ledger)) {
    return { jobId: job.id, repo: job.repo, output: `Job ${job.id} already has an open fix round.` };
  }
  const round = ledger.rounds.length + 1;
  ledger.rounds.push({
    round,
    headSha,
    trigger: plan.trigger,
    items: plan.items,
    at: now.toISOString(),
  });
  writeFeedbackLedger(config.kilnDir, ledger);
  let specText: string;
  try {
    specText = feedbackSpec(specHandedToYak(config, world, job), plan.items);
  } catch (error) {
    const message = errorMessage(error);
    writeLaunchError(config.kilnDir, job.id, message);
    const logPath = join(config.kilnDir, "logs", `${jobBasename(job.id)}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${message}\n`);
    writeBreadcrumb(breadcrumbPath(config.kilnDir, job.id), { jobId: job.id, pid: 0, logPath });
    return { jobId: job.id, repo: job.repo, kind: "fix", output: message };
  }
  const report = launchFixRun(config, job, host, repo.path, headSha, specText, sandboxFacts);
  return { ...report, output: `round ${round}\n${report.output}` };
}

/** Relaunch the open fix round. Does not append a round. Failures become a dead launch so retry can see them. */
function launchOpenFix(
  config: LoadedKilnConfig,
  world: World,
  job: Job,
  host: KilnHost,
  checkout: string,
  open: FeedbackLedger["rounds"][number],
  sandboxFacts?: SandboxFacts,
): LaunchReport {
  let specText: string;
  let headSha: string;
  try {
    clearLaunchError(config.kilnDir, job.id);
    specText = feedbackSpec(specHandedToYak(config, world, job), open.items);
    headSha = resolveCommit(host, checkout, open.headSha);
  } catch (error) {
    const message = errorMessage(error);
    writeLaunchError(config.kilnDir, job.id, message);
    const logPath = join(config.kilnDir, "logs", `${jobBasename(job.id)}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${message}\n`);
    writeBreadcrumb(breadcrumbPath(config.kilnDir, job.id), { jobId: job.id, pid: 0, logPath });
    return { jobId: job.id, repo: job.repo, kind: "fix", output: message };
  }
  return launchFixRun(config, job, host, checkout, headSha, specText, sandboxFacts);
}

function resolveCommit(host: KilnHost, checkout: string, sha: string): string {
  try {
    return host.git.revParse(checkout, sha);
  } catch {
    host.git.fetch(checkout);
    return host.git.revParse(checkout, sha);
  }
}

/** `workflows/fix.yaml` on `headSha`. Commits on `yak/<run-id>`. Does not push. */
function launchFixRun(
  config: LoadedKilnConfig,
  job: Job,
  host: KilnHost,
  checkout: string,
  headSha: string,
  specText: string,
  sandboxFacts?: SandboxFacts,
): LaunchReport {
  const sourceWorkflow = readFileSync(join(packageRoot(), "workflows", "fix.yaml"), "utf8");
  const workflow = materializeWorkflow(config.kilnDir, job.id, "fix");
  const repo = config.repos[job.repo];
  const logPath = join(config.kilnDir, "logs", `${jobBasename(job.id)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const blocked = commitAgentSandbox(config, job.id, "fix", workflow, logPath, sandboxFacts);
  if (blocked) return { jobId: job.id, repo: job.repo, kind: "fix", output: blocked };
  ensureCheckoutExcludes(checkout);
  const input = workflowInputs(sourceWorkflow, {
    title: job.title,
    specText,
    runNonce: randomUUID(),
    baseRef: headSha,
  });
  const args = agentArgs(config, job, workflow, headSha, input);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(repo?.test ? { KILN_TEST: repo.test } : {}),
    KILN_TASK_TITLE: job.title,
    KILN_VERIFY_WRAPPER: join(packageRoot(), "dist", "truncate-output.js"),
  };
  return spawnLogged(config, host, {
    jobId: job.id,
    repo: job.repo,
    kind: "fix",
    cwd: checkout,
    args,
    env,
    logPath,
  });
}

/**
 * Names why a sandboxed workflow cannot launch. Does not write a round or a
 * breadcrumb. `undefined` when this workflow stays on the host or the checks pass.
 */
function sandboxBlock(
  config: LoadedKilnConfig,
  workflowName: string,
  sandboxFacts?: SandboxFacts,
): string | undefined {
  const sandbox = resolveSandbox(config.sandbox, config.workflowSandbox[workflowName]);
  if (sandbox.mode !== "docker") return undefined;
  const checked =
    sandboxFacts ??
    probeSandboxEnvironment(process.env, [PROXY_SANDBOX_IMAGE, sandbox.image ?? AGENT_SANDBOX_IMAGE]);
  return sandboxPreflightFor(sandbox, config.adapter, checked);
}

/**
 * Inject `sandbox: docker` into a materialized workflow and refuse the launch
 * when preflight fails. The refusal is a launch error with no yak process.
 */
function commitAgentSandbox(
  config: LoadedKilnConfig,
  jobId: string,
  workflowName: string,
  workflowPath: string,
  logPath: string,
  sandboxFacts?: SandboxFacts,
): string | undefined {
  const sandbox = resolveSandbox(config.sandbox, config.workflowSandbox[workflowName]);
  if (sandbox.mode !== "docker") return undefined;
  writeFileSync(workflowPath, injectAgentSandbox(readFileSync(workflowPath, "utf8"), sandbox));
  const problem = sandboxBlock(config, workflowName, sandboxFacts);
  if (!problem) return undefined;
  writeLaunchError(config.kilnDir, jobId, problem);
  writeFileSync(logPath, `${problem}\n`);
  return problem;
}

function agentArgs(
  config: LoadedKilnConfig,
  job: Job,
  workflow: string,
  headSha: string,
  input: Record<string, string>,
): string[] {
  const args = [
    yakCliPath(),
    "run",
    workflow,
    "--adapter",
    config.adapter,
    "--isolation",
    "worktree",
    "--from",
    headSha,
    "--tag",
    jobTag(job.id),
  ];
  for (const [key, value] of Object.entries(input)) {
    args.push("--input", `${key}=${value}`);
  }
  return args;
}

function spawnLogged(
  config: LoadedKilnConfig,
  host: KilnHost,
  spec: {
    jobId: string;
    repo: string;
    kind?: "fix";
    cwd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    logPath: string;
  },
): LaunchReport {
  const crumbPath = breadcrumbPath(config.kilnDir, spec.jobId);
  writeBreadcrumb(crumbPath, { jobId: spec.jobId, pid: 0, logPath: spec.logPath });
  const logFd = openSync(spec.logPath, "a");
  try {
    const started = spawnAgent(host, { cwd: spec.cwd, args: spec.args, env: spec.env, logFd });
    const pid = started.pid ?? 0;
    writeBreadcrumb(crumbPath, { jobId: spec.jobId, pid, logPath: spec.logPath });
    return {
      jobId: spec.jobId,
      repo: spec.repo,
      ...(spec.kind ? { kind: spec.kind } : {}),
      output: `pid ${pid}\nlog ${spec.logPath}`,
    };
  } catch (error) {
    writeFileSync(spec.logPath, `${errorMessage(error)}\n`);
    return {
      jobId: spec.jobId,
      repo: spec.repo,
      ...(spec.kind ? { kind: spec.kind } : {}),
      output: `pid 0\nlog ${spec.logPath}`,
    };
  } finally {
    closeSync(logFd);
  }
}

function spawnAgent(host: KilnHost, spec: AgentStart): { pid: number } {
  if (host.startAgent) return host.startAgent(spec);
  const child = spawn(process.execPath, spec.args, {
    cwd: spec.cwd,
    detached: true,
    stdio: ["ignore", spec.logFd, spec.logFd],
    env: spec.env,
  });
  child.unref();
  return { pid: child.pid ?? 0 };
}

function launchJob(
  config: LoadedKilnConfig,
  world: World,
  job: Job,
  host: KilnHost,
  sandboxFacts?: SandboxFacts,
): LaunchReport {
  const repo = config.repos[job.repo];
  if (!repo) {
    throw new Error(`Repo ${job.repo} is not registered. Run kiln repo add ${job.repo} <path>.`);
  }
  const feedback = readFeedbackLedger(config.kilnDir, job.id);
  const open = feedback && feedback !== "corrupt" ? openFeedbackRound(feedback) : undefined;
  if (open) return launchOpenFix(config, world, job, host, repo.path, open, sandboxFacts);
  const sourceWorkflow = readFileSync(join(packageRoot(), "workflows", `${job.workflow}.yaml`), "utf8");
  const testCommand = repo.test;
  if (workflowNeedsTestCommand(sourceWorkflow) && !testCommand?.trim()) {
    throw new Error(
      `Repo ${job.repo} has no test command. Set repos.${job.repo}.test. The feature workflow refuses to run an empty KILN_TEST.`,
    );
  }
  const workflow = materializeWorkflow(config.kilnDir, job.id, job.workflow);
  const logPath = join(config.kilnDir, "logs", `${jobBasename(job.id)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  ensureCheckoutExcludes(repo.path);

  let baseSha: string;
  let specText: string;
  try {
    clearLaunchError(config.kilnDir, job.id);
    const blocked = commitAgentSandbox(config, job.id, job.workflow, workflow, logPath, sandboxFacts);
    if (blocked) return { jobId: job.id, repo: job.repo, output: blocked };
    assertStackTarget(world, job);
    baseSha = resolveLaunchBase({
      checkout: repo.path,
      deliver: repo.deliver,
      stack: job.stack === true,
      ...(repo.base ? { configuredBase: repo.base } : {}),
      ...(job.stack ? { upstreamBranch: upstreamBranch(world, job) } : {}),
      git: host.git,
    });
    specText = specHandedToYak(config, world, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLaunchError(config.kilnDir, job.id, message);
    writeFileSync(logPath, `${message}\n`);
    return { jobId: job.id, repo: job.repo, output: message };
  }

  const input = workflowInputs(sourceWorkflow, {
    title: job.title,
    specText,
    runNonce: randomUUID(),
    baseRef: baseSha,
  });
  const args = agentArgs(config, job, workflow, baseSha, input);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILN_TEST: testCommand,
    KILN_TASK_TITLE: job.title,
    KILN_VERIFY_WRAPPER: join(packageRoot(), "dist", "truncate-output.js"),
  };
  return spawnLogged(config, host, { jobId: job.id, repo: job.repo, cwd: repo.path, args, env, logPath });
}

interface LoadedJob {
  meta: { jobId: string; error?: string };
  job?: Job;
}

function loadJobs(config: LoadedKilnConfig): LoadedJob[] {
  if (!existsSync(config.jobsDir)) return [];
  return readdirSync(config.jobsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => loadJobFile(join(config.jobsDir, name)));
}

function loadJobFile(file: string): LoadedJob {
  const fileId = basename(file, ".json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { meta: { jobId: fileId, error: errorMessage(error) } };
  }
  const parsed = JobSchema.safeParse(raw);
  if (!parsed.success) {
    return { meta: { jobId: fileId, error: parsed.error.message } };
  }
  const job = parsed.data;
  if (`${jobBasename(job.id)}.json` !== basename(file)) {
    return {
      meta: {
        jobId: job.id,
        error: `Job file ${basename(file)} does not match id ${job.id}.`,
      },
    };
  }
  if ("state" in (raw as Record<string, unknown>)) {
    return { meta: { jobId: job.id, error: "Job state is derived and must not be stored." } };
  }
  return { meta: { jobId: job.id }, job };
}

function scanRuns(config: LoadedKilnConfig): Map<string, ObservedRun[]> {
  const byTag = new Map<string, ObservedRun[]>();
  for (const repo of Object.values(config.repos)) {
    for (const runDir of listRunDirs(repo.path)) {
      const events = readJournal(runDir);
      const started = events.find((event) => event.t === "run.started");
      if (!started?.tag || !parseJobTag(started.tag)) continue;
      const runId = basename(runDir);
      const status = classify(events);
      const gateDecision = readApproveDecision(runDir);
      const title = readRunTitle(runDir);
      const finished = [...events].reverse().find((event) => event.t === "run.finished");
      const stepPlan = readRunStepPlan(runDir);
      const stepEvents = stepEventsFrom(events);
      const sandboxError = sandboxFailureDetail(stepEvents);
      const pid = livePid(events);
      const activityMs = eventActivityMs(events) ?? fileMtimeMs(join(runDir, "journal.jsonl"));
      const finishedReason =
        finished && typeof finished.reason === "string" ? finished.reason : undefined;
      const run: ObservedRun = {
        runId,
        checkout: repo.path,
        status,
        gates: status === "suspended" ? openGates(runDir, events) : [],
        ...(gateDecision ? { gateDecision } : {}),
        ...(title ? { title } : {}),
        ...(typeof started?.at === "string" ? { startedAt: started.at } : {}),
        ...(typeof finished?.at === "string" ? { finishedAt: finished.at } : {}),
        ...(stepPlan.length > 0 ? { stepPlan } : {}),
        ...(stepEvents.length > 0 ? { stepEvents } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(activityMs !== undefined ? { activityMs } : {}),
        ...(finishedReason ? { finishedReason } : {}),
        ...(sandboxError ? { sandboxError } : {}),
      };
      const list = byTag.get(started.tag) ?? [];
      list.push(run);
      byTag.set(started.tag, list);
    }
  }
  return byTag;
}

function stepEventsFrom(events: JournalEvent[]): StepEvent[] {
  const found: StepEvent[] = [];
  for (const event of events) {
    if (event.t !== "step.started" && event.t !== "step.completed" && event.t !== "step.failed") continue;
    if (!event.stepId) continue;
    const failure = event.t === "step.failed" ? formatFailure(event.failure) : undefined;
    found.push({
      t: event.t,
      stepId: event.stepId,
      ...(failure?.detail ? { detail: failure.detail } : {}),
      ...(failure?.reason ? { failureReason: failure.reason } : {}),
    });
  }
  return found;
}

function formatFailure(failure: JournalEvent["failure"]): { detail?: string; reason?: string } | undefined {
  if (!failure) return undefined;
  const detail = typeof failure.detail === "string" ? failure.detail.trim() : "";
  const reason = typeof failure.reason === "string" ? failure.reason.trim() : "";
  const text = detail && reason ? `${detail} (${reason})` : detail || reason;
  if (!text && !reason) return undefined;
  return {
    ...(text ? { detail: text } : {}),
    ...(reason ? { reason } : {}),
  };
}

function readRunStepPlan(runDir: string): string[] {
  const file = join(runDir, "workflow.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { steps?: unknown };
    return leafStepIds(parsed.steps);
  } catch {
    return [];
  }
}

function readDiffSummary(checkout: string, runId: string): string | undefined {
  const worktree = join(checkout, ".yak", "worktrees", runId);
  if (existsSync(worktree)) {
    const result = spawnSync("git", ["diff", "--stat", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 5_000,
    });
    const text = result.status === 0 ? result.stdout.trim() : "";
    if (text) return clipText(text, 1500);
  }
  return readBuildSummary(join(checkout, ".runs", runId));
}

function readBuildSummary(runDir: string): string | undefined {
  const dir = join(runDir, "artifacts");
  if (!existsSync(dir)) return undefined;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { iter: number; file: string } | undefined;
  for (const file of files) {
    const match = /^build(?:\.(\d+))?\.json$/.exec(file);
    if (!match) continue;
    const iter = match[1] ? Number(match[1]) : 0;
    if (!best || iter >= best.iter) best = { iter, file };
  }
  if (!best) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, best.file), "utf8")) as { summary?: unknown };
    if (typeof parsed.summary !== "string" || !parsed.summary.trim()) return undefined;
    return clipText(parsed.summary.trim(), 280);
  } catch {
    return undefined;
  }
}

function readLogTail(logPath: string | undefined): string | undefined {
  if (!logPath) return undefined;
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return undefined;
  }
  if (size <= 0) return undefined;
  const take = Math.min(size, 64_000);
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const buffer = Buffer.alloc(take);
    readSync(fd, buffer, 0, take, size - take);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (size > take) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const tail = lines.slice(-40).join("\n").trim();
    return tail || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Prefer a run that is not already a recorded failure, so a retry is visible
 * even when its id does not sort after the failed one. Otherwise keep the
 * latest id, which is what a single-run job has always shown.
 */
function selectJobRun(
  runs: ObservedRun[],
  ledger: AttemptLedger | undefined,
  feedback: FeedbackLedger | undefined,
  baseRunId: string | undefined,
): { run?: ObservedRun; retired: boolean; fixInProgress: boolean; fixAwaitingPublish: boolean } {
  const settled = new Set<string>();
  for (const round of feedback?.rounds ?? []) {
    if ((round.outcome === "pushed" || round.outcome === "fixed") && round.fixRunId) settled.add(round.fixRunId);
  }
  const ignored = new Set(ledger?.ignoredRunIds ?? []);
  const failed = new Set((ledger?.attempts ?? []).flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])));
  const open = openFeedbackRound(feedback);
  if (open) {
    const bound =
      open.fixRunId && !ignored.has(open.fixRunId) && !failed.has(open.fixRunId) ? open.fixRunId : undefined;
    const fixRuns = runs.filter((run) => {
      if (settled.has(run.runId) || ignored.has(run.runId)) return false;
      if (bound) return run.runId === bound;
      if (failed.has(run.runId)) return false;
      return baseRunId ? run.runId !== baseRunId : true;
    });
    fixRuns.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0));
    const fix = fixRuns[0];
    if (fix) {
      const retired = failed.has(fix.runId);
      return {
        run: fix,
        retired,
        fixInProgress: true,
        fixAwaitingPublish: fix.status === "ok" && !retired,
      };
    }
    return { retired: false, fixInProgress: true, fixAwaitingPublish: false };
  }
  const picked = selectRun(
    runs.filter((run) => !settled.has(run.runId)),
    ledger,
  );
  return { ...picked, fixInProgress: false, fixAwaitingPublish: false };
}

function selectRun(runs: ObservedRun[], ledger: AttemptLedger | undefined): { run?: ObservedRun; retired: boolean } {
  const ignored = new Set(ledger?.ignoredRunIds ?? []);
  const failed = new Set(
    (ledger?.attempts ?? []).flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])),
  );
  const visible = runs.filter((run) => !ignored.has(run.runId));
  visible.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0));
  const fresh = visible.filter((run) => !failed.has(run.runId));
  if (fresh[0]) return { run: fresh[0], retired: false };
  if (visible[0]) return { run: visible[0], retired: true };
  return { retired: false };
}

function later(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function eventActivityMs(events: JournalEvent[]): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (!event.at) continue;
    const parsed = Date.parse(event.at);
    if (!Number.isFinite(parsed)) continue;
    if (latest === undefined || parsed > latest) latest = parsed;
  }
  return latest;
}

function listRunDirs(checkout: string): string[] {
  const runsDir = join(checkout, ".runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name));
}

function readJournal(runDir: string): JournalEvent[] {
  const file = join(runDir, "journal.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
  const events: JournalEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch (error) {
      if (index === lines.length - 1) continue;
      throw new Error(`Could not read ${file}: ${errorMessage(error)}`);
    }
  }
  return events;
}

/** Latest `run.resumed` pid, else `run.started`. Same rule as yak's livePidFromJournal. */
function livePid(events: JournalEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.t === "run.resumed" && typeof event.pid === "number") return event.pid;
  }
  const started = events.find((event) => event.t === "run.started");
  return typeof started?.pid === "number" ? started.pid : undefined;
}

function classify(events: JournalEvent[]): RunStatus {
  const last = events.at(-1);
  if (
    last?.t === "run.finished" &&
    (last.status === "ok" || last.status === "failed" || last.status === "suspended")
  ) {
    return last.status;
  }
  const pid = livePid(events);
  if (pid === undefined || !pidAlive(pid)) return "dead";
  return "alive";
}

function readApproveDecision(runDir: string): "approve" | "reject" | undefined {
  const file = join(runDir, "artifacts", "approval.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { decision?: unknown };
    if (parsed.decision === "approve" || parsed.decision === "reject") return parsed.decision;
  } catch {
    // A partial artifact is not a decision.
  }
  return undefined;
}

function readRunTitle(runDir: string): string | undefined {
  const file = join(runDir, "artifacts", "input.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { title?: unknown };
    return typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : undefined;
  } catch {
    return undefined;
  }
}

function openGates(runDir: string, events: JournalEvent[]): ObservedGate[] {
  const open = new Map<string, boolean>();
  for (const event of events) {
    if (event.t === "gate.opened" && event.stepId) open.set(event.stepId, true);
    else if (event.t === "gate.answered" && event.stepId) open.set(event.stepId, false);
  }
  const gates: ObservedGate[] = [];
  for (const [stepId, isOpen] of open) {
    if (!isOpen) continue;
    gates.push(readGate(runDir, stepId));
  }
  return gates;
}

function readGate(runDir: string, stepId: string): ObservedGate {
  const reviews = readReviewArtifacts(runDir);
  const file = join(runDir, "pending", `${stepId}.request.json`);
  if (!existsSync(file)) {
    return { stepId, prompt: "(request file missing)", ...(reviews.length > 0 ? { reviews } : {}) };
  }
  const request = JSON.parse(readFileSync(file, "utf8")) as {
    kind?: string;
    rendered?: string;
    tripped?: string;
    iteration?: number;
    answerSchema?: unknown;
    context?: { artifacts?: unknown };
  };
  const prompt =
    request.kind === "loop-exhausted"
      ? `loop exhausted (${request.tripped ?? "budget"} at iteration ${request.iteration ?? "?"})`
      : (request.rendered ?? stepId).split("\n")[0] ?? stepId;
  const shape = answerShape(request.answerSchema);
  const rendered = typeof request.rendered === "string" ? clipText(request.rendered, 2000) : undefined;
  const artifacts = readNamedArtifacts(runDir, artifactNames(request.context?.artifacts));
  return {
    stepId,
    prompt,
    ...(rendered ? { rendered } : {}),
    ...(shape ? { answerField: shape.field, choices: shape.choices } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(reviews.length > 0 ? { reviews } : {}),
  };
}

const REVIEW_STEPS = ["security", "ux", "ui", "code"] as const;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/;
const SECRET_KEY = /api[_-]?token|password|secret|authorization|credential/i;

/** The launch log stays after the breadcrumb is cleared. Status prints it only for a failed launch. */
function existingLog(kilnDir: string, jobId: string): string | undefined {
  let name: string;
  try {
    name = jobBasename(jobId);
  } catch {
    return undefined;
  }
  const path = join(kilnDir, "logs", `${name}.log`);
  return existsSync(path) ? path : undefined;
}

function artifactNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !ARTIFACT_NAME.test(entry) || names.includes(entry)) continue;
    names.push(entry);
  }
  return names;
}

function readNamedArtifacts(runDir: string, names: string[]): ObservedArtifact[] {
  const found: ObservedArtifact[] = [];
  for (const name of names) {
    const file = join(runDir, "artifacts", `${name}.json`);
    if (!existsSync(file)) continue;
    found.push(readArtifactSummary(file, name));
  }
  return found;
}

function readReviewArtifacts(runDir: string): ObservedArtifact[] {
  const dir = join(runDir, "artifacts");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const best = new Map<string, { iter: number; file: string }>();
  for (const file of files) {
    const match = /^(security|ux|ui|code)(?:\.(\d+))?\.json$/.exec(file);
    if (!match?.[1]) continue;
    const iter = match[2] ? Number(match[2]) : 0;
    const previous = best.get(match[1]);
    if (!previous || iter >= previous.iter) best.set(match[1], { iter, file });
  }
  const found: ObservedArtifact[] = [];
  for (const step of REVIEW_STEPS) {
    const picked = best.get(step);
    if (!picked) continue;
    found.push(readArtifactSummary(join(dir, picked.file), step));
  }
  return found;
}

function readArtifactSummary(file: string, name: string): ObservedArtifact {
  if (!existsSync(file)) return { name, summary: "(missing artifact)" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return { name, summary: summarizeArtifact(name, parsed) };
  } catch {
    return { name, summary: "(unreadable artifact)" };
  }
}

function summarizeArtifact(name: string, value: unknown): string {
  const clean = redactSecrets(value);
  if (name === "input" && isRecord(clean)) {
    const title = clean.title;
    return typeof title === "string" && title.trim() ? `title: ${clipText(title, 120)}` : "(no title)";
  }
  if (isRecord(clean)) {
    const head = typeof clean.decision === "string" ? clean.decision : typeof clean.verdict === "string" ? clean.verdict : undefined;
    const detail = typeof clean.reason === "string" ? clean.reason : typeof clean.findings === "string" ? clean.findings : undefined;
    if (head) return clipText(detail ? `${head} — ${detail}` : head, 280);
  }
  try {
    return clipText(JSON.stringify(clean), 280);
  } catch {
    return "(unreadable artifact)";
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(inner);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}...`;
}

function answerShape(schema: unknown): { field: string; choices: string[] } | undefined {
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) return undefined;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const required =
    "required" in schema && Array.isArray(schema.required)
      ? schema.required.filter((item) => typeof item === "string")
      : [];
  for (const key of required) {
    const prop = (properties as Record<string, unknown>)[key];
    if (typeof prop !== "object" || prop === null || !("enum" in prop) || !Array.isArray(prop.enum)) continue;
    const choices = prop.enum.filter((value): value is string => typeof value === "string");
    if (choices.length > 0) return { field: key, choices };
  }
  return undefined;
}

function breadcrumbPath(kilnDir: string, jobId: string): string {
  return join(kilnDir, "launching", `${jobBasename(jobId)}.json`);
}

function writeBreadcrumb(path: string, body: Omit<Breadcrumb, "path">): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function readBreadcrumbs(kilnDir: string): Breadcrumb[] {
  const root = join(kilnDir, "launching");
  if (!existsSync(root)) return [];
  const found: Breadcrumb[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<Breadcrumb, "path">>;
      if (!parsed.jobId) continue;
      found.push({
        path,
        jobId: parsed.jobId,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
        logPath: typeof parsed.logPath === "string" ? parsed.logPath : "",
      });
    } catch {
      // An unreadable crumb is left for a person. It does not count as a job.
    }
  }
  return found;
}

/** The checkout's git metadata must not show up in `git status` or a later `git add`. */
function ensureCheckoutExcludes(checkout: string): void {
  const gitDir = gitCommonDir(checkout);
  if (!gitDir) return;
  const info = join(gitDir, "info");
  mkdirSync(info, { recursive: true });
  const exclude = join(info, "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = [".runs/", ".yak/"].filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const suffix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(exclude, `${current}${suffix}${missing.join("\n")}\n`);
}

/** Main git dir, including when `.git` is a file (a linked worktree). */
function gitCommonDir(checkout: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: checkout,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const printed = result.stdout.trim();
  if (!printed) return undefined;
  return isAbsolute(printed) ? printed : join(checkout, printed);
}

function withTickLock<T>(kilnDir: string, fn: () => T): T {
  mkdirSync(kilnDir, { recursive: true });
  const lockPath = join(kilnDir, "tick.lock");
  acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Publish the pid with link(2) so a reader never observes the lock file
 * before its contents are complete. open(O_EXCL) plus a later write leaves
 * a window where the file exists and is empty.
 */
function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = `${lockPath}.${process.pid}.tmp`;
    writeFileSync(tmp, String(process.pid));
    try {
      linkSync(tmp, lockPath);
      rmSync(tmp, { force: true });
      return;
    } catch (error) {
      rmSync(tmp, { force: true });
      if (!isErrno(error, "EEXIST")) throw error;
      let pid = Number.NaN;
      try {
        pid = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        continue;
      }
      if (pidAlive(pid)) {
        throw new Error(`Another kiln tick is running (pid ${pid}).`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire tick lock ${lockPath}.`);
}

function releaseLock(lockPath: string): void {
  try {
    if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
  } catch {
    // The lock file is already gone.
  }
}

function pidAlive(pid: number): boolean {
  return isPidAlive(pid);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
