import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plan, Task } from "../src/schemas.js";
import { validatePlan, type PlanIssueCode } from "../src/validate.js";

function task(overrides: Partial<Task> & Pick<Task, "id" | "repo">): Task {
  return {
    title: `${overrides.repo} work`,
    description: `Work that lands in ${overrides.repo}.`,
    workflow: "feature",
    dependsOn: [],
    acceptance: ["The habit shows up once."],
    ...overrides,
  };
}

function seamPlan(): Plan {
  return {
    requirementId: "EX-1",
    contracts: [
      {
        id: "c-api",
        between: ["frontend", "ai-core"],
        owner: "ai-core",
        kind: "api",
        spec: "Example API seam for the fictional Pebble product.",
      },
    ],
    tasks: [
      task({
        id: "t-fe",
        repo: "frontend",
        title: "Show the reflection",
        description: "Render the weekly reflection from the assistant API.",
        dependsOn: ["c-api"],
      }),
      task({
        id: "t-ai",
        repo: "ai-core",
        title: "Write the reflection",
        description: "Return the weekly reflection from the assistant API.",
      }),
    ],
  };
}

function codes(plan: Plan): PlanIssueCode[] {
  return validatePlan(plan).map((issue) => issue.code);
}

describe("validatePlan", () => {
  it("accepts a plan whose owner task publishes the contract and the other side waits", () => {
    assert.deepEqual(validatePlan(seamPlan()), []);
  });

  it("accepts a consumer that depends on the publisher task directly", () => {
    const plan = seamPlan();
    const frontend = plan.tasks.find((item) => item.repo === "frontend");
    assert.ok(frontend);
    frontend.dependsOn = ["t-ai"];
    assert.deepEqual(validatePlan(plan), []);
  });

  it("accepts a single-repo plan with no contracts", () => {
    const plan: Plan = {
      requirementId: "EX-2",
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

  it("rejects dependency cycles, including a cycle through a contract id", () => {
    const mutual: Plan = {
      requirementId: "EX-4",
      contracts: [],
      tasks: [
        task({ id: "a", repo: "frontend", dependsOn: ["b"] }),
        task({ id: "b", repo: "frontend", dependsOn: ["a"] }),
      ],
    };
    assert.deepEqual(codes(mutual), ["dependency-cycle"]);

    const self: Plan = {
      requirementId: "EX-4",
      contracts: [],
      tasks: [task({ id: "a", repo: "frontend", dependsOn: ["a"] })],
    };
    assert.deepEqual(codes(self), ["dependency-cycle"]);

    const throughContract = seamPlan();
    const publisher = throughContract.tasks.find((item) => item.repo === "ai-core");
    assert.ok(publisher);
    publisher.dependsOn = ["t-fe"];
    assert.ok(codes(throughContract).includes("dependency-cycle"));
  });

  it("rejects a contract the other repo does not wait on", () => {
    const plan = seamPlan();
    const frontend = plan.tasks.find((item) => item.repo === "frontend");
    assert.ok(frontend);
    frontend.dependsOn = [];
    const issues = validatePlan(plan);
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["unreferenced-contract"],
    );
    assert.match(issues[0]?.message ?? "", /frontend/);
  });

  it("rejects tasks in two repos when no contract joins that pair", () => {
    const plan: Plan = {
      requirementId: "EX-5",
      contracts: [],
      tasks: [
        task({ id: "t-fe", repo: "frontend" }),
        task({ id: "t-ai", repo: "ai-core" }),
      ],
    };
    assert.deepEqual(codes(plan), ["cross-repo-without-contract"]);
  });

  it("rejects a cross-repo task edge that is not the contract publisher", () => {
    const coupled: Plan = {
      requirementId: "EX-5",
      contracts: [],
      tasks: [
        task({ id: "t-fe", repo: "frontend", dependsOn: ["t-ai"] }),
        task({ id: "t-ai", repo: "ai-core" }),
      ],
    };
    assert.deepEqual(codes(coupled), ["cross-repo-without-contract", "cross-repo-without-contract"]);
  });

  it("rejects a dependency on a contract the task's repo is not a side of", () => {
    const plan: Plan = {
      requirementId: "EX-5",
      contracts: [
        {
          id: "c-api",
          between: ["frontend", "ai-core"],
          owner: "ai-core",
          kind: "api",
          spec: "Example API seam.",
        },
        {
          id: "c-event",
          between: ["ai-core", "evals-obs"],
          owner: "ai-core",
          kind: "event",
          spec: "Example event seam.",
        },
        {
          id: "c-schema",
          between: ["frontend", "evals-obs"],
          owner: "evals-obs",
          kind: "schema",
          spec: "Example schema seam.",
        },
      ],
      tasks: [
        task({ id: "t-fe", repo: "frontend", dependsOn: ["c-api", "c-schema", "c-event"] }),
        task({ id: "t-ai", repo: "ai-core" }),
        task({ id: "t-ev", repo: "evals-obs", dependsOn: ["c-event"] }),
      ],
    };
    assert.deepEqual(codes(plan), ["foreign-contract"]);
  });

  it("rejects an owner that is not one of the contract's repos", () => {
    const plan = seamPlan();
    const contract = plan.contracts[0];
    assert.ok(contract);
    contract.owner = "evals-obs";
    assert.deepEqual(codes(plan), ["invalid-contract-owner"]);
  });

  it("rejects a contract with no single publishing task", () => {
    const plan = seamPlan();
    plan.tasks.push(task({ id: "t-ai-2", repo: "ai-core", title: "Also core", description: "A second core task." }));
    assert.deepEqual(codes(plan), ["invalid-contract-owner"]);
  });

  it("rejects a single-repo plan that still declares a contract, and only that", () => {
    const plan: Plan = {
      requirementId: "EX-6",
      contracts: [
        {
          id: "c-api",
          between: ["frontend", "ai-core"],
          owner: "frontend",
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
        }),
      ],
    };
    assert.deepEqual(codes(plan), ["single-repo-with-contracts"]);
  });

  it("rejects duplicate task and contract ids", () => {
    const plan: Plan = {
      requirementId: "EX-7",
      contracts: [],
      tasks: [
        task({ id: "same", repo: "frontend" }),
        task({ id: "same", repo: "frontend" }),
      ],
    };
    assert.deepEqual(codes(plan), ["duplicate-id"]);
  });
});
