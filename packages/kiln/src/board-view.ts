import { spawnSync } from "node:child_process";
import { attentionReason, scheduledRetry } from "./attention.js";
import type { KilnEvent } from "./events.js";
import type { FailureClass } from "./failure.js";
import { feedbackRoundLabel } from "./feedback.js";
import { ledgerRows, type LedgerRow } from "./ledger.js";
import { localDay, spendSnapshot, type SpendSnapshot } from "./rails.js";
import type { StatusJobView } from "./report.js";

/**
 * Lists, stats, and job pages for the serve shell. Job state still comes
 * from `jobState` (via the status view). Everything else is read off the
 * event log. Last-seen is not stored here: "since you last looked" is one
 * browser, so the page keeps that map in localStorage and this module only
 * counts events after a timestamp the caller supplies.
 */

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PHASE_OF: Record<string, string> = {
  spec: "spec",
  build: "build",
  verify: "build",
  security: "review",
  ux: "review",
  ui: "review",
  code: "review",
  approver: "approve",
  approve: "approve",
  land: "land",
  explore: "explore",
};

const PHASE_LABEL: Record<string, string> = {
  spec: "Spec",
  build: "Build",
  verify: "Verify",
  security: "Review · security",
  ux: "Review · ux",
  ui: "Review · ui",
  code: "Review · code",
  approver: "Approve",
  approve: "Gate",
  land: "Land",
  explore: "Explore",
};

export const STAT_WINDOWS = ["today", "7d", "30d"] as const;
export type StatWindow = (typeof STAT_WINDOWS)[number];

export interface FeedbackLine {
  label: string;
  url?: string;
}

export interface BoardJob {
  jobId: string;
  title: string;
  repo: string;
  workflow: string;
  state: string;
  reason: string;
  inbox: boolean;
  hand: boolean;
  finished: boolean;
  retry: boolean;
  sandboxed: boolean;
  canApprove: boolean;
  canReject: boolean;
  canRevise: boolean;
  attemptCount: number;
  maxAttempts: number;
  scheduledRetry: boolean;
  nextRetryAt?: string;
  attemptLine?: string;
  failureClass?: FailureClass;
  /** First 12 characters. The full value stays on the event. */
  fingerprint?: string;
  latestEventAt?: string;
  eventCount: number;
  prUrl?: string;
  prNumber?: number;
  dependsOn: { jobId: string; state: string; detail?: string }[];
  evidence: string[];
  feedback: FeedbackLine[];
  notes: string[];
  historyLine?: string;
  findings: boolean;
  spec: boolean;
  log: boolean;
  /** Launch log. List rows for a gate omit it; a failure row keeps the tail. */
  logTail?: string;
}

export interface BoardDocument {
  inbox: BoardJob[];
  hand: BoardJob[];
  history: BoardJob[];
  repos: { repo: string; jobs: BoardJob[] }[];
  inboxCount: number;
  handCount: number;
}

export interface PhaseCard {
  step: string;
  label: string;
  outcome: "started" | "completed" | "failed";
  ts: string;
  iteration?: number;
  verdict?: string;
  detail?: string;
  testCommand?: string;
  exitCode?: number;
  failureClass?: FailureClass;
  fingerprint?: string;
  note?: string;
}

export interface CommitRow {
  sha: string;
  subject: string;
  round?: number;
  kilnJob?: string;
}

export interface JobChanges {
  branch?: string;
  base?: string;
  prNumber?: number;
  prUrl?: string;
  diffStat?: string;
  commits: CommitRow[];
}

export interface JobRail {
  repo: string;
  issue?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  /** Set when a `pr.feedback` event recorded CI. */
  ci?: "failing" | "recovered";
  /** Latest review verdict that is not a pass. */
  risk?: string;
  /** Null when no run event recorded a dollar figure. */
  costUsd: number | null;
  attempts: { used: number; cap: number };
  fixRounds: { used: number; cap: number };
  failureClass?: FailureClass;
  fingerprint?: string;
}

