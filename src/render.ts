import type { RefineResult } from "./refine.js";
import type { Plan, Readiness, Requirement } from "./schemas.js";

const MISSING_LABEL: Record<Readiness["missing"][number], string> = {
  "acceptance-criteria": "acceptance criteria",
  scope: "scope",
  "user-facing-outcome": "user-facing outcome",
};

export function renderRefineResult(requirement: Requirement, result: RefineResult): string {
  if (result.kind === "questions") return renderQuestions(requirement, result.readiness);
  return renderPlan(requirement, result.plan);
}

function renderQuestions(requirement: Requirement, readiness: Readiness): string {
  const missing = readiness.missing.map((item) => `- ${MISSING_LABEL[item]}`).join("\n");
  const questions = readiness.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  return [
    `# Not ready: ${requirement.title}`,
    "",
    `Requirement \`${requirement.id}\` (${requirement.source}) is not ready to decompose.`,
    "",
    "## Missing",
    "",
    missing || "- (none listed)",
    "",
    "## Questions",
    "",
    questions,
    "",
  ].join("\n");
}

function renderPlan(requirement: Requirement, plan: Plan): string {
  const contracts =
    plan.contracts.length === 0
      ? "None. This plan stays inside one repo."
      : plan.contracts
          .map((contract) =>
            [
              `### \`${contract.id}\` (${contract.kind})`,
              "",
              `Between \`${contract.between[0]}\` and \`${contract.between[1]}\`. Owner: \`${contract.owner}\`.`,
              "",
              contract.spec,
            ].join("\n"),
          )
          .join("\n\n");
  const tasks = plan.tasks
    .map((task) => {
      const depends =
        task.dependsOn.length === 0
          ? "Depends on: nothing."
          : `Depends on: ${task.dependsOn.map((id) => `\`${id}\``).join(", ")}.`;
      return [
        `### \`${task.id}\` — ${task.title}`,
        "",
        `${task.repo}, ${task.workflow}`,
        "",
        task.description,
        "",
        depends,
        "",
        "Acceptance:",
        "",
        bullets(task.acceptance),
      ].join("\n");
    })
    .join("\n\n");

  return [
    `# Plan: ${requirement.title}`,
    "",
    plan.contracts.length > 0
      ? `Requirement \`${plan.requirementId}\`. The owner task of each contract publishes it. The other repo waits on that contract.`
      : `Requirement \`${plan.requirementId}\`. One repo, so there is no cross-repo contract.`,
    "",
    "## Contracts",
    "",
    contracts,
    "",
    "## Tasks",
    "",
    tasks,
    "",
  ].join("\n");
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
