import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPullRequestFeedback, type PullRequestFeedbackSource } from "./feedback.js";
import { isPublishableBranch } from "./pr-names.js";

/**
 * Git remote and GitHub CLI, behind one seam so tests can fake `gh` and point
 * `origin` at a local bare repo. Nothing here merges a pull request or pushes
 * the base branch.
 */
export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

export interface PullRequestRef {
  number: number;
  url: string;
  state: PullRequestState;
  mergedAt: string | null;
  head: string;
  base: string;
}

export interface GitHubHost {
  /** An existing pull request whose head branch is exactly `branch`, or null. */
  findByHead(checkout: string, branch: string): PullRequestRef | null;
  createDraft(input: {
    checkout: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): PullRequestRef;
  /** `gh pr view --json state,mergedAt`. Squash merges set `mergedAt`. */
  view(checkout: string, number: number): { state: PullRequestState; mergedAt: string | null };
  /**
   * Submit one pull request review as a comment.
   * The event is COMMENT. This does not approve, request changes, or merge,
   * and it does not leave a pending review.
   * Optional so older test doubles keep compiling. Production always sets it.
   */
  postCommentReview?(input: PullRequestCommentReview): PostedPullRequestReview;
}

/** One inline comment. `line` is a line that was already in the draft. */
export interface PullRequestReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * A submitted COMMENT review. `event` is not a field: the only review Kiln
 * submits is a comment.
 */
export interface PullRequestCommentReview {
  checkout: string;
  number: number;
  commitId: string;
  body: string;
  comments: readonly PullRequestReviewComment[];
}

export interface PostedPullRequestReview {
  id: string;
  url: string;
}

export interface GitRemote {
  /** `git fetch origin`. Updates remote-tracking refs and does not touch the worktree. */
  fetch(checkout: string): void;
  revParse(checkout: string, ref: string): string;
  /** SHA of `refs/heads/<branch>` on origin, or null when that branch is absent. */
  remoteBranchSha(checkout: string, branch: string): string | null;
  /**
   * Push `refs/heads/<branch>` to the same name on origin.
   * Refuses the base branch and any branch that is not `yak/<run-id>`.
   */
  pushBranch(checkout: string, branch: string, baseBranch: string): void;
  /**
   * Fast-forward `refs/heads/<target>` on origin to `refs/heads/<source>`.
   * `source` must be `yak/<run-id>`. `target` is that name or the readable
   * remote branch. Refuses the base branch and any force update. A
   * non-fast-forward is left for git to reject.
   */
  publishBranch(checkout: string, source: string, target: string, baseBranch: string): void;
  /** True when `ancestor` is an ancestor of `descendant` (or they are equal). */
  isAncestor(checkout: string, ancestor: string, descendant: string): boolean;
  /** Origin's default branch name, without the `origin/` prefix. */
  defaultBranch(checkout: string): string;
}

/** How a tick starts yak. Tests pass a stub. Production spawns the yak CLI. */
export interface AgentStart {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFd: number;
}

export interface ReviewRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
}

/** GitHub label `review-requests` requires when the trigger sets none. */
export const DEFAULT_REVIEW_LABEL = "kiln-review";

/** `gh pr list --search` query. Opt-in: the pull request must carry `label`. */
export function reviewSearchQuery(label: string): string {
  const trimmed = label.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error("Review label must be a single line.");
  return `review-requested:@me label:${quoteSearch(trimmed)}`;
}

export interface ReviewRequestSource {
  /**
   * Open pull requests where the authenticated user's review is requested
   * and the pull request carries `label` (default `kiln-review`).
   * Read-only. Uses the operator's gh auth. Does not post, approve, or merge.
   */
  list(repos: readonly { name: string; path: string; label?: string }[]): ReviewRequest[];
}

export interface KilnHost {
  github: GitHubHost;
  git: GitRemote;
  /** Read-only pull request feedback. Absent means this tick does not watch. */
  feedback?: PullRequestFeedbackSource;
  /**
   * Review-request listing. Absent means the hourly review trigger does not run.
   * `kiln tick` and `kiln serve` set this. Tests leave it off unless they stub it.
   */
  reviews?: ReviewRequestSource;
  /** Test seam for `yak run`. Absent means Kiln spawns yak. */
  startAgent?(spec: AgentStart): { pid: number };
}

