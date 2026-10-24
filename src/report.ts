import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.js";
import {
  inFlightCount,
  taskPhase,
  type Action,
  type Observation,
  type ObservedGate,
} from "./reconcile.js";

export interface LaunchReport {
  taskId: string;
  repo: string;
  output: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Absolute path of the yak CLI, from the installed package's `bin` field. */
export function yakCliPath(): string {
  const yakRoot = join(packageRoot(), "node_modules", "@lchase", "yak");
  const pkg = JSON.parse(readFileSync(join(yakRoot, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.yak;
  if (!relative) {
    throw new Error(`@lchase/yak at ${yakRoot} has no "yak" bin in package.json.`);
  }
  return join(yakRoot, relative);
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
  taskTitle?: string,
): string {
  const pendingDir = shellQuote(`.runs/${runId}/pending`);
  const answerFile = shellQuote(`.runs/${runId}/pending/${gate.stepId}.answer.json`);
  const field = gate.answerField ?? "decision";
  const answer = JSON.stringify({ [field]: choice });
  const title = taskTitle ? `KILN_TASK_TITLE=${shellQuote(taskTitle)} ` : "";
  return `cd ${shellQuote(checkout)} && mkdir -p ${pendingDir} && printf '%s\\n' ${shellQuote(answer)} > ${answerFile} && ${title}${yakInvocation("resume", runId)}`;
}

export function renderStatus(observation: Observation, planId?: string): string {
  const plans = planId ? observation.plans.filter((plan) => plan.planId === planId) : observation.plans;
  if (planId && plans.length === 0) {
    throw new Error(`No plan ${planId}.`);
  }
  if (plans.length === 0) return "no plans\n";

  const lines: string[] = [];
  for (const plan of plans) {
    lines.push(`plan ${plan.planId}`);
    if (plan.error) {
      lines.push(`  invalid: ${plan.error}`);
      continue;
    }
    lines.push(`  ${plan.approved ? "approved" : "unapproved"}`);
    for (const task of observation.tasks.filter((candidate) => candidate.planId === plan.planId)) {
      const phase = taskPhase(task, observation);
      const run = task.run ? `  run ${task.run.runId}` : "";
      const branch = phase === "ok" && task.run ? `  branch yak/${task.run.runId}` : "";
      lines.push(`  ${task.taskId}  ${task.repo}  ${phase}${run}${branch}`);
      if (phase === "launch-failed" && task.logPath) {
        lines.push(`    log ${task.logPath}`);
      }
      if (phase === "dead" && task.run) {
        lines.push(`    fix: cd ${shellQuote(task.run.checkout)} && ${yakInvocation("cancel", task.run.runId)}`);
      }
      if (task.run?.status === "suspended") {
        for (const gate of task.run.gates) {
          lines.push(`    gate ${gate.stepId}: ${gate.prompt}`);
          const choices = gate.choices?.length ? gate.choices : [];
          for (const choice of choices) {
            lines.push(
              `    answer ${choice}: ${gateAnswerCommand(task.run.checkout, task.run.runId, gate, choice, task.run.taskTitle)}`,
            );
          }
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderTick(observation: Observation, actions: Action[], launches: LaunchReport[]): string {
  const lines = [`tick  inFlight=${inFlightCount(observation)}  maxConcurrent=${observation.maxConcurrent}`];
  for (const plan of observation.plans) {
    if (plan.error) lines.push(`skip ${plan.planId} (invalid: ${plan.error})`);
    else if (!plan.approved) lines.push(`skip ${plan.planId} (not approved)`);
  }
  for (const action of actions) {
    if (action.type === "clear-breadcrumb") lines.push(`clear breadcrumb ${action.path}`);
  }
  for (const launch of launches) {
    lines.push(`launch ${launch.taskId}  ${launch.repo}`);
    for (const line of launch.output.split("\n")) {
      if (line.trim()) lines.push(`  ${line}`);
    }
  }
  if (!actions.some((action) => action.type === "launch") && launches.length === 0) {
    lines.push("nothing to launch");
  }
  return `${lines.join("\n")}\n`;
}
