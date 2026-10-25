import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** Origin's default branch name, without the `origin/` prefix. */
  defaultBranch(checkout: string): string;
}

export interface KilnHost {
  github: GitHubHost;
  git: GitRemote;
}

export function defaultHost(): KilnHost {
  return { github: realGitHub, git: realGitRemote };
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

function runGh(checkout: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const bin = ghBin();
  const result = spawnSync(bin, args, {
    cwd: checkout,
    encoding: "utf8",
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
};
