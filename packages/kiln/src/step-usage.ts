import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";
import type { StepPhase } from "./report.js";
import { STEP_NAME, findStep, planOf } from "./step-result.js";

/**
 * The model each step ran on and what it cost, read from `<runDir>/sessions/<step>.jsonl`.
 *
 * The claude-code adapter appends the raw SDK stream there, one invocation after another, so a step
 * that ran twice has two `result` lines. One `result` line is one round. Assistant lines carry
 * `message.model`. A value the session does not report stays `undefined`, never 0.
 */

export interface UsageRound {
  usd?: number;
  /** `input_tokens + output_tokens`, the sum yak's budget uses. */
  tokens?: number;
}

export interface StepUsage {
  stepId: string;
  /** The exact model id from the session, else the workflow's family name. */
  model?: string;
  /** `session`: observed. `workflow`: the configured family, because the session has not recorded one. */
  modelSource?: "session" | "workflow";
  rounds: UsageRound[];
  /** Sum over rounds. Set only when every round has a cost. */
  usd?: number;
  /** Sum over rounds. Set only when every round has a token count. */
  tokens?: number;
}

/** Where a step stands, from the journal. `pending` means it has not started. */
export interface StepPlanEntry {
  id: string;
  phase: StepPhase;
}

/** Letters, digits, `.`, `-`, `_`, `[`, `]`, `:`. Anything else is not shown. */
const MODEL_ID = /^[A-Za-z0-9._:[\]-]{1,100}$/;
const RESULT_LINE = /"type"\s*:\s*"result"/;
const ASSISTANT_LINE = /"type"\s*:\s*"assistant"/;
const CHUNK = 1 << 20;
/** A line longer than this is skipped rather than held in memory. */
const MAX_LINE = 8 << 20;
const NEWLINE = 0x0a;

interface Scan {
  size: number;
  mtimeMs: number;
  ino: number;
  /** Byte just after the last complete line read. */
  offset: number;
  model?: string;
  rounds: UsageRound[];
}

const scans = new Map<string, Scan>();
const counter = { reads: 0, bytes: 0 };

/** Test hook: file reads and bytes read since the process started. */
export function stepUsageReads(): { reads: number; bytes: number } {
  return { ...counter };
}

/**
 * One entry per step with a session file, plus agent steps that have started but have written no
 * session yet, in plan order. Only plan ids that match `STEP_NAME` go into a path.
 */
export function readStepUsage(runDir: string | undefined, plan: readonly StepPlanEntry[]): StepUsage[] {
  if (!runDir) return [];
  let steps: unknown;
  let loaded = false;
  const workflowStep = (id: string) => {
    if (!loaded) {
      steps = planOf(runDir);
      loaded = true;
    }
    return findStep(steps, id);
  };
  const out: StepUsage[] = [];
  const seen = new Set<string>();
  for (const entry of plan) {
    if (!STEP_NAME.test(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const scan = scanSession(join(runDir, "sessions", `${entry.id}.jsonl`));
    if (!scan) {
      if (entry.phase === "pending") continue;
      const configured = workflowStep(entry.id);
      if (configured?.kind !== "agent") continue;
      out.push({ stepId: entry.id, ...configuredModel(configured.model), rounds: [] });
      continue;
    }
    const model = scan.model
      ? { model: scan.model, modelSource: "session" as const }
      : configuredModel(workflowStep(entry.id)?.model);
    out.push({ stepId: entry.id, ...model, rounds: scan.rounds.map((round) => ({ ...round })), ...totals(scan.rounds) });
  }
  return out;
}

function configuredModel(model: string | undefined): Pick<StepUsage, "model" | "modelSource"> {
  const clean = modelId(model);
  return clean ? { model: clean, modelSource: "workflow" } : {};
}

function totals(rounds: readonly UsageRound[]): Pick<StepUsage, "usd" | "tokens"> {
  if (rounds.length === 0) return {};
  const usd = rounds.every((round) => round.usd !== undefined) ? rounds.reduce((sum, round) => sum + (round.usd ?? 0), 0) : undefined;
  const tokens = rounds.every((round) => round.tokens !== undefined) ? rounds.reduce((sum, round) => sum + (round.tokens ?? 0), 0) : undefined;
  return { ...(usd !== undefined ? { usd } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}

/**
 * The cached scan of one session. Unchanged size and mtime: no read. Grown: only the bytes after the
 * last complete line. Shrunk or replaced: one rescan from the start.
 */
function scanSession(file: string): Scan | undefined {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    scans.delete(file);
    return undefined;
  }
  // A symlink or anything else that is not a regular file is not read.
  if (!stat.isFile()) return undefined;
  const hit = scans.get(file);
  if (hit && hit.ino === stat.ino && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit;
  const resume = hit && hit.ino === stat.ino && stat.size > hit.size;
  const scan: Scan = resume
    ? { ...hit, rounds: [...hit.rounds], size: stat.size, mtimeMs: stat.mtimeMs }
    : { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, offset: 0, rounds: [] };
  try {
    readFrom(file, scan, stat.size);
  } catch {
    return hit;
  }
  scans.delete(file);
  scans.set(file, scan);
  // ponytail: oldest-inserted eviction at 200 files, as `sessionOf` in activity.ts.
  if (scans.size > 200) scans.delete(scans.keys().next().value as string);
  return scan;
}

function readFrom(file: string, scan: Scan, size: number): void {
  if (size <= scan.offset) return;
  const fd = openSync(file, "r");
  try {
    let position = scan.offset;
    let carry = Buffer.alloc(0);
    let skipping = false;
    while (position < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - position));
      const read = readSync(fd, buffer, 0, buffer.length, position);
      counter.reads += 1;
      counter.bytes += read;
      if (read <= 0) break;
      position += read;
      const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      const end = chunk.lastIndexOf(NEWLINE);
      if (end === -1) {
        carry = chunk;
        if (carry.length > MAX_LINE) {
          skipping = true;
          carry = Buffer.alloc(0);
        }
        continue;
      }
      const lines = chunk.subarray(0, end).toString("utf8").split("\n");
      // The head of an over-long line was dropped; its tail is not a line.
      if (skipping) lines.shift();
      skipping = false;
      for (const line of lines) take(line, scan);
      carry = Buffer.from(chunk.subarray(end + 1));
    }
    scan.offset = position - carry.length;
  } finally {
    closeSync(fd);
  }
}

/** Parses only the lines that can matter: results, and assistant lines until a model is known. */
function take(line: string, scan: Scan): void {
  const isResult = RESULT_LINE.test(line);
  if (!isResult && (scan.model || !ASSISTANT_LINE.test(line))) return;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    record = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (record.type === "result") {
    scan.rounds.push(roundOf(record));
    return;
  }
  if (record.type === "assistant" && !scan.model) {
    const message = record.message;
    const model = message && typeof message === "object" ? (message as { model?: unknown }).model : undefined;
    const clean = typeof model === "string" ? modelId(model) : undefined;
    if (clean) scan.model = clean;
  }
}

function roundOf(record: Record<string, unknown>): UsageRound {
  const cost = record.total_cost_usd;
  const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : {};
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const usd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  const tokens = count(input) && count(output) ? input + output : undefined;
  return { ...(usd !== undefined ? { usd } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Redacted, then held to the id pattern. Anything redaction touched is dropped. */
function modelId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (redact(trimmed) !== trimmed) return undefined;
  return MODEL_ID.test(trimmed) ? trimmed : undefined;
}
