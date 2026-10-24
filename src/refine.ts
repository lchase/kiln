import type { LoadedKilnConfig } from "./config.js";
import { PlanValidationError, PlannerOutputError } from "./errors.js";
import { expectSchema, type Planner } from "./planner.js";
import {
  PlanSchema,
  ReadinessSchema,
  type Plan,
  type Readiness,
  type Requirement,
} from "./schemas.js";
import { validatePlan } from "./validate.js";

export type RefineResult =
  | { kind: "questions"; readiness: Readiness }
  | { kind: "plan"; plan: Plan };

export interface RefineOptions {
  config: LoadedKilnConfig;
}

/**
 * Structural readiness from the parsed requirement, then the planner's own
 * gaps, reported as the union. A model that says ready cannot override a
 * missing acceptance criterion, scope, or outcome. Decomposition runs only
 * when the union is ready, and the plan must pass the semantic validator.
 */
export async function refine(
  requirement: Requirement,
  planner: Planner,
  options: RefineOptions,
): Promise<RefineResult> {
  const context = {
    requirement,
    ownership: options.config.ownership,
    checkouts: options.config.checkouts,
    example: options.config.example,
  };
  const structural = structuralReadiness(requirement);
  const modelReadiness = expectSchema(
    ReadinessSchema,
    await planner.assessReadiness(context),
    "Readiness",
  );
  const readiness = unionReadiness(structural, modelReadiness);
  if (!readiness.ready) {
    return { kind: "questions", readiness };
  }

  const plan = expectSchema(PlanSchema, await planner.decompose(context), "Plan");
  if (plan.requirementId !== requirement.id) {
    throw new PlannerOutputError(`Plan is for ${plan.requirementId}, not ${requirement.id}.`);
  }
  const issues = validatePlan(plan);
  if (issues.length > 0) {
    throw new PlanValidationError(issues);
  }
  return { kind: "plan", plan };
}

function structuralReadiness(requirement: Requirement): Readiness {
  const missing: Readiness["missing"] = [];
  const questions: string[] = [];
  if (!requirement.acceptanceCriteria?.length) {
    missing.push("acceptance-criteria");
    questions.push(
      `What are the acceptance criteria for "${requirement.title}"? List the observable checks that would tell us it is done.`,
    );
  }
  if (!requirement.scope) {
    missing.push("scope");
    questions.push(
      `Which of frontend, ai-core, and evals-obs does "${requirement.title}" change, and which are out of scope?`,
    );
  }
  if (!requirement.outcome) {
    missing.push("user-facing-outcome");
    questions.push(
      `What should a person using the product be able to see or do when "${requirement.title}" is done?`,
    );
  }
  return { ready: missing.length === 0, missing, questions };
}

function unionReadiness(first: Readiness, second: Readiness): Readiness {
  const missing = [...new Set([...first.missing, ...second.missing])];
  const questions = [...new Set([...first.questions, ...second.questions])];
  const ready = first.ready && second.ready && missing.length === 0 && questions.length === 0;
  if (!ready && questions.length === 0) {
    questions.push("What is still missing before this requirement can be decomposed?");
  }
  return { ready, missing, questions };
}
