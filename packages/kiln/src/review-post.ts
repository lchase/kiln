import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents, type KilnEvent } from "./events.js";
import { classifyFailureText, type FailureClass } from "./failure.js";
import { realGitHub, type KilnHost, type PullRequestReviewComment } from "./host.js";
import { redact } from "./redact.js";
import { parseReviewSource } from "./triggers.js";

/**
 * A review draft the human has not posted yet, and the COMMENT review Kiln
 * writes after they approve the Inbox gate.
 *
 * The review event is always COMMENT. Kiln does not approve, request
 * changes, or merge. A second approve at the same `review:<repo>:<number>:<sha>`
 * does not post again.
 */

export const REVIEW_SEVERITIES = ["note", "nit", "warning", "blocking"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  comment: string;
}

export interface ReviewDraft {
  markdown: string;
  findings: ReviewFinding[];
}

export interface CommentReviewBody {
  body: string;
  comments: PullRequestReviewComment[];
  findings: number;
  inline: number;
  skipped: number;
}

export interface ReviewTarget {
  repo: string;
  number: number;
  sha: string;
  dedupe: string;
}

const NEEDS_HUMAN_REASON = "review-post";

/** Target of a review-request job, or undefined when the draft is not tied to a pull request. */
export function reviewTargetFrom(repo: string, sourceRef: string | undefined): ReviewTarget | undefined {
  if (!sourceRef) return undefined;
  const parsed = parseReviewSource(sourceRef);
  if (!parsed || parsed.repo !== repo) return undefined;
  return {
    repo: parsed.repo,
    number: parsed.number,
    sha: parsed.sha,
    dedupe: `review:${parsed.repo}:${parsed.number}:${parsed.sha}`,
  };
}

export function reviewAlreadyPosted(events: readonly KilnEvent[], dedupe: string): boolean {
  return events.some((event) => event.event === "review.posted" && event.properties.dedupe === dedupe);
}

/**
 * Latest post for this job. A `review.posted` for the same dedupe, including
 * one recorded on another job, counts as posted.
 */
export function reviewPostForJob(
  events: readonly KilnEvent[],
  job: { jobId: string; repo: string; source?: { kind: string; ref: string } },
): { url?: string; error?: string } {
  const dedupe = job.source?.kind === "trigger" ? reviewTargetFrom(job.repo, job.source.ref)?.dedupe : undefined;
  let url: string | undefined;
  let error: string | undefined;
  for (const event of events) {
    const posted =
      event.event === "review.posted" &&
      (event.job_id === job.jobId || (dedupe !== undefined && event.properties.dedupe === dedupe));
    if (posted) {
      url = event.properties.url;
      error = undefined;
      continue;
    }
    if (event.event === "review.failed" && event.job_id === job.jobId) {
      url = undefined;
      error = `Could not post the review (${event.properties.class}). ${event.properties.detail}`;
    }
  }
  return { ...(url ? { url } : {}), ...(error ? { error } : {}) };
}

