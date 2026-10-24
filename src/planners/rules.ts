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
 * Rules-based planner for tests and for `kiln refine` without a model.
 * Structural gaps (acceptance, scope, outcome) are checked in `refine` from
 * the parsed requirement. This planner only adds a scope gap when the scope
 * text names no repo, then decomposes.
 */
export class RulesPlanner implements Planner {
  async assessReadiness(context: PlannerContext): Promise<Readiness> {
    const { requirement } = context;
    const missing: Readiness["missing"] = [];
    const questions: string[] = [];

    if (requirement.scope && reposNamedIn(requirement.scope).length === 0) {
      missing.push("scope");
      questions.push(
        `Which of frontend, ai-core, and evals-obs does "${requirement.title}" change? The scope section does not name one.`,
      );
    }

    return { ready: missing.length === 0, missing, questions };
  }

  async decompose(context: PlannerContext): Promise<Plan> {
    const { requirement, ownership } = context;
    const repos = requirement.scope ? reposNamedIn(requirement.scope) : reposInScope(requirement.body);
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
    const outcome = requirement.outcome ?? outcomeOf(requirement.body);
    const contracts = seamsFor(requirement.id, repos, ownership, outcome);
    const tasks = repos.map((repo) => ({
      id: `${requirement.id}-${repo}`,
      repo,
      title: `${requirement.title} (${repo})`,
      description: outcome
        ? `In ${repo}: ${oneLine(outcome)}`
        : `In ${repo}: ${requirement.title}.`,
      workflow,
      dependsOn: contracts
        .filter((contract) => contract.between.includes(repo) && contract.owner !== repo)
        .map((contract) => contract.id),
      acceptance: acceptanceFor(repo, acceptance, repos),
    }));

    return {
      requirementId: requirement.id,
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
  return reposNamedIn(scope);
}

function reposNamedIn(scope: string): Repo[] {
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

function mentionedRepos(text: string, inScope: readonly Repo[]): Repo[] {
  const found = new Set<Repo>();
  for (const match of text.matchAll(REPO_PATTERN)) {
    const repo = match[1];
    if ((repo === "frontend" || repo === "ai-core" || repo === "evals-obs") && inScope.includes(repo)) {
      found.add(repo);
    }
  }
  return REPOS.filter((repo) => found.has(repo));
}

/**
 * A criterion that names a repo goes only to that repo. A criterion that names
 * no in-scope repo goes to the first in-scope repo, not to every task.
 */
function acceptanceFor(repo: Repo, criteria: string[], repos: Repo[]): string[] {
  const first = repos[0];
  const mine = criteria.filter((item) => {
    const named = mentionedRepos(item, repos);
    if (named.length === 0) return repo === first;
    return named.includes(repo);
  });
  if (mine.length > 0) return mine;
  return [`Deliver the ${repo} part of this requirement.`];
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
  for (let i = 0; i < repos.length; i += 1) {
    for (let j = i + 1; j < repos.length; j += 1) {
      const left = repos[i];
      const right = repos[j];
      if (!left || !right) continue;
      const kind = kindFor(left, right);
      contracts.push({
        id: `${requirementId}-${kind}-${left}-${right}`,
        between: [left, right],
        owner: ownerFor(left, right),
        kind,
        spec: specFor(left, right, kind, ownership, outcome),
      });
    }
  }
  return contracts;
}

function kindFor(left: Repo, right: Repo): ContractKind {
  const pair = new Set([left, right]);
  if (pair.has("ai-core") && pair.has("evals-obs")) return "event";
  if (pair.has("frontend") && pair.has("ai-core")) return "api";
  return "schema";
}

/** ai-core publishes the assistant API and the trace event. Otherwise evals-obs owns the schema. */
function ownerFor(left: Repo, right: Repo): Repo {
  const pair = new Set([left, right]);
  if (pair.has("ai-core")) return "ai-core";
  return "evals-obs";
}

function specFor(
  left: Repo,
  right: Repo,
  kind: ContractKind,
  ownership: OwnershipMap[],
  outcome: string,
): string {
  const expose = (repo: Repo) => ownership.find((map) => map.repo === repo)?.exposes[0] ?? repo;
  const outcomeLine = oneLine(outcome);
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

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