export interface JobDetail {
  job: BoardJob;
  overview: PhaseCard[];
  changes: JobChanges;
  timeline: KilnEvent[];
  rail: JobRail;
}

export interface StatsDocument {
  window: StatWindow;
  since: string;
  spend: SpendSnapshot;
  windowUsd: number;
  costByRepo: { repo: string; usd: number }[];
  costByPhase: { phase: string; usd: number }[];
  runs: { started: number; finished: number; failed: number };
  failuresByClass: { class: string; count: number }[];
  interventions: { total: number; rows: LedgerRow[] };
}

export interface DayRun {
  jobId: string;
  repo: string;
  title: string;
  runId: string | null;
  outcome: "running" | "ok" | "failed";
  failureClass?: string;
  usd: number | null;
  at: string;
}

export interface DayReport {
  day: string;
  spend: SpendSnapshot;
  runs: DayRun[];
  interventions: { total: number; rows: LedgerRow[] };
}

export function parseStatsWindow(raw: string | null): StatWindow | undefined {
  if (raw === null || raw === "" || raw === "today") return "today";
  if (raw === "7d" || raw === "30d") return raw;
  return undefined;
}

/** `jobId|ISO` pairs from `seen` query params. A bad pair is ignored. */
export function parseSeenQuery(values: readonly string[]): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const value of values) {
    const split = value.indexOf("|");
    if (split <= 0) continue;
    const jobId = value.slice(0, split);
    const ts = value.slice(split + 1);
    if (!JOB_ID.test(jobId) || !Number.isFinite(Date.parse(ts))) continue;
    seen[jobId] = ts;
  }
  return seen;
}

export function isInbox(job: StatusJobView): boolean {
  if (job.canApprove || job.canReject || job.canRevise) return true;
  return job.state === "needs-human" && job.gates.length > 0 && !job.stopReason && !job.feedbackReason;
}

/**
 * Needs a person, and not an open gate. A failure that still has a scheduled
 * retry is in flight, so it stays off this list.
 */
export function isHand(job: StatusJobView): boolean {
  if (isInbox(job) || scheduledRetry(job)) return false;
  return job.state === "needs-human" || job.state === "failed" || job.state === "dead" || job.state === "invalid";
}

export function isFinished(job: StatusJobView): boolean {
  return job.state === "done" || job.state === "rejected";
}

