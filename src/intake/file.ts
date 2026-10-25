import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LoadedKilnConfig } from "../config.js";
import { titleFromSpec, writeJob } from "../jobs.js";
import type { Job } from "../schemas.js";

export interface AddFileInput {
  workflow: string;
  repo: string;
  specPath: string;
  title?: string;
  dependsOn: string[];
  cwd: string;
  now?: Date;
}

/** `kiln add <workflow> --repo R --spec file.md` */
export function addFromFile(config: LoadedKilnConfig, input: AddFileInput): { job: Job; jsonPath: string } {
  const source = resolve(input.cwd, input.specPath);
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read spec ${source}: ${message}`);
  }
  if (!text.trim()) {
    throw new Error(`Spec ${source} is empty.`);
  }
  const title = input.title?.trim() || titleFromSpec(text, source);
  return writeJob(config, {
    workflow: input.workflow,
    repo: input.repo,
    specText: text,
    title,
    dependsOn: input.dependsOn,
    source: { kind: "file", ref: source },
    ...(input.now ? { now: input.now } : {}),
  });
}
