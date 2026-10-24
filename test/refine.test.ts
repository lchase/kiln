import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { PlanValidationError, PlannerOutputError } from "../src/errors.js";
import { packageRoot } from "../src/paths.js";
import { parseRequirement } from "../src/parse-requirement.js";
import type { Planner } from "../src/planner.js";
import { FakePlanner } from "../src/planners/fake.js";
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

describe("refine", () => {
  const planner = new FakePlanner();

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

  it("returns a valid cross-repo plan with contracts ordered before the dependent tasks", async () => {
    const requirement = example("weekly-reflection.md");
    const config = exampleConfig();
    const plan = assertPlan(await refine(requirement, planner, { config }));
    const maps = config.ownership;

    assert.equal(plan.requirementId, "EX-202");
    assert.deepEqual(plan.acceptance, requirement.acceptanceCriteria);
    assert.equal(plan.contracts.length, 1);
    const contract = plan.contracts[0];
    assert.ok(contract);
    assert.equal(contract.kind, "api");
    assert.deepEqual(contract.between, ["frontend", "ai-core"]);
    for (const repo of contract.between) {
      const expose = maps.find((map) => map.repo === repo)?.exposes[0];
      assert.ok(expose);
      assert.match(contract.spec, new RegExp(expose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    assert.deepEqual(
      plan.tasks.map((task) => task.repo),
      ["frontend", "ai-core"],
    );
    const taskIds = new Set(plan.tasks.map((task) => task.id));
    for (const task of plan.tasks) {
      assert.equal(task.workflow, "feature");
      assert.deepEqual(task.contractRefs, [contract.id]);
      assert.equal(task.dependsOn[0], contract.id);
      for (const dep of task.dependsOn) {
        assert.equal(taskIds.has(dep), false);
      }
    }
    assert.deepEqual(validatePlan(plan), []);
    for (const map of maps) {
      assert.match(map.note ?? "", /PLACEHOLDER EXAMPLE/);
    }
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
    assert.deepEqual(task.contractRefs, []);
    assert.deepEqual(plan.acceptance, requirement.acceptanceCriteria);
    assert.deepEqual(validatePlan(plan), []);
  });

  it("connects three repos with two seams and no cross-repo task edges", async () => {
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
    };
    const plan = assertPlan(await refine(requirement, planner, { config: exampleConfig() }));
    assert.deepEqual(
      plan.contracts.map((contract) => [contract.kind, contract.between.join("/")]),
      [
        ["api", "frontend/ai-core"],
        ["event", "ai-core/evals-obs"],
      ],
    );
    const byRepo = new Map(plan.tasks.map((task) => [task.repo, task]));
    assert.deepEqual(byRepo.get("frontend")?.dependsOn, ["EX-204-api-frontend-ai-core"]);
    assert.deepEqual(byRepo.get("ai-core")?.dependsOn, [
      "EX-204-api-frontend-ai-core",
      "EX-204-event-ai-core-evals-obs",
    ]);
    assert.deepEqual(byRepo.get("evals-obs")?.dependsOn, ["EX-204-event-ai-core-evals-obs"]);
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
          acceptance: ["Opening the habit list after midnight shows each habit once."],
          contracts: [],
          tasks: [
            {
              id: "a",
              repo: "frontend",
              workflow: "bug",
              dependsOn: ["b"],
              contractRefs: [],
              acceptance: ["Opening the habit list after midnight shows each habit once."],
            },
            {
              id: "b",
              repo: "frontend",
              workflow: "bug",
              dependsOn: ["a"],
              contractRefs: [],
              acceptance: ["Opening the habit list after midnight shows each habit once."],
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
          acceptance: ["Opening the habit list after midnight shows each habit once."],
          contracts: [],
          tasks: [
            {
              id: "only",
              repo: "frontend",
              workflow: "bug",
              dependsOn: [],
              contractRefs: [],
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
