import type { KilnEvent } from "./events.js";
import { appendEvent, readEvents } from "./events.js";

/**
 * Pause, daily spend, and revise notes. All of it is derived from the
 * event log. Nothing new is stored beside it.
 */

export interface SpendSnapshot {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Sum of dollar figures recorded today. Null figures add nothing. */
  usd: number;
  /** Configured cap. Null when the config sets none. */
  cap: number | null;
  blocked: boolean;
}

export function localDay(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isPaused(kilnDir: string): boolean {
  return pausedFrom(readEvents(kilnDir, { warn: () => {} }));
}

export function pausedFrom(events: readonly KilnEvent[]): boolean {
  let paused = false;
  for (const event of events) {
    if (event.event === "kiln.paused") paused = true;
    else if (event.event === "kiln.resumed") paused = false;
  }
  return paused;
}

/** Append a pause event when the factory is running. Already paused is a no-op. */
export function pauseFactory(kilnDir: string, now = new Date()): boolean {
  if (pausedFrom(readEvents(kilnDir, { warn: () => {} }))) return false;
  appendEvent(kilnDir, {
    job_id: null,
    event: "kiln.paused",
    properties: {},
    ts: now.toISOString(),
  });
  return true;
}

/** Append a resume event when the factory is paused. Already running is a no-op. */
export function resumeFactory(kilnDir: string, now = new Date()): boolean {
  if (!pausedFrom(readEvents(kilnDir, { warn: () => {} }))) return false;
  appendEvent(kilnDir, {
    job_id: null,
    event: "kiln.resumed",
    properties: {},
    ts: now.toISOString(),
  });
  return true;
}

export function spendSnapshot(events: readonly KilnEvent[], cap: number | undefined, now = new Date()): SpendSnapshot {
  const day = localDay(now);
  let usd = 0;
  for (const event of events) {
    if (localDay(new Date(event.ts)) !== day) continue;
    const amount = dollarCost(event);
    if (amount === undefined) continue;
    usd += amount;
  }
  const limit = cap === undefined ? null : cap;
  return {
    day,
    usd,
    cap: limit,
    blocked: limit !== null && usd >= limit,
  };
}

export function spendFor(kilnDir: string, cap: number | undefined, now = new Date()): SpendSnapshot {
  return spendSnapshot(readEvents(kilnDir, { warn: () => {} }), cap, now);
}

/** One event per local day when the dollar cap is blocking new runs. */
export function recordDailyCap(kilnDir: string, spend: SpendSnapshot, now = new Date()): void {
  if (!spend.blocked || spend.cap === null) return;
  appendEvent(kilnDir, {
    job_id: null,
    event: "budget.blocked",
    properties: {
      day: spend.day,
      usd: spend.usd,
      cap: spend.cap,
      once: `daily-cap:${spend.day}`,
    },
    ts: now.toISOString(),
  });
}

export function formatSpend(spend: SpendSnapshot): string {
  const cap = spend.cap === null ? "no cap" : `$${spend.cap.toFixed(2)}`;
  return `today ${spend.day}  $${spend.usd.toFixed(2)} / ${cap}`;
}

export function holdDetail(paused: boolean, spend: SpendSnapshot): string | undefined {
  if (paused) return "Paused. New runs wait until kiln resume.";
  if (spend.blocked && spend.cap !== null) {
    return `Daily cap reached ($${spend.usd.toFixed(2)} of $${spend.cap.toFixed(2)}). New runs wait until the local day rolls over.`;
  }
  return undefined;
}

/**
 * Revise notes written since the latest `run.started` for this job.
 * The next launch appends them to the spec, which is the next prompt's input.
 */
export function reviseNotesSinceRun(events: readonly KilnEvent[], jobId: string): string[] {
  const notes: string[] = [];
  for (const event of events) {
    if (event.job_id !== jobId) continue;
    if (event.event === "run.started") {
      notes.length = 0;
      continue;
    }
    if (event.event === "gate.resolved" && event.properties.decision === "revise" && event.properties.note) {
      notes.push(event.properties.note);
    }
  }
  return notes;
}

export function withReviseNotes(spec: string, notes: readonly string[]): string {
  if (notes.length === 0) return spec;
  return [
    spec.trimEnd(),
    "",
    "## Human note",
    "",
    "Apply every note below on this round. A person typed it at the gate.",
    "",
    notes.join("\n\n"),
    "",
  ].join("\n");
}

/** Fingerprint or attempt-cap stop that a later manual retry has not cleared. */
export function stopReasonFromEvents(
  events: readonly KilnEvent[],
  jobId: string,
): "fingerprint" | "attempt-cap" | undefined {
  let reason: "fingerprint" | "attempt-cap" | undefined;
  for (const event of events) {
    if (event.job_id !== jobId) continue;
    if (event.event === "job.retried") {
      reason = undefined;
      continue;
    }
    if (event.event !== "needs-human") continue;
    if (event.properties.reason === "fingerprint" || event.properties.reason === "attempt-cap") {
      reason = event.properties.reason;
    }
  }
  return reason;
}

/** How many `run.failed` lines for this job already carry `fingerprint`. */
export function fingerprintCount(events: readonly KilnEvent[], jobId: string, fingerprint: string): number {
  let count = 0;
  for (const event of events) {
    if (event.job_id !== jobId || event.event !== "run.failed") continue;
    if (event.properties.fingerprint === fingerprint) count += 1;
  }
  return count;
}

function dollarCost(event: KilnEvent): number | undefined {
  if (event.event !== "run.finished" && event.event !== "run.failed") return undefined;
  const usd = event.properties.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return undefined;
  return usd;
}
