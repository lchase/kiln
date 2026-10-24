import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { PlanValidationError, PlannerOutputError } from "../src/errors.js";
import { packageRoot } from "../src/paths.js";
import { parseRequirement } from "../src/parse-requirement.js";
import type { Planner } from "../src/planner.js";
import { RulesPlanner } from "../src/planners/rules.js";
import { refine, type RefineResult } from "../src/refine.js";
import type { Plan, Requirement } from "../src/schemas.js";
import { validatePlan } from "../src/validate.js";

function exampleConfig(): LoadedKilnConfig {
  return loadKilnConfig(join(packageRoot(), "examples", "kiln.config.json"), {
    cwd: packageRoot(),
  });
}

function example(name: string): Requirement {
  const path = join(packageRoot(), "examples", "requirements", name);
  return parseRequirement(readFileSync(path, "utf8"), path);
}

function assertPlan(result: RefineResult): Plan {
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") throw new Error("expected a plan");
  return result.plan;
}

function assertEveryPairHasAContract(plan: Plan): void {
  const repos = [...new Set(plan.tasks.map((task) => task.repo))];
  for (let i = 0; i < repos.length; i += 1) {
    for (let j = i + 1; j < repos.length; j += 1) {
      const left = repos[i];
      const right = repos[j];
      const found = plan.contracts.some(
        (contract) =>
          contract.between.length === 2 &&
          contract.between.includes(left!) &&
          contract.between.includes(right!) &&
          contract.between[0] !== contract.between[1],
      );
      assert.equal(found, true, `missing contract for ${left} and ${right}`);
    }
  }
}

function assertOwnersPrecedeDependents(plan: Plan): void {
  for (const contract of plan.contracts) {
    assert.equal(contract.between.includes(contract.owner), true);
    const publishers = plan.tasks.filter(
      (task) => task.repo === contract.owner && !task.dependsOn.includes(contract.id),
    );
    assert.equal(publishers.length, 1);
    const publisher = publishers[0];
    assert.ok(publisher);
    for (const repo of contract.between) {
      if (repo === contract.owner) continue;
      const consumers = plan.tasks.filter((task) => task.repo === repo);
      assert.ok(consumers.length > 0);
      for (const consumer of consumers) {
        const waiting =
          consumer.dependsOn.includes(contract.id) || consumer.dependsOn.includes(publisher.id);
        assert.equal(waiting, true, `${consumer.id} does not wait on ${contract.id}`);
      }
    }
  }
}

