import { spawnSync } from "node:child_process";

/**
 * Fix-round commits carry three trailers. The `land` command in
 * `workflows/fix.yaml` writes them when it creates the commit. An agent
 * commit that landed without them is amended here before publish.
 * Yak's own `commitAllIfDirty` is the map checkpoint and is not this path.
 */

export interface FixTrailers {
  jobId: string;
  round: number;
  promptsHash: string;
  title: string;
}

export function fixTrailerLines(input: FixTrailers): string[] {
  return [`Kiln-Job: ${input.jobId}`, `Kiln-Round: ${input.round}`, `Kiln-Prompts-Hash: ${input.promptsHash}`];
}

/**
 * The fix workflow `land` step. `workflows/fix.yaml` keeps the same command.
 * Launch sets `KILN_JOB`, `KILN_ROUND`, and `KILN_PROMPTS_HASH`.
 */
export const FIX_LAND_COMMAND =
  'git add -A && git diff --cached --quiet || git commit -m "kiln: $KILN_TASK_TITLE" --trailer "Kiln-Job: $KILN_JOB" --trailer "Kiln-Round: $KILN_ROUND" --trailer "Kiln-Prompts-Hash: $KILN_PROMPTS_HASH"';

export type FixCommitResult = "committed" | "amended" | "present" | "clean";

/**
 * Make the tip of `dir` carry the fix-round trailers.
 * A dirty tree is committed. A tip that already moved and lacks the trailers
 * is amended. A clean tree still on `baseSha` is left alone.
 */
export function ensureFixTrailers(dir: string, input: FixTrailers, baseSha?: string): FixCommitResult {
  if (!hasTrailers(dir, input)) {
    if (isDirty(dir)) {
      commit(dir, input, false);
      return "committed";
    }
    const head = revParse(dir, "HEAD");
    if (!head || (baseSha && head === baseSha)) return "clean";
    commit(dir, input, true);
    return "amended";
  }
  return "present";
}

export function commitMessageHasTrailers(message: string, input: FixTrailers): boolean {
  return fixTrailerLines(input).every((line) => message.split("\n").some((entry) => entry.trim() === line));
}

function hasTrailers(dir: string, input: FixTrailers): boolean {
  const message = git(dir, ["log", "-1", "--format=%B"]);
  if (message.status !== 0) return false;
  return commitMessageHasTrailers(message.stdout, input);
}

function isDirty(dir: string): boolean {
  const status = git(dir, ["status", "--porcelain"]);
  if (status.status !== 0) return false;
  return status.stdout.trim().length > 0;
}

function revParse(dir: string, ref: string): string | undefined {
  const result = git(dir, ["rev-parse", ref]);
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha || undefined;
}

function commit(dir: string, input: FixTrailers, amend: boolean): void {
  if (!amend) {
    const added = git(dir, ["add", "-A"]);
    if (added.status !== 0) return;
  }
  const args = ["commit"];
  if (amend) args.push("--amend", "--no-edit");
  else args.push("-m", `kiln: ${input.title}`);
  for (const line of fixTrailerLines(input)) args.push("--trailer", line);
  git(dir, args);
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}
