import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { planBasename } from "./plans.js";
import { renderStatus, renderTick, type LaunchReport } from "./report.js";
import {
  contractPublishers,
  plan,
  type Observation,
  type ObservedGate,
  type ObservedPlan,
  type ObservedRun,
  type ObservedTask,
  type RunStatus,
} from "./reconcile.js";
import { PlanSchema, type Plan, type Repo, type Task } from "./schemas.js";
import { packageRoot } from "./paths.js";
import { validatePlan } from "./validate.js";

interface JournalEvent {
  t: string;
  tag?: string;
  status?: string;
  stepId?: string;
}

interface Breadcrumb {
  path: string;
  planId: string;
  taskId: string;
  repo: Repo;
  tickPid: number;
  startedAt: string;
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
      tasks.push({
        planId: loadedPlan.meta.planId,
        taskId: task.id,
        repo: task.repo,
        title: task.title,
        dependsOn: task.dependsOn,
        approved: loadedPlan.meta.approved,
        launching: Boolean(crumb) && !run,
        ...(crumb && !run ? { breadcrumbPath: crumb.path } : {}),
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
  if (!testCommand) {
    throw new Error(
      `Repo ${task.repo} has no test command. Set repos.${task.repo}.test in the kiln config. The feature workflow runs that command as its verify step.`,
    );
  }
  const workflow = join(packageRoot(), "workflows", "feature.yaml");
  if (!existsSync(workflow)) {
    throw new Error(`Feature workflow not found at ${workflow}.`);
  }
  const yak = join(packageRoot(), "node_modules", "@lchase", "yak", "dist", "index.js");
  const crumbPath = breadcrumbPath(config.kilnDir, planFile.requirementId, task.id);
  writeBreadcrumb(crumbPath, {
    planId: planFile.requirementId,
    taskId: task.id,
    repo: task.repo,
    tickPid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const input = taskInput(planFile, task);
  const args = [yak, "run", workflow, "--adapter", config.adapter, "--tag", taskTag(planFile.requirementId, task.id)];
  for (const [key, value] of Object.entries(input)) {
    args.push("--input", `${key}=${value}`);
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, KILN_TEST: testCommand },
    });
  } finally {
    // The journal is the link once yak has returned. A breadcrumb left behind
    // means this process died during the spawn; the next tick keeps the task
    // in `launching` until a journal with the tag shows up, or a person
    // deletes the file.
    rmSync(crumbPath, { force: true });
  }

  if (result.error) {
    throw new Error(`Could not run yak for ${task.id}: ${result.error.message}`);
  }
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  if (result.status !== 0 && result.status !== 1 && result.status !== 78) {
    throw new Error(`yak exited ${String(result.status)} for ${task.id}:\n${output}`);
  }
  return { taskId: task.id, repo: task.repo, output };
}

function taskInput(planFile: Plan, task: Task): Record<string, string> {
  const contracts = planFile.contracts.filter(
    (contract) =>
      task.dependsOn.includes(contract.id) ||
      (task.repo === contract.owner && !task.dependsOn.includes(contract.id)),
  );
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
      const run: ObservedRun = {
        runId,
        checkout,
        status,
        gates: status === "suspended" ? openGates(runDir, events) : [],
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
  const events: JournalEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch (error) {
      throw new Error(`Could not read ${file}: ${errorMessage(error)}`);
    }
  }
  return events;
}

function classify(events: JournalEvent[]): RunStatus {
  const last = events.at(-1);
  if (last?.t === "run.finished" && (last.status === "ok" || last.status === "failed" || last.status === "suspended")) {
    return last.status;
  }
  return "alive";
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
  const answerJson = suggestedAnswer(request.answerSchema);
  return { stepId, prompt, ...(answerJson ? { answerJson } : {}) };
}

function suggestedAnswer(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) return undefined;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const required = "required" in schema && Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];
  const answer: Record<string, unknown> = {};
  for (const key of required) {
    const prop = (properties as Record<string, unknown>)[key];
    if (typeof prop !== "object" || prop === null) return undefined;
    const values = "enum" in prop && Array.isArray(prop.enum) ? prop.enum : undefined;
    if (!values || values.length === 0) return undefined;
    const preferred = values.find((value) => value === "approve" || value === "continue");
    answer[key] = preferred ?? values[0];
  }
  return Object.keys(answer).length > 0 ? JSON.stringify(answer) : undefined;
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
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Omit<Breadcrumb, "path">;
        if (!parsed.planId || !parsed.taskId) continue;
        found.push({ ...parsed, path });
      } catch {
        // An unreadable crumb is left for a person. It does not count as a task.
      }
    }
  }
  return found;
}

function withTickLock<T>(kilnDir: string, fn: () => T): T {
  mkdirSync(kilnDir, { recursive: true });
  const lockPath = join(kilnDir, "tick.lock");
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
    } catch {
      // The lock file is already gone.
    }
  }
}

function acquireLock(lockPath: string): number {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (pidAlive(pid)) {
        throw new Error(`Another kiln tick is running (pid ${pid}).`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire tick lock ${lockPath}.`);
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
