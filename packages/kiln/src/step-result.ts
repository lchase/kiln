import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReviewStep } from "./job-view.js";
import { redact } from "./redact.js";

/**
 * What one step of a run produced, read from `<runDir>/artifacts`. The step page's Result view renders this.
 * Only the latest round's artifact is read.
 */
export type StepResult =
  | { kind: "spec"; goal: string; design: string; acceptance: string }
  | { kind: "build"; status: string; summary: string }
  | { kind: "verify"; exitCode: number | null; tail: string }
  | { kind: "review"; verdict: string; findings: string }
  | { kind: "approver"; decision: string; reason: string }
  | { kind: "none" };

export interface StepRead {
  result: StepResult;
  /** The workflow step's `model`, for an agent step. */
  model?: string;
  /** The workflow step's kind: agent, command, gate, transform. */
  stepKind?: string;
}

/** Same shape as `ARTIFACT_FILE` in activity.ts. Nothing else goes into a path. */
export const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The same tail rule activity.ts uses for command output. */
const TAIL_LINES = 40;

interface PlanStep {
  produces?: string;
  model?: string;
  kind?: string;
}

export function readStepResult(runDir: string | undefined, stepId: string): StepRead {
  if (!runDir || !STEP_NAME.test(stepId)) return { result: { kind: "none" } };
  const plan = planStep(runDir, stepId);
  const name = plan?.produces ?? stepId;
  const meta: Omit<StepRead, "result"> = {
    ...(plan?.model ? { model: plan.model } : {}),
    ...(plan?.kind ? { stepKind: plan.kind } : {}),
  };
  if (!STEP_NAME.test(name)) return { result: { kind: "none" }, ...meta };
  const value = latestArtifact(join(runDir, "artifacts"), name);
  return { result: resultOf(stepId, value), ...meta };
}

function planStep(runDir: string, stepId: string): PlanStep | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(runDir, "workflow.json"), "utf8"));
  } catch {
    return undefined;
  }
  const steps = parsed && typeof parsed === "object" && "steps" in parsed ? parsed.steps : undefined;
  return findStep(steps, stepId);
}

/** Walks loop bodies and map steps the way `leafStepIds` in workflow.ts does. */
function findStep(steps: unknown, stepId: string): PlanStep | undefined {
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    if (record.kind === "loop") {
      const found = findStep(record.body, stepId);
      if (found) return found;
      continue;
    }
    if (record.kind === "map") {
      const found = findStep([record.step], stepId);
      if (found) return found;
      continue;
    }
    if (record.id !== stepId) continue;
    return {
      ...(typeof record.produces === "string" ? { produces: record.produces } : {}),
      ...(typeof record.model === "string" ? { model: record.model } : {}),
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    };
  }
  return undefined;
}

/** The highest `<name>.<n>.json` (a loop round), else `<name>.json`. */
function latestArtifact(dir: string, name: string): unknown {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { file: string; round: number } | undefined;
  for (const file of names) {
    if (file === `${name}.json`) {
      if (!best) best = { file, round: -1 };
      continue;
    }
    if (!file.startsWith(`${name}.`) || !file.endsWith(".json")) continue;
    const round = file.slice(name.length + 1, -".json".length);
    if (!/^\d+$/.test(round)) continue;
    const n = Number(round);
    if (!best || n > best.round) best = { file, round: n };
  }
  if (!best) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, best.file), "utf8"));
  } catch {
    return undefined;
  }
}

function resultOf(stepId: string, value: unknown): StepResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "none" };
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? redact(record[key] as string) : undefined);
  if (stepId === "spec") {
    const goal = text("goal");
    const design = text("design");
    const acceptance = text("acceptance");
    return goal !== undefined && design !== undefined && acceptance !== undefined ? { kind: "spec", goal, design, acceptance } : { kind: "none" };
  }
  if (stepId === "build") {
    const status = text("status");
    const summary = text("summary");
    return status !== undefined && summary !== undefined ? { kind: "build", status, summary } : { kind: "none" };
  }
  if (stepId === "verify") {
    const stdout = record.stdout;
    const stderr = record.stderr;
    const exit = record.exitCode;
    if (stdout !== undefined && typeof stdout !== "string") return { kind: "none" };
    if (stderr !== undefined && typeof stderr !== "string") return { kind: "none" };
    if (exit !== undefined && exit !== null && typeof exit !== "number") return { kind: "none" };
    if (stdout === undefined && stderr === undefined && exit === undefined) return { kind: "none" };
    const out = stdout ?? "";
    const err = stderr ?? "";
    const output = `${out}${out && err ? "\n" : ""}${err}`.trim();
    return { kind: "verify", exitCode: typeof exit === "number" ? exit : null, tail: redact(output.split("\n").slice(-TAIL_LINES).join("\n")) };
  }
  if (isReviewStep(stepId)) {
    const verdict = text("verdict");
    const findings = text("findings");
    return verdict !== undefined && findings !== undefined ? { kind: "review", verdict, findings } : { kind: "none" };
  }
  if (stepId === "approver") {
    const decision = text("decision");
    const reason = text("reason");
    return decision !== undefined && reason !== undefined ? { kind: "approver", decision, reason } : { kind: "none" };
  }
  return { kind: "none" };
}
