import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";
import { STEP_NAME, planOf } from "./step-result.js";

/**
 * Everything a run's steps wrote to `<runDir>/artifacts`, grouped for the job page's Artifacts column: what was
 * made before the first round, then each round (newest first). Which artifacts exist depends on the workflow, so
 * nothing here assumes a step list. A file whose shape is not recognised still shows its text fields.
 */

export type ArtifactTone = "pass" | "bad" | "warn" | "neutral";
export type ArtifactKind = "ask" | "spec" | "build" | "verify" | "review" | "approver" | "other";

export interface ArtifactEntry {
  /** The artifact's file name without the round or `.json`: `security`, `decision`. */
  name: string;
  /** The workflow step that produced it, so the label can match the step track. */
  stepId: string;
  kind: ArtifactKind;
  /** The headline word: PASS, FAIL, CHANGES, APPROVE, or a plain noun. */
  chip: string;
  tone: ArtifactTone;
  /** Quiet text after the chip: `2 notes`, `exit 1`. */
  detail?: string;
  /** One short plain-text line for the closed entry. */
  preview: string;
  /** `markdown` is rendered by the page, `text` is shown as-is in a block. */
  format: "markdown" | "text";
  body: string;
}

export interface ArtifactRound {
  round: number;
  /** The highest round. Its entries include the artifacts a step after the loop wrote once (the approver's). */
  latest: boolean;
  entries: ArtifactEntry[];
}

export interface ArtifactSet {
  /** Made before the first round: the ask and the spec. */
  start: ArtifactEntry[];
  /** Newest first. */
  rounds: ArtifactRound[];
}

export const EMPTY_ARTIFACTS: ArtifactSet = { start: [], rounds: [] };

const FILE = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.(\d+))?\.json$/;
/** Aggregates and the person's own click, not a step's output. */
const SKIPPED = new Set(["rounds", "approval"]);
const MAX_FILES = 80;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY = 20_000;
const PREVIEW = 170;
const TAIL_LINES = 40;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

interface Found {
  name: string;
  round?: number;
  value: Record<string, unknown>;
}

export function readRunArtifacts(runDir: string | undefined): ArtifactSet {
  if (!runDir) return EMPTY_ARTIFACTS;
  const dir = artifactsDir(runDir);
  const found = dir ? readFound(dir) : [];
  if (found.length === 0) return EMPTY_ARTIFACTS;
  const plan = planIndex(runDir);
  const entries = new Map<Found, ArtifactEntry>(found.map((item) => [item, describe(item.name, plan.stepOf.get(item.name) ?? item.name, item.value)]));
  // The ask comes before every step. A name the plan does not know sorts last.
  const order = (item: Found) => (item.name === "input" ? -1 : (plan.order.get(item.name) ?? Number.MAX_SAFE_INTEGER));
  const byPlan = (left: Found, right: Found) => order(left) - order(right) || left.name.localeCompare(right.name);

  const numbered = found.filter((item) => item.round !== undefined);
  if (numbered.length === 0) {
    return { start: found.sort(byPlan).map((item) => entries.get(item)!), rounds: [] };
  }
  const roundNumbers = [...new Set(numbered.map((item) => item.round as number))].sort((a, b) => b - a);
  const latest = roundNumbers[0] as number;
  const firstLoop = Math.min(...numbered.map(order));
  const start: Found[] = [];
  const perRound = new Map<number, Found[]>(roundNumbers.map((round) => [round, []]));
  for (const item of found) {
    if (item.round !== undefined) perRound.get(item.round)?.push(item);
    else if (item.name === "input" || order(item) < firstLoop) start.push(item);
    else perRound.get(latest)?.push(item);
  }
  return {
    start: start.sort(byPlan).map((item) => entries.get(item)!),
    rounds: roundNumbers.map((round) => ({
      round,
      latest: round === latest,
      entries: (perRound.get(round) ?? []).sort(byPlan).map((item) => entries.get(item)!),
    })),
  };
}

/**
 * `<runDir>/artifacts`, only when it is a real directory directly inside the real run folder. A symlinked folder
 * (or a symlink anywhere in that path) could point the page at files that are not the run's, so it reads nothing.
 */
function artifactsDir(runDir: string): string | undefined {
  const dir = join(runDir, "artifacts");
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    return realpathSync(dir) === join(realpathSync(runDir), "artifacts") ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses one artifact file. It opens without following a final symlink, then checks the type and size on the open
 * handle and reads from that same handle, so the file cannot be swapped between the check and the read.
 */
function readJson(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readFound(dir: string): Found[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: Found[] = [];
  for (const file of names.sort()) {
    const match = FILE.exec(file);
    const name = match?.[1];
    if (!match || !name || SKIPPED.has(name) || !STEP_NAME.test(name)) continue;
    if (found.length >= MAX_FILES) break;
    const value = readJson(join(dir, file));
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    found.push({ name, ...(match[2] !== undefined ? { round: Number(match[2]) } : {}), value: value as Record<string, unknown> });
  }
  return found;
}

interface PlanIndex {
  /** Artifact name to the step that produces it. */
  stepOf: Map<string, string>;
  /** Artifact name to its position in the plan, so entries read in the order the steps ran. */
  order: Map<string, number>;
}

/** Walks `<runDir>/workflow.json` the way `findStep` does: loop bodies and map steps count, in order. */
function planIndex(runDir: string): PlanIndex {
  const stepOf = new Map<string, string>();
  const order = new Map<string, number>();
  const walk = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (typeof step !== "object" || step === null) continue;
      const record = step as Record<string, unknown>;
      if (record.kind === "loop") walk(record.body);
      else if (record.kind === "map") walk([record.step]);
      else if (typeof record.id === "string") {
        const name = typeof record.produces === "string" ? record.produces : record.id;
        if (!stepOf.has(name)) {
          stepOf.set(name, record.id);
          order.set(name, order.size);
        }
      }
    }
  };
  walk(planOf(runDir));
  return { stepOf, order };
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? redact(value) : undefined;
}

