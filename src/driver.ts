import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { planBasename } from "./plans.js";
import { renderStatus, renderTick, yakCliPath, type LaunchReport } from "./report.js";
import {
  contractPublishers,
  plan,
  publisherKey,
  type Observation,
  type ObservedGate,
  type ObservedPlan,
  type ObservedRun,
  type ObservedTask,
  type RunStatus,
} from "./reconcile.js";
import { PlanSchema, type Plan, type Task } from "./schemas.js";
import { packageRoot } from "./paths.js";
import { validatePlan } from "./validate.js";

interface JournalEvent {
  t: string;
  tag?: string;
  status?: string;
  stepId?: string;
  pid?: number;
}

interface Breadcrumb {
  path: string;
  planId: string;
  taskId: string;
  pid: number;
  logPath: string;
}

interface World {
  observation: Observation;
  plans: Map<string, Plan>;
}

const TAG_PREFIX = "kiln:";

export function taskTag(planId: string, taskId: string): string {
  return `${TAG_PREFIX}${planId}/${taskId}`;
}

export function parseTaskTag(tag: string): { planId: string; taskId: string } | undefined {
  if (!tag.startsWith(TAG_PREFIX)) return undefined;
  const rest = tag.slice(TAG_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { planId: rest.slice(0, slash), taskId: rest.slice(slash + 1) };
}

export function approvePlan(config: LoadedKilnConfig, planId: string): string {
  const file = join(config.plansDir, `${planBasename(planId)}.json`);
  if (!existsSync(file)) {
    throw new Error(`No plan ${planId} at ${file}. Run kiln refine first.`);
  }
  const plan = parseStoredPlan(JSON.parse(readFileSync(file, "utf8")));
  if (plan.requirementId !== planId) {
    throw new Error(`Plan file ${file} is for ${plan.requirementId}, not ${planId}.`);
  }
  mkdirSync(config.plansDir, { recursive: true });
  const approvedPath = join(config.plansDir, `${planBasename(planId)}.approved.json`);
  const body = { planId, approvedAt: new Date().toISOString() };
  writeFileSync(approvedPath, `${JSON.stringify(body, null, 2)}\n`);
  return `Approved ${planId}\nWrote ${approvedPath}\n`;
}

export function runStatus(config: LoadedKilnConfig, planId?: string): string {
  return renderStatus(observe(config).observation, planId);
}

export function runTick(config: LoadedKilnConfig): string {
  return withTickLock(config.kilnDir, () => {
    const world = observe(config);
    const actions = plan(world.observation);
    return apply(config, world, actions);
  });
}

function observe(config: LoadedKilnConfig): World {
  const loaded = loadPlans(config);
  const runs = scanRuns(config);
  const breadcrumbs = readBreadcrumbs(config.kilnDir);
  const tasks: ObservedTask[] = [];
  const publishers: Observation["publishers"] = {};
  const breadcrumbsToClear: Observation["breadcrumbsToClear"] = [];
  const plansById = new Map<string, Plan>();

  for (const loadedPlan of loaded) {
    if (!loadedPlan.plan) continue;
    plansById.set(loadedPlan.meta.planId, loadedPlan.plan);
    Object.assign(publishers, contractPublishers(loadedPlan.meta.planId, loadedPlan.plan));
    for (const task of loadedPlan.plan.tasks) {
      const tag = taskTag(loadedPlan.meta.planId, task.id);
      const run = runs.get(tag);
      const crumb = breadcrumbs.find(
        (candidate) => candidate.planId === loadedPlan.meta.planId && candidate.taskId === task.id,
      );
      if (crumb && run) breadcrumbsToClear.push({ path: crumb.path });
      const childAlive = crumb ? pidAlive(crumb.pid) : false;
      tasks.push({
        planId: loadedPlan.meta.planId,
        taskId: task.id,
        repo: task.repo,
        dependsOn: task.dependsOn,
        approved: loadedPlan.meta.approved,
        launching: Boolean(crumb) && !run && childAlive,
        launchFailed: Boolean(crumb) && !run && !childAlive,
        ...(crumb?.logPath ? { logPath: crumb.logPath } : {}),
        ...(run ? { run } : {}),
      });
    }
  }

  return {
    observation: {
      maxConcurrent: config.maxConcurrent,
      plans: loaded.map((entry) => entry.meta),
      tasks,
      publishers,
      breadcrumbsToClear,
    },
    plans: plansById,
  };
}

function apply(
  config: LoadedKilnConfig,
  world: World,
  actions: ReturnType<typeof plan>,
): string {
  const launches: LaunchReport[] = [];
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") {
      rmSync(action.path, { force: true });
      continue;
    }
    const planFile = world.plans.get(action.planId);
    const task = planFile?.tasks.find((candidate) => candidate.id === action.taskId);
    if (!planFile || !task) {
      throw new Error(`Tick planned a launch for ${action.planId}/${action.taskId}, which is not in the observed plans.`);
    }
    launches.push(launchTask(config, planFile, task));
  }
  return renderTick(world.observation, actions, launches);
}

