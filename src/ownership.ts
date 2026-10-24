import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OwnershipMapSchema, REPOS, type OwnershipMap, type Repo } from "./schemas.js";

export function loadOwnershipMap(file: string, expected: Repo): OwnershipMap {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ownership map ${file}: ${message}`);
  }
  const parsed = OwnershipMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Ownership map ${file} is invalid: ${parsed.error.message}`);
  }
  if (parsed.data.repo !== expected) {
    throw new Error(`${file} declares repo ${parsed.data.repo}, expected ${expected}.`);
  }
  return parsed.data;
}

export function loadOwnershipMaps(dir: string): OwnershipMap[] {
  return REPOS.map((repo) => loadOwnershipMap(join(dir, `${repo}.json`), repo));
}
