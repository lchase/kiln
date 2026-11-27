/**
 * Pull request title and remote branch for `deliver=pr`.
 * Yak keeps the local branch `yak/<run-id>`. Kiln pushes that ref to a
 * readable name and opens the pull request with `--head` set to it.
 */

export const DEFAULT_PR_TITLE = "[{issue}] {title}";
/** Default remote branch when the job has an issue. Renders as `ABC-123-slug`. */
export const DEFAULT_BRANCH_TEMPLATE = "{issue}-{slug}";

export function stripIssuePrefix(title: string, issue: string): string {
  const trimmed = title.trim();
  const escaped = issue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^\\[${escaped}\\]\\s*`),
    new RegExp(`^${escaped}:\\s*`),
    new RegExp(`^${escaped}\\s+`),
  ];
  for (const pattern of patterns) {
    if (!pattern.test(trimmed)) continue;
    const next = trimmed.replace(pattern, "").trim();
    return next || trimmed;
  }
  return trimmed;
}

/** Values the approver may return as `changeType`, used for a `{type}` title placeholder. */
export const CHANGE_TYPES = ["feat", "fix", "docs", "test", "refactor", "chore"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export function isChangeType(value: unknown): value is ChangeType {
  return typeof value === "string" && (CHANGE_TYPES as readonly string[]).includes(value);
}

/**
 * The default template is `[{issue}] {title}`. A template that uses `{issue}`
 * applies only when the job has an issue; without one the title is returned
 * unchanged. A template without `{issue}` applies to every job.
 * With an issue, a leading `ABC-123:`, `ABC-123 `, or `[ABC-123]` is stripped
 * so a Jira `KEY: summary` title is not applied twice.
 * `{type}` is filled from the approver's change type, and a leading imported
 * ticket number (`01: `) is dropped from the title. With no type, a `{type}`
 * template falls back to the default title so no literal `{type}` is shown.
 */
export function pullRequestTitle(input: { title: string; issue?: string; template?: string; type?: string }): string {
  const raw = input.title.trim();
  const template = input.template?.trim() || DEFAULT_PR_TITLE;
  const usesType = template.includes("{type}");
  if (usesType && !input.type) return pullRequestTitle({ title: raw, ...(input.issue ? { issue: input.issue } : {}) });
  if (template.includes("{issue}") && !input.issue) return raw;
  let title = input.issue ? stripIssuePrefix(raw, input.issue) : raw;
  if (usesType) title = title.replace(/^\d+:\s*/, "").trim() || title;
  return template
    .replaceAll("{issue}", input.issue ?? "")
    .replaceAll("{type}", input.type ?? "")
    .replaceAll("{title}", title)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Kebab-case title, at most 50 characters. An issue prefix is not part of the slug. */
export function titleSlug(title: string, issue?: string): string {
  const base = issue ? stripIssuePrefix(title, issue) : title.trim();
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, 50).replace(/-+$/g, "");
  return cut || "task";
}

/**
 * The random suffix of a kiln job id (`j` + 14 digits + 4 hex), otherwise
 * the last six alphanumeric characters.
 */
export function shortJobId(jobId: string): string {
  const hex = /^j\d{14}([0-9a-f]{4})$/.exec(jobId);
  if (hex?.[1]) return hex[1];
  const compact = jobId.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return compact.slice(-6) || "job";
}

export function defaultRemoteBranch(input: { title: string; jobId: string; issue?: string }): string {
  if (input.issue) return formatBranchTemplate(DEFAULT_BRANCH_TEMPLATE, input);
  const slug = titleSlug(input.title, input.issue);
  return `kiln/${slug}-${shortJobId(input.jobId)}`;
}

export function formatBranchTemplate(
  template: string,
  input: { title: string; jobId: string; issue?: string },
): string {
  const slug = titleSlug(input.title, input.issue);
  return template
    .replaceAll("{issue}", input.issue ?? "")
    .replaceAll("{slug}", slug)
    .replaceAll("{jobId}", input.jobId)
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/^[-\/]+|[-\/]+$/g, "");
}

export function isPublishableBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("@")
  );
}

export interface ChooseRemoteBranchInput {
  title: string;
  jobId: string;
  issue?: string;
  template?: string;
  localSha: string;
  remoteSha: (name: string) => string | null;
  /** Name already stored for this run. Re-tick uses it and does not rename. */
  recorded?: string;
}

/**
 * Remote branch for this job. A name that already points at `localSha` is
 * ours (a crash between push and the delivery record). Any other existing
 * remote branch gets `-<short job id>` appended, or the full job id when
 * the short id is already on the name.
 */
export function chooseRemoteBranch(input: ChooseRemoteBranchInput): string {
  if (input.recorded) return input.recorded;
  const desired = input.template ? formatBranchTemplate(input.template, input) : defaultRemoteBranch(input);
  assertPublishable(desired);
  const current = input.remoteSha(desired);
  if (current === null || current === input.localSha) return desired;
  const short = shortJobId(input.jobId);
  const already = desired.endsWith(`-${short}`) || desired.endsWith(`/${short}`);
  const suffixed = (already ? `${desired}-${input.jobId}` : `${desired}-${short}`)
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-");
  assertPublishable(suffixed);
  const altSha = input.remoteSha(suffixed);
  if (altSha === null || altSha === input.localSha) return suffixed;
  const full = `${desired}-${input.jobId}`.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/-{2,}/g, "-");
  assertPublishable(full);
  return full;
}

function assertPublishable(name: string): void {
  if (isPublishableBranch(name)) return;
  throw new Error(
    `Branch name ${JSON.stringify(name)} is not a safe git branch. Check the repo branch template.`,
  );
}
