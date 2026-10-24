import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plan, Task } from "../src/schemas.js";
import { validatePlan, type PlanIssueCode } from "../src/validate.js";

function task(overrides: Partial<Task> & Pick<Task, "id" | "repo">): Task {
  return {
    workflow: "feature",
    dependsOn: [],
    contractRefs: [],
    acceptance: ["The habit shows up once."],
    ...overrides,
  };
}

function seamPlan(): Plan {
  return {
    requirementId: "EX-1",
    acceptance: ["A person can read the weekly reflection."],
    contracts: [
      {
        id: "c-api",
        between: ["frontend", "ai-core"],
        kind: "api",
        spec: "Example API seam for the fictional Pebble product.",
      },
    ],
    tasks: [
      task({
        id: "t-fe",
        repo: "frontend",
        dependsOn: ["c-api"],
        contractRefs: ["c-api"],
      }),
      task({
        id: "t-ai",
        repo: "ai-core",
        dependsOn: ["c-api"],
        contractRefs: ["c-api"],
      }),
    ],
  };
}

function codes(plan: Plan): PlanIssueCode[] {
  return validatePlan(plan).map((issue) => issue.code);
}

describe("validatePlan", () => {
  it("accepts a cross-repo plan whose tasks depend on the contract, not on each other", () => {
    assert.deepEqual(validatePlan(seamPlan()), []);
  });

  it("accepts a single-repo plan with no contracts", () => {
    const plan: Plan = {
      requirementId: "EX-2",
      acceptance: ["The habit list shows each habit once."],
      contracts: [],
      tasks: [task({ id: "t-fe", repo: "frontend", workflow: "bug" })],
    };
    assert.deepEqual(validatePlan(plan), []);
  });

  it("rejects a dangling dependsOn", () => {
    const plan = seamPlan();
    plan.tasks[0]?.dependsOn.push("missing-task");
    assert.deepEqual(codes(plan), ["dangling-dependency"]);
  });

  it("rejects a dangling contractRefs entry", () => {
    const plan: Plan = {
      requirementId: "EX-3",
      acceptance: ["The habit list shows each habit once."],
      contracts: [],
      tasks: [task({ id: "t-fe", repo: "frontend", contractRefs: ["missing-contract"] })],
    };
    assert.deepEqual(codes(plan), ["dangling-contract-ref"]);
  });

  it("rejects dependency cycles", () => {
    const mutual: Plan = {
      requirementId: "EX-4",
      acceptance: ["The habit list shows each habit once."],
      contracts: [],
      tasks: [
        task({ id: "a", repo: "frontend", dependsOn: ["b"] }),
        task({ id: "b", repo: "frontend", dependsOn: ["a"] }),
      ],
    };
    assert.deepEqual(codes(mutual), ["dependency-cycle"]);

    const self: Plan = {
      requirementId: "EX-4",
      acceptance: ["The habit list shows each habit once."],
      contracts: [],
      tasks: [task({ id: "a", repo: "frontend", dependsOn: ["a"] })],
    };
    assert.deepEqual(codes(self), ["dependency-cycle"]);
  });

  it("rejects a contract whose repos have no task referencing it", () => {
    const plan = seamPlan();
    for (const task of plan.tasks) {
      task.contractRefs = [];
      task.dependsOn = [];
    }
    const issues = validatePlan(plan);
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["unreferenced-contract"],
    );
    assert.match(issues[0]?.message ?? "", /frontend/);
    assert.match(issues[0]?.message ?? "", /ai-core/);
  });

  it("rejects a task that crosses into another repo without a contract", () => {
    const coupled: Plan = {
      requirementId: "EX-5",
      acceptance: ["A person can read the weekly reflection."],
      contracts: [],
      tasks: [
        task({ id: "t-fe", repo: "frontend", dependsOn: ["t-ai"] }),
        task({ id: "t-ai", repo: "ai-core" }),
      ],
    };
    assert.deepEqual(codes(coupled), ["cross-repo-without-contract"]);

    const foreignRef: Plan = {
      requirementId: "EX-5",
      acceptance: ["A person can read the weekly reflection."],
      contracts: [
        {
          id: "c-event",
          between: ["ai-core", "evals-obs"],
          kind: "event",
          spec: "Example event seam for the fictional Pebble product.",
        },
      ],
      tasks: [
        task({
          id: "t-fe",
          repo: "frontend",
          dependsOn: ["c-event"],
          contractRefs: ["c-event"],
        }),
        task({
          id: "t-ai",
          repo: "ai-core",
          dependsOn: ["c-event"],
          contractRefs: ["c-event"],
        }),
        task({
          id: "t-ev",
          repo: "evals-obs",
          dependsOn: ["c-event"],
          contractRefs: ["c-event"],
        }),
      ],
    };
    assert.deepEqual(codes(foreignRef), ["cross-repo-without-contract"]);
  });

  it("rejects a single-repo plan that still declares a cross-repo contract", () => {
    const plan: Plan = {
      requirementId: "EX-6",
      acceptance: ["The habit list shows each habit once."],
      contracts: [
        {
          id: "c-api",
          between: ["frontend", "ai-core"],
          kind: "api",
          spec: "Example API seam for the fictional Pebble product.",
        },
      ],
      tasks: [
        task({
          id: "t-fe",
          repo: "frontend",
          workflow: "bug",
          dependsOn: ["c-api"],
          contractRefs: ["c-api"],
        }),
      ],
    };
    assert.deepEqual(codes(plan).sort(), ["single-repo-with-contracts", "unreferenced-contract"]);
  });

  it("rejects duplicate task and contract ids", () => {
    const plan: Plan = {
      requirementId: "EX-7",
      acceptance: ["The habit list shows each habit once."],
      contracts: [],
      tasks: [
        task({ id: "same", repo: "frontend" }),
        task({ id: "same", repo: "frontend" }),
      ],
    };
    assert.deepEqual(codes(plan), ["duplicate-id"]);
  });
});
