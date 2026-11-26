import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of the Kiln package that contains this file.
 *
 * Starts at `import.meta.url` and walks up to the nearest `package.json`.
 * That is the repo root in a checkout (`src/` via tsx, or compiled `dist/`)
 * and the installed package root for `node_modules/@lchase/kiln`. Workflows
 * and prompts are read from there, not from `process.cwd()`.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find package.json above the running file.");
}

/** One path segment. Job ids we generate already pass; this rejects `..` and slashes. */
export function jobBasename(id: string): string {
  const safe = id
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  if (!safe) {
    throw new Error(`Job id ${JSON.stringify(id)} cannot be used as a file name.`);
  }
  return safe;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reject a job id from a URL or the command line before it reaches a path.
 * `jobBasename` sanitizes; this refuses. `..` is refused anywhere in the id.
 */
export function assertJobId(id: string): string {
  if (!JOB_ID.test(id) || id.includes("..")) {
    throw new Error(`Job id ${JSON.stringify(id)} is not valid.`);
  }
  return id;
}

export function isJobId(id: string): boolean {
  return JOB_ID.test(id) && !id.includes("..");
}
