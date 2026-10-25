import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Yak always runs `git worktree add -b yak/<run-id> <path> HEAD` in the
 * checkout. Kiln needs that worktree cut from another commit (origin/<base>,
 * or the upstream branch) without moving the checkout HEAD or its files.
 * A `git` shim earlier on the child PATH rewrites only that invocation.
 * Item worktrees (`yak-item/...`) and every other git command pass through.
 */
const SHIM_SOURCE = `'use strict';
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const real = process.env.KILN_REAL_GIT;
const base = process.env.KILN_WORKTREE_BASE || '';
const branch = args[3] || '';
if (
  base &&
  real &&
  args[0] === 'worktree' &&
  args[1] === 'add' &&
  args[2] === '-b' &&
  branch.startsWith('yak/') &&
  !branch.startsWith('yak-item/') &&
  args[args.length - 1] === 'HEAD'
) {
  args[args.length - 1] = base;
}
if (!real) {
  process.stderr.write('KILN_REAL_GIT is not set\\n');
  process.exit(127);
}
const result = spawnSync(real, args, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(String(result.error.message) + '\\n');
  process.exit(127);
}
process.exit(result.status === null ? 1 : result.status);
`;

export function realGitBinary(): string {
  const result = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const found = result.stdout.trim().split("\n")[0] ?? "";
  if (result.status !== 0 || !found.startsWith("/")) {
    throw new Error("Could not find git on PATH.");
  }
  return found;
}

/** Write `<kilnDir>/bin/git`. Returns that directory, to prepend to PATH. */
export function installGitShim(kilnDir: string, realGit = realGitBinary()): string {
  const dir = join(kilnDir, "bin");
  mkdirSync(dir, { recursive: true });
  const cjs = join(dir, "git-shim.cjs");
  const sh = join(dir, "git");
  writeFileSync(cjs, SHIM_SOURCE);
  writeFileSync(
    sh,
    `#!/bin/sh\nexport KILN_REAL_GIT=${quote(realGit)}\nexec ${quote(process.execPath)} ${quote(cjs)} "$@"\n`,
  );
  chmodSync(cjs, 0o755);
  chmodSync(sh, 0o755);
  return dir;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