function launchTask(config: LoadedKilnConfig, planFile: Plan, task: Task): LaunchReport {
  const checkout = config.checkouts[task.repo];
  const testCommand = config.testCommands[task.repo];
  if (!testCommand?.trim()) {
    throw new Error(
      `Repo ${task.repo} has an empty test command. Set repos.${task.repo}.test in the kiln config. The feature workflow refuses to run an empty KILN_TEST.`,
    );
  }
  const workflow = join(packageRoot(), "workflows", "feature.yaml");
  if (!existsSync(workflow)) {
    throw new Error(`Feature workflow not found at ${workflow}.`);
  }
  const logPath = join(
    config.kilnDir,
    "logs",
    planBasename(planFile.requirementId),
    `${planBasename(task.id)}.log`,
  );
  mkdirSync(dirname(logPath), { recursive: true });
  const crumbPath = breadcrumbPath(config.kilnDir, planFile.requirementId, task.id);
  ensureCheckoutExcludes(checkout);

  const input = taskInput(planFile, task);
  const args = [
    yakCliPath(),
    "run",
    workflow,
    "--adapter",
    config.adapter,
    "--isolation",
    "worktree",
    "--tag",
    taskTag(planFile.requirementId, task.id),
  ];
  for (const [key, value] of Object.entries(input)) {
    args.push("--input", `${key}=${value}`);
  }

  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, args, {
      cwd: checkout,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, KILN_TEST: testCommand, KILN_TASK_TITLE: task.title },
    });
    child.unref();
    const pid = child.pid ?? 0;
    writeBreadcrumb(crumbPath, {
      planId: planFile.requirementId,
      taskId: task.id,
      pid,
      logPath,
    });
    return { taskId: task.id, repo: task.repo, output: `pid ${pid}\nlog ${logPath}` };
  } catch (error) {
    writeFileSync(logPath, `${errorMessage(error)}\n`);
    writeBreadcrumb(crumbPath, {
      planId: planFile.requirementId,
      taskId: task.id,
      pid: 0,
      logPath,
    });
    return { taskId: task.id, repo: task.repo, output: `pid 0\nlog ${logPath}` };
  } finally {
    closeSync(logFd);
  }
}

function taskInput(planFile: Plan, task: Task): Record<string, string> {
  const publishers = contractPublishers(planFile.requirementId, planFile);
  const contracts = planFile.contracts.filter((contract) => {
    const publisherId = publishers[publisherKey(planFile.requirementId, contract.id)];
    return task.dependsOn.includes(contract.id) || publisherId === task.id;
  });
  const text = contracts.map(
    (contract) => `${contract.id} (${contract.kind}, owner ${contract.owner}): ${contract.spec}`,
  );
  return {
    title: task.title,
    description: task.description,
    acceptance: task.acceptance.join("\n"),
    contracts: text.length > 0 ? text.join("\n") : "none",
  };
}

interface LoadedPlan {
  meta: ObservedPlan;
  plan?: Plan;
}

function loadPlans(config: LoadedKilnConfig): LoadedPlan[] {
  if (!existsSync(config.plansDir)) return [];
  const files = readdirSync(config.plansDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".approved.json"))
    .sort();
  return files.map((name) => loadPlanFile(config, join(config.plansDir, name)));
}