export function defaultHost(): KilnHost {
  return { github: realGitHub, git: realGitRemote, feedback: realPullRequestFeedback };
}

/** `kiln tick` and `kiln serve`. Review requests use the operator's gh auth. */
export function productionHost(): KilnHost {
  return { ...defaultHost(), reviews: { list: listReviewRequests } };
}

/**
 * Open pull requests awaiting the authenticated user's review, per registered repo.
 * The search is opt-in: a pull request must carry `label`, or `kiln-review` when
 * that is omitted. A remote that is not GitHub is skipped, so a local test origin does not call gh.
 */
export function listReviewRequests(repos: readonly { name: string; path: string; label?: string }[]): ReviewRequest[] {
  const found: ReviewRequest[] = [];
  for (const repo of repos) {
    if (!githubRemote(repo.path)) continue;
    const label = repo.label?.trim() || DEFAULT_REVIEW_LABEL;
    const result = spawnSync(
      ghBin(),
      [
        "pr",
        "list",
        "--search",
        reviewSearchQuery(label),
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        "number,title,url,headRefOid,labels",
      ],
      {
        cwd: repo.path,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    if (result.error || result.status !== 0) {
      throw new HostError(`Could not list review requests for ${repo.name}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout || "[]");
    } catch {
      throw new HostError("gh pr list returned data that is not JSON.");
    }
    if (!Array.isArray(parsed)) throw new HostError("gh pr list returned data that is not a list.");
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { number?: unknown; title?: unknown; url?: unknown; headRefOid?: unknown; labels?: unknown };
      const number = typeof record.number === "number" ? record.number : Number.NaN;
      const sha = typeof record.headRefOid === "string" ? record.headRefOid.trim().toLowerCase() : "";
      if (!Number.isInteger(number) || number <= 0 || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
      if (!carriesLabel(record.labels, label)) continue;
      const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : `PR ${number}`;
      const url = typeof record.url === "string" ? record.url : "";
      found.push({ repo: repo.name, number, title, url, headSha: sha });
    }
  }
  return found;
}

/** Missing `labels` trusts the search. A present list must include `label`. */
function carriesLabel(labels: unknown, label: string): boolean {
  if (labels === undefined) return true;
  if (!Array.isArray(labels)) return false;
  const want = label.trim().toLowerCase();
  return labels.some((item) => {
    if (typeof item === "string") return item.trim().toLowerCase() === want;
    if (typeof item !== "object" || item === null || !("name" in item)) return false;
    const name = (item as { name?: unknown }).name;
    return typeof name === "string" && name.trim().toLowerCase() === want;
  });
}

function quoteSearch(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function githubRemote(checkout: string): boolean {
  const result = gitResult(checkout, ["remote", "get-url", "origin"]);
  if (result.status !== 0) return false;
  const url = result.stdout.trim();
  return /github\.com[:/]/i.test(url);
}

const YAK_BRANCH = /^yak\/[A-Za-z0-9._-]+$/;

function assertYakBranch(branch: string, baseBranch: string): void {
  if (branch === baseBranch || branch === `refs/heads/${baseBranch}`) {
    throw new HostError(`Refusing to push ${branch}: that is the base branch.`);
  }
  if (!YAK_BRANCH.test(branch)) {
    throw new HostError(`Refusing to push ${branch}: kiln only pushes yak/<run-id>.`);
  }
}

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

function gitResult(checkout: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8", env: gitEnv() });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

export const realGitRemote: GitRemote = {
  fetch(checkout) {
    const result = gitResult(checkout, ["fetch", "origin"]);
    if (result.status !== 0) {
      throw new HostError(`Could not fetch origin in ${checkout}: ${result.stderr.trim() || "git fetch failed"}`);
    }
  },

  revParse(checkout, ref) {
    const result = gitResult(checkout, ["rev-parse", "--verify", ref]);
    const sha = result.stdout.trim();
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new HostError(
        `Could not resolve ${ref} in ${checkout}: ${(result.stderr || result.stdout || "no such ref").trim()}`,
      );
    }
    return sha;
  },

  remoteBranchSha(checkout, branch) {
    const result = gitResult(checkout, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (result.status !== 0) {
      throw new HostError(
        `Could not look up origin/${branch} in ${checkout}: ${result.stderr.trim() || "git ls-remote failed"}`,
      );
    }
    const line = result.stdout
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.endsWith(`refs/heads/${branch}`));
    if (!line) return null;
    const sha = line.split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  },

  pushBranch(checkout, branch, baseBranch) {
    if (branch === baseBranch || branch === `refs/heads/${baseBranch}`) {
      throw new HostError(`Refusing to push ${branch}: that is the base branch.`);
    }
    if (!/^yak\/[A-Za-z0-9._-]+$/.test(branch)) {
      throw new HostError(`Refusing to push ${branch}: kiln only pushes yak/<run-id>.`);
    }
    const result = gitResult(checkout, [
      "push",
      "origin",
      `refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    if (result.status !== 0) {
      throw new HostError(`Could not push ${branch}: ${result.stderr.trim() || "git push failed"}`);
    }
  },

  publishBranch(checkout, source, target, baseBranch) {
    assertYakBranch(source, baseBranch);
    if (target === baseBranch || target === `refs/heads/${baseBranch}`) {
      throw new HostError(`Refusing to push ${target}: that is the base branch.`);
    }
    if (source.includes("+") || target.includes("+")) {
      throw new HostError(`Refusing to push ${target}: kiln does not force-push.`);
    }
    if (!isPublishableBranch(target)) {
      throw new HostError(`Refusing to push ${target}: that branch name is not safe.`);
    }
    const result = gitResult(checkout, ["push", "origin", `refs/heads/${source}:refs/heads/${target}`]);
    if (result.status !== 0) {
      throw new HostError(`Could not push ${source} onto ${target}: ${result.stderr.trim() || "git push failed"}`);
    }
  },

  isAncestor(checkout, ancestor, descendant) {
    const result = gitResult(checkout, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return result.status === 0;
  },

  defaultBranch(checkout) {
    const symbolic = gitResult(checkout, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (symbolic.status === 0) {
      const name = symbolic.stdout.trim().replace(/^origin\//, "");
      if (name && !name.includes(" ")) return name;
    }
    const listed = gitResult(checkout, ["ls-remote", "--symref", "origin", "HEAD"]);
    if (listed.status === 0) {
      const match = listed.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
      const name = match?.[1];
      if (name) return name;
    }
    throw new HostError(
      `Could not discover origin's default branch in ${checkout}. Pass --base when you register the repo.`,
    );
  },
};

function ghBin(): string {
  return process.env.KILN_GH && process.env.KILN_GH.length > 0 ? process.env.KILN_GH : "gh";
}

function runGh(checkout: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const bin = ghBin();
  const result = spawnSync(bin, args, {
    cwd: checkout,
    encoding: "utf8",
    input,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new HostError(
        `gh is not installed (looked for ${bin}). Install the GitHub CLI from https://cli.github.com/ and run gh auth login, then run kiln tick again.`,
      );
    }
    throw new HostError(`Could not run gh: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ghFailure(stderr: string, stdout: string): HostError {
  const detail = (stderr || stdout).trim() || "gh failed";
  const auth = /auth|login|token|credential/i.test(detail);
  const hint = auth
    ? "Run gh auth login, then run kiln tick again."
    : "Fix gh, then run kiln tick again.";
  return new HostError(`Could not open a pull request: ${detail} ${hint}`);
}

function asState(value: unknown): PullRequestState {
  if (value === "MERGED" || value === "CLOSED" || value === "OPEN") return value;
  return "OPEN";
}

function asMergedAt(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface GhPull {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
}

function toRef(raw: GhPull, fallback: { head: string; base: string }): PullRequestRef | null {
  const number = typeof raw.number === "number" ? raw.number : Number.NaN;
  const url = typeof raw.url === "string" ? raw.url : "";
  if (!Number.isInteger(number) || number <= 0 || !url) return null;
  return {
    number,
    url,
    state: asState(raw.state),
    mergedAt: asMergedAt(raw.mergedAt),
    head: typeof raw.headRefName === "string" && raw.headRefName.length > 0 ? raw.headRefName : fallback.head,
    base: typeof raw.baseRefName === "string" && raw.baseRefName.length > 0 ? raw.baseRefName : fallback.base,
  };
}

export const realGitHub: GitHubHost = {
  findByHead(checkout, branch) {
    const result = runGh(checkout, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "30",
      "--json",
      "number,url,state,mergedAt,headRefName,baseRefName",
    ]);
    if (result.status !== 0) throw ghFailure(result.stderr, result.stdout);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout || "[]");
    } catch {
      throw new HostError(`gh pr list returned data that is not JSON.`);
    }
    if (!Array.isArray(parsed)) throw new HostError(`gh pr list returned data that is not a list.`);
    const matches = parsed
      .map((item) => toRef(item as GhPull, { head: branch, base: "" }))
      .filter((item): item is PullRequestRef => item !== null && item.head === branch);
    const open = matches.find((item) => item.state === "OPEN");
    if (open) return open;
    const merged = matches.find((item) => item.state === "MERGED" || item.mergedAt);
    if (merged) return merged;
    return matches.sort((left, right) => right.number - left.number)[0] ?? null;
  },

  createDraft(input) {
    const dir = mkdtempSync(join(tmpdir(), "kiln-pr-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, input.body);
    try {
      const result = runGh(input.checkout, [
        "pr",
        "create",
        "--draft",
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title.replace(/[\r\n]+/g, " ").trim(),
        "--body-file",
        bodyFile,
      ]);
      if (result.status !== 0) throw ghFailure(result.stderr, result.stdout);
      const url = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("http"))
        .at(-1);
      const number = Number(url?.match(/\/pull\/(\d+)\s*$/)?.[1]);
      if (!url || !Number.isInteger(number)) {
        throw new HostError(`gh pr create did not return a pull request URL: ${result.stdout.trim()}`);
      }
      return { number, url, state: "OPEN", mergedAt: null, head: input.head, base: input.base };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  view(checkout, number) {
    const result = runGh(checkout, ["pr", "view", String(number), "--json", "state,mergedAt"]);
    if (result.status !== 0) throw ghFailure(result.stderr, result.stdout);
    let parsed: GhPull;
    try {
      parsed = JSON.parse(result.stdout) as GhPull;
    } catch {
      throw new HostError(`gh pr view returned data that is not JSON.`);
    }
    return { state: asState(parsed.state), mergedAt: asMergedAt(parsed.mergedAt) };
  },

  postCommentReview(input) {
    return submitCommentReview(input);
  },
};

/**
 * `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `event: COMMENT`.
 * One call submits the review. There is no pending-review step, no approve,
 * and no merge.
 */
export function submitCommentReview(input: PullRequestCommentReview): PostedPullRequestReview {
  const repo = githubOwnerRepo(input.checkout);
  const event = "COMMENT" as const;
  const payload: {
    commit_id: string;
    body: string;
    event: "COMMENT";
    comments?: { path: string; body: string; line: number; side: "RIGHT" }[];
  } = {
    commit_id: input.commitId,
    body: input.body,
    event,
  };
  if (input.comments.length > 0) {
    payload.comments = input.comments.map((comment) => ({
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: "RIGHT" as const,
    }));
  }
  const result = runGh(
    input.checkout,
    ["api", "--method", "POST", `repos/${repo.owner}/${repo.name}/pulls/${input.number}/reviews`, "--input", "-"],
    JSON.stringify(payload),
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "gh api failed";
    throw new HostError(`Could not post the pull request review: ${detail}`);
  }
  let parsed: { id?: unknown; html_url?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as { id?: unknown; html_url?: unknown };
  } catch {
    throw new HostError("gh api returned data that is not a pull request review.");
  }
  const id = typeof parsed.id === "number" || typeof parsed.id === "string" ? String(parsed.id) : "";
  const url = typeof parsed.html_url === "string" ? parsed.html_url.trim() : "";
  if (!id || !url) throw new HostError("gh api did not return a review id and URL.");
  return { id, url };
}

function githubOwnerRepo(checkout: string): { owner: string; name: string } {
  const result = runGh(checkout, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const name = result.stdout.trim();
  const [owner, repo] = name.split("/");
  if (result.status !== 0 || !owner || !repo || name.split("/").length !== 2) {
    throw new HostError(
      `Could not read owner/name for the review: ${(result.stderr || result.stdout).trim() || name || "gh repo view failed"}`,
    );
  }
  return { owner, name: repo };
}
