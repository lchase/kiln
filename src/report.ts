import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  inFlightCount,
  isDone,
  isLanded,
  jobState,
  type Action,
  type Observation,
  type ObservedGate,
  type ObservedJob,
} from "./reconcile.js";

export interface LaunchReport {
  jobId: string;
  repo: string;
  output: string;
}

export interface DeliverReport {
  jobId: string;
  repo: string;
  ok: boolean;
  detail: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Absolute path of the yak CLI, from the installed package's `bin.yak`. */
export function yakCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@lchase/yak/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.yak;
  if (!relative) {
    throw new Error(`${pkgPath} has no "yak" bin.`);
  }
  return join(dirname(pkgPath), relative);
}

export function yakInvocation(subcommand: "resume" | "cancel", runId: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(yakCliPath())} ${subcommand} ${shellQuote(runId)}`;
}

/** One variant of the command that answers an open gate and continues the run. */
export function gateAnswerCommand(
  checkout: string,
  runId: string,
  gate: ObservedGate,
  choice: string,
  title?: string,
): string {
  const pendingDir = shellQuote(`.runs/${runId}/pending`);
  const answerFile = shellQuote(`.runs/${runId}/pending/${gate.stepId}.answer.json`);
  const field = gate.answerField ?? "decision";
  const answer = JSON.stringify({ [field]: choice });
  const titlePrefix = title ? `KILN_TASK_TITLE=${shellQuote(title)} ` : "";
  return `cd ${shellQuote(checkout)} && mkdir -p ${pendingDir} && printf '%s\\n' ${shellQuote(answer)} > ${answerFile} && ${titlePrefix}${yakInvocation("resume", runId)}`;
}

export function renderStatus(observation: Observation, jobId?: string): string {
  const jobs = jobId ? observation.jobs.filter((job) => job.jobId === jobId) : observation.jobs;
  if (jobId && jobs.length === 0) {
    throw new Error(`No job ${jobId}.`);
  }
  if (jobs.length === 0) return "no jobs\n";

  const lines: string[] = [];
  for (const job of jobs) {
    if (job.error) {
      lines.push(`${job.jobId}  invalid: ${job.error}`);
      continue;
    }
    const state = jobState(job, observation);
    const run = job.run ? `  run ${job.run.runId}` : "";
    const branch =
      job.run && (state === "done" || state === "in-review") ? `  branch yak/${job.run.runId}` : "";
    const pr = prSuffix(job, state);
    lines.push(`${job.jobId}  ${job.repo}  ${job.workflow}  ${state}${run}${branch}${pr}`);
    if (job.source) lines.push(`  source ${job.source.kind} ${job.source.ref}`);
    if (state === "in-review" && !job.delivery?.prNumber) {
      lines.push("  pull request not opened yet");
    }
    if (state === "failed" && job.delivery?.error) {
      lines.push(`  ${job.delivery.error}`);
    }
    if (state === "failed" && job.delivery?.prState === "CLOSED" && job.delivery.prNumber) {
      lines.push(`  pull request #${job.delivery.prNumber} was closed without merging`);
    }
    if (job.delivery?.viewError && (state === "in-review" || state === "done")) {
      lines.push(`  could not read pull request: ${job.delivery.viewError}`);
    }
    if (state === "failed" && job.launchFailed && job.logPath) {
      lines.push(`  log ${job.logPath}`);
    }
    if (state === "failed" && job.launchError) {
      lines.push(`  ${job.launchError}`);
    }
    if (state === "failed" && job.run?.status === "ok" && !job.run.gateDecision) {
      lines.push("  no readable approval decision");
    }
    if (state === "dead" && job.run) {
      lines.push(`  fix: cd ${shellQuote(job.run.checkout)} && ${yakInvocation("cancel", job.run.runId)}`);
    }
    if (state === "blocked") {
      for (const line of blockedLines(job, observation)) lines.push(line);
    }
    if (state === "needs-human" && job.run) {
      for (const gate of job.run.gates) {
        lines.push(`  gate ${gate.stepId}: ${gate.prompt}`);
        appendGateCommands(lines, job, gate);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function prSuffix(job: ObservedJob, state: string): string {
  const url = job.delivery?.prUrl;
  if (!url) return "";
  if (state !== "in-review" && state !== "done" && state !== "failed") return "";
  return `  pr ${url}`;
}

function blockedLines(job: ObservedJob, observation: Observation): string[] {
  const lines: string[] = [];
  for (const dep of job.dependsOn) {
    const upstream = observation.jobs.find((candidate) => candidate.jobId === dep);
    if (!upstream) {
      lines.push(`  blocked on missing job ${dep}`);
      continue;
    }
    if (job.stack) {
      if (!isLanded(upstream)) lines.push(`  waiting for ${dep} to land`);
      continue;
    }
    if (isDone(upstream)) continue;
    const number = upstream.delivery?.prNumber;
    if (number && !upstream.delivery?.merged && upstream.delivery?.prState !== "CLOSED") {
      lines.push(`  waiting for PR #${number} to merge`);
      continue;
    }
    if ((upstream.deliver ?? "local") === "pr" && isLanded(upstream)) {
      lines.push(`  waiting for ${dep} to open a pull request`);
    }
  }
  return lines;
}

function appendGateCommands(lines: string[], job: ObservedJob, gate: ObservedGate): void {
  const choices = gate.choices?.length ? gate.choices : ["approve", "reject"];
  if (choices.includes("approve")) lines.push(`  approve: kiln approve ${job.jobId}`);
  if (choices.includes("reject")) lines.push(`  reject: kiln reject ${job.jobId}`);
}

export function renderTick(
  observation: Observation,
  actions: Action[],
  launches: LaunchReport[],
  delivers: DeliverReport[] = [],
): string {
  const lines = [`tick  inFlight=${inFlightCount(observation)}  maxConcurrent=${observation.maxConcurrent}`];
  for (const job of observation.jobs) {
    if (job.error) lines.push(`skip ${job.jobId} (invalid: ${job.error})`);
  }
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") lines.push(`clear breadcrumb ${action.path}`);
  }
  for (const deliver of delivers) {
    lines.push(
      deliver.ok
        ? `deliver ${deliver.jobId}  ${deliver.repo}  ${deliver.detail}`
        : `deliver ${deliver.jobId}  ${deliver.repo}  failed: ${deliver.detail}`,
    );
  }
  for (const launch of launches) {
    lines.push(`launch ${launch.jobId}  ${launch.repo}`);
    for (const line of launch.output.split("\n")) {
      if (line.trim()) lines.push(`  ${line}`);
    }
  }
  if (
    !actions.some((action) => action.type === "launch") &&
    launches.length === 0 &&
    delivers.length === 0
  ) {
    lines.push("nothing to launch");
  }
  return `${lines.join("\n")}\n`;
}
