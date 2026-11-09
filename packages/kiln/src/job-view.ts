import { scheduledRetry, attentionReason } from "./attention.js";
import type { KilnEvent } from "./events.js";
import type { FailureClass } from "./failure.js";
import { feedbackRoundLabel } from "./feedback.js";
import type { StatusJobView } from "./report.js";
import { parseReviewDraft, type ReviewFinding, type ReviewSeverity } from "./review-post.js";
import { parseReviewSource } from "./triggers.js";

/**
 * One projection of a job. Cards, the pipeline, the repo page, and the job
 * page all render this. They do not format events or gate text on their own.
 *
 * A review gate contributes one ask, one markdown body, one findings list,
 * and the draft JSON only as `raw` for a collapsed disclosure.
 */

const PHASE_LABEL: Record<string, string> = {
  spec: "Spec",
  build: "Build",
  verify: "Verify",
  security: "Security",
  ux: "UX",
  ui: "UI",
  code: "Code",
  approver: "Approve",
  approve: "Approve",
  land: "Land",
  explore: "Explore",
  draft: "Draft",
  fix: "Fix",
};

const SEVERITY_ORDER: readonly ReviewSeverity[] = ["blocking", "warning", "nit", "note"];

const BOILERPLATE = /^Approving (?:keeps this draft|posts this draft)\b/i;
const FINDING_LINE =
  /^(?:[-*+]|\d+\.)?\s*\*\*(note|nit|warning|blocking)\*\*\s+`?([A-Za-z0-9_./\\-]+):(\d+)`?\s*(?:[—–:-]+\s*)?(.+)$/i;
const VERDICT_LINE = /^(?:\*\*)?Verdict:(?:\*\*)?\s*(.+)$/i;

export const PIPELINE_COLUMNS = ["queued", "running", "needs-you", "needs-hand", "done"] as const;
export type PipelineColumn = (typeof PIPELINE_COLUMNS)[number];

export const COLUMN_LABEL: Record<PipelineColumn, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
  "needs-hand": "Needs a hand",
  done: "Done",
};

export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PhaseView {
  id: string;
  label: string;
  status: PhaseStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  verdict?: string;
  detail?: string;
  iteration?: number;
  testCommand?: string;
  exitCode?: number;
  failureClass?: FailureClass;
  fingerprint?: string;
  note?: string;
}

export interface FindingView {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  comment: string;
}

export interface ReviewDeliverable {
  kind: "review";
  markdown: string;
  findings: FindingView[];
  verdict?: string;
  prUrl?: string;
  prNumber?: number;
  headSha?: string;
  /** Draft JSON, shown only inside a collapsed disclosure. */
  raw?: string;
}

export interface ProseDeliverable {
  kind: "prose";
  markdown?: string;
  notes: string[];
}

export type Deliverable = ReviewDeliverable | ProseDeliverable;

export interface FeedbackLine {
  label: string;
  url?: string;
}

export interface TimelineEntry {
  ts: string;
  summary: string;
}

export interface TimelineRun {
  runId: string | null;
  entries: TimelineEntry[];
}

export interface JobView {
  jobId: string;
  title: string;
  repo: string;
  workflow: string;
  state: string;
  column: PipelineColumn;
  reason: string;
  ask?: string;
  since?: string;
  costUsd: number | null;
  currentPhase?: string;
  phases: PhaseView[];
  deliverable?: Deliverable;
  headSha?: string;
  branch?: string;
  reviewUrl?: string;
  timeline: TimelineRun[];
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
  logTail?: string;
  reviewPostError?: string;
}

export function isInbox(job: StatusJobView): boolean {
  if (job.reviewPostError) return false;
  if (job.canApprove || job.canReject || job.canRevise) return true;
  return job.state === "needs-human" && job.gates.length > 0 && !job.stopReason && !job.feedbackReason;
}

