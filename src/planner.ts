import { z } from "zod";
import { PlannerOutputError } from "./errors.js";
import type { OwnershipMap, Plan, Readiness, Repo, Requirement } from "./schemas.js";

export interface PlannerContext {
  requirement: Requirement;
  ownership: OwnershipMap[];
  /** Absolute paths of the three local checkouts from the kiln config. */
  checkouts: Record<Repo, string>;
  /** True when the config is the committed fictional example, not the user's machine. */
  example: boolean;
}

/**
 * The model behind refine. `assessReadiness` adds gaps on top of the
 * structural checks. `decompose` runs only after the union of those checks
 * passes.
 */
export interface Planner {
  assessReadiness(context: PlannerContext): Promise<Readiness>;
  decompose(context: PlannerContext): Promise<Plan>;
}

export function expectSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PlannerOutputError(`${label} did not match the schema: ${parsed.error.message}`);
  }
  return parsed.data;
}
