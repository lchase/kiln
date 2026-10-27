import { z } from "zod";

/**
 * Kiln config file. `repos` is an open map: any name, not a fixed set.
 * `path` is absolute, `~`, or (in older files) relative to the config directory.
 * `repo add` stores a relative path as absolute, resolved from the working directory.
 * `test` is the shell command a workflow runs as its verify step (`KILN_TEST`).
 */
/**
 * `deliver` defaults to `local` when omitted: land on `yak/<run-id>` and do not push.
 * `pr` pushes that branch and opens a draft pull request against `base`.
 * `base` defaults to origin's default branch, discovered with git, when omitted.
 */
export const RepoEntrySchema = z.object({
  path: z.string().min(1),
  test: z.string().min(1).optional(),
  deliver: z.enum(["local", "pr"]).optional(),
  base: z.string().min(1).optional(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

/**
 * Optional Jira Cloud credentials in the gitignored kiln config.
 * `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` override these.
 * Empty strings are treated as unset. The token is never copied into a job.
 */
export const JiraConfigSchema = z.object({
  baseUrl: z.string().optional(),
  email: z.string().optional(),
  apiToken: z.string().optional(),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

/** No yak event and no log output for this long stalls a running job. `<= 0` disables it. */
export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;
/** Transient failures retry until this many attempts, then the job is dead. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Pull request fix rounds before the job is needs-human (`feedback-exhausted`). */
export const DEFAULT_MAX_FIX_ROUNDS = 2;

export const KilnConfigFileSchema = z.object({
  note: z.string().min(1).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  /**
   * Milliseconds without a yak event or log output before a running job is
   * killed and retried. Default 15 minutes. `0` or negative disables stall detection.
   */
  stallTimeoutMs: z.number().int().optional(),
  /** Transient failures before the job is dead. Default 3. */
  maxAttempts: z.number().int().min(1).optional(),
  /**
   * Fix rounds for an open pull request before the job is needs-human with
   * reason `feedback-exhausted`. Default 2. Kiln does not merge.
   */
  maxFixRounds: z.number().int().min(1).optional(),
  adapter: z.enum(["mock", "claude-code"]).optional(),
  repos: z.record(z.string(), RepoEntrySchema),
  jira: JiraConfigSchema.optional(),
});
export type KilnConfigFile = z.infer<typeof KilnConfigFileSchema>;

/**
 * Where a job came from. Adapters set this; tick and reconcile do not branch on it.
 * `ref` is an absolute spec path (`file`), `inline` or `stdin` (`prompt`), the
 * absolute ticket path (`tickets`), or the issue key (`jira`, such as `PROJ-123`).
 */
export const JobSourceSchema = z.object({
  kind: z.enum(["file", "prompt", "tickets", "jira"]),
  ref: z.string().min(1),
});
export type JobSource = z.infer<typeof JobSourceSchema>;

/**
 * One unit of factory work. Stored as `<kilnDir>/jobs/<id>.json`.
 * `spec` is a markdown file under the kiln directory.
 * `dependsOn` names other job ids. There is no plan and no stored state.
 * Every intake writes this same shape. `source` is omitted on jobs written
 * before intake; those files still parse.
 */
export const JobSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  workflow: z.string().min(1),
  spec: z.string().min(1),
  title: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  /**
   * When true, this job starts once its single upstream has landed, on that
   * upstream's branch. Omitted means after-merged: wait until every upstream
   * is `done`. More than one `dependsOn` with `stack` is rejected at add time.
   * Stacking onto an investigation is rejected: that workflow does not land
   * a branch.
   */
  stack: z.boolean().optional(),
  source: JobSourceSchema.optional(),
  createdAt: z.string().min(1),
});
export type Job = z.infer<typeof JobSchema>;

/**
 * Derived from the yak journal, gate files, and (for `deliver=pr`) the
 * delivery record plus `gh pr view`. Never written into the job file.
 *
 * For `deliver=local`, `done` is a run that finished ok with an approve
 * decision. For `deliver=pr`, `done` is that landed run whose pull request
 * has merged (`state` or `mergedAt`, so a squash merge counts). `in-review`
 * is the landed run while the pull request is still open. An investigation
 * is `done` when the gate says approve, including when the repo is
 * `deliver=pr`. It does not enter `in-review`. A reject, a failure, a dead
 * process, and an ok run with no readable approval do not unblock an
 * after-merged dependent. A stacked job unblocks when its one upstream has
 * landed, which includes `in-review`. `dead` is also a job whose transient
 * failures have used `maxAttempts`. Those attempts live under the kiln
 * directory, not in this file.
 */
export const JOB_STATES = [
  "queued",
  "blocked",
  "running",
  "needs-human",
  "approved",
  "rejected",
  "failed",
  "dead",
  "in-review",
  "done",
] as const;
export type JobState = (typeof JOB_STATES)[number];
