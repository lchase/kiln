import { readFileSync } from "node:fs";
import type { LoadedKilnConfig } from "../config.js";
import { writeJob } from "../jobs.js";
import type { Job } from "../schemas.js";

/** First-line titles longer than this are cut and end with `...`. */
export const PROMPT_TITLE_MAX = 80;

export function titleFromPrompt(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) {
    throw new Error("Prompt is empty.");
  }
  if (line.length <= PROMPT_TITLE_MAX) return line;
  return `${line.slice(0, PROMPT_TITLE_MAX - 3)}...`;
}

export function readPrompt(value: string): { text: string; fromStdin: boolean } {
  if (value !== "-") return { text: value, fromStdin: false };
  let text: string;
  try {
    text = readFileSync(0, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read prompt from stdin: ${message}`);
  }
  return { text, fromStdin: true };
}

export interface AddPromptInput {
  workflow: string;
  repo: string;
  prompt: string;
  title?: string;
  dependsOn: string[];
  now?: Date;
}

/** `kiln add <workflow> --repo R --prompt text` or `--prompt -` for stdin. */
export function addFromPrompt(config: LoadedKilnConfig, input: AddPromptInput): { job: Job; jsonPath: string } {
  const { text, fromStdin } = readPrompt(input.prompt);
  if (!text.trim()) {
    throw new Error(fromStdin ? "Prompt from stdin is empty." : "Prompt is empty.");
  }
  const title = input.title?.trim() || titleFromPrompt(text);
  return writeJob(config, {
    workflow: input.workflow,
    repo: input.repo,
    specText: text,
    title,
    dependsOn: input.dependsOn,
    source: { kind: "prompt", ref: fromStdin ? "stdin" : "inline" },
    ...(input.now ? { now: input.now } : {}),
  });
}
