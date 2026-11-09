import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { redactDeep } from "./redact.js";

/**
 * Append-only event log at `<kilnDir>/events.jsonl` (`~/.kiln/events.jsonl`
 * when that directory is the kiln home). One module writes it. One reader
 * parses it. A write failure is reported and does not escape to the caller.
 *
 * `run_id` and `step` are null when the moment has none. `job_id` is null
 * for `config.reloaded`, `kiln.paused`, `kiln.resumed`, `budget.blocked`,
 * and trigger fires that do not belong to a job yet.
 */

export const EVENT_NAMES = [
  "job.added",
  "job.cancelled",
  "job.retried",
  "run.started",
  "phase.started",
  "phase.finished",
  "gate.opened",
  "gate.resolved",
  "run.failed",
  "run.finished",
  "pr.opened",
  "pr.feedback",
  "worktree.cleaned",
  "worktree.kept",
  "config.reloaded",
  "needs-human",
  "kiln.paused",
  "kiln.resumed",
  "budget.blocked",
  "trigger.fired",
  "trigger.routed",
  "trigger.failed",
  "trigger.skipped",
  "review.posted",
  "review.failed",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const once = z.string().min(1).optional();

const JobAdded = z.object({
  repo: z.string().min(1),
  workflow: z.string().min(1),
  title: z.string().min(1),
  source_kind: z.string().min(1).optional(),
  once,
});
const JobRetried = z.object({
  by: z.literal("human"),
  repo: z.string().min(1),
  once,
});
const JobCancelled = z.object({
  repo: z.string().min(1),
  workflow: z.string().min(1),
  once,
});
const RunStarted = z.object({
  kiln_version: z.string().min(1),
  yak_version: z.string().min(1),
  workflow: z.string().min(1),
  prompts_hash: z.string().min(1),
  repo: z.string().min(1),
  once,
});
const PhaseStarted = z.object({
  iteration: z.number().int().nonnegative().optional(),
  once,
});
const PhaseFinished = z.object({
  outcome: z.enum(["completed", "failed"]),
  iteration: z.number().int().nonnegative().optional(),
  cached: z.boolean().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  verdict: z.string().min(1).optional(),
  test_command: z.string().min(1).optional(),
  exit_code: z.number().int().optional(),
  once,
});
const GateOpened = z.object({
  prompt: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  edit: z.string().min(1).optional(),
  once,
});
const GateResolved = z.object({
  decision: z.string().min(1),
  by: z.string().min(1),
  repo: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  edit: z.string().min(1).optional(),
  once,
});
const costFields = {
  /** Sum of yak `budget.consumed` tokens. Null when the journal did not report any. */
  tokens: z.number().nonnegative().nullable().optional(),
  /** Sum of reported dollars. Null when the journal did not report any. Never invented. */
  usd: z.number().nonnegative().nullable().optional(),
};
const RunFailed = z.object({
  reason: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  class: z.enum(["transient", "deterministic", "budget"]).optional(),
  fingerprint: z.string().min(1).optional(),
  ...costFields,
  once,
});
const RunFinished = z.object({
  status: z.literal("ok"),
  ...costFields,
  once,
});
const PrOpened = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  once,
});
const PrFeedback = z.object({
  round: z.number().int().positive(),
  trigger: z.enum(["ci", "review"]),
  outcome: z.enum(["fixed", "pushed"]).optional(),
  items: z.number().int().nonnegative().optional(),
  once,
});
const Worktree = z.object({ once });
const ConfigReloaded = z.object({ once });
const NeedsHuman = z.object({
  reason: z.string().min(1),
  once,
});
const FactoryToggle = z.object({ once });
const BudgetBlocked = z.object({
  day: z.string().min(1),
  usd: z.number().nonnegative(),
  cap: z.number().nonnegative(),
  once,
});
const TriggerFired = z.object({
  trigger_id: z.string().min(1),
  source: z.enum(["schedule", "jira", "pr", "review"]),
  /** Stable dedupe id. Not named `key`: the redactor masks any property with that name. */
  dedupe: z.string().min(1),
  external_id: z.string().min(1),
  revision: z.string().min(1),
  repo: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  once,
});
const TriggerRouted = z.object({
  trigger_id: z.string().min(1),
  dedupe: z.string().min(1),
  action: z.enum(["create", "attach"]),
  workflow: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  once,
});
const TriggerFailed = z.object({
  trigger_id: z.string().min(1),
  error: z.string().min(1),
  once,
});
const TriggerSkipped = z.object({
  trigger_id: z.string().min(1),
  reason: z.enum(["paused", "capped", "burst-cap", "queued-cap"]),
  /** Pull request or issue the skip applies to, when the fire skipped one item. */
  external_id: z.string().min(1).optional(),
  once,
});
const ReviewPosted = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  review_id: z.string().min(1),
  url: z.string().min(1),
  findings: z.number().int().nonnegative(),
  inline: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** `review:<repo>:<number>:<head sha>`. Same shape as the review-request dedupe. */
  dedupe: z.string().min(1),
  once,
});
const ReviewFailed = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  class: z.enum(["transient", "deterministic", "budget"]),
  detail: z.string().min(1),
  dedupe: z.string().min(1),
  once,
});

