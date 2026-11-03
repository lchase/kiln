import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jobBasename } from "./paths.js";

/**
 * Workflow name for a spike, probe, or research job.
 * An approved investigation is `done` with no pull request and no land.
 */
export const INVESTIGATION_WORKFLOW = "investigation";

/**
 * Headings the findings markdown must contain. The investigation prompt
 * asks for these spellings. Kiln stores the agent's markdown only when
 * every one of them is present.
 */
export const FINDINGS_HEADINGS = [
  "## Questions",
  "## Answers",
  "## Unconfirmed",
  "## Implications for dependent tickets",
] as const;

/** `<kilnDir>/findings/<jobId>.md`. The job file does not store this path. */
export function findingsFilePath(kilnDir: string, jobId: string): string {
  return join(kilnDir, "findings", `${jobBasename(jobId)}.md`);
}

/** Absolute path when the findings file is already on disk. */
export function existingFindingsPath(kilnDir: string, jobId: string): string | undefined {
  const path = findingsFilePath(kilnDir, jobId);
  return existsSync(path) ? path : undefined;
}

export function findingsMarkdownComplete(markdown: string): boolean {
  return FINDINGS_HEADINGS.every((heading) => markdown.includes(heading));
}

/**
 * Store the approved findings document. Writing the same text again does
 * not touch the file. A document missing a required heading is refused.
 */
export function writeFindings(kilnDir: string, jobId: string, markdown: string): string {
  if (!findingsMarkdownComplete(markdown)) {
    throw new Error(
      `Findings for ${jobId} are missing a required section. Expected ${FINDINGS_HEADINGS.join(", ")}.`,
    );
  }
  const path = findingsFilePath(kilnDir, jobId);
  mkdirSync(dirname(path), { recursive: true });
  const body = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === body) return path;
  writeFileSync(path, body);
  return path;
}

/** The explore step's `findings` artifact, when it is a complete markdown document. */
export function readFindingsMarkdown(checkout: string, runId: string): string | undefined {
  const path = join(checkout, ".runs", runId, "artifacts", "findings.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("markdown" in parsed)) return undefined;
    const markdown = (parsed as { markdown: unknown }).markdown;
    if (typeof markdown !== "string") return undefined;
    const text = markdown.trim();
    if (!text || !findingsMarkdownComplete(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/**
 * Spec text handed to yak. Investigation dependencies contribute a
 * `## Findings from <title>` section. The stored spec file is not modified.
 */
export function appendInvestigationFindings(
  specText: string,
  sections: readonly { title: string; markdown: string }[],
): string {
  if (sections.length === 0) return specText;
  const base = specText.endsWith("\n") ? specText : `${specText}\n`;
  const blocks = sections.map(
    (section) => `## Findings from ${section.title}\n\n${section.markdown.trim()}\n`,
  );
  return `${base}\n${blocks.join("\n")}`;
}
