import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HostError } from "./host.js";
import { jobBasename } from "./paths.js";

/**
 * Feedback ledger under `<kilnDir>/feedback/<jobId>.json`.
 * Job files stay free of stored state. Tick is the only writer.
 * A second tick that sees the same head sha and the same items does not
 * append a round. `at` is when the round was opened, so a later review can
 * be told from one this round already included.
 *
 * Kiln reads pull request state. It does not merge, approve, or comment.
 */

const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 2_000;

const ItemSchema = z.object({
  kind: z.string().min(1),
  source: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().min(1).optional(),
});

const RoundSchema = z.object({
  round: z.number().int().min(1),
  headSha: z.string().min(1),
  trigger: z.enum(["ci", "review"]),
  items: z.array(ItemSchema).min(1),
  fixRunId: z.string().min(1).optional(),
  outcome: z.enum(["fixed", "pushed"]).optional(),
  /** When this round was opened. Review feedback newer than this can start another round. */
  at: z.string().min(1),
});

const LedgerSchema = z.object({
  jobId: z.string().min(1),
  rounds: z.array(RoundSchema),
  /** A further round would pass `maxFixRounds`. The job is needs-human. */
  exhausted: z.boolean().optional(),
  /** Feedback Kiln could not classify. The job is needs-human. No fix is launched. */
  ambiguous: z.boolean().optional(),
});

export type FeedbackItem = z.infer<typeof ItemSchema>;
export type FeedbackRound = z.infer<typeof RoundSchema>;
export type FeedbackLedger = z.infer<typeof LedgerSchema>;

export interface FeedbackCheck {
  name: string;
  /** `completed`, or a not-yet-finished status such as `queued` or `in_progress`. */
  status: string;
  /** Conclusion for a completed check. Null while the check is still running. */
  conclusion: string | null;
  url?: string;
  /** Tail of the check log or the check's output text. Kiln truncates it. */
  logExcerpt?: string;
}

export interface FeedbackReview {
  id: string;
  author: string;
  /** `CHANGES_REQUESTED`, `APPROVED`, `COMMENTED`, `DISMISSED`, `PENDING`, or another GitHub state. */
  state: string;
  body: string;
  submittedAt: string;
  url?: string;
}

export interface FeedbackComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  submittedAt: string;
  url?: string;
  resolved: boolean;
}

/** One read of an open pull request. Tests stub this. The gh implementation only reads. */
export interface PullRequestFeedback {
  /**
   * Login of the authenticated gh user. That person opens the pull request,
   * so their inline comments count. A top-level note counts only with a `/kiln` prefix.
   */
  operatorLogin: string | null;
  headSha: string;
  checks: FeedbackCheck[];
  reviews: FeedbackReview[];
  comments: FeedbackComment[];
}

export interface PullRequestFeedbackSource {
  /**
   * Pull request feedback for `prNumber`.
   * Implementations must not merge, approve, or post a comment.
   */
  read(checkout: string, prNumber: number): PullRequestFeedback;
}

export type FeedbackPlan =
  | { action: "none" }
  | { action: "fix"; headSha: string; trigger: "ci" | "review"; items: FeedbackItem[] }
  | { action: "exhaust" }
  | { action: "ambiguous" };

const FAILING = new Set(["failure", "timed_out", "startup_failure", "error"]);
const PASSING = new Set(["success", "neutral", "skipped", "cancelled"]);
const QUIET_REVIEW = new Set(["APPROVED", "COMMENTED", "DISMISSED", "PENDING"]);
/** A top-level operator note. The rest of the body is the fix instruction. */
const KILN_REQUEST = /^\/kiln\b\s*/;

export function feedbackLedgerPath(kilnDir: string, jobId: string): string {
  return join(kilnDir, "feedback", `${jobBasename(jobId)}.json`);
}

export function readFeedbackLedger(kilnDir: string, jobId: string): FeedbackLedger | "corrupt" | undefined {
  const path = feedbackLedgerPath(kilnDir, jobId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = LedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.jobId !== jobId) return "corrupt";
    return parsed;
  } catch {
    return "corrupt";
  }
}