export function buildBoard(jobs: readonly StatusJobView[], events: readonly KilnEvent[]): BoardDocument {
  const rows = jobs.map((job) => toBoardJob(job, events));
  const inbox = rows.filter((job) => job.inbox);
  const hand = rows.filter((job) => job.hand);
  const history = rows.filter((job) => job.finished);
  const byRepo = new Map<string, BoardJob[]>();
  for (const job of rows) {
    const list = byRepo.get(job.repo) ?? [];
    list.push(job);
    byRepo.set(job.repo, list);
  }
  const repos = [...byRepo.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((repo) => ({ repo, jobs: byRepo.get(repo) ?? [] }));
  return { inbox, hand, history, repos, inboxCount: inbox.length, handCount: hand.length };
}

/** Events for this job strictly after `since`. No timestamp counts as zero. */
export function changesSince(events: readonly KilnEvent[], jobId: string, since: string | undefined): number {
  if (!since) return 0;
  const cut = Date.parse(since);
  if (!Number.isFinite(cut)) return 0;
  let count = 0;
  for (const event of events) {
    if (event.job_id !== jobId) continue;
    const ts = Date.parse(event.ts);
    if (Number.isFinite(ts) && ts > cut) count += 1;
  }
  return count;
}

export function unseenChanges(
  events: readonly KilnEvent[],
  seen: Readonly<Record<string, string>>,
  inboxIds: ReadonlySet<string>,
): { jobs: { jobId: string; count: number }[]; inbox: number } {
  const ids = new Set<string>(Object.keys(seen));
  for (const event of events) if (event.job_id) ids.add(event.job_id);
  const jobs: { jobId: string; count: number }[] = [];
  let inbox = 0;
  for (const jobId of [...ids].sort()) {
    const count = changesSince(events, jobId, seen[jobId]);
    if (count > 0) jobs.push({ jobId, count });
    if (inboxIds.has(jobId)) inbox += count;
  }
  return { jobs, inbox };
}

export function phaseFeed(events: readonly KilnEvent[], jobId: string): PhaseCard[] {
  const cards: PhaseCard[] = [];
  for (const event of events) {
    if (event.job_id !== jobId) continue;
    if (event.event === "phase.started" && event.step) {
      cards.push({
        step: event.step,
        label: PHASE_LABEL[event.step] ?? event.step,
        outcome: "started",
        ts: event.ts,
        ...(event.properties.iteration !== undefined ? { iteration: event.properties.iteration } : {}),
      });
      continue;
    }
    if (event.event === "phase.finished" && event.step) {
      const open = [...cards].reverse().find((card) => card.step === event.step && card.outcome === "started");
      const card: PhaseCard = open ?? {
        step: event.step,
        label: PHASE_LABEL[event.step] ?? event.step,
        outcome: "started",
        ts: event.ts,
      };
      if (!open) cards.push(card);
      card.outcome = event.properties.outcome === "failed" ? "failed" : "completed";
      card.ts = event.ts;
      if (event.properties.iteration !== undefined) card.iteration = event.properties.iteration;
      if (event.properties.verdict) card.verdict = event.properties.verdict;
      if (event.properties.detail) card.detail = event.properties.detail;
      if (event.properties.test_command) card.testCommand = event.properties.test_command;
      if (event.properties.exit_code !== undefined) card.exitCode = event.properties.exit_code;
      continue;
    }
    if (event.event === "gate.resolved" && event.properties.decision === "revise" && event.properties.note) {
      cards.push({
        step: event.step ?? "revise",
        label: "Revise",
        outcome: "completed",
        ts: event.ts,
        note: event.properties.note,
      });
      continue;
    }
    if (event.event === "pr.feedback") {
      const trigger = event.properties.trigger === "ci" ? "CI" : "review";
      cards.push({
        step: "fix",
        label: `Fix round ${event.properties.round} · ${trigger}`,
        outcome: event.properties.outcome ? "completed" : "started",
        ts: event.ts,
        iteration: event.properties.round,
        ...(event.properties.outcome ? { detail: event.properties.outcome } : {}),
      });
      continue;
    }
    if (event.event === "run.failed") {
      const card = [...cards].reverse().find((item) => item.outcome === "failed") ?? cards[cards.length - 1];
      const klass = event.properties.class;
      const fingerprint = shortFingerprint(event.properties.fingerprint);
      if (card) {
        if (klass) card.failureClass = klass;
        if (fingerprint) card.fingerprint = fingerprint;
        if (event.properties.detail && !card.detail) card.detail = event.properties.detail;
      } else {
        cards.push({
          step: "run",
          label: "Run failed",
          outcome: "failed",
          ts: event.ts,
          ...(klass ? { failureClass: klass } : {}),
          ...(fingerprint ? { fingerprint } : {}),
          ...(event.properties.detail ? { detail: event.properties.detail } : {}),
        });
      }
    }
  }
  return cards;
}

export function jobChanges(
  job: StatusJobView,
  events: readonly KilnEvent[],
  commits: readonly CommitRow[],
  diffStat?: string,
): JobChanges {
  let branch = job.branch;
  let base: string | undefined;
  let prNumber = job.prNumber;
  let prUrl = job.prUrl;
  for (const event of events) {
    if (event.job_id !== job.jobId || event.event !== "pr.opened") continue;
    branch = event.properties.branch;
    base = event.properties.base;
    prNumber = event.properties.number;
    prUrl = event.properties.url;
  }
  const diff = diffStat?.trim() || job.diffSummary?.trim() || undefined;
  return {
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(diff ? { diffStat: diff } : {}),
    commits: [...commits],
  };
}

export function jobRail(
  job: StatusJobView,
  events: readonly KilnEvent[],
  options: { issue?: string; maxFixRounds: number; branch?: string },
): JobRail {
  const failure = latestFailure(events, job.jobId);
  const cost = jobCost(events, job.jobId);
  let ci: JobRail["ci"];
  let risk: string | undefined;
  for (const event of events) {
    if (event.job_id !== job.jobId) continue;
    if (event.event === "pr.feedback" && event.properties.trigger === "ci") {
      ci = event.properties.outcome === "fixed" || event.properties.outcome === "pushed" ? "recovered" : "failing";
    }
    if (event.event === "phase.finished" && event.properties.verdict && !passed(event.properties.verdict)) {
      risk = event.properties.verdict;
    }
  }
  const fixRounds = Math.max(fixRoundCount(events, job.jobId), job.feedbackRounds?.length ?? 0);
  return {
    repo: job.repo,
    ...(options.issue ? { issue: options.issue } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(job.prUrl ? { prUrl: job.prUrl } : {}),
    ...(job.prNumber ? { prNumber: job.prNumber } : {}),
    ...(ci ? { ci } : {}),
    ...(risk ? { risk } : {}),
    costUsd: cost,
    attempts: { used: job.attemptCount, cap: job.maxAttempts },
    fixRounds: { used: fixRounds, cap: options.maxFixRounds },
    ...(failure?.class ? { failureClass: failure.class } : {}),
    ...(failure?.fingerprint ? { fingerprint: shortFingerprint(failure.fingerprint) } : {}),
  };
}

export function jobDetail(input: {
  job: StatusJobView;
  events: readonly KilnEvent[];
  issue?: string;
  maxFixRounds: number;
  commits?: readonly CommitRow[];
  diffStat?: string;
}): JobDetail {
  const jobEvents = input.events.filter((event) => event.job_id === input.job.jobId);
  const changes = jobChanges(input.job, input.events, input.commits ?? [], input.diffStat);
  return {
    job: toBoardJob(input.job, input.events),
    overview: phaseFeed(input.events, input.job.jobId),
    changes,
    timeline: jobEvents,
    rail: jobRail(input.job, input.events, {
      ...(input.issue ? { issue: input.issue } : {}),
      maxFixRounds: input.maxFixRounds,
      ...(changes.branch ? { branch: changes.branch } : {}),
    }),
  };
}

export function statsFor(
  events: readonly KilnEvent[],
  options: { window: StatWindow; cap?: number; now?: Date },
): StatsDocument {
  const now = options.now ?? new Date();
  const since = windowStart(options.window, now);
  const spend = spendSnapshot(events, options.cap, now);
  const repos = new Map<string, number>();
  const phases = new Map<string, number>();
  const classes = new Map<string, number>();
  const repoOf = repoByJob(events);
  let started = 0;
  let finished = 0;
  let failed = 0;
  let windowUsd = 0;
  for (const event of events) {
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < since.getTime()) continue;
    if (event.event === "run.started") started += 1;
    if (event.event === "run.finished") finished += 1;
    if (event.event === "run.failed") {
      failed += 1;
      const name = event.properties.class ?? "unclassified";
      classes.set(name, (classes.get(name) ?? 0) + 1);
    }
    const usd = dollarCost(event);
    if (usd === undefined) continue;
    windowUsd += usd;
    const repo = (event.job_id && repoOf.get(event.job_id)) || "(no repo)";
    repos.set(repo, (repos.get(repo) ?? 0) + usd);
    const phase = phaseOfRun(events, event.run_id);
    phases.set(phase, (phases.get(phase) ?? 0) + usd);
  }
  const rows = ledgerRows(events, { since, now });
  return {
    window: options.window,
    since: since.toISOString(),
    spend,
    windowUsd,
    costByRepo: [...repos.entries()].map(([repo, usd]) => ({ repo, usd })).sort((a, b) => a.repo.localeCompare(b.repo)),
    costByPhase: [...phases.entries()].map(([phase, usd]) => ({ phase, usd })).sort((a, b) => a.phase.localeCompare(b.phase)),
    runs: { started, finished, failed },
    failuresByClass: [...classes.entries()]
      .map(([name, count]) => ({ class: name, count }))
      .sort((a, b) => a.class.localeCompare(b.class)),
    interventions: { total: rows.reduce((sum, row) => sum + row.total, 0), rows },
  };
}

export function dayReport(events: readonly KilnEvent[], options: { cap?: number; now?: Date } = {}): DayReport {
  const now = options.now ?? new Date();
  const day = localDay(now);
  const spend = spendSnapshot(events, options.cap, now);
  const titles = new Map<string, string>();
  const repos = repoByJob(events);
  const runs = new Map<string, DayRun>();
  for (const event of events) {
    if (event.event === "job.added" && event.job_id) titles.set(event.job_id, event.properties.title);
  }
  for (const event of events) {
    if (!event.job_id) continue;
    if (event.event !== "run.started" && event.event !== "run.finished" && event.event !== "run.failed") continue;
    if (localDay(new Date(event.ts)) !== day) continue;
    const key = `${event.job_id}\0${event.run_id ?? ""}`;
    const row = runs.get(key) ?? {
      jobId: event.job_id,
      repo: repos.get(event.job_id) ?? "(no repo)",
      title: titles.get(event.job_id) ?? event.job_id,
      runId: event.run_id,
      outcome: "running" as const,
      usd: null,
      at: event.ts,
    };
    if (event.event === "run.started" && event.properties.repo) row.repo = event.properties.repo;
    if (event.event === "run.finished") {
      row.outcome = "ok";
      const usd = dollarCost(event);
      if (usd !== undefined) row.usd = usd;
    }
    if (event.event === "run.failed") {
      row.outcome = "failed";
      if (event.properties.class) row.failureClass = event.properties.class;
      const usd = dollarCost(event);
      if (usd !== undefined) row.usd = usd;
    }
    if (event.ts > row.at) row.at = event.ts;
    runs.set(key, row);
  }
  const since = windowStart("today", now);
  const ledger = ledgerRows(events, { since, now });
  return {
    day,
    spend,
    runs: [...runs.values()].sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0)),
    interventions: { total: ledger.reduce((sum, row) => sum + row.total, 0), rows: ledger },
  };
}

