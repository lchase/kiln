import type { Plan } from "./schemas.js";

/**
 * Graph checks the schema cannot express.
 *
 * - dependsOn / contractRefs point at ids that exist (task ids or, for
 *   dependsOn, contract ids).
 * - Task dependencies do not cycle. Contract ids are roots, not nodes.
 * - Each repo named on a contract has a task in that repo that references it.
 * - A task does not depend on a task in another repo. The seam is the
 *   contract, so the two sides stay independent after it lands.
 * - A task does not reference a contract its repo is not party to.
 * - A plan whose tasks sit in one repo does not declare a cross-repo contract.
 */
export type PlanIssueCode =
  | "duplicate-id"
  | "dangling-dependency"
  | "dangling-contract-ref"
  | "dependency-cycle"
  | "unreferenced-contract"
  | "cross-repo-without-contract"
  | "single-repo-with-contracts";

export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
}

export function validatePlan(plan: Plan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const taskIds = plan.tasks.map((task) => task.id);
  const contractIds = plan.contracts.map((contract) => contract.id);
  const taskIdSet = new Set(taskIds);
  const contractIdSet = new Set(contractIds);
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));

  for (const id of duplicated([...taskIds, ...contractIds])) {
    issues.push({
      code: "duplicate-id",
      message: `Id ${id} is used more than once. Task ids and contract ids share one namespace.`,
    });
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIdSet.has(dep) && !contractIdSet.has(dep)) {
        issues.push({
          code: "dangling-dependency",
          message: `Task ${task.id} depends on ${dep}, which is not a task or a contract in this plan.`,
        });
      }
    }
    for (const ref of task.contractRefs) {
      if (!contractIdSet.has(ref)) {
        issues.push({
          code: "dangling-contract-ref",
          message: `Task ${task.id} references contract ${ref}, which is not in this plan.`,
        });
      }
    }
  }

  const cycle = findCycle(plan);
  if (cycle) {
    issues.push({
      code: "dependency-cycle",
      message: `Tasks depend on each other in a cycle: ${cycle.join(" → ")}.`,
    });
  }

  for (const contract of plan.contracts) {
    const missing = contract.between.filter(
      (repo) => !plan.tasks.some((task) => task.repo === repo && task.contractRefs.includes(contract.id)),
    );
    if (missing.length > 0) {
      issues.push({
        code: "unreferenced-contract",
        message: `Contract ${contract.id} joins ${contract.between.join(" and ")}, but no task in ${missing.join(" or ")} references it.`,
      });
    }
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      const other = taskById.get(dep);
      if (!other || other.repo === task.repo) continue;
      issues.push({
        code: "cross-repo-without-contract",
        message: `Task ${task.id} in ${task.repo} depends on task ${other.id} in ${other.repo}. Cross-repo ordering goes through a contract, so the two tasks can run independently.`,
      });
    }
    for (const ref of task.contractRefs) {
      const contract = plan.contracts.find((item) => item.id === ref);
      if (!contract) continue;
      if (!contract.between.includes(task.repo)) {
        issues.push({
          code: "cross-repo-without-contract",
          message: `Task ${task.id} in ${task.repo} references contract ${contract.id}, which joins ${contract.between.join(" and ")} and does not include ${task.repo}.`,
        });
      }
    }
  }

  const repos = new Set(plan.tasks.map((task) => task.repo));
  if (repos.size <= 1 && plan.contracts.length > 0) {
    const where = repos.size === 0 ? "no repo" : `only ${[...repos][0]}`;
    issues.push({
      code: "single-repo-with-contracts",
      message: `This plan has tasks in ${where}, but still declares ${plan.contracts.length} cross-repo contract(s).`,
    });
  }

  return issues;
}

function duplicated(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

function findCycle(plan: Plan): string[] | null {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const color = new Map<string, "white" | "gray" | "black">();
  for (const task of plan.tasks) color.set(task.id, "white");
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, "gray");
    stack.push(id);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (!byId.has(dep)) continue;
        const state = color.get(dep);
        if (state === "gray") {
          const start = stack.indexOf(dep);
          return [...stack.slice(start), dep];
        }
        if (state === "white") {
          const found = visit(dep);
          if (found) return found;
        }
      }
    }
    stack.pop();
    color.set(id, "black");
    return null;
  };

  for (const task of plan.tasks) {
    if (color.get(task.id) === "white") {
      const found = visit(task.id);
      if (found) return found;
    }
  }
  return null;
}
