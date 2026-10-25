import { z } from "zod";

/**
 * Kiln config file. `repos` is an open map: any name, not a fixed set.
 * `path` is absolute, relative to the config file's directory, or `~`.
 * `test` is the shell command a workflow runs as its verify step (`KILN_TEST`).
 */
export const RepoEntrySchema = z.object({
  path: z.string().min(1),
  test: z.string().min(1).optional(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export const KilnConfigFileSchema = z.object({
  note: z.string().min(1).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  adapter: z.enum(["mock", "claude-code"]).optional(),
  repos: z.record(z.string(), RepoEntrySchema),
});
export type KilnConfigFile = z.infer<typeof KilnConfigFileSchema>;

/**
 * Where a job came from. Adapters set this; tick and reconcile do not branch on it.
 * `ref` is an absolute spec path (`file`), `inline` or `stdin` (`prompt`), or the
 * absolute ticket path (`tickets`).
 */
export const JobSourceSchema = z.object({
  kind: z.enum(["file", "prompt", "tickets"]),
  ref: z.string().min(1),
});
export type JobSource = z.infer<typeof JobSourceSchema>;

/**
 * One unit of factory work. Stored as `<kilnDir>/jobs/<id>.json`.
 * `spec` is a markdown file under the kiln directory.
 * `dependsOn` names other job ids. There is no plan and no stored state.
 * Every intake writes this same shape.
 */
export const JobSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  workflow: z.string().min(1),
  spec: z.string().min(1),
  title: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  source: JobSourceSchema,
  createdAt: z.string().min(1),
});
export type Job = z.infer<typeof JobSchema>;

/**
 * Derived from the yak journal and gate files. Never written into the job file.
 *
 * `done` is the only state that unblocks dependents: the run finished ok and
 * the gate decision is approve. A reject, a failure, a dead process, and an
 * ok run with no readable approval do not unblock.
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
  "done",
] as const;
export type JobState = (typeof JOB_STATES)[number];
