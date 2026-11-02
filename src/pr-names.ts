/**
 * Pull request title and remote branch for `deliver=pr`.
 * Yak keeps the local branch `yak/<run-id>`. Kiln pushes that ref to a
 * readable name and opens the pull request with `--head` set to it.
 */

export const DEFAULT_PR_TITLE = "[{issue}] {title}";

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

/**
 * No issue: the title is unchanged, including when a repo template is set.
 * With an issue: strip a leading `ABC-123:`, `ABC-123 `, or `[ABC-123]`
 * so a Jira `KEY: summary` title is not applied twice, then fill the template.
 * The default template is `[{issue}] {title}`.
 */
export function pullRequestTitle(input: { title: string; issue?: string; template?: string }): string {
  const raw = input.title.trim();
  if (!input.issue) return raw;
  const title = stripIssuePrefix(raw, input.issue);
  const template = input.template?.trim() || DEFAULT_PR_TITLE;
  return template.replaceAll("{issue}", input.issue).replaceAll("{title}", title).replace(/[ \t]{2,}/g, " ").trim();
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
  const slug = titleSlug(input.title, input.issue);
  if (input.issue) return `${input.issue}-${slug}`;
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
