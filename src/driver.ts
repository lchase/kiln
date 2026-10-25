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
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { readJobSpec } from "./jobs.js";
import { jobBasename, packageRoot } from "./paths.js";
import {
  decide,
  jobState,
  type Observation,
  type ObservedGate,
  type ObservedJob,
  type ObservedRun,
  type RunStatus,
} from "./reconcile.js";
import { gateAnswerCommand, renderStatus, renderTick, yakCliPath, type LaunchReport } from "./report.js";
import { JobSchema, type Job } from "./schemas.js";
import { materializeWorkflow, workflowInputs } from "./workflow.js";

interface JournalEvent {
  t: string;
  tag?: string;
  status?: string;
  stepId?: string;
  pid?: number;
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

export function runStatus(config: LoadedKilnConfig, jobId?: string): string {
  return renderStatus(observe(config).observation, jobId);
}

export function runTick(config: LoadedKilnConfig): string {
  return withTickLock(config.kilnDir, () => {
    const world = observe(config);
    const actions = decide(world.observation);
    return apply(config, world, actions);
  });
}

export function answerJob(config: LoadedKilnConfig, jobId: string, choice: "approve" | "reject"): string {
  const world = observe(config);
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
  return output.endsWith("\n") || output.length === 0 ? output : `${output}\n`;
}

function gateForChoice(gates: ObservedGate[], choice: "approve" | "reject"): ObservedGate | undefined {
  return (
    gates.find((gate) => gate.choices?.includes(choice)) ??
    gates.find((gate) => !gate.choices?.length)
  );
}

function observe(config: LoadedKilnConfig): World {
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
    jobs.push({
      jobId: entry.meta.jobId,
      repo: entry.job?.repo ?? "",
      workflow: entry.job?.workflow ?? "",
      title: entry.job?.title ?? "",
      dependsOn: entry.job?.dependsOn ?? [],
      ...(entry.job ? { source: entry.job.source } : {}),
      launching: Boolean(crumb) && !run && childAlive,
      launchFailed: Boolean(crumb) && !run && !childAlive,
      ...(crumb?.logPath ? { logPath: crumb.logPath } : {}),
      ...(run ? { run } : {}),
      ...(entry.meta.error || repoError ? { error: entry.meta.error ?? repoError } : {}),
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

function apply(config: LoadedKilnConfig, world: World, actions: ReturnType<typeof decide>): string {
  const launches: LaunchReport[] = [];
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") {
      rmSync(action.path, { force: true });
      continue;
    }
    const job = world.jobs.get(action.jobId);
    if (!job) {
      throw new Error(`Tick planned a launch for ${action.jobId}, which is not in the observed jobs.`);
    }
    launches.push(launchJob(config, job));
  }
  return renderTick(world.observation, actions, launches);
}

function launchJob(config: LoadedKilnConfig, job: Job): LaunchReport {
  const repo = config.repos[job.repo];
  if (!repo) {
    throw new Error(`Repo ${job.repo} is not registered. Run kiln repo add ${job.repo} <path>.`);
  }
  const testCommand = repo.test;
  if (!testCommand?.trim()) {
    throw new Error(
      `Repo ${job.repo} has no test command. Set repos.${job.repo}.test. The feature workflow refuses to run an empty KILN_TEST.`,
    );
  }
  const workflow = materializeWorkflow(config.kilnDir, job.id, job.workflow);
  const logPath = join(config.kilnDir, "logs", `${jobBasename(job.id)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const crumbPath = breadcrumbPath(config.kilnDir, job.id);
  ensureCheckoutExcludes(repo.path);

  const specText = readJobSpec(config.kilnDir, job);
  const sourceWorkflow = readFileSync(join(packageRoot(), "workflows", `${job.workflow}.yaml`), "utf8");
  const input = workflowInputs(sourceWorkflow, {
    title: job.title,
    specText,
    runNonce: randomUUID(),
    baseRef: checkoutHead(repo.path),
  });
  const args = [
    yakCliPath(),
    "run",
    workflow,
    "--adapter",
    config.adapter,
    "--isolation",
    "worktree",
    "--tag",
    jobTag(job.id),
  ];
  for (const [key, value] of Object.entries(input)) {
    args.push("--input", `${key}=${value}`);
  }

  writeBreadcrumb(crumbPath, { jobId: job.id, pid: 0, logPath });
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, args, {
      cwd: repo.path,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        KILN_TEST: testCommand,
        KILN_TASK_TITLE: job.title,
        KILN_VERIFY_WRAPPER: join(packageRoot(), "dist", "truncate-output.js"),
      },
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
      const run: ObservedRun = {
        runId,
        checkout: repo.path,
        status,
        gates: status === "suspended" ? openGates(runDir, events) : [],
        ...(gateDecision ? { gateDecision } : {}),
        ...(title ? { title } : {}),
      };
      const previous = byTag.get(started.tag);
      if (!previous || run.runId > previous.runId) byTag.set(started.tag, run);
    }
  }
  return byTag;
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
  const file = join(runDir, "pending", `${stepId}.request.json`);
  if (!existsSync(file)) return { stepId, prompt: "(request file missing)" };
  const request = JSON.parse(readFileSync(file, "utf8")) as {
    kind?: string;
    rendered?: string;
    tripped?: string;
    iteration?: number;
    answerSchema?: unknown;
  };
  const prompt =
    request.kind === "loop-exhausted"
      ? `loop exhausted (${request.tripped ?? "budget"} at iteration ${request.iteration ?? "?"})`
      : (request.rendered ?? stepId).split("\n")[0] ?? stepId;
  const shape = answerShape(request.answerSchema);
  return {
    stepId,
    prompt,
    ...(shape ? { answerField: shape.field, choices: shape.choices } : {}),
  };
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

/** Checkout HEAD at launch. The worktree branch is cut from this commit. */
function checkoutHead(checkout: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    const detail = (result.stderr || result.stdout || "no HEAD").trim();
    throw new Error(`Could not record the base SHA for ${checkout}: ${detail}`);
  }
  return sha;
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