export function commitsFromLog(text: string): CommitRow[] {
  const rows: CommitRow[] = [];
  for (const record of text.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, subject, body] = trimmed.split("\x1f");
    if (!sha || subject === undefined) continue;
    const row: CommitRow = { sha, subject };
    const round = trailer(body ?? "", "Kiln-Round");
    const kilnJob = trailer(body ?? "", "Kiln-Job");
    if (round && /^\d+$/.test(round)) row.round = Number(round);
    if (kilnJob) row.kilnJob = kilnJob;
    rows.push(row);
  }
  return rows;
}

/** `git log` of `branch` in `repoPath`. A missing branch is an empty list. */
export function readBranchCommits(repoPath: string, branch: string): CommitRow[] {
  if (!safeRef(branch)) return [];
  const result = spawnSync("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", branch], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return commitsFromLog(result.stdout ?? "");
}

/** `git diff --shortstat base...branch`. Failure is omitted, not invented. */
export function readDiffStat(repoPath: string, base: string, branch: string): string | undefined {
  if (!safeRef(base) || !safeRef(branch)) return undefined;
  const result = spawnSync("git", ["diff", "--shortstat", `${base}...${branch}`], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const text = (result.stdout ?? "").trim();
  return text || undefined;
}

export function branchOf(job: StatusJobView, events: readonly KilnEvent[]): string | undefined {
  let branch = job.branch;
  for (const event of events) {
    if (event.job_id === job.jobId && event.event === "pr.opened") branch = event.properties.branch;
  }
  return branch;
}

function toBoardJob(job: StatusJobView, events: readonly KilnEvent[]): BoardJob {
  const inbox = isInbox(job);
  const hand = isHand(job);
  const finished = isFinished(job);
  const failure = latestFailure(events, job.jobId);
  const activity = jobActivity(events, job.jobId);
  const waiting = scheduledRetry(job);
  const reason = hand ? handLine(job, failure) : attentionReason(job);
  const notes: string[] = [];
  if (job.launchError?.trim()) notes.push(job.launchError.trim());
  if (job.failureDetail?.trim()) notes.push(job.failureDetail.trim());
  if (job.waitReason) notes.push(job.waitReason);
  const feedback: FeedbackLine[] = [];
  for (const round of job.feedbackRounds ?? []) {
    const url = round.items.find((item) => item.url)?.url;
    feedback.push({ label: feedbackRoundLabel(round), ...(url ? { url } : {}) });
  }
  let historyLine: string | undefined;
  if (finished) historyLine = finishedLine(job);
  return {
    jobId: job.jobId,
    title: job.title || job.jobId,
    repo: job.repo,
    workflow: job.workflow,
    state: job.state,
    reason,
    inbox,
    hand,
    finished,
    retry: (job.state === "failed" || job.state === "dead" || (job.state === "needs-human" && Boolean(job.stopReason))) && job.gates.length === 0,
    sandboxed: job.sandboxed === true,
    canApprove: job.canApprove,
    canReject: job.canReject,
    canRevise: job.canRevise,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    scheduledRetry: waiting,
    ...(waiting && job.nextRetryAt ? { nextRetryAt: job.nextRetryAt } : {}),
    ...(attemptLine(job) ? { attemptLine: attemptLine(job) } : {}),
    ...(failure?.class ? { failureClass: failure.class } : {}),
    ...(failure?.fingerprint ? { fingerprint: shortFingerprint(failure.fingerprint) } : {}),
    ...(activity.latest ? { latestEventAt: activity.latest } : {}),
    eventCount: activity.count,
    ...(job.prUrl ? { prUrl: job.prUrl } : {}),
    ...(job.prNumber ? { prNumber: job.prNumber } : {}),
    dependsOn: job.dependsOn.map((dep) => ({
      jobId: dep.jobId,
      state: dep.state,
      ...(dep.blockedDetail ? { detail: dep.blockedDetail } : {}),
    })),
    evidence: evidenceTexts(job),
    feedback,
    notes,
    ...(historyLine ? { historyLine } : {}),
    findings: Boolean(job.findingsPath),
    spec: Boolean(job.specPath),
    log: Boolean(job.logPath),
    ...(job.logTail?.trim() ? { logTail: job.logTail.trim() } : {}),
  };
}

function finishedLine(job: StatusJobView): string {
  if (job.state === "rejected") return "Rejected";
  if (job.prNumber) return `merged · PR #${job.prNumber}`;
  if (job.prUrl && httpUrl(job.prUrl)) return "merged · PR";
  return job.branch ? `landed locally · ${job.branch}` : "landed locally";
}

function httpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function handLine(job: StatusJobView, failure: { class?: FailureClass; fingerprint?: string } | undefined): string {
  let label = "Needs a person";
  if (job.stopReason === "attempt-cap") label = "Attempt cap";
  else if (job.stopReason === "fingerprint") label = "Same failure";
  else if (job.feedbackReason === "feedback-exhausted") label = "Fix round cap";
  else if (job.feedbackReason === "feedback-ambiguous") label = "Feedback unclear";
  else if (job.state === "failed" || job.state === "dead" || job.state === "invalid") label = attentionReason(job);
  const parts = [label];
  if (failure?.class) parts.push(failure.class);
  const fingerprint = shortFingerprint(failure?.fingerprint);
  if (fingerprint) parts.push(fingerprint);
  return parts.join(" · ");
}

function evidenceTexts(job: StatusJobView): string[] {
  const texts: string[] = [];
  if (job.workflow !== "investigation" && job.diffSummary?.trim()) texts.push(job.diffSummary.trim());
  for (const gate of job.gates) {
    const body = gate.rendered?.trim() || gate.prompt?.trim();
    if (body) texts.push(body);
    for (const review of gate.reviews ?? []) if (review.summary?.trim()) texts.push(review.summary.trim());
    for (const artifact of gate.artifacts ?? []) if (artifact.summary?.trim()) texts.push(artifact.summary.trim());
  }
  return texts;
}

function attemptLine(job: StatusJobView): string | undefined {
  if (job.attemptCount <= 0 && !job.lastFailureReason) return undefined;
  const parts: string[] = [];
  if (job.attemptCount > 0) parts.push(`attempt ${job.attemptCount}/${job.maxAttempts}`);
  if (job.lastFailureReason) parts.push(job.lastFailureReason);
  return parts.join(" · ");
}

function jobActivity(events: readonly KilnEvent[], jobId: string): { count: number; latest?: string } {
  let count = 0;
  let latest: string | undefined;
  for (const event of events) {
    if (event.job_id !== jobId) continue;
    count += 1;
    if (!latest || event.ts > latest) latest = event.ts;
  }
  return { count, ...(latest ? { latest } : {}) };
}

function latestFailure(
  events: readonly KilnEvent[],
  jobId: string,
): { class?: FailureClass; fingerprint?: string } | undefined {
  let found: { class?: FailureClass; fingerprint?: string } | undefined;
  for (const event of events) {
    if (event.job_id !== jobId || event.event !== "run.failed") continue;
    found = {
      ...(event.properties.class ? { class: event.properties.class } : {}),
      ...(event.properties.fingerprint ? { fingerprint: event.properties.fingerprint } : {}),
    };
  }
  return found;
}

function jobCost(events: readonly KilnEvent[], jobId: string): number | null {
  let usd = 0;
  let saw = false;
  for (const event of events) {
    if (event.job_id !== jobId) continue;
    const amount = dollarCost(event);
    if (amount === undefined) continue;
    usd += amount;
    saw = true;
  }
  return saw ? usd : null;
}

function fixRoundCount(events: readonly KilnEvent[], jobId: string): number {
  let count = 0;
  for (const event of events) {
    if (event.job_id === jobId && event.event === "pr.feedback") count += 1;
  }
  return count;
}

function shortFingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 12);
}

