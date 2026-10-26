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
  appendInvestigationFindings,
  existingFindingsPath,
  findingsFilePath,
  INVESTIGATION_WORKFLOW,
  readFindingsMarkdown,
  writeFindings,
} from "./findings.js";
import { defaultHost, type KilnHost, type PullRequestState } from "./host.js";
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
  gateAnswerCommand,
  renderStatus,
  renderTick,
  statusView,
  yakCliPath,
  type DeliverReport,
  type FindingsReport,
  type LaunchReport,
  type StepEvent,
} from "./report.js";
import { JobSchema, type Job } from "./schemas.js";
import { leafStepIds, materializeWorkflow, workflowInputs, workflowNeedsTestCommand, workflowStepPlan } from "./workflow.js";

interface JournalEvent {
  t: string;
  at?: string;
  tag?: string;
  status?: string;
  stepId?: string;
  pid?: number;
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

export function runStatus(config: LoadedKilnConfig, jobId?: string, host: KilnHost = defaultHost()): string {
  return renderStatus(readStatus(config, jobId, host));
}

export function runTick(config: LoadedKilnConfig, host: KilnHost = defaultHost()): string {
  return withTickLock(config.kilnDir, () => {
    const world = observe(config, host);
    const actions = decide(world.observation);
    return apply(config, world, actions, host);
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
 * Run a failed or dead job again.
 * A landed job whose only failure is opening the pull request is handed to
 * the same deliver path tick uses. Everything else is a new `yak run`, the
 * same launch tick uses. Yak run ids sort by time, so the new journal
 * supersedes the old one. A dead journal is cancelled first.
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
    if (shouldRedeliver(observed)) {
      const report = deliverObserved(config, world, jobId, host);
      if (!report.ok) throw new Error(report.detail);
      const detail = report.detail.endsWith("\n") || report.detail.length === 0 ? report.detail : `${report.detail}\n`;
      return `retry ${jobId}  ${job.repo}\n${detail}`;
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
    return `retry ${report.jobId}  ${report.repo}\n${output}`;
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
    const run = runs.get(tag);
    const crumb = breadcrumbs.find((candidate) => candidate.jobId === entry.meta.jobId);
    if (crumb && run) breadcrumbsToClear.push({ path: crumb.path });
    const childAlive = crumb ? pidAlive(crumb.pid) : false;
    const repoKnown = entry.job ? Boolean(config.repos[entry.job.repo]) : false;
    const repoError =
      entry.job && !repoKnown ? `Repo ${entry.job.repo} is not registered.` : undefined;
    const repo = entry.job ? config.repos[entry.job.repo] : undefined;
    const deliver = repo?.deliver ?? "local";
    const delivery =
      entry.job && repo && deliver === "pr"
        ? observedDelivery(config.kilnDir, host, repo.path, entry.job.id, run?.runId)
        : undefined;
    const launchError = entry.job && !run ? readLaunchError(config.kilnDir, entry.job.id) : undefined;
    const stackError =
      entry.job?.stack && (entry.job.dependsOn?.length ?? 0) !== 1
        ? "stack needs exactly one dependency."
        : undefined;
    const logPath = crumb?.logPath || existingLog(config.kilnDir, entry.meta.jobId);
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
      launching: Boolean(crumb) && !run && childAlive,
      launchFailed: Boolean(crumb) && !run && !childAlive,
      ...(launchError ? { launchError } : {}),
      ...(logPath ? { logPath } : {}),
      ...(entry.job?.createdAt ? { createdAt: entry.job.createdAt } : {}),
      ...(logTail ? { logTail } : {}),
      ...(diffSummary ? { diffSummary } : {}),
      ...(stepPlan && stepPlan.length > 0 ? { stepPlan } : {}),
      ...(run ? { run } : {}),
      ...(entry.meta.error || repoError || stackError
        ? { error: entry.meta.error ?? repoError ?? stackError }
        : {}),
    });
  }

  return {
    observation: {
      maxConcurrent: config.maxConcurrent,
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
    const job = world.jobs.get(action.jobId);
    if (!job) {
      throw new Error(`Tick planned a launch for ${action.jobId}, which is not in the observed jobs.`);
    }
    launches.push(launchJob(config, world, job, host));
  }
  return renderTick(world.observation, actions, launches, delivers, findings);
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

function launchJob(config: LoadedKilnConfig, world: World, job: Job, host: KilnHost): LaunchReport {
  const repo = config.repos[job.repo];
  if (!repo) {
    throw new Error(`Repo ${job.repo} is not registered. Run kiln repo add ${job.repo} <path>.`);
  }
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
  const crumbPath = breadcrumbPath(config.kilnDir, job.id);
  ensureCheckoutExcludes(repo.path);

  let baseSha: string;
  let specText: string;
  try {
    clearLaunchError(config.kilnDir, job.id);
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
  const args = [
    yakCliPath(),
    "run",
    workflow,
    "--adapter",
    config.adapter,
    "--isolation",
    "worktree",
    "--from",
    baseSha,
    "--tag",
    jobTag(job.id),
  ];
  for (const [key, value] of Object.entries(input)) {
    args.push("--input", `${key}=${value}`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILN_TEST: testCommand,
    KILN_TASK_TITLE: job.title,
    KILN_VERIFY_WRAPPER: join(packageRoot(), "dist", "truncate-output.js"),
  };

  writeBreadcrumb(crumbPath, { jobId: job.id, pid: 0, logPath });
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, args, {
      cwd: repo.path,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    child.unref();
    const pid = child.pid ?? 0;
    writeBreadcrumb(crumbPath, { jobId: job.id, pid, logPath });
    return { jobId: job.id, repo: job.repo, output: `pid ${pid}\nlog ${logPath}` };
  } catch (error) {
    writeFileSync(logPath, `${errorMessage(error)}\n`);
    return { jobId: job.id, repo: job.repo, output: `pid 0\nlog ${logPath}` };
  } finally {
    closeSync(logFd);
  }
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

function scanRuns(config: LoadedKilnConfig): Map<string, ObservedRun> {
  const byTag = new Map<string, ObservedRun>();
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
      };
      const previous = byTag.get(started.tag);
      if (!previous || run.runId > previous.runId) byTag.set(started.tag, run);
    }
  }
  return byTag;
}

function stepEventsFrom(events: JournalEvent[]): StepEvent[] {
  const found: StepEvent[] = [];
  for (const event of events) {
    if (event.t !== "step.started" && event.t !== "step.completed" && event.t !== "step.failed") continue;
    if (!event.stepId) continue;
    const detail = event.t === "step.failed" ? formatFailure(event.failure) : undefined;
    found.push({
      t: event.t,
      stepId: event.stepId,
      ...(detail ? { detail } : {}),
    });
  }
  return found;
}

function formatFailure(failure: JournalEvent["failure"]): string | undefined {
  if (!failure) return undefined;
  const detail = typeof failure.detail === "string" ? failure.detail.trim() : "";
  const reason = typeof failure.reason === "string" ? failure.reason.trim() : "";
  const text = detail && reason ? `${detail} (${reason})` : detail || reason;
  return text || undefined;
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
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
