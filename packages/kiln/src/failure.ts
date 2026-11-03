import { createHash } from "node:crypto";
import { redact } from "./redact.js";

/**
 * One failed run is transient, deterministic, or budget.
 * Transient may retry with backoff inside the attempt cap.
 * Deterministic does not. A cap hit is budget and stops in Needs human.
 */

export const FAILURE_CLASSES = ["transient", "deterministic", "budget"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const TRANSIENT = [
  /\b429\b/,
  /rate limit/i,
  /too many requests/i,
  /\b5\d\d\b/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE/i,
  /socket hang up/i,
  /network (?:error|unreachable|is down)/i,
  /fetch failed/i,
  /connection (?:reset|refused|timed out|closed)/i,
  /container never started/i,
  /failed to start (?:the )?(?:container|sandbox)/i,
  /docker daemon/i,
  /cannot connect to the docker/i,
  /OCI runtime/i,
  /error creating container/i,
  /sandbox (?:start|flake)/i,
];

const DETERMINISTIC = [
  /\berror TS\d+\b/,
  /type error/i,
  /cannot find name/i,
  /is not assignable/i,
  /syntax error/i,
  /\bAssertionError\b/,
  /\b(?:tests?|assertion) failed\b/i,
  /\bfailing tests?\b/i,
  /\bbuild failed\b/i,
  /\bcompilation failed\b/i,
  /\bcompile error\b/i,
  /npm ERR!/i,
];

/** A container or sandbox that did not start. Those are transient. */
export function isSandboxStartFlake(text: string): boolean {
  return /container never started|failed to start (?:the )?(?:container|sandbox)|docker daemon|cannot connect to the docker|OCI runtime|error creating container|sandbox (?:start|flake)/i.test(
    text,
  );
}

/**
 * Strip timestamps, temp and worktree paths, hex ids, and line numbers so
 * the same failure hashes the same way across runs.
 */
export function normalizeFailureText(text: string): string {
  let out = redact(text).replace(/\r\n/g, "\n").trim();
  out = out.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>");
  out = out.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>");
  out = out.replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'")\]:]+/g, "<tmp>");
  out = out.replace(/[^\s'")\]]*[/\\]\.yak[/\\]worktrees[/\\][^\s'")\]:]+/g, "<worktree>");
  out = out.replace(/[^\s'")\]]+[/\\]worktrees[/\\][^\s'")\]:]+/g, "<worktree>");
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>");
  out = out.replace(/\b[0-9a-f]{8,}\b/gi, "<id>");
  out = out.replace(/:(\d+)(?::\d+)?\b/g, ":<line>");
  out = out.replace(/\bline\s+\d+\b/gi, "line <line>");
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.toLowerCase();
}

/** Stable id for one normalized failure. */
export function failureFingerprint(text: string): string {
  return createHash("sha256").update(normalizeFailureText(text)).digest("hex");
}

/**
 * Transient when the text is a network, rate-limit, 5xx, or start flake.
 * A test, build, or type error is deterministic and wins over a transient
 * pattern in the same text. Anything else is deterministic.
 */
export function classifyFailureText(text: string): "transient" | "deterministic" {
  if (DETERMINISTIC.some((pattern) => pattern.test(text))) return "deterministic";
  if (TRANSIENT.some((pattern) => pattern.test(text))) return "transient";
  return "deterministic";
}

export interface FailureDecisionInput {
  /** Joined failure text: step details, log tail, and the attempt detail. */
  text: string;
  /**
   * Operational failures kiln already retries (stall, crash, orphan, a bare
   * non-zero exit) stay transient unless the text is a test, build, or type error.
   */
  operational: boolean;
  /** Auth rejection or a sandbox error that is not a start flake. */
  blocked: boolean;
  /** Attempts including the one being recorded. */
  attempt: number;
  maxAttempts: number;
  /** Failures with this fingerprint, including the one being recorded. */
  sameFingerprint: number;
  maxSameFingerprint: number;
}

export interface FailureDecision {
  class: FailureClass;
  fingerprint: string;
  /** Schedule backoff. False for deterministic, blocked, fingerprint, and budget stops. */
  retry: boolean;
  /** Set when the job stops in Needs human. */
  needsHuman?: "fingerprint" | "attempt-cap";
}

/**
 * The only decision for what a recorded failure does next.
 * Attempt cap wins over the fingerprint breaker when both trip on the same run.
 */
export function decideFailure(input: FailureDecisionInput): FailureDecision {
  const fingerprint = failureFingerprint(input.text);
  const deterministicHit = DETERMINISTIC.some((pattern) => pattern.test(input.text));
  const transientHit = TRANSIENT.some((pattern) => pattern.test(input.text));
  // Stall, crash, orphan, and a bare non-zero exit stay transient unless the
  // text is a test, build, or type error, or the failure is blocked.
  let failureClass: FailureClass = deterministicHit
    ? "deterministic"
    : transientHit || (input.operational && !input.blocked)
      ? "transient"
      : "deterministic";
  let retry = failureClass === "transient" && !input.blocked;
  let needsHuman: FailureDecision["needsHuman"];
  if (input.attempt >= input.maxAttempts) {
    failureClass = "budget";
    retry = false;
    needsHuman = "attempt-cap";
  } else if (input.sameFingerprint >= input.maxSameFingerprint) {
    retry = false;
    needsHuman = "fingerprint";
  } else if (input.blocked || failureClass === "deterministic") {
    retry = false;
  }
  return { class: failureClass, fingerprint, retry, ...(needsHuman ? { needsHuman } : {}) };
}

export interface RunCost {
  tokens: number | null;
  usd: number | null;
}

/** Sum yak `budget.consumed` lines. Missing numbers stay null. Never invents a figure. */
export function costFromJournal(events: readonly unknown[]): RunCost {
  let tokens = 0;
  let usd = 0;
  let sawTokens = false;
  let sawUsd = false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as { t?: unknown; tokens?: unknown; usd?: unknown };
    if (record.t !== "budget.consumed") continue;
    if (typeof record.tokens === "number" && Number.isFinite(record.tokens) && record.tokens >= 0) {
      tokens += record.tokens;
      sawTokens = true;
    }
    if (typeof record.usd === "number" && Number.isFinite(record.usd) && record.usd >= 0) {
      usd += record.usd;
      sawUsd = true;
    }
  }
  return {
    tokens: sawTokens ? tokens : null,
    usd: sawUsd ? usd : null,
  };
}