const envelope = {
  id: z.string().min(1),
  ts: z.string().regex(ISO_UTC, "ts must be ISO-8601 UTC"),
  run_id: z.string().min(1).nullable(),
  step: z.string().min(1).nullable(),
};

export const EventSchema = z.discriminatedUnion("event", [
  z.object({ ...envelope, event: z.literal("job.added"), job_id: z.string().min(1), properties: JobAdded }),
  z.object({ ...envelope, event: z.literal("job.cancelled"), job_id: z.string().min(1), properties: JobCancelled }),
  z.object({ ...envelope, event: z.literal("job.retried"), job_id: z.string().min(1), properties: JobRetried }),
  z.object({ ...envelope, event: z.literal("run.started"), job_id: z.string().min(1), properties: RunStarted }),
  z.object({ ...envelope, event: z.literal("phase.started"), job_id: z.string().min(1), properties: PhaseStarted }),
  z.object({ ...envelope, event: z.literal("phase.finished"), job_id: z.string().min(1), properties: PhaseFinished }),
  z.object({ ...envelope, event: z.literal("gate.opened"), job_id: z.string().min(1), properties: GateOpened }),
  z.object({ ...envelope, event: z.literal("gate.resolved"), job_id: z.string().min(1), properties: GateResolved }),
  z.object({ ...envelope, event: z.literal("run.failed"), job_id: z.string().min(1), properties: RunFailed }),
  z.object({ ...envelope, event: z.literal("run.finished"), job_id: z.string().min(1), properties: RunFinished }),
  z.object({ ...envelope, event: z.literal("pr.opened"), job_id: z.string().min(1), properties: PrOpened }),
  z.object({ ...envelope, event: z.literal("pr.feedback"), job_id: z.string().min(1), properties: PrFeedback }),
  z.object({ ...envelope, event: z.literal("worktree.cleaned"), job_id: z.string().min(1), properties: Worktree }),
  z.object({ ...envelope, event: z.literal("worktree.kept"), job_id: z.string().min(1), properties: Worktree }),
  z.object({
    ...envelope,
    event: z.literal("config.reloaded"),
    job_id: z.string().min(1).nullable(),
    properties: ConfigReloaded,
  }),
  z.object({ ...envelope, event: z.literal("needs-human"), job_id: z.string().min(1), properties: NeedsHuman }),
  z.object({
    ...envelope,
    event: z.literal("kiln.paused"),
    job_id: z.string().min(1).nullable(),
    properties: FactoryToggle,
  }),
  z.object({
    ...envelope,
    event: z.literal("kiln.resumed"),
    job_id: z.string().min(1).nullable(),
    properties: FactoryToggle,
  }),
  z.object({
    ...envelope,
    event: z.literal("budget.blocked"),
    job_id: z.string().min(1).nullable(),
    properties: BudgetBlocked,
  }),
  z.object({
    ...envelope,
    event: z.literal("trigger.fired"),
    job_id: z.string().min(1).nullable(),
    properties: TriggerFired,
  }),
  z.object({
    ...envelope,
    event: z.literal("trigger.routed"),
    job_id: z.string().min(1).nullable(),
    properties: TriggerRouted,
  }),
  z.object({
    ...envelope,
    event: z.literal("trigger.failed"),
    job_id: z.string().min(1).nullable(),
    properties: TriggerFailed,
  }),
  z.object({
    ...envelope,
    event: z.literal("trigger.skipped"),
    job_id: z.string().min(1).nullable(),
    properties: TriggerSkipped,
  }),
  z.object({ ...envelope, event: z.literal("review.posted"), job_id: z.string().min(1), properties: ReviewPosted }),
  z.object({ ...envelope, event: z.literal("review.failed"), job_id: z.string().min(1), properties: ReviewFailed }),
]);

export type KilnEvent = z.infer<typeof EventSchema>;

export interface EventDraft {
  job_id: string | null;
  run_id?: string | null;
  event: EventName;
  step?: string | null;
  properties: Record<string, unknown>;
  /** Test hook. Production leaves this unset and stamps the current time. */
  ts?: string;
  id?: string;
}

