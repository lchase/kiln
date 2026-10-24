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

/** The command a person runs to answer one open gate and continue the yak run. */
export function gateAnswerCommand(checkout: string, runId: string, gate: ObservedGate): string {
  const pendingDir = shellQuote(`.runs/${runId}/pending`);
  const answerFile = shellQuote(`.runs/${runId}/pending/${gate.stepId}.answer.json`);
  const write = gate.answerJson
    ? `printf '%s\\n' ${shellQuote(gate.answerJson)} > ${answerFile} && `
    : "";
  return `cd ${shellQuote(checkout)} && mkdir -p ${pendingDir} && ${write}yak resume ${shellQuote(runId)}`;
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
      lines.push(`  ${task.taskId}  ${task.repo}  ${phase}${run}`);
      if (phase === "launching" && task.breadcrumbPath) {
        lines.push(`    breadcrumb ${task.breadcrumbPath}`);
        lines.push("    delete that file to retry if no yak process is running");
      }
      if (task.run?.status === "suspended") {
        for (const gate of task.run.gates) {
          lines.push(`    gate ${gate.stepId}: ${gate.prompt}`);
          lines.push(`    answer: ${gateAnswerCommand(task.run.checkout, task.run.runId, gate)}`);
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