export function writeFeedbackLedger(kilnDir: string, ledger: FeedbackLedger): void {
  const path = feedbackLedgerPath(kilnDir, ledger.jobId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(LedgerSchema.parse(ledger), null, 2)}\n`);
  renameSync(tmp, path);
}

/** A round that has not been marked fixed or pushed. Undefined once the ledger is closed. */
export function openFeedbackRound(ledger: FeedbackLedger | undefined): FeedbackRound | undefined {
  if (!ledger || ledger.exhausted || ledger.ambiguous) return undefined;
  return [...ledger.rounds].reverse().find((round) => round.outcome !== "pushed" && round.outcome !== "fixed");
}

/** Last 40 lines, and at most 2000 characters, keeping the tail. */
export function truncateExcerpt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/).slice(-EXCERPT_LINES);
  let excerpt = lines.join("\n").trim();
  if (excerpt.length > EXCERPT_CHARS) excerpt = excerpt.slice(excerpt.length - EXCERPT_CHARS).trim();
  return excerpt;
}

/**
 * Kiln itself, and any GitHub App (`name[bot]`).
 * CI checks are not authors, so a failing check still counts.
 * The operator is not ignored: they open the pull request, and GitHub will
 * not let them request changes on it.
 */
export function isIgnoredAuthor(author: string): boolean {
  const login = author.trim().toLowerCase();
  if (!login) return false;
  return login === "kiln" || login.endsWith("[bot]");
}

function isOperator(author: string, operatorLogin: string | null): boolean {
  if (!operatorLogin) return false;
  return author.trim().toLowerCase() === operatorLogin.trim().toLowerCase();
}

/** Text after a leading `/kiln`, or undefined when the body is not a kiln request. */
function kilnRequest(body: string): string | undefined {
  const trimmed = body.trim();
  const match = KILN_REQUEST.exec(trimmed);
  if (!match) return undefined;
  const rest = trimmed.slice(match[0].length).trim();
  return rest.length > 0 ? rest : undefined;
}

/** An inline comment or any other comment that belongs to a review thread. */
function isThreadComment(comment: FeedbackComment): boolean {
  return Boolean(comment.path) || typeof comment.line === "number";
}

/**
 * What this tick should do with one pull request snapshot.
 * Pending checks are ignored. A failing check counts only on a head sha that
 * no round has already recorded. Review feedback counts when it is newer than
 * the last round and was not already an item. The same sha and the same item
 * source never return `fix` twice.
 */
export function planFeedback(input: {
  maxFixRounds: number;
  ledger: FeedbackLedger | undefined;
  snapshot: PullRequestFeedback;
}): FeedbackPlan {
  const ledger = input.ledger;
  if (ledger?.exhausted || ledger?.ambiguous) return { action: "none" };
  if (openFeedbackRound(ledger)) return { action: "none" };

  const seen = new Set<string>();
  for (const round of ledger?.rounds ?? []) {
    for (const item of round.items) seen.add(item.source);
  }
  const last = ledger?.rounds.at(-1);
  const lastAt = last ? Date.parse(last.at) : Number.NaN;
  const shaIsNew = !last || last.headSha !== input.snapshot.headSha;

  const isNew = (source: string, submittedAt: string | undefined): boolean => {
    if (seen.has(source)) return false;
    if (!last) return true;
    if (!submittedAt) return true;
    const at = Date.parse(submittedAt);
    if (!Number.isFinite(at) || !Number.isFinite(lastAt)) return true;
    return at > lastAt;
  };

  let ambiguous = false;
  const items: FeedbackItem[] = [];

  if (shaIsNew) {
    for (const check of input.snapshot.checks) {
      const status = normalize(check.status);
      const conclusion = check.conclusion ? normalize(check.conclusion) : null;
      if (isPending(status, conclusion)) continue;
      if (conclusion && PASSING.has(conclusion)) continue;
      if (conclusion && FAILING.has(conclusion)) {
        const source = `check:${input.snapshot.headSha}:${check.name}`;
        if (seen.has(source)) continue;
        const excerpt = check.logExcerpt ? truncateExcerpt(check.logExcerpt) : "";
        const summary = excerpt ? `${check.name} failed\n\n${excerpt}` : `${check.name} failed`;
        items.push({
          kind: "check",
          source,
          summary,
          ...(check.url ? { url: check.url } : {}),
        });
        continue;
      }
      ambiguous = true;
    }
  }

  for (const review of input.snapshot.reviews) {
    if (isIgnoredAuthor(review.author)) continue;
    const source = `review:${review.id}`;
    if (isOperator(review.author, input.snapshot.operatorLogin)) {
      const request = kilnRequest(review.body);
      if (!request || !isNew(source, review.submittedAt)) continue;
      items.push({
        kind: "review",
        source,
        summary: request,
        ...(review.url ? { url: review.url } : {}),
      });
      continue;
    }
    const state = review.state.trim().toUpperCase();
    if (QUIET_REVIEW.has(state)) continue;
    if (state !== "CHANGES_REQUESTED") {
      ambiguous = true;
      continue;
    }
    if (!isNew(source, review.submittedAt)) continue;
    const body = review.body.trim();
    items.push({
      kind: "review",
      source,
      summary: body ? `Changes requested\n\n${body}` : "Changes requested",
      ...(review.url ? { url: review.url } : {}),
    });
  }

  for (const comment of input.snapshot.comments) {
    if (comment.resolved) continue;
    if (isIgnoredAuthor(comment.author)) continue;
    const source = `comment:${comment.id}`;
    if (!isNew(source, comment.submittedAt)) continue;
    const operator = isOperator(comment.author, input.snapshot.operatorLogin);
    let body = comment.body.trim();
    if (!isThreadComment(comment)) {
      // Top-level conversation notes are not review threads. Other people
      // still act through a review or an inline comment. The operator acts
      // here only with a `/kiln` request, and the prefix stays out of the prompt.
      if (!operator) continue;
      const request = kilnRequest(comment.body);
      if (!request) continue;
      body = request;
    }
    const where = comment.path ? (typeof comment.line === "number" ? `${comment.path}:${comment.line}` : comment.path) : "";
    const summary = [where, body].filter((part) => part.length > 0).join("\n\n") || "Review comment";
    items.push({
      kind: "comment",
      source,
      summary,
      ...(comment.url ? { url: comment.url } : {}),
    });
  }

  if (items.length === 0) return ambiguous ? { action: "ambiguous" } : { action: "none" };
  if ((ledger?.rounds.length ?? 0) >= input.maxFixRounds) return { action: "exhaust" };
  const trigger = items.some((item) => item.kind === "check") ? "ci" : "review";
  return { action: "fix", headSha: input.snapshot.headSha, trigger, items };
}

/** Original spec plus the feedback items the fix agent has to address. */
export function feedbackSpec(spec: string, items: readonly FeedbackItem[]): string {
  const blocks = items.map((item) => {
    const body = item.summary.trim();
    return item.url ? `${body}\n\n${item.url}` : body;
  });
  return [
    spec.trim(),
    "",
    "## Pull request feedback",
    "",
    "Address every item below. Commit on the current branch.",
    "Do not push. Do not force-push. Do not open a pull request. Do not approve one. Do not comment on one.",
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}

/** Chip text for one feedback round. Outcome, when set, follows the trigger. */
export function feedbackRoundLabel(round: { trigger: "ci" | "review"; outcome?: "fixed" | "pushed" }): string {
  const trigger = round.trigger === "ci" ? "CI failed" : "changes requested";
  if (round.outcome === "pushed") return `${trigger} · pushed`;
  if (round.outcome === "fixed") return `${trigger} · fixed`;
  return trigger;
}

/** Drawer markdown for one round. Item urls become links. */
export function feedbackRoundText(round: FeedbackRound): string {
  const lines = [`# R${round.round}`, "", feedbackRoundLabel(round), ""];
  for (const item of round.items) {
    const [title, ...rest] = item.summary.split("\n");
    const head = (title ?? item.kind).trim();
    lines.push(item.url ? `- [${head}](${item.url})` : `- ${head}`);
    const body = rest.join("\n").trim();
    if (body) lines.push("", body);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isPending(status: string, conclusion: string | null): boolean {
  if (status === "completed") return false;
  if (conclusion && (FAILING.has(conclusion) || PASSING.has(conclusion))) return false;
  return true;
}

export const realPullRequestFeedback: PullRequestFeedbackSource = {
  read(checkout, prNumber) {
    const operatorLogin = ghLogin(checkout);
    const repo = ghRepo(checkout);
    const view = ghJson(checkout, ["pr", "view", String(prNumber), "--json", "headRefOid,statusCheckRollup,reviews,url"]);
    const headSha = stringField(view, "headSha") || stringField(view, "headRefOid");
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new HostError(`gh pr view did not return a head sha for pull request #${prNumber}.`);
    }
    const prUrl = stringField(view, "url");
    const checks = checksFrom(view);
    attachCheckExcerpts(checkout, repo, headSha, checks);
    const reviews = reviewsFrom(view, prUrl);
    const comments = threadsFrom(checkout, repo, prNumber);
    return { operatorLogin, headSha, checks, reviews, comments };
  },
};

function ghLogin(checkout: string): string {
  const result = runGh(checkout, ["api", "user", "--jq", ".login"]);
  const login = result.stdout.trim();
  if (result.status !== 0 || !login || /\s/.test(login)) {
    throw new HostError(
      `Could not read the gh login. Kiln will not act on pull request feedback until gh api user works. ${result.stderr.trim()}`.trim(),
    );
  }
  return login;
}

function ghRepo(checkout: string): { owner: string; name: string } {
  const result = runGh(checkout, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const name = result.stdout.trim();
  const [owner, repo] = name.split("/");
  if (result.status !== 0 || !owner || !repo || name.split("/").length !== 2) {
    throw new HostError(`Could not read owner/name for ${checkout}: ${result.stderr.trim() || name || "gh repo view failed"}`);
  }
  return { owner, name: repo };
}

function ghJson(checkout: string, args: string[]): Record<string, unknown> {
  const result = runGh(checkout, args);
  if (result.status !== 0) {
    throw new HostError(`Could not read the pull request: ${(result.stderr || result.stdout).trim() || "gh failed"}`);
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HostError("gh pr view returned data that is not a JSON object.");
  }
}

function checksFrom(view: Record<string, unknown>): FeedbackCheck[] {
  const rollup = view.statusCheckRollup;
  if (!Array.isArray(rollup)) return [];
  const checks: FeedbackCheck[] = [];
  for (const entry of rollup) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = stringField(record, "name") || stringField(record, "context");
    if (!name) continue;
    const status = stringField(record, "status") || (stringField(record, "state") ? "completed" : "");
    const conclusion = stringField(record, "conclusion") || stringField(record, "state") || null;
    const url = stringField(record, "detailsUrl") || stringField(record, "targetUrl") || undefined;
    if (stringField(record, "state").toUpperCase() === "PENDING") {
      checks.push({ name, status: "pending", conclusion: null, ...(url ? { url } : {}) });
      continue;
    }
    checks.push({
      name,
      status: status || "completed",
      conclusion: conclusion && conclusion.toUpperCase() !== "PENDING" ? conclusion : null,
      ...(url ? { url } : {}),
    });
  }
  return checks;
}

function attachCheckExcerpts(
  checkout: string,
  repo: { owner: string; name: string },
  headSha: string,
  checks: FeedbackCheck[],
): void {
  const failing = checks.filter((check) => {
    const conclusion = check.conclusion ? normalize(check.conclusion) : null;
    return conclusion !== null && FAILING.has(conclusion);
  });
  if (failing.length === 0) return;
  const result = runGh(checkout, [
    "api",
    `repos/${repo.owner}/${repo.name}/commits/${headSha}/check-runs`,
    "--paginate",
  ]);
  if (result.status !== 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return;
  }
  const runs = checkRunList(parsed);
  for (const check of failing) {
    const match = runs.find((run) => run.name === check.name);
    if (!match) continue;
    const excerpt = truncateExcerpt([match.summary, match.text].filter(Boolean).join("\n\n"));
    if (excerpt) check.logExcerpt = excerpt;
  }
}

function checkRunList(parsed: unknown): { name: string; summary: string; text: string }[] {
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const runs: { name: string; summary: string; text: string }[] = [];
  for (const page of pages) {
    if (typeof page !== "object" || page === null) continue;
    const list = (page as Record<string, unknown>).check_runs;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const name = stringField(record, "name");
      if (!name) continue;
      const output = record.output;
      const summary =
        typeof output === "object" && output !== null ? stringField(output as Record<string, unknown>, "summary") : "";
      const text =
        typeof output === "object" && output !== null ? stringField(output as Record<string, unknown>, "text") : "";
      runs.push({ name, summary, text });
    }
  }
  return runs;
}

