import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Turn a requirement id into a single path segment under the local plans directory. */
export function planBasename(id: string): string {
  const safe = id
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  if (!safe) {
    throw new Error(`Requirement id ${JSON.stringify(id)} cannot be used as a plan filename.`);
  }
  return safe;
}

export function writePlanFiles(
  plansDir: string,
  requirementId: string,
  json: string,
  markdown: string,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(plansDir, { recursive: true });
  const base = planBasename(requirementId);
  const jsonPath = join(plansDir, `${base}.json`);
  const markdownPath = join(plansDir, `${base}.md`);
  writeFileSync(jsonPath, json.endsWith("\n") ? json : `${json}\n`);
  writeFileSync(markdownPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { jsonPath, markdownPath };
}