function clip(value: string): string {
  return value.length > MAX_BODY ? `${value.slice(0, MAX_BODY).trimEnd()}\n...` : value;
}

/** A plain one-liner from markdown: headings, list markers, finding tags, and code ticks removed. */
export function previewOf(markdown: string): string {
  const plain = markdown
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?(?:AC\d+:\s*)?/gm, "")
    .replace(/\[(?:must|should|nit|follow-up)\]\s*/g, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW ? `${plain.slice(0, PREVIEW).trimEnd()}...` : plain;
}

function describe(name: string, stepId: string, record: Record<string, unknown>): ArtifactEntry {
  const base = { name, stepId };
  if (name === "input") {
    const description = text(record, "description") ?? text(record, "title") ?? "";
    return { ...base, kind: "ask", chip: "Ticket", tone: "neutral", preview: previewOf(description), format: "markdown", body: clip(description) };
  }
  const verdict = text(record, "verdict");
  const findings = text(record, "findings");
  if (verdict !== undefined && findings !== undefined) {
    const must = (findings.match(/^\s*-\s*\[must\]/gm) ?? []).length;
    const notes = (findings.match(/^\s*-\s*\[(?:should|nit|follow-up)\]/gm) ?? []).length;
    const word = verdict.toUpperCase();
    const failed = /FAIL|REJECT/.test(word);
    const detail = must > 0 ? `${must} must fix` : notes > 0 ? `${notes} note${notes === 1 ? "" : "s"}` : undefined;
    return {
      ...base,
      kind: "review",
      chip: word === "PASS" ? "PASS" : failed ? word : "CHANGES",
      tone: word === "PASS" ? "pass" : failed ? "bad" : "warn",
      ...(detail ? { detail } : {}),
      preview: previewOf(findings),
      format: "markdown",
      body: clip(findings),
    };
  }
  const exit = record.exitCode;
  if ((typeof exit === "number" || exit === null) && (typeof record.stdout === "string" || typeof record.stderr === "string" || typeof exit === "number")) {
    const out = typeof record.stdout === "string" ? record.stdout : "";
    const err = typeof record.stderr === "string" ? record.stderr : "";
    const output = redact(`${out}${out && err ? "\n" : ""}${err}`.replace(ANSI, "")).trim();
    const ok = exit === 0;
    const passed = ok ? (output.match(/(\d+) passed/g) ?? []).pop() : undefined;
    return {
      ...base,
      kind: "verify",
      chip: ok ? "PASS" : "FAIL",
      tone: ok ? "pass" : "bad",
      detail: ok ? (passed ?? "exit 0") : `exit ${typeof exit === "number" ? exit : "?"}`,
      preview: ok ? "Tests and checks, exit 0" : "The check command failed",
      format: "text",
      body: clip(output.split("\n").slice(-TAIL_LINES).join("\n")),
    };
  }
  const decision = text(record, "decision");
  const reason = text(record, "reason");
  if (decision !== undefined && reason !== undefined) {
    const word = decision.toUpperCase();
    return {
      ...base,
      kind: "approver",
      chip: word,
      tone: /APPROVE/.test(word) ? "pass" : /REJECT/.test(word) ? "bad" : "warn",
      preview: previewOf(reason),
      format: "markdown",
      body: clip(reason),
    };
  }
  const status = text(record, "status");
  const summary = text(record, "summary");
  if (status !== undefined && summary !== undefined) {
    return { ...base, kind: "build", chip: "Summary", tone: "neutral", preview: previewOf(summary.replace(/^#\s.*\n/, "")), format: "markdown", body: clip(summary) };
  }
  const goal = text(record, "goal");
  const design = text(record, "design");
  const acceptance = text(record, "acceptance");
  if (goal !== undefined && design !== undefined && acceptance !== undefined) {
    const criteria = (acceptance.match(/^\s*-\s*\[[ xX]\]/gm) ?? []).length;
    return {
      ...base,
      kind: "spec",
      chip: criteria > 0 ? `Design and ${criteria} criteria` : "Spec",
      tone: "neutral",
      preview: previewOf(acceptance || goal),
      format: "markdown",
      body: clip(`## Goal\n\n${goal}\n\n## Design\n\n${design}\n\n${acceptance}`),
    };
  }
  const sections: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim()) sections.push(`## ${key}\n\n${redact(value)}`);
  }
  const body = sections.join("\n\n");
  return { ...base, kind: "other", chip: "Result", tone: "neutral", preview: previewOf(body), format: "markdown", body: clip(body) };
}
