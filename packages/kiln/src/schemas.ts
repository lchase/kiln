import { z } from "zod";
import { BOARD_THEME_IDS } from "./theme.js";

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
/** Jira-style issue keys (`ABC-123`). Stored and matched in uppercase. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export function parseIssueKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) {
    throw new Error(`Issue key ${JSON.stringify(raw)} must match KEY-123.`);
  }
  return key;
}

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const RepoEntrySchema = z.object({
  path: z.string().min(1, "Path is required."),
  test: z.string().min(1, "Test command is empty.").optional(),
  deliver: z.enum(["local", "pr"]).optional(),
  base: z.string().min(1, "Base branch is empty.").optional(),
  /**
   * Pull request title when the job has an `issue`. Placeholders `{issue}` and `{title}`.
   * Default `[{issue}] {title}`. A job with no issue keeps its title and ignores this.
   */
  prTitle: z.string().min(1, "PR title template is empty.").optional(),
  /**
   * Remote branch for `deliver=pr`. Placeholders `{issue}`, `{slug}`, and `{jobId}`.
   * Default `<issue>-<slug>`, or `kiln/<slug>-<short id>` when there is no issue.
   * The local branch stays `yak/<run-id>`.
   */
  branch: z.string().min(1, "Branch template is empty.").optional(),
  /** Overrides the global attempt cap for jobs in this repo. */
  maxAttempts: z
    .number()
    .int("Max attempts must be a whole number.")
    .min(1, "Max attempts must be at least 1.")
    .optional(),
  /** Overrides the global fix-round cap for jobs in this repo. */
  maxFixRounds: z
    .number()
    .int("Max fix rounds must be a whole number.")
    .min(1, "Max fix rounds must be at least 1.")
    .optional(),
  /**
   * GitHub label `review-requests` searches for in this checkout.
   * Overrides the trigger `label`. Omitted uses that label, which defaults to `kiln-review`.
   */
  reviewLabel: z.string().min(1).optional(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

/** Repo map shared by the config file and the settings API. */
export const KilnReposSchema = z.record(
  z.string().regex(
    REPO_NAME,
    "must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens",
  ),
  RepoEntrySchema,
);

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

/**
 * Opt-in Docker sandbox. Omitted mode means off at that layer.
 * `image` overrides yak's `yak-agent-sandbox:latest`.
 * `allowDomains` replaces the built-in host list when set.
 */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const SandboxSettingsSchema = z.object({
  mode: z.enum(["off", "docker"]).optional(),
  image: z
    .string()
    .min(1)
    .regex(/^\S+$/, "image must not contain whitespace")
    .optional(),
  allowDomains: z.array(z.string().regex(HOSTNAME, "must be a hostname")).min(1).optional(),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

/**
 * Sandbox fields the settings UI edits. `image` stays on the file schema only
 * and is preserved when settings are saved.
 */
export const EditableSandboxSchema = SandboxSettingsSchema.pick({
  mode: true,
  allowDomains: true,
}).strict();

const WORKFLOW_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** No yak event and no log output for this long stalls a running job. `<= 0` disables it. */
export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;
/** Transient failures retry until this many attempts, then the job needs a person. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Pull request fix rounds before the job is needs-human (`feedback-exhausted`). */
export const DEFAULT_MAX_FIX_ROUNDS = 2;
/** Identical failure fingerprints before the job needs a person. */
export const DEFAULT_MAX_SAME_FINGERPRINT = 3;

/**
 * Milliseconds without a yak event or log output before a running job is
 * killed and retried. Default 15 minutes. `0` or negative disables stall detection.
 */
const stallTimeoutMs = z.number().int("Stall timeout must be a whole number of milliseconds.").optional();
/** Transient failures before the job needs a person. Default 3. Hitting the cap is a budget failure. */
const maxAttempts = z
  .number()
  .int("Max attempts must be a whole number.")
  .min(1, "Max attempts must be at least 1.")
  .optional();
/** Same failure fingerprint before Needs human. Default 3. */
const maxSameFingerprint = z
  .number()
  .int("Fingerprint limit must be a whole number.")
  .min(1, "Fingerprint limit must be at least 1.")
  .optional();
/**
 * Dollars of recorded run cost allowed on the local calendar day.
 * Omitted means no cap. `0` blocks new runs immediately.
 */
const dailyDollarCap = z.number().nonnegative("Daily dollar cap cannot be negative.").optional();
/**
 * Fix rounds for an open pull request before the job is needs-human with
 * reason `feedback-exhausted`. Default 2. Kiln does not merge.
 */
const maxFixRounds = z
  .number()
  .int("Max fix rounds must be a whole number.")
  .min(1, "Max fix rounds must be at least 1.")
  .optional();

/**
 * The subset `kiln serve` settings can edit. The file schema below uses these
 * same field validators. Settings does not accept jira, tokens, adapter,
 * workflows, or sandbox image. Trigger edits are enable/disable only.
 */
const TRIGGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One trigger in `kiln.config.json`. `enabled` defaults to true.
 * `schedule` uses `cron` (5 fields, local time). `jira` uses `jql` or
 * `label` / `status` (compiled to JQL) and `every` (default `5m`).
 * `pr` is the built-in Kiln-owned pull request source.
 * On `review-requests`, `label` is the GitHub label a pull request must
 * carry (default `kiln-review`). `maxNew` is how many new review jobs one
 * fire may create (default 3). `maxQueued` is how many review jobs may be
 * queued or running at once (default 5).
 */
export const TriggerConfigSchema = z
  .object({
    id: z.string().regex(TRIGGER_ID, "Trigger id must start with a letter or digit."),
    enabled: z.boolean().optional(),
    kind: z.enum(["schedule", "jira", "pr"]),
    cron: z.string().min(1).optional(),
    every: z.string().min(1).optional(),
    repo: z.string().regex(REPO_NAME).optional(),
    jql: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    /** Review jobs created on one fire of `review-requests`. Default 3. */
    maxNew: z.number().int().min(1).optional(),
    /** Queued or running review jobs at once. Default 5. */
    maxQueued: z.number().int().min(1).optional(),
  })
  .strict();
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

/** Maps a trigger id to create a job or attach to one. Hot-reloaded with the config. */
export const RouteConfigSchema = z
  .object({
    id: z.string().regex(TRIGGER_ID, "Route id must start with a letter or digit."),
    trigger: z.string().regex(TRIGGER_ID),
    action: z.enum(["create", "attach"]),
    workflow: z.string().min(1).optional(),
    repo: z.string().regex(REPO_NAME).optional(),
  })
  .strict();
export type RouteConfig = z.infer<typeof RouteConfigSchema>;

/** Settings API body for enable/disable. Other trigger fields stay in the file. */
export const TriggerToggleSchema = z
  .object({
    id: z.string().regex(TRIGGER_ID),
    enabled: z.boolean(),
  })
  .strict();
export type TriggerToggle = z.infer<typeof TriggerToggleSchema>;

/** Known board theme ids. An unknown id in a write is rejected. */
export const BoardThemeSchema = z.enum(BOARD_THEME_IDS);

/**
 * `board` on disk. `theme` is free text so a typo does not make the whole
 * file invalid; readers fall back to `kiln`.
 */
export const BoardFileSchema = z.object({
  theme: z.string().optional(),
});

/** `board` on PUT /api/settings. Only a known theme id is written. */
export const BoardWriteSchema = z
  .object({
    theme: BoardThemeSchema,
  })
  .strict();

export const EditableKilnSettingsSchema = z.object({
  repos: KilnReposSchema,
  stallTimeoutMs,
  maxAttempts,
  maxFixRounds,
  maxSameFingerprint,
  dailyDollarCap,
  sandbox: EditableSandboxSchema.optional(),
  triggers: z.array(TriggerToggleSchema).optional(),
  board: BoardWriteSchema.optional(),
});
export type EditableKilnSettings = z.infer<typeof EditableKilnSettingsSchema>;

/** PUT /api/settings body. `revision` is the sha256 of the file the client loaded. */
export const SettingsWriteSchema = EditableKilnSettingsSchema.extend({
  revision: z.string().min(1, "Reload settings and try again."),
}).strict();

export const KilnConfigFileSchema = z.object({
  note: z.string().min(1).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  stallTimeoutMs,
  maxAttempts,
  maxFixRounds,
  maxSameFingerprint,
  dailyDollarCap,
  adapter: z.enum(["mock", "claude-code"]).optional(),
  sandbox: SandboxSettingsSchema.optional(),
  /** Per-workflow sandbox override. A set field replaces the global one; an omitted field inherits. */
  workflows: z.record(z.string().regex(WORKFLOW_KEY), z.object({ sandbox: SandboxSettingsSchema.optional() })).optional(),
  repos: KilnReposSchema,
  jira: JiraConfigSchema.optional(),
  /** Clock, Jira poll, and pull-request sources. Omitted entries use the built-ins. */
  triggers: z.array(TriggerConfigSchema).optional(),
  /** Trigger id → create a job or attach to an existing one. */
  routes: z.array(RouteConfigSchema).optional(),
  /**
   * Reviewer prompt file. Relative paths resolve from the config directory.
   * Omitted uses the packaged `prompts/kiln/review.md`.
   */
  reviewPrompt: z.string().min(1).optional(),
  /** Board appearance. Omitted theme means Kiln. */
  board: BoardFileSchema.optional(),
});
export type KilnConfigFile = z.infer<typeof KilnConfigFileSchema>;

/**
 * Where a job came from. Adapters set this; tick and reconcile do not branch on it.
 * `ref` is an absolute spec path (`file`), `inline` or `stdin` (`prompt`), the
 * absolute ticket path (`tickets`), the issue key (`jira`, such as `SAMPLE-1`),
 * or the trigger dedupe key (`trigger`).
 */
export const JobSourceSchema = z.object({
  kind: z.enum(["file", "prompt", "tickets", "jira", "trigger"]),
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
  /** Issue id such as `ABC-123`. Omitted when intake had no key. */
  issue: z.string().regex(ISSUE_KEY).optional(),
  source: JobSourceSchema.optional(),
  createdAt: z.string().min(1),
  /**
   * Set when a person cancels the job before it starts.
   * Tick does not launch it. Cancelling does not delete a branch.
   */
  cancelledAt: z.string().min(1).optional(),
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
 * landed, which includes `in-review`. A job that has used its attempt cap,
 * fix-round cap, or fingerprint breaker is `needs-human`. `dead` is a run
 * whose process died and has not been recorded yet. `cancelled` is a job
 * cancelled before it started. Attempts live under
 * the kiln directory, not in this file.
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
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];