function loadPlanFile(config: LoadedKilnConfig, file: string): LoadedPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { meta: { planId: planIdFromFile(file), approved: false, error: errorMessage(error) } };
  }
  let plan: Plan;
  try {
    plan = parseStoredPlan(raw);
  } catch (error) {
    return { meta: { planId: planIdFromFile(file), approved: false, error: errorMessage(error) } };
  }
  const approved = existsSync(approvalPath(config, plan.requirementId));
  if (`${planBasename(plan.requirementId)}.json` !== basename(file)) {
    return {
      meta: {
        planId: plan.requirementId,
        approved,
        error: `Plan file ${basename(file)} does not match requirement ${plan.requirementId}.`,
      },
    };
  }
  const issues = validatePlan(plan);
  if (issues.length > 0) {
    return {
      meta: {
        planId: plan.requirementId,
        approved,
        error: issues.map((issue) => issue.message).join(" "),
      },
    };
  }
  return { meta: { planId: plan.requirementId, approved }, plan };
}

function parseStoredPlan(raw: unknown): Plan {
  if (isRefinePlan(raw)) return PlanSchema.parse(raw.plan);
  return PlanSchema.parse(raw);
}

function isRefinePlan(raw: unknown): raw is { kind: "plan"; plan: unknown } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "kind" in raw &&
    raw.kind === "plan" &&
    "plan" in raw
  );
}

function planIdFromFile(file: string): string {
  return basename(file, ".json");
}

function approvalPath(config: LoadedKilnConfig, planId: string): string {
  return join(config.plansDir, `${planBasename(planId)}.approved.json`);
}

function scanRuns(config: LoadedKilnConfig): Map<string, ObservedRun> {
  const byTag = new Map<string, ObservedRun>();
  for (const checkout of Object.values(config.checkouts)) {
    for (const runDir of listRunDirs(checkout)) {
      const events = readJournal(runDir);
      const started = events.find((event) => event.t === "run.started");
      if (!started?.tag || !parseTaskTag(started.tag)) continue;
      const runId = basename(runDir);
      const status = classify(events);
      const gateDecision = status === "ok" ? readApproveDecision(runDir) : undefined;
      const taskTitle = readRunTitle(runDir);
      const run: ObservedRun = {
        runId,
        checkout,
        status,
        gates: status === "suspended" ? openGates(runDir, events) : [],
        ...(gateDecision ? { gateDecision } : {}),
        ...(taskTitle ? { taskTitle } : {}),
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
  const files = [
    join(runDir, "artifacts", "approval.json"),
    join(runDir, "pending", "approve.answer.json"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { decision?: unknown };
      if (parsed.decision === "approve" || parsed.decision === "reject") return parsed.decision;
    } catch {
      // A partial artifact is not a decision.
    }
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

function breadcrumbPath(kilnDir: string, planId: string, taskId: string): string {
  return join(kilnDir, "launching", planBasename(planId), `${planBasename(taskId)}.json`);
}

function writeBreadcrumb(path: string, body: Omit<Breadcrumb, "path">): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function readBreadcrumbs(kilnDir: string): Breadcrumb[] {
  const root = join(kilnDir, "launching");
  if (!existsSync(root)) return [];
  const found: Breadcrumb[] = [];
  for (const planDir of readdirSync(root, { withFileTypes: true })) {
    if (!planDir.isDirectory()) continue;
    const dir = join(root, planDir.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<Breadcrumb, "path">>;
        if (!parsed.planId || !parsed.taskId) continue;
        found.push({
          path,
          planId: parsed.planId,
          taskId: parsed.taskId,
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          logPath: typeof parsed.logPath === "string" ? parsed.logPath : "",
        });
      } catch {
        // An unreadable crumb is left for a person. It does not count as a task.
      }
    }
  }
  return found;
}

/** The checkout's git metadata must not show up in `git status` or a later `git add`. */
function ensureCheckoutExcludes(checkout: string): void {
  const gitDir = join(checkout, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
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
