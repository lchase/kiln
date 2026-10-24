import { section } from "../parse-requirement.js";
import type { Planner, PlannerContext } from "../planner.js";
import {
  REPOS,
  type Contract,
  type ContractKind,
  type OwnershipMap,
  type Plan,
  type Readiness,
  type Repo,
  type Workflow,
} from "../schemas.js";

const REPO_PATTERN = /\b(frontend|ai-core|evals-obs)\b/g;

/**
 * Deterministic planner for tests and for `kiln refine` without a model.
 * It applies a fixed rubric. It does not call an agent CLI.
 */
export class FakePlanner implements Planner {
  async assessReadiness(context: PlannerContext): Promise<Readiness> {
    const { requirement } = context;
    const missing: Readiness["missing"] = [];
    const questions: string[] = [];

    if (!requirement.acceptanceCriteria?.length) {
      missing.push("acceptance-criteria");
      questions.push(
        `What are the acceptance criteria for "${requirement.title}"? List the observable checks that would tell us it is done.`,
      );
    }

    if (reposInScope(requirement.body).length === 0) {
      missing.push("scope");
      questions.push(
        `Which of frontend, ai-core, and evals-obs does "${requirement.title}" change, and which are out of scope?`,
      );
    }

    if (!outcomeOf(requirement.body)) {
      missing.push("user-facing-outcome");
      questions.push(
        `What should a person using the product be able to see or do when "${requirement.title}" is done?`,
      );
    }

    return { ready: missing.length === 0, missing, questions };
  }

  async decompose(context: PlannerContext): Promise<Plan> {
    const { requirement, ownership } = context;
    const repos = reposInScope(requirement.body);
    if (repos.length === 0) {
      throw new Error(
        `Cannot decompose ${requirement.id}: no in-scope repo. Run the readiness check first.`,
      );
    }
    const acceptance = requirement.acceptanceCriteria ?? [];
    if (acceptance.length === 0) {
      throw new Error(`Cannot decompose ${requirement.id}: no acceptance criteria.`);
    }
    const workflow = workflowOf(requirement.title, requirement.body, repos);
    const outcome = outcomeOf(requirement.body);
    const contracts = seamsFor(requirement.id, repos, ownership, outcome);
    const tasks = repos.map((repo) => {
      const related = contracts.filter((contract) => contract.between.includes(repo));
      const contractIds = related.map((contract) => contract.id);
      return {
        id: `${requirement.id}-${repo}`,
        repo,
        workflow,
        dependsOn: contractIds,
        contractRefs: contractIds,
        acceptance,
      };
    });

    return {
      requirementId: requirement.id,
      acceptance,
      contracts,
      tasks,
    };
  }
}

/**
 * Repo names in the Scope section, skipping lines that mark work out of scope.
 * Order follows frontend → ai-core → evals-obs.
 */
export function reposInScope(body: string): Repo[] {
  const scope = section(body, "Scope");
  if (!scope) return [];
  const found = new Set<Repo>();
  for (const line of scope.split(/\r?\n/)) {
    if (/out of scope/i.test(line) || /^\s*out\s*:/i.test(line)) continue;
    for (const match of line.matchAll(REPO_PATTERN)) {
      const repo = match[1];
      if (repo === "frontend" || repo === "ai-core" || repo === "evals-obs") {
        found.add(repo);
      }
    }
  }
  return REPOS.filter((repo) => found.has(repo));
}

function outcomeOf(body: string): string {
  return section(body, "Outcome") || section(body, "User-facing outcome");
}

function workflowOf(title: string, body: string, repos: Repo[]): Workflow {
  const raw = section(body, "Workflow").trim().toLowerCase();
  if (raw === "bug" || raw === "feature" || raw === "security" || raw === "prototype") {
    return raw;
  }
  if (repos.length === 1 && /\bbug\b/i.test(`${title}\n${body}`)) return "bug";
  return "feature";
}

function seamsFor(
  requirementId: string,
  repos: Repo[],
  ownership: OwnershipMap[],
  outcome: string,
): Contract[] {
  const contracts: Contract[] = [];
  for (let i = 0; i < repos.length - 1; i += 1) {
    const left = repos[i];
    const right = repos[i + 1];
    if (!left || !right) continue;
    const kind = kindFor(left, right);
    contracts.push({
      id: `${requirementId}-${kind}-${left}-${right}`,
      between: [left, right],
      kind,
      spec: specFor(left, right, kind, ownership, outcome),
    });
  }
  return contracts;
}

function kindFor(left: Repo, right: Repo): ContractKind {
  const pair = new Set([left, right]);
  if (pair.has("ai-core") && pair.has("evals-obs")) return "event";
  if (pair.has("frontend") && pair.has("ai-core")) return "api";
  return "schema";
}

function specFor(
  left: Repo,
  right: Repo,
  kind: ContractKind,
  ownership: OwnershipMap[],
  outcome: string,
): string {
  const expose = (repo: Repo) =>
    ownership.find((map) => map.repo === repo)?.exposes[0] ?? repo;
  const outcomeLine = outcome.replace(/\s+/g, " ").trim();
  const label = kind === "api" ? "API" : kind;
  return [
    `Example ${label} seam for the fictional Pebble product.`,
    `${left}: ${sentence(expose(left))}`,
    `${right}: ${sentence(expose(right))}`,
    outcomeLine ? `Outcome this seam supports: ${sentence(outcomeLine)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
