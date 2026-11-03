import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, sep } from "node:path";
import { appendEvent } from "./events.js";
import { costFromJournal, decideFailure } from "./failure.js";
import { jobBasename, packageRoot } from "./paths.js";

/**
 * Project a yak journal into the kiln event log. Called when a run is
 * observed. `properties.once` makes a second observation of the same journal
 * line a no-op.
 *
 * `run.started` carries the kiln version, the yak version, the workflow
 * name, and a hash of the prompts and skills that workflow is using.
 */

const REVIEW_STEPS = new Set(["security", "ux", "ui", "code"]);
const CLIP = 240;

export interface ProjectRunInput {
  kilnDir: string;
  jobId: string;
  runId: string;
  runDir: string;
  /** Job file workflow (`feature`, `investigation`, …). A fix journal overrides this. */
  workflow: string;
  repo: string;
  testCommand?: string;
  events: readonly unknown[];
}

export function projectRunJournal(input: ProjectRunInput): void {
  try {
    project(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kiln: event log: ${message}`);
  }
}

export function kilnVersion(): string {
  return packageVersion(join(packageRoot(), "package.json"));
}

export function yakVersion(): string {
  const require = createRequire(import.meta.url);
  return packageVersion(require.resolve("@lchase/yak/package.json"));
}

/**
 * SHA-256 of the prompt files this workflow launches with, then any files
 * under the package `skills/` directory. The rendered prompt (preamble plus
 * factory body) is what the run uses when it is already on disk. Otherwise
 * the packaged prompt, combined the same way, is hashed. Labels are basenames
 * for prompts and package-relative paths for skills, so the hash does not
 * depend on the machine path.
 */
export function promptsHash(workflow: string, kilnDir: string, jobId: string): string {
  const hash = createHash("sha256");
  hash.update("prompts\0");
  for (const file of promptFiles(workflow, kilnDir, jobId)) {
    hash.update(file.label);
    hash.update("\0");
    hash.update(file.body);
    hash.update("\0");
  }
  hash.update("skills\0");
  for (const file of skillFiles()) {
    hash.update(file.label);
    hash.update("\0");
    hash.update(file.body);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function project(input: ProjectRunInput): void {
  const workflow = workflowName(input);
  for (let index = 0; index < input.events.length; index += 1) {
    const event = asRecord(input.events[index]);
    if (!event || typeof event.t !== "string") continue;
    if (event.t === "run.started") recordRunStarted(input, workflow);
    else if (event.t === "step.started") recordPhaseStarted(input, event, index);
    else if (event.t === "step.completed" || event.t === "step.failed") recordPhaseFinished(input, event, index);
    else if (event.t === "gate.opened") recordGateOpened(input, event, index);
    else if (event.t === "gate.answered") recordGateResolved(input, event);
    else if (event.t === "run.finished") recordRunFinished(input, event);
  }
}

function recordRunStarted(input: ProjectRunInput, workflow: string): void {
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "run.started",
    properties: {
      kiln_version: kilnVersion(),
      yak_version: yakVersion(),
      workflow,
      prompts_hash: promptsHash(workflow, input.kilnDir, input.jobId),
      repo: input.repo || "unknown",
      once: "run.started",
    },
  });
}

function recordPhaseStarted(input: ProjectRunInput, event: Record<string, unknown>, index: number): void {
  const step = typeof event.stepId === "string" ? event.stepId : "";
  if (!step) return;
  const iteration = iterationOf(event);
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "phase.started",
    step,
    properties: {
      ...(iteration !== undefined ? { iteration } : {}),
      once: `phase.started:${index}`,
    },
  });
}

function recordPhaseFinished(input: ProjectRunInput, event: Record<string, unknown>, index: number): void {
  const step = typeof event.stepId === "string" ? event.stepId : "";
  if (!step) return;
  const failed = event.t === "step.failed";
  const iteration = iterationOf(event);
  const artifactName = typeof event.artifact === "string" ? event.artifact : step;
  const artifact = failed ? undefined : readArtifact(input.runDir, artifactName, iteration);
  const failure = failed ? asRecord(event.failure) : undefined;
  const reason = typeof failure?.reason === "string" ? clip(failure.reason) : undefined;
  const detail = typeof failure?.detail === "string" ? clip(failure.detail) : undefined;
  const verdict = artifact && typeof artifact.verdict === "string" ? clip(artifact.verdict) : undefined;
  const exitCode =
    step === "verify" && artifact && typeof artifact.exitCode === "number" && Number.isInteger(artifact.exitCode)
      ? artifact.exitCode
      : undefined;
  const testCommand = step === "verify" && input.testCommand?.trim() ? clip(input.testCommand.trim()) : undefined;
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "phase.finished",
    step,
    properties: {
      outcome: failed ? "failed" : "completed",
      ...(iteration !== undefined ? { iteration } : {}),
      ...(typeof event.cached === "boolean" ? { cached: event.cached } : {}),
      ...(event.skipped === true ? { skipped: true } : {}),
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
      ...(verdict && REVIEW_STEPS.has(step) ? { verdict } : {}),
      ...(testCommand ? { test_command: testCommand } : {}),
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      once: `phase.finished:${index}`,
    },
  });
}

function recordGateOpened(input: ProjectRunInput, event: Record<string, unknown>, index: number): void {
  const step = typeof event.stepId === "string" ? event.stepId : "";
  if (!step) return;
  const request = readJson(join(input.runDir, "pending", `${step}.request.json`));
  const rendered = request && typeof request.rendered === "string" ? clip(request.rendered.split("\n")[0] ?? "") : "";
  const noted = noteFrom(request);
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "gate.opened",
    step,
    properties: {
      ...(rendered ? { prompt: rendered } : {}),
      ...(noted ?? {}),
      once: `gate.opened:${index}`,
    },
  });
}

function recordGateResolved(input: ProjectRunInput, event: Record<string, unknown>): void {
  const step = typeof event.stepId === "string" ? event.stepId : "";
  if (!step || event.skipped === true) return;
  const answer =
    readJson(join(input.runDir, "pending", `${step}.answer.json`)) ??
    readJson(join(input.runDir, "artifacts", "approval.json"));
  const decision = answer && typeof answer.decision === "string" ? answer.decision : "";
  if (!decision) return;
  const noted = noteFrom(answer);
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "gate.resolved",
    step,
    properties: {
      decision,
      by: "human",
      ...(input.repo ? { repo: input.repo } : {}),
      ...(noted ?? {}),
      once: `gate.resolved:${step}`,
    },
  });
}

function recordRunFinished(input: ProjectRunInput, event: Record<string, unknown>): void {
  const cost = costFromJournal(input.events);
  if (event.status === "ok") {
    appendEvent(input.kilnDir, {
      job_id: input.jobId,
      run_id: input.runId,
      event: "run.finished",
      properties: { status: "ok", tokens: cost.tokens, usd: cost.usd, once: "run.finished" },
    });
    return;
  }
  // A normal failure is classified in recoverRuns, which owns the retry decision.
  // A cancelled run is not recovered, so the class is recorded here.
  if (event.status !== "failed" || event.reason !== "cancelled") return;
  const decision = decideFailure({
    text: "cancelled",
    operational: false,
    blocked: true,
    attempt: 1,
    maxAttempts: Number.MAX_SAFE_INTEGER,
    sameFingerprint: 1,
    maxSameFingerprint: Number.MAX_SAFE_INTEGER,
  });
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "run.failed",
    properties: {
      status: "failed",
      reason: "cancelled",
      class: decision.class,
      fingerprint: decision.fingerprint,
      tokens: cost.tokens,
      usd: cost.usd,
      once: `run.failed:${input.runId}`,
    },
  });
}

function workflowName(input: ProjectRunInput): string {
  const started = input.events.map(asRecord).find((event) => event?.t === "run.started");
  const journal = started && typeof started.workflow === "string" ? started.workflow : "";
  if (journal === "kiln-fix") return "fix";
  if (journal === "kiln-feature") return "feature";
  if (journal === "kiln-investigation") return "investigation";
  if (journal.startsWith("kiln-") && journal.length > "kiln-".length) return journal.slice("kiln-".length);
  return input.workflow || journal || "unknown";
}

function iterationOf(event: Record<string, unknown>): number | undefined {
  return typeof event.iteration === "number" && Number.isInteger(event.iteration) && event.iteration >= 0
    ? event.iteration
    : undefined;
}

function noteFrom(value: Record<string, unknown> | undefined): { note?: string; edit?: string } | undefined {
  if (!value) return undefined;
  const note = typeof value.note === "string" ? clip(value.note) : "";
  const edit = typeof value.edit === "string" ? clip(value.edit) : "";
  if (!note && !edit) return undefined;
  return {
    ...(note ? { note } : {}),
    ...(edit ? { edit } : {}),
  };
}

function readArtifact(runDir: string, name: string, iteration: number | undefined): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  const file = iteration === undefined ? `${name}.json` : `${name}.${iteration}.json`;
  return readJson(join(runDir, "artifacts", file));
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length <= CLIP ? trimmed : `${trimmed.slice(0, CLIP - 1)}…`;
}

interface HashedFile {
  label: string;
  body: string;
}

function promptFiles(workflow: string, kilnDir: string, jobId: string): HashedFile[] {
  const rendered = renderedWorkflow(kilnDir, jobId, workflow);
  const packaged = join(packageRoot(), "workflows", `${workflow}.yaml`);
  const yamlPath = rendered ?? (existsSync(packaged) ? packaged : undefined);
  if (!yamlPath) return [];
  let yaml = "";
  try {
    yaml = readFileSync(yamlPath, "utf8");
  } catch {
    return [];
  }
  const paths = new Set<string>();
  for (const match of yaml.matchAll(/file:\s*(?:"([^"]+\.md)"|'([^']+\.md)'|(\S+\.md))/g)) {
    const found = match[1] ?? match[2] ?? match[3];
    if (found) paths.add(found);
  }
  const files: HashedFile[] = [];
  for (const file of [...paths].sort()) {
    const body = promptBody(file, Boolean(rendered));
    if (body === undefined) continue;
    files.push({ label: basename(file), body });
  }
  files.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
  return files;
}

function renderedWorkflow(kilnDir: string, jobId: string, workflow: string): string | undefined {
  let safe: string;
  try {
    safe = jobBasename(jobId);
  } catch {
    return undefined;
  }
  const path = join(kilnDir, "rendered", safe, `${workflow}.yaml`);
  return existsSync(path) ? path : undefined;
}

/** A rendered prompt is already the combined text. A packaged path is combined here. */
function promptBody(file: string, rendered: boolean): string | undefined {
  const path = file.startsWith("/") || /^[A-Za-z]:/.test(file) ? file : join(packageRoot(), file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (rendered) return text;
  const directive = text.match(/^<!--\s*factory:\s*(prompts\/factory\/[a-z0-9-]+\.md)\s*-->/m);
  if (!directive?.[1]) return text;
  const factoryPath = join(packageRoot(), directive[1]);
  const factoryRoot = join(packageRoot(), "prompts", "factory") + sep;
  if (!factoryPath.startsWith(factoryRoot)) return text;
  try {
    const factory = readFileSync(factoryPath, "utf8");
    return `${text.trimEnd()}\n\n${factory.trimStart()}`;
  } catch {
    return text;
  }
}

function skillFiles(): HashedFile[] {
  const root = packageRoot();
  const dir = join(root, "skills");
  if (!existsSync(dir)) return [];
  const found: HashedFile[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try {
          found.push({ label: relative(root, path), body: readFileSync(path, "utf8") });
        } catch {
          // A skill that cannot be read is left out of this hash.
        }
      }
    }
  };
  walk(dir);
  found.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
  return found;
}

function packageVersion(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
