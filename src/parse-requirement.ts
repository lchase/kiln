import {
  RequirementSchema,
  type Requirement,
  type RequirementSource,
} from "./schemas.js";

export class RequirementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementParseError";
  }
}

export function section(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const target = heading.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (match?.[1]?.trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i] ?? "")) break;
    collected.push(lines[i] ?? "");
  }
  return collected.join("\n").trim();
}

function bullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function frontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  const text = markdown.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    if (text.startsWith("---")) {
      throw new RequirementParseError("Unclosed frontmatter. Expected a closing --- line.");
    }
    return { meta: {}, body: text.trim() };
  }
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf(":");
    if (splitAt <= 0) {
      throw new RequirementParseError(`Could not read frontmatter line: ${trimmed}`);
    }
    const key = trimmed.slice(0, splitAt).trim();
    const value = trimmed.slice(splitAt + 1).trim();
    meta[key] = value;
  }
  return { meta, body: (match[2] ?? "").trim() };
}

function isSource(value: string | undefined): value is RequirementSource {
  return value === "markdown" || value === "jira";
}

/** Parse a markdown requirement file into the Requirement shape. */
export function parseRequirement(markdown: string, filename = "requirement.md"): Requirement {
  const { meta, body } = frontmatter(markdown);
  const heading = /^#\s+(.+)$/m.exec(body);
  const title = meta.title || heading?.[1]?.trim();
  if (!title) {
    throw new RequirementParseError(
      `${filename} needs a title, either as frontmatter "title:" or as a level-1 heading.`,
    );
  }
  if (!meta.id) {
    throw new RequirementParseError(`${filename} needs an "id:" line in its frontmatter.`);
  }
  if (!isSource(meta.source)) {
    throw new RequirementParseError(
      `${filename} needs "source: markdown" or "source: jira" in its frontmatter.`,
    );
  }
  const criteria = bullets(section(body, "Acceptance criteria"));
  const scope = section(body, "Scope");
  const outcome = section(body, "Outcome") || section(body, "User-facing outcome");
  const parsed = RequirementSchema.safeParse({
    id: meta.id,
    source: meta.source,
    title,
    body,
    ...(criteria.length > 0 ? { acceptanceCriteria: criteria } : {}),
    ...(scope ? { scope } : {}),
    ...(outcome ? { outcome } : {}),
  });
  if (!parsed.success) {
    throw new RequirementParseError(`${filename} is not a valid requirement: ${parsed.error.message}`);
  }
  return parsed.data;
}
