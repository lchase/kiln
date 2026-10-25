import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. Works for `src/` under tsx and for the compiled `dist/` tree. */
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
