import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  inFlightCount,
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
    const branch = state === "done" && job.run ? `  branch yak/${job.run.runId}` : "";
    lines.push(`${job.jobId}  ${job.repo}  ${job.workflow}  ${state}${run}${branch}`);
    if (state === "failed" && job.launchFailed && job.logPath) {
      lines.push(`  log ${job.logPath}`);
    }
    if (state === "failed" && job.run?.status === "ok" && !job.run.gateDecision) {
      lines.push("  no readable approval decision");
    }
    if (state === "dead" && job.run) {
      lines.push(`  fix: cd ${shellQuote(job.run.checkout)} && ${yakInvocation("cancel", job.run.runId)}`);
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

function appendGateCommands(lines: string[], job: ObservedJob, gate: ObservedGate): void {
  const choices = gate.choices?.length ? gate.choices : ["approve", "reject"];
  if (choices.includes("approve")) lines.push(`  approve: kiln approve ${job.jobId}`);
  if (choices.includes("reject")) lines.push(`  reject: kiln reject ${job.jobId}`);
}

export function renderTick(observation: Observation, actions: Action[], launches: LaunchReport[]): string {
  const lines = [`tick  inFlight=${inFlightCount(observation)}  maxConcurrent=${observation.maxConcurrent}`];
  for (const job of observation.jobs) {
    if (job.error) lines.push(`skip ${job.jobId} (invalid: ${job.error})`);
  }
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") lines.push(`clear breadcrumb ${action.path}`);
  }
  for (const launch of launches) {
    lines.push(`launch ${launch.jobId}  ${launch.repo}`);
    for (const line of launch.output.split("\n")) {
      if (line.trim()) lines.push(`  ${line}`);
    }
  }
  if (!actions.some((action) => action.type === "launch") && launches.length === 0) {
    lines.push("nothing to launch");
  }
  return `${lines.join("\n")}\n`;
}
