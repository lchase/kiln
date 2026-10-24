import { z } from "zod";
import { PlannerOutputError } from "./errors.js";
import type { OwnershipMap, Plan, Readiness, Requirement } from "./schemas.js";

export interface PlannerContext {
  requirement: Requirement;
  ownership: OwnershipMap[];
}

/**
 * The model behind refine. `assessReadiness` decides whether the filer still
 * owes answers. `decompose` runs only after that check passes.
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
