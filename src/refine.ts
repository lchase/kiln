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
 * Readiness, then decomposition, then the semantic validator.
 * Returns questions for the filer, or a plan that already passed validation.
 * An invalid plan is an error from the planner, not a question for the filer.
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
  const readiness = expectSchema(
    ReadinessSchema,
    await planner.assessReadiness(context),
    "Readiness",
  );
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