function passed(verdict: string): boolean {
  return verdict === "PASS" || verdict === "APPROVE";
}

function dollarCost(event: KilnEvent): number | undefined {
  if (event.event !== "run.finished" && event.event !== "run.failed") return undefined;
  const usd = event.properties.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return undefined;
  return usd;
}

function phaseOfRun(events: readonly KilnEvent[], runId: string | null): string {
  if (!runId) return "run";
  let workflow = "";
  let phase = "run";
  for (const event of events) {
    if (event.run_id !== runId) continue;
    if (event.event === "run.started") {
      workflow = event.properties.workflow;
      if (workflow === "fix") phase = "fix";
      else if (workflow === "investigation") phase = "explore";
    }
    if (workflow === "fix") continue;
    if ((event.event === "phase.started" || event.event === "phase.finished") && event.step && PHASE_OF[event.step]) {
      phase = PHASE_OF[event.step];
    }
  }
  return phase;
}

function repoByJob(events: readonly KilnEvent[]): Map<string, string> {
  const repos = new Map<string, string>();
  for (const event of events) {
    if (event.event === "job.added" && event.job_id) repos.set(event.job_id, event.properties.repo);
  }
  for (const event of events) {
    if (!event.job_id || repos.has(event.job_id)) continue;
    if (event.event === "run.started" || event.event === "job.retried") repos.set(event.job_id, event.properties.repo);
  }
  return repos;
}

function windowStart(window: StatWindow, now: Date): Date {
  if (window === "today") {
    const day = localDay(now);
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year ?? 0, (month ?? 1) - 1, date ?? 1, 0, 0, 0, 0);
  }
  const days = window === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000);
}

function trailer(body: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(body);
  return match?.[1]?.trim() || undefined;
}

function safeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && !ref.includes("..") && !/[\0\n]/.test(ref);
}