describe("refine", () => {
  const planner = new RulesPlanner();

  it("returns questions for a thin Jira-style requirement and does not decompose it", async () => {
    let decomposed = false;
    const watching: Planner = {
      assessReadiness: (context) => planner.assessReadiness(context),
      async decompose(context) {
        decomposed = true;
        return planner.decompose(context);
      },
    };
    const requirement = example("thin-jira.md");
    const result = await refine(requirement, watching, { config: exampleConfig() });

    assert.equal(result.kind, "questions");
    if (result.kind !== "questions") return;
    assert.equal(result.readiness.ready, false);
    assert.deepEqual(result.readiness.missing, [
      "acceptance-criteria",
      "scope",
      "user-facing-outcome",
    ]);
    assert.equal(result.readiness.questions.length, 3);
    assert.match(result.readiness.questions.join("\n"), /Search is weird/);
    assert.equal(decomposed, false);
  });

  it("does not let a planner declare a requirement with no acceptance criteria ready", async () => {
    const requirement: Requirement = {
      id: "EX-THIN",
      source: "jira",
      title: "Search is weird",
      body: "Search feels off.",
      scope: "frontend",
      outcome: "A person can find a habit.",
    };
    const stub: Planner = {
      async assessReadiness() {
        return { ready: true, missing: [], questions: [] };
      },
      async decompose() {
        throw new Error("decompose should not run");
      },
    };
    const result = await refine(requirement, stub, { config: exampleConfig() });
    assert.equal(result.kind, "questions");
    if (result.kind !== "questions") return;
    assert.equal(result.readiness.ready, false);
    assert.deepEqual(result.readiness.missing, ["acceptance-criteria"]);
    assert.match(result.readiness.questions.join("\n"), /acceptance criteria/i);
  });

  it("keeps a planner's extra question after the structural checks pass", async () => {
    const requirement = example("duplicate-habit.md");
    const stub: Planner = {
      async assessReadiness() {
        return {
          ready: false,
          missing: ["scope"],
          questions: ["Does the empty state need a new illustration?"],
        };
      },
      async decompose() {
        throw new Error("decompose should not run");
      },
    };
    const result = await refine(requirement, stub, { config: exampleConfig() });
    assert.equal(result.kind, "questions");
    if (result.kind !== "questions") return;
    assert.deepEqual(result.readiness.missing, ["scope"]);
    assert.deepEqual(result.readiness.questions, ["Does the empty state need a new illustration?"]);
  });

  it("asks which repo when the scope text names none", async () => {
    const requirement: Requirement = {
      id: "EX-SCOPE",
      source: "markdown",
      title: "Polish the copy",
      body: [
        "## Outcome",
        "",
        "A person reads clearer copy.",
        "",
        "## Scope",
        "",
        "The habit screen copy.",
        "",
        "## Acceptance criteria",
        "",
        "- The home screen uses the new copy.",
      ].join("\n"),
      acceptanceCriteria: ["The home screen uses the new copy."],
      scope: "The habit screen copy.",
      outcome: "A person reads clearer copy.",
    };
    const result = await refine(requirement, planner, { config: exampleConfig() });
    assert.equal(result.kind, "questions");
    if (result.kind !== "questions") return;
    assert.ok(result.readiness.missing.includes("scope"));
  });

  it("returns a valid cross-repo plan whose owner task precedes dependents", async () => {
    const requirement = example("weekly-reflection.md");
    const plan = assertPlan(await refine(requirement, planner, { config: exampleConfig() }));
    const criteria = requirement.acceptanceCriteria ?? [];

    assert.equal(plan.requirementId, "EX-202");
    assert.equal("acceptance" in plan, false);
    assertEveryPairHasAContract(plan);
    assertOwnersPrecedeDependents(plan);
    assert.deepEqual(
      plan.tasks.map((task) => task.repo),
      ["frontend", "ai-core"],
    );
    assert.ok(plan.tasks.every((task) => task.workflow === "feature"));
    assert.equal(new Set(plan.tasks.map((task) => task.title)).size, plan.tasks.length);
    assert.equal(new Set(plan.tasks.map((task) => task.description)).size, plan.tasks.length);
    for (const task of plan.tasks) {
      assert.ok(task.title.length > 0);
      assert.ok(task.description.length > 0);
      assert.notDeepEqual(task.acceptance, criteria);
    }
    const named = criteria.find((item) => /\bai-core\b/.test(item));
    assert.ok(named);
    assert.equal(plan.tasks.find((task) => task.repo === "frontend")?.acceptance.includes(named), false);
    assert.equal(plan.tasks.find((task) => task.repo === "ai-core")?.acceptance.includes(named), true);
    assert.deepEqual(validatePlan(plan), []);
  });

  it("returns a single-repo bug plan with no contracts", async () => {
    const requirement = example("duplicate-habit.md");
    const plan = assertPlan(await refine(requirement, planner, { config: exampleConfig() }));

    assert.equal(plan.requirementId, "EX-203");
    assert.deepEqual(plan.contracts, []);
    assert.equal(plan.tasks.length, 1);
    const task = plan.tasks[0];
    assert.ok(task);
    assert.equal(task.repo, "frontend");
    assert.equal(task.workflow, "bug");
    assert.deepEqual(task.dependsOn, []);
    assert.ok(task.title.length > 0);
    assert.ok(task.description.length > 0);
    assert.deepEqual(task.acceptance, requirement.acceptanceCriteria);
    assert.deepEqual(validatePlan(plan), []);
  });

  it("covers every pair when three repos are in scope", async () => {
    const requirement: Requirement = {
      id: "EX-204",
      source: "markdown",
      title: "Score the weekly reflection",
      body: [
        "## Outcome",
        "",
        "A person can see a score next to last week's reflection.",
        "",
        "## Scope",
        "",
        "- frontend shows the score next to the reflection.",
        "- ai-core returns a trace id with the reflection.",
        "- evals-obs stores the trace and produces the score.",
        "",
        "## Workflow",
        "",
        "feature",
      ].join("\n"),
      acceptanceCriteria: ["The reflection shows a score that came from the eval store."],
      scope: [
        "- frontend shows the score next to the reflection.",
        "- ai-core returns a trace id with the reflection.",
        "- evals-obs stores the trace and produces the score.",
      ].join("\n"),
      outcome: "A person can see a score next to last week's reflection.",
    };
    const plan = assertPlan(await refine(requirement, planner, { config: exampleConfig() }));
    assert.equal(plan.tasks.length, 3);
    assert.equal(plan.contracts.length, 3);
    assertEveryPairHasAContract(plan);
    assertOwnersPrecedeDependents(plan);
    assert.ok(plan.tasks.every((task) => task.workflow === "feature"));
    assert.equal(new Set(plan.tasks.map((task) => task.title)).size, 3);
    for (const task of plan.tasks) {
      assert.ok(task.acceptance.length > 0);
    }
    assert.deepEqual(validatePlan(plan), []);
  });

  it("does not return a plan the validator rejects", async () => {
    const requirement = example("duplicate-habit.md");
    const broken: Planner = {
      async assessReadiness() {
        return { ready: true, missing: [], questions: [] };
      },
      async decompose() {
        return {
          requirementId: requirement.id,
          contracts: [],
          tasks: [
            {
              id: "a",
              repo: "frontend",
              title: "Group the list",
              description: "Fix the day boundary in the habit list.",
              workflow: "bug",
              dependsOn: ["b"],
              acceptance: ["Opening the habit list after midnight shows each habit once."],
            },
            {
              id: "b",
              repo: "frontend",
              title: "Keep yesterday",
              description: "Leave yesterday's habits on yesterday.",
              workflow: "bug",
              dependsOn: ["a"],
              acceptance: ["A habit completed yesterday still appears on yesterday."],
            },
          ],
        };
      },
    };
    await assert.rejects(
      () => refine(requirement, broken, { config: exampleConfig() }),
      (error: unknown) => {
        assert.ok(error instanceof PlanValidationError);
        assert.ok(error.issues.some((issue) => issue.code === "dependency-cycle"));
        return true;
      },
    );
  });

  it("rejects a plan for a different requirement", async () => {
    const requirement = example("duplicate-habit.md");
    const confused: Planner = {
      async assessReadiness() {
        return { ready: true, missing: [], questions: [] };
      },
      async decompose() {
        return {
          requirementId: "EX-OTHER",
          contracts: [],
          tasks: [
            {
              id: "only",
              repo: "frontend",
              title: "Show each habit once",
              description: "Fix the day-boundary grouping.",
              workflow: "bug",
              dependsOn: [],
              acceptance: ["Opening the habit list after midnight shows each habit once."],
            },
          ],
        };
      },
    };
    await assert.rejects(
      () => refine(requirement, confused, { config: exampleConfig() }),
      PlannerOutputError,
    );
  });
});
