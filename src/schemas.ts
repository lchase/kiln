import { z } from "zod";

/**
 * The three monorepos this factory plans for. A closed set keeps a plan from
 * naming a repository nobody owns. Add a repo here and in the kiln config together.
 */
export const REPOS = ["frontend", "ai-core", "evals-obs"] as const;

export const RepoSchema = z.enum(REPOS);
export type Repo = z.infer<typeof RepoSchema>;

export const RequirementSourceSchema = z.enum(["markdown", "jira"]);
export type RequirementSource = z.infer<typeof RequirementSourceSchema>;

export const RequirementSchema = z.object({
  id: z.string().min(1),
  source: RequirementSourceSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  /** Text of the Scope section, when the requirement has one. */
  scope: z.string().min(1).optional(),
  /** Text of the Outcome section, when the requirement has one. */
  outcome: z.string().min(1).optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/**
 * The only gaps the readiness check reports. Anything else belongs in
 * `questions` as prose for the person who filed the requirement.
 */
export const MissingSchema = z.enum([
  "acceptance-criteria",
  "scope",
  "user-facing-outcome",
]);
export type Missing = z.infer<typeof MissingSchema>;

export const ReadinessSchema = z
  .object({
    ready: z.boolean(),
    missing: z.array(MissingSchema),
    questions: z.array(z.string().min(1)),
  })
  .superRefine((value, ctx) => {
    if (value.ready && (value.missing.length > 0 || value.questions.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A ready requirement has no gaps and no questions.",
      });
    }
    if (!value.ready && value.questions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A requirement that is not ready needs at least one question for the filer.",
      });
    }
  });
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ContractKindSchema = z.enum(["api", "event", "schema"]);
export type ContractKind = z.infer<typeof ContractKindSchema>;

/**
 * A contract is one seam with two sides. `between` is an array of length 2
 * (not a tuple) so agent structured output accepts the schema. The validator
 * checks that the two repos differ. `owner` is the repo whose task publishes
 * the seam; that task does not depend on the contract, and the other side does.
 */
export const ContractSchema = z.object({
  id: z.string().min(1),
  between: z.array(RepoSchema).min(2).max(2),
  owner: RepoSchema,
  kind: ContractKindSchema,
  spec: z.string().min(1),
});
export type Contract = z.infer<typeof ContractSchema>;

export const WorkflowSchema = z.enum(["feature", "bug", "security", "prototype"]);
export type Workflow = z.infer<typeof WorkflowSchema>;

/**
 * `dependsOn` names a task id or a contract id. A contract id waits on the
 * owner repo's task that publishes it (the task in `owner` that does not
 * depend on this contract). That is what makes the contract land first.
 */
export const TaskSchema = z.object({
  id: z.string().min(1),
  repo: RepoSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  workflow: WorkflowSchema,
  dependsOn: z.array(z.string().min(1)),
  acceptance: z.array(z.string().min(1)).min(1),
});
export type Task = z.infer<typeof TaskSchema>;

export const PlanSchema = z.object({
  requirementId: z.string().min(1),
  contracts: z.array(ContractSchema),
  tasks: z.array(TaskSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

export const OwnershipMapSchema = z.object({
  note: z.string().min(1).optional(),
  repo: RepoSchema,
  owns: z.array(z.string().min(1)).min(1),
  exposes: z.array(z.string().min(1)).min(1),
});
export type OwnershipMap = z.infer<typeof OwnershipMapSchema>;