/** The draft step's artifact. Missing or unreadable is undefined. Extra fields are ignored. */
export function readReviewDraft(checkout: string, runId: string): ReviewDraft | undefined {
  const path = join(checkout, ".runs", runId, "artifacts", "draft.json");
  if (!existsSync(path)) return undefined;
  try {
    return parseReviewDraft(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export function parseReviewDraft(value: unknown): ReviewDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const markdown = (value as { markdown?: unknown }).markdown;
  if (typeof markdown !== "string" || !markdown.trim()) return undefined;
  const raw = (value as { findings?: unknown }).findings;
  const findings: ReviewFinding[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const finding = parseFinding(item);
      if (finding) findings.push(finding);
    }
  }
  return { markdown: markdown.trim(), findings };
}

/**
 * Body is the draft markdown. Findings with a real file and line become
 * inline comments. Anything else is folded into the body when the markdown
 * does not already contain it. Line numbers are never invented.
 */
export function buildCommentReview(draft: ReviewDraft): CommentReviewBody {
  const comments: PullRequestReviewComment[] = [];
  const skipped: ReviewFinding[] = [];
  for (const finding of draft.findings) {
    const path = commentPath(finding.file);
    const line = commentLine(finding.line);
    if (!path || line === undefined) {
      skipped.push(finding);
      continue;
    }
    comments.push({ path, line, body: commentText(finding) });
  }
  return {
    body: redact(foldSkipped(draft.markdown, skipped)),
    comments: comments.map((comment) => ({ ...comment, body: redact(comment.body) })),
    findings: draft.findings.length,
    inline: comments.length,
    skipped: skipped.length,
  };
}

export interface PostApprovedReviewInput {
  kilnDir: string;
  jobId: string;
  runId: string;
  repo: string;
  sourceRef: string | undefined;
  checkout: string;
  host: KilnHost;
  paused: boolean;
  spendBlocked: boolean;
}

/**
 * Post the approved draft, or do nothing when that head SHA was already
 * posted. Throws without calling gh when the factory is paused, the daily
 * cap is blocking, or the post fails. The caller leaves the gate open on throw.
 */
export function postApprovedReview(input: PostApprovedReviewInput): void {
  const target = reviewTargetFrom(input.repo, input.sourceRef);
  if (!target) {
    recordNeedsHuman(input);
    throw new Error("This review draft is not tied to a pull request, so Kiln will not post it.");
  }
  const events = readEvents(input.kilnDir, { warn: () => {} });
  if (reviewAlreadyPosted(events, target.dedupe)) return;
  if (input.paused) {
    throw new Error("Paused. Kiln will not post this review until kiln resume.");
  }
  if (input.spendBlocked) {
    throw new Error("Daily cap reached. Kiln will not post this review until the local day rolls over.");
  }
  const draft = readReviewDraft(input.checkout, input.runId);
  if (!draft) {
    failPost(input, target, "deterministic", "The draft artifact is missing or unreadable.");
  }
  const review = buildCommentReview(draft);
  const poster = input.host.github.postCommentReview ?? realGitHub.postCommentReview;
  if (!poster) {
    failPost(input, target, "deterministic", "gh cannot post a review from this host.");
  }
  let posted: { id: string; url: string };
  try {
    posted = poster.call(input.host.github, {
      checkout: input.checkout,
      number: target.number,
      commitId: target.sha,
      body: review.body,
      comments: review.comments,
    });
  } catch (error) {
    const detail = publicDetail(error);
    failPost(input, target, classifyFailureText(detail), detail);
  }
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "review.posted",
    step: "approve",
    properties: {
      repo: target.repo,
      number: target.number,
      sha: target.sha,
      review_id: posted.id,
      url: posted.url,
      findings: review.findings,
      inline: review.inline,
      skipped: review.skipped,
      dedupe: target.dedupe,
      once: `posted:${target.dedupe}`,
    },
  });
}

function failPost(input: PostApprovedReviewInput, target: ReviewTarget, failureClass: FailureClass, detail: string): never {
  const clipped = detail.trim() || "The review was not posted.";
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "review.failed",
    step: "approve",
    properties: {
      repo: target.repo,
      number: target.number,
      sha: target.sha,
      class: failureClass,
      detail: clipped,
      dedupe: target.dedupe,
    },
  });
  recordNeedsHuman(input);
  throw new Error(`Could not post the review (${failureClass}). ${clipped}`);
}

function recordNeedsHuman(input: PostApprovedReviewInput): void {
  appendEvent(input.kilnDir, {
    job_id: input.jobId,
    run_id: input.runId,
    event: "needs-human",
    step: "approve",
    properties: { reason: NEEDS_HUMAN_REASON, once: `needs-human:${NEEDS_HUMAN_REASON}` },
  });
}

function publicDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = redact(message).replace(/\s+/g, " ").trim();
  if (cleaned.length > 500) return `${cleaned.slice(0, 499)}…`;
  return cleaned || "The review was not posted.";
}

function parseFinding(value: unknown): ReviewFinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { severity?: unknown; file?: unknown; line?: unknown; comment?: unknown };
  if (typeof record.comment !== "string" || !record.comment.trim()) return undefined;
  const severity = REVIEW_SEVERITIES.find((item) => item === record.severity) ?? "note";
  const file = typeof record.file === "string" ? record.file : undefined;
  const line = commentLine(record.line);
  return {
    severity,
    comment: record.comment.trim(),
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

/** A relative path inside the repo. Absolute paths and `..` are not locations. A leading `./` is a normal relative path. */
export function commentPath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const raw = file.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) return undefined;
  if (/[\0\r\n]/.test(raw)) return undefined;
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "..")) return undefined;
  const cleaned = parts.filter((part) => part !== ".");
  if (cleaned.length === 0) return undefined;
  return cleaned.join("/");
}

function commentLine(line: unknown): number | undefined {
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  return line;
}

function commentText(finding: ReviewFinding): string {
  const text = finding.comment.trim();
  if (finding.severity === "nit") return `**nit** (not blocking)\n\n${text}`;
  return `**${finding.severity}**\n\n${text}`;
}

function foldSkipped(markdown: string, skipped: readonly ReviewFinding[]): string {
  const base = markdown.trim();
  const extra = skipped.filter((finding) => !base.includes(finding.comment.trim()));
  if (extra.length === 0) return `${base}\n`;
  const lines = [
    base,
    "",
    "## Not posted on a line",
    "",
    "These findings had no file and line Kiln could check, so they are only in this review.",
    "",
  ];
  for (const finding of extra) lines.push(`- **${finding.severity}** ${finding.comment.trim()}`);
  return `${lines.join("\n")}\n`;
}
