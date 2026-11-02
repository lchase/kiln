import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LoadedKilnConfig } from "./config.js";
import type { GitRemote, KilnHost, PullRequestRef } from "./host.js";
import { HostError } from "./host.js";
import { readJobSpec } from "./jobs.js";
import { jobBasename } from "./paths.js";
import { chooseRemoteBranch, defaultRemoteBranch, formatBranchTemplate, isPublishableBranch, pullRequestTitle } from "./pr-names.js";
import type { Job } from "./schemas.js";

/**
 * Derived per run, under `<kilnDir>/deliveries/<jobId>.json`. Not the job file.
 * `pushed` is true once origin has this branch at `sha`. Re-tick uses it, and
 * `gh pr list --head`, so a crash between push and create does not open a
 * second pull request or push the same commit again.
 */
export const DeliveryRecordSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  sha: z.string().min(1).optional(),
  pushed: z.boolean(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

export function deliveryPath(kilnDir: string, jobId: string): string {
  return join(kilnDir, "deliveries", `${jobBasename(jobId)}.json`);
}

export function readDelivery(kilnDir: string, jobId: string): DeliveryRecord | undefined {
  const path = deliveryPath(kilnDir, jobId);
  if (!existsSync(path)) return undefined;
  try {
    return DeliveryRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function writeDelivery(kilnDir: string, record: DeliveryRecord): void {
  const path = deliveryPath(kilnDir, record.jobId);
  mkdirSync(join(kilnDir, "deliveries"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(DeliveryRecordSchema.parse(record), null, 2)}\n`);
}

const LAUNCH_ERROR = z.object({ error: z.string().min(1) });

export function launchErrorPath(kilnDir: string, jobId: string): string {
  return join(kilnDir, "launch-errors", `${jobBasename(jobId)}.json`);
}

export function readLaunchError(kilnDir: string, jobId: string): string | undefined {
  const path = launchErrorPath(kilnDir, jobId);
  if (!existsSync(path)) return undefined;
  try {
    return LAUNCH_ERROR.parse(JSON.parse(readFileSync(path, "utf8"))).error;
  } catch {
    return undefined;
  }
}

export function writeLaunchError(kilnDir: string, jobId: string, error: string): void {
  const path = launchErrorPath(kilnDir, jobId);
  mkdirSync(join(kilnDir, "launch-errors"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ error }, null, 2)}\n`);
}

export function clearLaunchError(kilnDir: string, jobId: string): void {
  rmSync(launchErrorPath(kilnDir, jobId), { force: true });
}

/**
 * Full SHA the worktree is cut from. Passed to yak as `--from` and to the
 * workflow as `baseRef`.
 *
 * `deliver=local` without `--stack` is checkout HEAD.
 * `deliver=pr` fetches and uses `origin/<base>` (configured, or origin's default).
 * A stacked job uses the local upstream `yak/<run-id>` tip. The caller passes
 * that ref, not the remote pull request head.
 */
export function resolveLaunchBase(input: {
  checkout: string;
  deliver: "local" | "pr";
  stack: boolean;
  configuredBase?: string;
  upstreamBranch?: string;
  git: GitRemote;
}): string {
  if (input.stack) {
    if (!input.upstreamBranch) {
      throw new HostError("This stacked job has no upstream branch to start from yet.");
    }
    return input.git.revParse(input.checkout, input.upstreamBranch);
  }
  if (input.deliver === "pr") {
    input.git.fetch(input.checkout);
    const base = input.configuredBase ?? input.git.defaultBranch(input.checkout);
    return input.git.revParse(input.checkout, `origin/${base}`);
  }
  return input.git.revParse(input.checkout, "HEAD");
}

export interface DeliverRequest {
  config: LoadedKilnConfig;
  job: Job;
  checkout: string;
  runId: string;
  /** Pull request base branch. A stacked job passes the upstream remote branch. */
  baseBranch: string;
  host: KilnHost;
}

export interface DeliverOutcome {
  ok: boolean;
  detail: string;
  prUrl?: string;
  prNumber?: number;
}

/**
 * Remote branch this job would publish, before a delivery record exists.
 * A branch template that is not a safe ref falls back to the default name.
 */
export function plannedRemoteBranch(job: Job, template?: string): string {
  const input = {
    title: job.title,
    jobId: job.id,
    ...(job.issue ? { issue: job.issue } : {}),
  };
  if (template?.trim()) {
    const name = formatBranchTemplate(template, input);
    if (isPublishableBranch(name)) return name;
  }
  return defaultRemoteBranch(input);
}

/**
 * Push local `yak/<run-id>` to the remote branch and open one draft pull request.
 * The delivery record stores the remote name. A later tick looks that name up
 * and skips both the push and `gh pr create` when origin already has this commit.
 * A recorded name, including an older `yak/<run-id>` record, is reused.
 * Failures stay on this job (`HostError` text) and do not escape.
 */
export function deliverJob(request: DeliverRequest): DeliverOutcome {
  const localBranch = `yak/${request.runId}`;
  const prior = readDelivery(request.config.kilnDir, request.job.id);
  const sameRun = prior?.runId === request.runId ? prior : undefined;
  const repo = request.config.repos[request.job.repo];
  let remoteName = sameRun?.branch;
  try {
    const localSha = request.host.git.revParse(request.checkout, localBranch);
    if (sameRun?.prNumber && sameRun.prUrl && sameRun.sha === localSha) {
      return { ok: true, detail: sameRun.prUrl, prUrl: sameRun.prUrl, prNumber: sameRun.prNumber };
    }
    if (!remoteName) {
      remoteName = chooseRemoteBranch({
        title: request.job.title,
        jobId: request.job.id,
        ...(request.job.issue ? { issue: request.job.issue } : {}),
        ...(repo?.branchTemplate ? { template: repo.branchTemplate } : {}),
        localSha,
        remoteSha: (name) => request.host.git.remoteBranchSha(request.checkout, name),
      });
    }
    // Ask gh before pushing so a missing or logged-out CLI does not publish the branch.
    let existing = request.host.github.findByHead(request.checkout, remoteName);
    const remoteSha = request.host.git.remoteBranchSha(request.checkout, remoteName);
    if (remoteSha !== localSha) {
      request.host.git.publishBranch(request.checkout, localBranch, remoteName, request.baseBranch);
    }
    const title = pullRequestTitle({
      title: request.job.title,
      ...(request.job.issue ? { issue: request.job.issue } : {}),
      ...(repo?.prTitle ? { template: repo.prTitle } : {}),
    });
    writeDelivery(request.config.kilnDir, {
      jobId: request.job.id,
      runId: request.runId,
      branch: remoteName,
      base: request.baseBranch,
      sha: localSha,
      pushed: true,
      ...(sameRun?.prNumber ? { prNumber: sameRun.prNumber, prUrl: sameRun.prUrl } : {}),
    });
    if (!existing) existing = request.host.github.findByHead(request.checkout, remoteName);
    const pr =
      existing ??
      (sameRun?.prNumber && sameRun.prUrl
        ? {
            number: sameRun.prNumber,
            url: sameRun.prUrl,
            state: "OPEN" as const,
            mergedAt: null,
            head: remoteName,
            base: request.baseBranch,
          }
        : request.host.github.createDraft({
            checkout: request.checkout,
            head: remoteName,
            base: request.baseBranch,
            title,
            body: pullRequestBody(request),
          }));
    writeDelivery(request.config.kilnDir, {
      jobId: request.job.id,
      runId: request.runId,
      branch: remoteName,
      base: request.baseBranch,
      sha: localSha,
      pushed: true,
      prNumber: pr.number,
      prUrl: pr.url,
    });
    return { ok: true, detail: pr.url, prUrl: pr.url, prNumber: pr.number };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kept = readDelivery(request.config.kilnDir, request.job.id);
    const base = kept?.runId === request.runId ? kept : sameRun;
    writeDelivery(request.config.kilnDir, {
      jobId: request.job.id,
      runId: request.runId,
      branch: remoteName ?? plannedRemoteBranch(request.job, repo?.branchTemplate),
      base: request.baseBranch,
      ...(base?.sha ? { sha: base.sha } : {}),
      pushed: base?.pushed ?? false,
      ...(base?.prNumber ? { prNumber: base.prNumber, prUrl: base.prUrl } : {}),
      error: message,
    });
    return { ok: false, detail: message };
  }
}

/** First paragraph of the job spec, capped, plus the job id and reviewer verdicts. */
export function pullRequestBody(request: DeliverRequest): string {
  const spec = readJobSpec(request.config.kilnDir, request.job);
  const summary = specSummary(spec);
  const reviews = reviewerLines(join(request.checkout, ".runs", request.runId, "artifacts"));
  return [
    summary,
    "",
    `Kiln job: ${request.job.id}`,
    "",
    "## Reviewers",
    ...(reviews.length > 0 ? reviews : ["- (no reviewer artifacts)"]),
    "",
  ].join("\n");
}

export function specSummary(specText: string): string {
  const lines = specText.split(/\r?\n/);
  const body: string[] = [];
  let skippedTitle = false;
  for (const line of lines) {
    if (!skippedTitle && /^#\s+/.test(line)) {
      skippedTitle = true;
      continue;
    }
    body.push(line);
  }
  const paragraph = (body.join("\n").trim().split(/\n\s*\n/)[0] ?? "").trim().replace(/\s+/g, " ");
  if (!paragraph) return "(empty spec)";
  if (paragraph.length <= 500) return paragraph;
  return `${paragraph.slice(0, 497)}...`;
}

function reviewerLines(artifactsDir: string): string[] {
  const lines: string[] = [];
  for (const name of ["security", "ux", "ui", "code"]) {
    const verdict = verdictOf(latestArtifact(artifactsDir, name));
    if (verdict) lines.push(`- ${name}: ${verdict}`);
  }
  const decision = verdictOf(latestArtifact(artifactsDir, "decision"), "decision");
  if (decision) lines.push(`- approver: ${decision}`);
  return lines;
}

function verdictOf(value: unknown, field = "verdict"): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) return undefined;
  const verdict = (value as Record<string, unknown>)[field];
  return typeof verdict === "string" && verdict.length > 0 ? verdict : undefined;
}

function latestArtifact(dir: string, name: string): unknown {
  if (!existsSync(dir)) return undefined;
  let best: { n: number; file: string } | undefined;
  for (const file of readdirSync(dir)) {
    if (file === `${name}.json`) {
      if (!best || best.n <= 0) best = { n: 0, file };
      continue;
    }
    const match = new RegExp(`^${name}\\.(\\d+)\\.json$`).exec(file);
    if (!match?.[1]) continue;
    const n = Number(match[1]);
    if (!best || n >= best.n) best = { n, file };
  }
  if (!best) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, best.file), "utf8"));
  } catch {
    return undefined;
  }
}

/** True when `gh pr view` says the pull request is merged, including a squash. */
export function isMerged(pr: { state: PullRequestRef["state"]; mergedAt: string | null }): boolean {
  return pr.state === "MERGED" || (typeof pr.mergedAt === "string" && pr.mergedAt.length > 0);
}
