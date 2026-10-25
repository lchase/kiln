import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import { jobBasename } from "./paths.js";
import { JobSchema, type Job, type JobSource } from "./schemas.js";
import { assertWorkflowName } from "./workflow.js";

export function newJobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `j${stamp}${randomBytes(2).toString("hex")}`;
}

export function jobFilePath(jobsDir: string, id: string): string {
  return join(jobsDir, `${jobBasename(id)}.json`);
}

export function resolveJobSpec(kilnDir: string, spec: string): string {
  return isAbsolute(spec) ? spec : join(kilnDir, spec);
}

export function readJobSpec(kilnDir: string, job: Job): string {
  const path = resolveJobSpec(kilnDir, job.spec);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read spec for job ${job.id} at ${path}: ${message}`);
  }
}

export function titleFromSpec(text: string, filePath: string): string {
  for (const line of text.split("\n")) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  const base = basename(filePath).replace(/\.md$/i, "");
  if (!base || base === "." || base === "..") {
    throw new Error(`Could not derive a title from ${filePath}. Pass --title.`);
  }
  return base;
}

export interface WriteJobInput {
  /** When set, the batch allocator already chose the id. */
  id?: string;
  workflow: string;
  repo: string;
  specText: string;
  title: string;
  dependsOn: string[];
  /** True when this job stacks on its single upstream. Omitted means after-merged. */
  stack?: boolean;
  source: JobSource;
  now?: Date;
  /**
   * Ids that count as existing because this batch is about to write them.
   * `--after` on a single add leaves this empty, so those deps must already be on disk.
   */
  pendingIds?: ReadonlySet<string>;
}

/** Persist one job. Intake adapters call this; they do not write job files themselves. */
export function writeJob(config: LoadedKilnConfig, input: WriteJobInput): { job: Job; jsonPath: string } {
  assertWorkflowName(input.workflow);
  if (!config.repos[input.repo]) {
    const known = Object.keys(config.repos).sort();
    const suffix = known.length > 0 ? ` Known repos: ${known.join(", ")}.` : " No repos are registered.";
    throw new Error(`Unknown repo ${input.repo}.${suffix} Run kiln repo add ${input.repo} <path>.`);
  }
  if (!input.specText.trim()) {
    throw new Error("Job spec is empty.");
  }
  const title = input.title.trim();
  if (!title) {
    throw new Error("Job title is empty. Pass --title.");
  }

  const now = input.now ?? new Date();
  const id = input.id ?? newJobId(now);
  const dependsOn = normalizedDepends(input.dependsOn);
  if (dependsOn.includes(id)) {
    throw new Error(`Job ${id} cannot depend on itself.`);
  }
  const known = listValidJobs(config);
  assertCanStack(input.repo, dependsOn, input.stack, known);
  const knownIds = new Set(known.map((job) => job.id));
  for (const pending of input.pendingIds ?? []) knownIds.add(pending);
  for (const dep of dependsOn) {
    if (!knownIds.has(dep)) {
      throw new Error(`Job ${dep} does not exist. --after must name a job already under ${config.jobsDir}.`);
    }
  }

  const specRel = `specs/${id}.md`;
  const specDest = join(config.kilnDir, specRel);
  mkdirSync(join(config.kilnDir, "specs"), { recursive: true });
  writeFileSync(specDest, input.specText);

  const job = JobSchema.parse({
    id,
    repo: input.repo,
    workflow: input.workflow,
    spec: specRel,
    title,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(input.stack ? { stack: true } : {}),
    source: input.source,
    createdAt: now.toISOString(),
  });
  mkdirSync(config.jobsDir, { recursive: true });
  const jsonPath = jobFilePath(config.jobsDir, job.id);
  writeFileSync(jsonPath, `${JSON.stringify(job, null, 2)}\n`);
  return { job, jsonPath };
}

export function renderAddedJob(job: Job, jsonPath: string): string {
  const lines = [`added ${job.id}`, `repo ${job.repo}`, `workflow ${job.workflow}`, `spec ${job.spec}`];
  if (job.stack) lines.push("stack");
  if (job.source) lines.push(`source ${job.source.kind} ${job.source.ref}`);
  lines.push(`wrote ${jsonPath}`, "");
  return lines.join("\n");
}

/** Valid job files. Unreadable files are skipped; the driver reports those. */
export function listValidJobs(config: LoadedKilnConfig): Job[] {
  if (!existsSync(config.jobsDir)) return [];
  const jobs: Job[] = [];
  for (const name of readdirSync(config.jobsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(config.jobsDir, name), "utf8"));
      const job = JobSchema.parse(raw);
      if (`${jobBasename(job.id)}.json` === name) jobs.push(job);
    } catch {
      // An unreadable job is not a dependency target. The driver reports it.
    }
  }
  return jobs;
}

/**
 * `stack` needs one upstream in the same repo: the pull request has one base
 * branch, and the worktree is cut from that branch. Zero dependencies and
 * two or more are both rejected. An investigation upstream is rejected: that
 * workflow does not land a branch. An upstream that is not on disk yet is
 * allowed here so an import batch can validate the count before every job
 * exists; the same-repo check runs when the upstream file is already there.
 */
export function assertCanStack(
  repo: string,
  dependsOn: string[],
  stack: boolean | undefined,
  known: readonly Job[] = [],
): void {
  if (!stack) return;
  if (dependsOn.length !== 1) {
    throw new Error(
      `stack needs exactly one dependency so the pull request has one base branch. Got ${dependsOn.length}.`,
    );
  }
  const upstreamId = dependsOn[0];
  const upstream = known.find((job) => job.id === upstreamId);
  if (upstream?.workflow === INVESTIGATION_WORKFLOW) {
    throw new Error(
      `stack cannot target investigation job ${upstreamId}. An investigation does not land a branch.`,
    );
  }
  if (upstream && upstream.repo !== repo) {
    throw new Error(
      `stack needs upstream ${upstreamId} to be in repo ${repo}. That job is in repo ${upstream.repo}.`,
    );
  }
}

function normalizedDepends(dependsOn: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of dependsOn) {
    if (seen.has(id)) {
      throw new Error(`--after lists ${id} more than once.`);
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