function reviewsFrom(view: Record<string, unknown>, prUrl: string): FeedbackReview[] {
  if (!Array.isArray(view.reviews)) return [];
  const reviews: FeedbackReview[] = [];
  for (const entry of view.reviews) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = reviewId(record);
    if (!id) continue;
    const author = authorLogin(record.author);
    const state = stringField(record, "state") || "COMMENTED";
    const body = stringField(record, "body");
    const submittedAt = stringField(record, "submittedAt");
    const url = stringField(record, "url") || reviewUrl(prUrl, id);
    reviews.push({
      id,
      author,
      state,
      body,
      submittedAt,
      ...(url ? { url } : {}),
    });
  }
  return reviews;
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100) {
        nodes {
          id
          body
          createdAt
          url
          author { login }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 20) {
            nodes {
              id
              body
              createdAt
              url
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}`.trim();

function threadsFrom(checkout: string, repo: { owner: string; name: string }, prNumber: number): FeedbackComment[] {
  const result = runGh(checkout, [
    "api",
    "graphql",
    "-f",
    `query=${THREADS_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
    "-F",
    `number=${prNumber}`,
  ]);
  if (result.status !== 0) {
    throw new HostError(
      `Could not read review threads for pull request #${prNumber}: ${(result.stderr || result.stdout).trim() || "gh api graphql failed"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new HostError("gh api graphql returned data that is not JSON.");
  }
  const comments: FeedbackComment[] = [];
  const conversation = dig(parsed, ["data", "repository", "pullRequest", "comments", "nodes"]);
  if (Array.isArray(conversation)) {
    for (const node of conversation) {
      const comment = commentFrom(node, false);
      if (comment) comments.push(comment);
    }
  }
  const threads = dig(parsed, ["data", "repository", "pullRequest", "reviewThreads", "nodes"]);
  if (!Array.isArray(threads)) return comments;
  for (const thread of threads) {
    if (typeof thread !== "object" || thread === null) continue;
    const resolved = (thread as Record<string, unknown>).isResolved === true;
    const nodes = dig(thread, ["comments", "nodes"]);
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const comment = commentFrom(node, resolved);
      if (comment) comments.push(comment);
    }
  }
  return comments;
}

function commentFrom(node: unknown, resolved: boolean): FeedbackComment | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const id = stringField(record, "id");
  if (!id) return undefined;
  const line = typeof record.line === "number" ? record.line : undefined;
  const path = stringField(record, "path");
  const url = stringField(record, "url");
  return {
    id,
    author: authorLogin(record.author),
    body: stringField(record, "body"),
    ...(path ? { path } : {}),
    ...(line !== undefined ? { line } : {}),
    submittedAt: stringField(record, "createdAt"),
    ...(url ? { url } : {}),
    resolved,
  };
}

function reviewId(record: Record<string, unknown>): string {
  if (typeof record.id === "string" && record.id.length > 0) return record.id;
  if (typeof record.id === "number" && Number.isFinite(record.id)) return String(record.id);
  return "";
}

function reviewUrl(prUrl: string, id: string): string | undefined {
  const numeric = /\/(\d+)$/.exec(id)?.[1] ?? (/^\d+$/.test(id) ? id : "");
  if (!prUrl || !numeric) return undefined;
  return `${prUrl}#pullrequestreview-${numeric}`;
}

function authorLogin(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "login" in value) {
    const login = (value as { login?: unknown }).login;
    return typeof login === "string" ? login : "";
  }
  return "";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function dig(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function runGh(checkout: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const bin = process.env.KILN_GH && process.env.KILN_GH.length > 0 ? process.env.KILN_GH : "gh";
  const result = spawnSync(bin, args, {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new HostError(
      `gh is not installed (looked for ${bin}). Install the GitHub CLI from https://cli.github.com/ and run gh auth login, then run kiln tick again.`,
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}
