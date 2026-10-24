import type { Contract, Plan, Repo, Task } from "./schemas.js";

/**
 * Graph checks the schema cannot express.
 *
 * - dependsOn names a task id or a contract id that exists in this plan.
 * - Each contract joins two different repos, and its owner is one of them.
 * - Exactly one task in the owner repo publishes the contract: it does not
 *   depend on the contract id. Depending on the contract waits on that task.
 * - Every pair of repos that both have tasks has a contract for that pair.
 * - A task does not depend on a contract its repo is not party to.
 * - A task does not depend on a task in another repo, unless that task
 *   publishes a contract whose sides are those two repos.
 * - The other side of a contract has a task that depends on the contract or
 *   on its publisher. A one-repo plan does not declare a contract at all.
 */
export type PlanIssueCode =
  | "duplicate-id"
  | "dangling-dependency"
  | "dependency-cycle"
  | "unreferenced-contract"
  | "cross-repo-without-contract"
  | "foreign-contract"
  | "invalid-contract-owner"
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
  const contractById = new Map(plan.contracts.map((contract) => [contract.id, contract]));

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
  }

  const repos = new Set(plan.tasks.map((task) => task.repo));
  if (repos.size <= 1 && plan.contracts.length > 0) {
    const where = repos.size === 0 ? "no repo" : `only ${[...repos][0]}`;
    issues.push({
      code: "single-repo-with-contracts",
      message: `This plan has tasks in ${where}, but still declares ${plan.contracts.length} cross-repo contract(s).`,
    });
    const cycle = findCycle(plan, new Map());
    if (cycle) {
      issues.push({
        code: "dependency-cycle",
        message: `Tasks depend on each other in a cycle: ${cycle.join(" → ")}.`,
      });
    }
    return issues;
  }

  const publisherByContract = new Map<string, Task>();
  const contractsByPublisher = new Map<string, Contract[]>();

  for (const contract of plan.contracts) {
    const distinct =
      contract.between.length === 2 && contract.between[0] !== contract.between[1];
    if (!distinct) {
      issues.push({
        code: "invalid-contract-owner",
        message: `Contract ${contract.id} must join two different repos.`,
      });
      continue;
    }
    if (!contract.between.includes(contract.owner)) {
      issues.push({
        code: "invalid-contract-owner",
        message: `Contract ${contract.id} is owned by ${contract.owner}, which is not one of ${contract.between.join(" and ")}.`,
      });
      continue;
    }
    const publishers = plan.tasks.filter(
      (task) => task.repo === contract.owner && !task.dependsOn.includes(contract.id),
    );
    if (publishers.length !== 1) {
      issues.push({
        code: "invalid-contract-owner",
        message: `Contract ${contract.id} needs exactly one task in ${contract.owner} that publishes it (a task that does not depend on ${contract.id}). Found ${publishers.length}.`,
      });
      continue;
    }
    const publisher = publishers[0];
    if (!publisher) continue;
    publisherByContract.set(contract.id, publisher);
    const published = contractsByPublisher.get(publisher.id) ?? [];
    published.push(contract);
    contractsByPublisher.set(publisher.id, published);
  }

  const cycle = findCycle(plan, publisherByContract);
  if (cycle) {
    issues.push({
      code: "dependency-cycle",
      message: `Tasks depend on each other in a cycle: ${cycle.join(" → ")}.`,
    });
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      const contract = contractById.get(dep);
      if (!contract) continue;
      if (contract.between.length !== 2 || contract.between[0] === contract.between[1]) continue;
      if (!contract.between.includes(task.repo)) {
        issues.push({
          code: "foreign-contract",
          message: `Task ${task.id} in ${task.repo} depends on contract ${contract.id}, which joins ${contract.between.join(" and ")} and does not include ${task.repo}.`,
        });
      }
    }
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      const other = taskById.get(dep);
      if (!other || other.repo === task.repo) continue;
      const published = contractsByPublisher.get(other.id) ?? [];
      const throughSeam = published.some(
        (contract) => contract.between.includes(task.repo) && contract.between.includes(other.repo),
      );
      if (throughSeam) continue;
      issues.push({
        code: "cross-repo-without-contract",
        message: `Task ${task.id} in ${task.repo} depends on task ${other.id} in ${other.repo}. Cross-repo ordering goes through a contract that ${other.repo} publishes.`,
      });
    }
  }

  const covered = new Set<string>();
  for (const contract of plan.contracts) {
    const left = contract.between[0];
    const right = contract.between[1];
    if (!left || !right || left === right) continue;
    covered.add(pairKey(left, right));
  }
  const repoList = [...repos];
  for (let i = 0; i < repoList.length; i += 1) {
    for (let j = i + 1; j < repoList.length; j += 1) {
      const left = repoList[i];
      const right = repoList[j];
      if (!left || !right) continue;
      if (covered.has(pairKey(left, right))) continue;
      issues.push({
        code: "cross-repo-without-contract",
        message: `Tasks span ${left} and ${right}, but no contract joins that pair.`,
      });
    }
  }

  for (const contract of plan.contracts) {
    const publisher = publisherByContract.get(contract.id);
    if (!publisher) continue;
    for (const repo of contract.between) {
      if (repo === contract.owner) continue;
      const waiting = plan.tasks.some(
        (task) =>
          task.repo === repo &&
          (task.dependsOn.includes(contract.id) || task.dependsOn.includes(publisher.id)),
      );
      if (!waiting) {
        issues.push({
          code: "unreferenced-contract",
          message: `Contract ${contract.id} joins ${contract.between.join(" and ")}, but no task in ${repo} depends on it or on its owner task ${publisher.id}.`,
        });
      }
    }
  }

  return issues;
}

function pairKey(left: Repo, right: Repo): string {
  return [left, right].sort().join("/");
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

function findCycle(plan: Plan, publisherByContract: Map<string, Task>): string[] | null {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const color = new Map<string, "white" | "gray" | "black">();
  for (const task of plan.tasks) color.set(task.id, "white");
  const stack: string[] = [];

  const edges = (task: Task): string[] => {
    const next: string[] = [];
    for (const dep of task.dependsOn) {
      const publisher = publisherByContract.get(dep);
      if (publisher) {
        if (publisher.id !== task.id) next.push(publisher.id);
        continue;
      }
      if (byId.has(dep)) next.push(dep);
    }
    return next;
  };

  const visit = (id: string): string[] | null => {
    color.set(id, "gray");
    stack.push(id);
    const task = byId.get(id);
    if (task) {
      for (const dep of edges(task)) {
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