const LOCK_WAIT_MS = 5_000;
const pauseBuf = new Int32Array(new SharedArrayBuffer(4));

export function eventsPath(kilnDir: string): string {
  return join(kilnDir, "events.jsonl");
}

/**
 * Append one JSON line. Concurrent callers in this process take a file lock
 * and each lock holder performs one `write` of the full line, so lines do
 * not interleave. A failure is printed and swallowed.
 *
 * `properties.once` is an idempotency key. A later append with the same
 * job, run, event, step, and `once` is a no-op. Moments that should repeat
 * (a second manual retry, a second config reload) omit it.
 */
export function appendEvent(kilnDir: string, draft: EventDraft): void {
  let line: string;
  let event: KilnEvent;
  try {
    event = buildEvent(draft);
    line = `${JSON.stringify(event)}\n`;
  } catch (error) {
    report(error);
    return;
  }
  try {
    withEventsLock(kilnDir, () => {
      if (alreadyRecorded(kilnDir, event)) return;
      writeLine(eventsPath(kilnDir), line);
    });
  } catch (error) {
    report(error);
  }
}

export interface ReadEventsOptions {
  /** Called with a line number when a line is skipped. Defaults to stderr. */
  warn?: (message: string) => void;
}

/** Parse the log. A blank line is ignored. Any other bad line is skipped. */
export function readEvents(kilnDir: string, options: ReadEventsOptions = {}): KilnEvent[] {
  const warn = options.warn ?? ((message: string) => console.error(message));
  const path = eventsPath(kilnDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    warn(`kiln: event log unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const events: KilnEvent[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const parsed = parseLine(line);
    if (!parsed) {
      warn(`kiln: skipped event log line ${index + 1}`);
      continue;
    }
    events.push(parsed);
  }
  return events;
}

export function eventsForJob(kilnDir: string, jobId: string, options?: ReadEventsOptions): KilnEvent[] {
  return readEvents(kilnDir, options).filter((event) => event.job_id === jobId);
}

function buildEvent(draft: EventDraft): KilnEvent {
  const properties = redactDeep(draft.properties);
  const candidate = {
    id: draft.id ?? randomUUID(),
    ts: draft.ts ?? new Date().toISOString(),
    job_id: draft.job_id,
    run_id: draft.run_id ?? null,
    event: draft.event,
    step: draft.step ?? null,
    properties,
  };
  const parsed = EventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`refused ${draft.event}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

function parseLine(line: string): KilnEvent | undefined {
  try {
    const parsed = EventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function alreadyRecorded(kilnDir: string, event: KilnEvent): boolean {
  const key = event.properties.once;
  if (!key) return false;
  const path = eventsPath(kilnDir);
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        job_id?: unknown;
        run_id?: unknown;
        event?: unknown;
        step?: unknown;
        properties?: { once?: unknown };
      };
      if (
        parsed.job_id === event.job_id &&
        parsed.run_id === event.run_id &&
        parsed.event === event.event &&
        parsed.step === event.step &&
        parsed.properties?.once === key
      ) {
        return true;
      }
    } catch {
      // A corrupt line does not count as a recorded event.
    }
  }
  return false;
}

/** One `write` of the whole line, including the newline. */
function writeLine(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    const buf = Buffer.from(line);
    const wrote = writeSync(fd, buf, 0, buf.length);
    if (wrote !== buf.length) {
      throw new Error(`short write (${wrote} of ${buf.length})`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Exclusive append across threads in this process. The lock file holds the
 * pid. Another thread in the same process shares that pid and waits. A
 * later process may remove a lock whose pid is gone.
 */
function withEventsLock(kilnDir: string, fn: () => void): void {
  mkdirSync(kilnDir, { recursive: true });
  const lockPath = join(kilnDir, "events.lock");
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, String(process.pid));
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  try {
    while (!held) {
      try {
        linkSync(tmp, lockPath);
        held = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (lockHolderDead(lockPath)) {
          rmSync(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for the event log lock");
        Atomics.wait(pauseBuf, 0, 0, 5);
      }
    }
    fn();
  } finally {
    if (held) rmSync(lockPath, { force: true });
    rmSync(tmp, { force: true });
  }
}

function lockHolderDead(lockPath: string): boolean {
  let holder = Number.NaN;
  try {
    holder = Number(readFileSync(lockPath, "utf8").trim());
  } catch {
    return true;
  }
  if (holder === process.pid) return false;
  return !pidAlive(holder);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    console.error(`kiln: event log: ${message}`);
  } catch {
    // The caller still continues when stderr itself fails.
  }
}