/** Needs a person, and not an open gate. A scheduled retry stays in flight. */
export function isHand(job: StatusJobView): boolean {
  if (isInbox(job) || scheduledRetry(job)) return false;
  return job.state === "needs-human" || job.state === "failed" || job.state === "dead" || job.state === "invalid";
}

export function isFinished(job: StatusJobView): boolean {
  return job.state === "done" || job.state === "rejected" || job.state === "cancelled";
}

export function columnOf(job: StatusJobView): PipelineColumn {
  if (isFinished(job)) return "done";
  if (isInbox(job) || job.state === "in-review") return "needs-you";
  if (isHand(job)) return "needs-hand";
  if (job.state === "queued" || job.state === "blocked") return "queued";
  return "running";
}

export function projectJob(job: StatusJobView, events: readonly KilnEvent[]): JobView {
  const inbox = isInbox(job);
  const hand = isHand(job);
  const finished = isFinished(job);
  const own = events.filter((event) => event.job_id === job.jobId);
  const failure = latestFailure(own);
  const activity = jobActivity(own);
  const waiting = scheduledRetry(job);
  const reason = hand ? handLine(job, failure) : attentionReason(job);
  const phases = phasesOf(job, own);
  const target = reviewTarget(job, own);
  const deliverable = deliverableOf(job, target);
  const ask = askOf(job);
  const notes = noteLines(job, deliverable);
  const feedback: FeedbackLine[] = [];
  for (const round of job.feedbackRounds ?? []) {
    const url = round.items.find((item) => item.url)?.url;
    feedback.push({ label: feedbackRoundLabel(round), ...(url ? { url } : {}) });
  }
  const historyLine = finished ? finishedLine(job) : undefined;
  const attempt = attemptLine(job);
  const current = currentPhase(phases);
  const since = job.startedAt ?? job.createdAt ?? activity.latest;
  return {
    jobId: job.jobId,
    title: job.title || job.jobId,
    repo: job.repo,
    workflow: job.workflow,
    state: job.state,
    column: columnOf(job),
    reason,
    ...(ask ? { ask } : {}),
    ...(since ? { since } : {}),
    costUsd: jobCost(own),
    ...(current ? { currentPhase: current } : {}),
    phases,
    ...(deliverable ? { deliverable } : {}),
    ...(target.headSha ? { headSha: target.headSha } : {}),
    ...(job.branch ? { branch: job.branch } : {}),
    ...(target.reviewUrl || job.reviewUrl ? { reviewUrl: target.reviewUrl ?? job.reviewUrl } : {}),
    timeline: timelineOf(own),
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
    ...(attempt ? { attemptLine: attempt } : {}),
    ...(failure?.class ? { failureClass: failure.class } : {}),
    ...(failure?.fingerprint ? { fingerprint: shortFingerprint(failure.fingerprint) } : {}),
    ...(activity.latest ? { latestEventAt: activity.latest } : {}),
    eventCount: activity.count,
    ...(target.prUrl || job.prUrl ? { prUrl: target.prUrl ?? job.prUrl } : {}),
    ...(target.prNumber || job.prNumber ? { prNumber: target.prNumber ?? job.prNumber } : {}),
    dependsOn: job.dependsOn.map((dep) => ({
      jobId: dep.jobId,
      state: dep.state,
      ...(dep.blockedDetail ? { detail: dep.blockedDetail } : {}),
    })),
    evidence: evidenceLines(deliverable, notes),
    feedback,
    notes,
    ...(historyLine ? { historyLine } : {}),
    findings: Boolean(job.findingsPath),
    spec: Boolean(job.specPath),
    log: Boolean(job.logPath),
    ...(job.logTail?.trim() ? { logTail: job.logTail.trim() } : {}),
    ...(job.reviewPostError ? { reviewPostError: job.reviewPostError } : {}),
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const leftover = min % 60;
  return leftover ? `${hr}h ${leftover}m` : `${hr}h`;
}

export function formatCost(usd: number | null | undefined): string | undefined {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return undefined;
  return `$${usd.toFixed(2)}`;
}

/** Relative label from `now`. The page script replaces it with the viewer's clock. */
export function formatRelative(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const delta = now - ts;
  const future = delta < 0;
  const abs = Math.abs(delta);
  const sec = Math.round(abs / 1000);
  if (sec < 45) return future ? "in a moment" : "just now";
  const min = Math.round(sec / 60);
  const suffix = future ? "" : " ago";
  const prefix = future ? "in " : "";
  if (min < 60) return `${prefix}${min}m${suffix}`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${prefix}${hr}h${suffix}`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${prefix}${day}d${suffix}`;
  return formatLocal(iso);
}

/** Readable clock time in the server's zone. The browser rewrites it locally. */
export function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function stateTone(state: string): string {
  switch (state) {
    case "running":
    case "approved":
      return "running";
    case "queued":
    case "blocked":
      return "queued";
    case "needs-human":
    case "in-review":
      return "needs-you";
    case "failed":
    case "dead":
    case "invalid":
      return "needs-hand";
    case "done":
    case "cancelled":
      return "done";
    case "rejected":
      return "failed";
    default:
      return "queued";
  }
}

function phasesOf(job: StatusJobView, events: readonly KilnEvent[]): PhaseView[] {
  const planned = new Set(job.steps.map((step) => step.id));
  const byStep = new Map<string, PhaseView>();
  const order: string[] = [];
  const ensure = (id: string, label?: string): PhaseView => {
    const existing = byStep.get(id);
    if (existing) return existing;
    const phase: PhaseView = { id, label: label ?? labelOf(id), status: "pending" };
    byStep.set(id, phase);
    order.push(id);
    return phase;
  };
  for (const step of job.steps) {
    ensure(step.id).status = stepStatus(step.phase);
  }
  for (const event of events) {
    if (event.event === "phase.started" && event.step) {
      const phase = ensure(event.step);
      phase.startedAt = event.ts;
      if (!planned.has(event.step) && phase.status === "pending") phase.status = "running";
      if (event.properties.iteration !== undefined) phase.iteration = event.properties.iteration;
      continue;
    }
    if (event.event === "phase.finished" && event.step) {
      const phase = ensure(event.step);
      phase.finishedAt = event.ts;
      if (!planned.has(event.step)) {
        phase.status = event.properties.outcome === "failed" ? "failed" : event.properties.skipped ? "skipped" : "done";
      }
      if (event.properties.iteration !== undefined) phase.iteration = event.properties.iteration;
      if (event.properties.verdict) phase.verdict = event.properties.verdict;
      if (event.properties.detail) phase.detail = event.properties.detail;
      if (event.properties.test_command) phase.testCommand = event.properties.test_command;
      if (event.properties.exit_code !== undefined) phase.exitCode = event.properties.exit_code;
      continue;
    }
    if (event.event === "gate.resolved" && event.properties.decision === "revise" && event.properties.note) {
      const phase = ensure(event.step ?? `revise-${event.ts}`, "Revise");
      phase.status = "done";
      phase.finishedAt = event.ts;
      phase.note = event.properties.note;
      continue;
    }
    if (event.event === "pr.feedback") {
      const phase = ensure(`fix-${event.properties.round}`, `Fix ${event.properties.round}`);
      phase.status = event.properties.outcome ? "done" : "running";
      phase.finishedAt = event.ts;
      phase.iteration = event.properties.round;
      phase.detail = event.properties.outcome ?? event.properties.trigger;
      continue;
    }
    if (event.event === "run.failed") {
      const phase = [...byStep.values()].reverse().find((item) => item.status === "failed") ?? [...byStep.values()].at(-1);
      const fingerprint = shortFingerprint(event.properties.fingerprint);
      if (phase) {
        if (event.properties.class) phase.failureClass = event.properties.class;
        if (fingerprint) phase.fingerprint = fingerprint;
        if (event.properties.detail && !phase.detail) phase.detail = event.properties.detail;
      } else {
        const failed = ensure("run", "Run");
        failed.status = "failed";
        failed.finishedAt = event.ts;
        if (event.properties.class) failed.failureClass = event.properties.class;
        if (fingerprint) failed.fingerprint = fingerprint;
        if (event.properties.detail) failed.detail = event.properties.detail;
      }
    }
  }
  for (const phase of byStep.values()) {
    if (!phase.startedAt || !phase.finishedAt) continue;
    const ms = Date.parse(phase.finishedAt) - Date.parse(phase.startedAt);
    if (Number.isFinite(ms) && ms >= 0) phase.durationMs = ms;
  }
  return order.map((id) => byStep.get(id)).filter((phase): phase is PhaseView => Boolean(phase));
}

function timelineOf(events: readonly KilnEvent[]): TimelineRun[] {
  const runs: TimelineRun[] = [];
  const index = new Map<string, TimelineRun>();
  for (const event of events) {
    const key = event.run_id ?? "";
    let run = index.get(key);
    if (!run) {
      run = { runId: event.run_id, entries: [] };
      index.set(key, run);
      runs.push(run);
    }
    run.entries.push({ ts: event.ts, summary: summarizeEvent(event) });
  }
  return runs;
}

function summarizeEvent(event: KilnEvent): string {
  switch (event.event) {
    case "job.added":
      return `Added · ${event.properties.workflow}`;
    case "job.retried":
      return "Retried";
    case "run.started":
      return `Run started · ${event.properties.workflow}`;
    case "phase.started":
      return `${labelOf(event.step ?? "step")} started`;
    case "phase.finished": {
      const outcome = event.properties.outcome === "failed" ? "failed" : "finished";
      const verdict = event.properties.verdict ? ` · ${event.properties.verdict}` : "";
      return `${labelOf(event.step ?? "step")} ${outcome}${verdict}`;
    }
    case "gate.opened":
      return event.properties.prompt ? `Gate opened · ${oneLine(event.properties.prompt, 120)}` : "Gate opened";
    case "gate.resolved":
      return `Gate ${event.properties.decision}`;
    case "run.failed":
      return event.properties.class ? `Run failed · ${event.properties.class}` : "Run failed";
    case "run.finished":
      return "Run finished";
    case "pr.opened":
      return `Opened pull request #${event.properties.number}`;
    case "pr.feedback":
      return `Feedback round ${event.properties.round} · ${event.properties.trigger}`;
    case "worktree.cleaned":
      return "Worktree cleaned";
    case "worktree.kept":
      return "Worktree kept";
    case "needs-human":
      return `Needs a person · ${event.properties.reason}`;
    case "job.cancelled":
      return "Cancelled before it started";
    case "review.posted":
      return `Posted the review on ${event.properties.repo}#${event.properties.number}`;
    case "review.failed":
      return `Could not post the review · ${event.properties.class}`;
    default:
      return event.event;
  }
}

interface ReviewTarget {
  prUrl?: string;
  prNumber?: number;
  headSha?: string;
  reviewUrl?: string;
}

function reviewTarget(job: StatusJobView, events: readonly KilnEvent[]): ReviewTarget {
  const parsed = job.source?.ref ? parseReviewSource(job.source.ref) : undefined;
  const target: ReviewTarget = {};
  if (parsed && parsed.repo === job.repo) {
    target.prNumber = parsed.number;
    target.headSha = parsed.sha;
  }
  for (const event of events) {
    if (event.event === "pr.opened") {
      target.prUrl = event.properties.url;
      target.prNumber = event.properties.number;
    }
    if (event.event === "review.posted") {
      target.prNumber = event.properties.number;
      target.headSha = event.properties.sha.toLowerCase();
      target.reviewUrl = event.properties.url;
    }
  }
  const texts = collectedTexts(job);
  for (const text of texts) {
    const url = /^Pull request:\s*(https?:\/\/\S+)/m.exec(text)?.[1];
    const number = /^Number:\s*(\d+)/m.exec(text)?.[1];
    const head = /^Head:\s*([0-9a-f]{7,64})/im.exec(text)?.[1];
    if (url && !target.prUrl) target.prUrl = url;
    if (number && !target.prNumber) target.prNumber = Number(number);
    if (head && !target.headSha) target.headSha = head.toLowerCase();
  }
  if (job.prUrl && !target.prUrl) target.prUrl = job.prUrl;
  if (job.prNumber && !target.prNumber) target.prNumber = job.prNumber;
  if (job.reviewUrl && !target.reviewUrl) target.reviewUrl = job.reviewUrl;
  return target;
}

function deliverableOf(job: StatusJobView, target: ReviewTarget): Deliverable | undefined {
  const gate = gateParts(job);
  const draft = draftFrom(collectedTexts(job));
  const review = job.workflow === "review" || Boolean(draft) || Boolean(job.source?.ref && parseReviewSource(job.source.ref));
  if (review && (draft || gate.markdown || gate.ask)) {
    const markdown = longer(draft?.markdown, gate.markdown);
    const fromJson = draft?.findings ?? [];
    const findings = sortFindings(fromJson.length > 0 ? fromJson : findingsFromMarkdown(markdown));
    const stripped = presentMarkdown(markdown, job.title, findings.length > 0);
    return {
      kind: "review",
      markdown: stripped.markdown,
      findings,
      ...(stripped.verdict ? { verdict: stripped.verdict } : {}),
      ...(target.prUrl ? { prUrl: target.prUrl } : {}),
      ...(target.prNumber ? { prNumber: target.prNumber } : {}),
      ...(target.headSha ? { headSha: target.headSha } : {}),
      ...(draft?.raw ? { raw: draft.raw } : {}),
    };
  }
  const notes = proseNotes(job, gate.markdown);
  if (!gate.markdown && notes.length === 0) return undefined;
  return { kind: "prose", ...(gate.markdown ? { markdown: gate.markdown } : {}), notes };
}

function askOf(job: StatusJobView): string | undefined {
  const gate = job.gates[0];
  if (!gate) return undefined;
  const first = gate.rendered?.split("\n")[0]?.trim();
  const ask = first || gate.prompt.trim();
  return ask || undefined;
}

function gateParts(job: StatusJobView): { ask?: string; markdown: string } {
  const gate = job.gates.find((item) => item.rendered?.includes("\n")) ?? job.gates[0];
  if (!gate?.rendered?.includes("\n")) return { ...(gate ? { ask: gate.prompt.trim() } : {}), markdown: "" };
  const ask = gate.rendered.split("\n")[0]?.trim() || gate.prompt.trim();
  const parts = gate.rendered.split("\n").slice(1).join("\n").trim().split(/\n\s*\n/);
  if (parts[0] && BOILERPLATE.test(parts[0].trim())) parts.shift();
  return { ...(ask ? { ask } : {}), markdown: parts.join("\n\n").trim() };
}

function draftFrom(texts: readonly string[]): { markdown: string; findings: FindingView[]; raw: string } | undefined {
  let best: { markdown: string; findings: FindingView[]; raw: string } | undefined;
  for (const text of texts) {
    const start = text.indexOf("{");
    if (start < 0 || !text.includes('"markdown"')) continue;
    const raw = text.slice(start).trim();
    const parsed = parseObject(raw);
    if (parsed) {
      const draft = parseReviewDraft(parsed);
      if (!draft) continue;
      const findings = draft.findings.flatMap((finding) => {
        const view = findingView(finding);
        return view ? [view] : [];
      });
      if (!best || draft.markdown.length >= best.markdown.length) best = { markdown: draft.markdown, findings, raw };
      continue;
    }
    const match = /"markdown"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
    if (!match?.[1]) continue;
    const markdown = unescapeJson(match[1]);
    if (!markdown.trim()) continue;
    const findings = findingsFromMarkdown(markdown);
    if (!best || markdown.length > best.markdown.length) best = { markdown, findings, raw };
  }
  return best;
}

function presentMarkdown(markdown: string, title: string, dropFindingLines: boolean): { markdown: string; verdict?: string } {
  let body = markdown.trim();
  const verdict = verdictOf(body);
  body = body
    .split("\n")
    .filter((line) => !VERDICT_LINE.test(line.trim()))
    .join("\n");
  if (dropFindingLines) {
    body = body
      .split("\n")
      .filter((line) => !FINDING_LINE.test(line.trim()))
      .join("\n");
  }
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  const lines = body.split("\n");
  const heading = lines[0]?.trim().replace(/^#+\s*/, "") ?? "";
  if (heading && (heading === title || heading.endsWith(title))) {
    body = lines.slice(1).join("\n").trim();
  }
  return { markdown: body, ...(verdict ? { verdict } : {}) };
}

function findingsFromMarkdown(markdown: string): FindingView[] {
  const found: FindingView[] = [];
  for (const line of markdown.split("\n")) {
    const match = FINDING_LINE.exec(line.trim());
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) continue;
    const severity = SEVERITY_ORDER.find((item) => item === match[1].toLowerCase());
    if (!severity) continue;
    found.push({ severity, file: match[2], line: Number(match[3]), comment: match[4].trim() });
  }
  return found;
}

function proseNotes(job: StatusJobView, markdown: string): string[] {
  const notes: string[] = [];
  const push = (text: string | undefined) => {
    const trimmed = text?.trim();
    if (!trimmed || notes.includes(trimmed)) return;
    if (markdown && (trimmed === markdown || markdown.includes(trimmed))) return;
    if (/^title:\s*/i.test(trimmed)) return;
    if (trimmed.startsWith("{") && trimmed.includes('"markdown"')) return;
    notes.push(trimmed);
  };
  if (job.workflow !== "investigation") push(job.diffSummary);
  for (const gate of job.gates) {
    for (const review of gate.reviews) push(reviewLabel(review.name, review.summary));
    for (const artifact of gate.artifacts) {
      if (artifact.name === "input" || artifact.name === "draft") continue;
      push(artifact.summary);
    }
  }
  return notes;
}

function noteLines(job: StatusJobView, deliverable: Deliverable | undefined): string[] {
  const covered = deliverable?.kind === "prose" ? deliverable.notes : [];
  const notes: string[] = [];
  const push = (text: string | undefined) => {
    const trimmed = text?.trim();
    if (!trimmed || notes.includes(trimmed) || covered.includes(trimmed) || isDump(trimmed)) return;
    notes.push(trimmed);
  };
  push(job.launchError);
  push(job.failureDetail);
  push(job.waitReason);
  push(job.reviewPostError);
  return notes;
}

function evidenceLines(deliverable: Deliverable | undefined, notes: string[]): string[] {
  const lines = [...notes];
  if (deliverable?.kind === "review" && deliverable.markdown) lines.unshift(deliverable.markdown);
  if (deliverable?.kind === "prose" && deliverable.markdown) lines.unshift(deliverable.markdown);
  return lines;
}

function isDump(text: string): boolean {
  if (/^title:\s*/i.test(text)) return true;
  if (text.startsWith("{") && text.includes('"markdown"')) return true;
  return false;
}

function collectedTexts(job: StatusJobView): string[] {
  const texts: string[] = [];
  for (const gate of job.gates) {
    if (gate.rendered) texts.push(gate.rendered);
    for (const artifact of gate.artifacts) texts.push(artifact.summary);
    for (const review of gate.reviews) texts.push(review.summary);
  }
  for (const file of job.files ?? []) texts.push(file.text);
  return texts;
}

function finishedLine(job: StatusJobView): string {
  if (job.state === "cancelled") return "Cancelled";
  if (job.state === "rejected") return "Rejected";
  if (job.workflow === "review") return job.reviewUrl ? "comment posted" : "approved";
  if (job.prNumber) return `merged · PR #${job.prNumber}`;
  if (job.prUrl && httpUrl(job.prUrl)) return "merged · PR";
  return job.branch ? `landed locally · ${job.branch}` : "landed locally";
}

function handLine(job: StatusJobView, failure: { class?: FailureClass; fingerprint?: string } | undefined): string {
  if (job.reviewPostError) return job.reviewPostError;
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

function attemptLine(job: StatusJobView): string | undefined {
  if (job.attemptCount <= 0 && !job.lastFailureReason) return undefined;
  const parts: string[] = [];
  if (job.attemptCount > 0) parts.push(`attempt ${job.attemptCount}/${job.maxAttempts}`);
  if (job.lastFailureReason) parts.push(job.lastFailureReason);
  return parts.join(" · ");
}

function jobActivity(events: readonly KilnEvent[]): { count: number; latest?: string } {
  let count = 0;
  let latest: string | undefined;
  for (const event of events) {
    count += 1;
    if (!latest || event.ts > latest) latest = event.ts;
  }
  return { count, ...(latest ? { latest } : {}) };
}

function latestFailure(events: readonly KilnEvent[]): { class?: FailureClass; fingerprint?: string } | undefined {
  let found: { class?: FailureClass; fingerprint?: string } | undefined;
  for (const event of events) {
    if (event.event !== "run.failed") continue;
    found = {
      ...(event.properties.class ? { class: event.properties.class } : {}),
      ...(event.properties.fingerprint ? { fingerprint: event.properties.fingerprint } : {}),
    };
  }
  return found;
}

function jobCost(events: readonly KilnEvent[]): number | null {
  let usd = 0;
  let saw = false;
  for (const event of events) {
    if (event.event !== "run.finished" && event.event !== "run.failed") continue;
    const amount = event.properties.usd;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) continue;
    usd += amount;
    saw = true;
  }
  return saw ? usd : null;
}

function findingView(finding: ReviewFinding): FindingView | undefined {
  if (!finding.comment.trim()) return undefined;
  return {
    severity: finding.severity,
    comment: finding.comment.trim(),
    ...(finding.file ? { file: finding.file } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
  };
}

function sortFindings(findings: readonly FindingView[]): FindingView[] {
  return [...findings].sort((left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity));
}

function verdictOf(markdown: string): string | undefined {
  for (const line of markdown.split("\n")) {
    const match = VERDICT_LINE.exec(line.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function reviewLabel(name: string, summary: string): string {
  const text = summary.trim();
  if (!text) return "";
  if (text.toLowerCase().startsWith(name.toLowerCase())) return text;
  return `${name}: ${text}`;
}

function labelOf(id: string): string {
  return PHASE_LABEL[id] ?? id.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function stepStatus(phase: StatusJobView["steps"][number]["phase"]): PhaseStatus {
  if (phase === "done") return "done";
  if (phase === "current") return "running";
  if (phase === "failed") return "failed";
  return "pending";
}

function currentPhase(phases: readonly PhaseView[]): string | undefined {
  return (
    phases.find((phase) => phase.status === "running")?.label ??
    [...phases].reverse().find((phase) => phase.status === "failed")?.label ??
    [...phases].reverse().find((phase) => phase.status === "done")?.label
  );
}

function longer(left: string | undefined, right: string): string {
  const a = left?.trim() ?? "";
  const b = right.trim();
  return a.length >= b.length ? a : b;
}

function parseObject(text: string): unknown {
  const slice = text.replace(/\.\.\.$/, "").trim();
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    return undefined;
  }
}

function unescapeJson(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function shortFingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 12);
}

function httpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
