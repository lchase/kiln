import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contractPublishers,
  plan,
  taskPhase,
  type Observation,
  type ObservedRun,
  type ObservedTask,
} from "../src/reconcile.js";
import type { Plan, Repo } from "../src/schemas.js";

const PLAN_ID = "PEBBLE-WEEKLY";

function run(status: ObservedRun["status"], runId = "2026-10-24T00-00-00Z-aaaa"): ObservedRun {
  return { runId, checkout: "/tmp/checkout", status, gates: [] };
}

function task(overrides: Partial<ObservedTask> & Pick<ObservedTask, "taskId" | "repo">): ObservedTask {
  return {
    planId: PLAN_ID,
    dependsOn: [],
    approved: true,
    launching: false,
    launchFailed: false,
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    maxConcurrent: 2,
    plans: [{ planId: PLAN_ID, approved: true }],
    tasks: [],
    publishers: {},
    breadcrumbsToClear: [],
    ...overrides,
  };
}

describe("plan", () => {
  it("does not launch an unapproved task", () => {
    const obs = observation({
      plans: [{ planId: PLAN_ID, approved: false }],
      tasks: [task({ taskId: "publish", repo: "ai-core", approved: false })],
    });
    assert.deepEqual(plan(obs), []);
    assert.equal(taskPhase(obs.tasks[0]!, obs), "unapproved");
  });

  it("launches the contract publisher first and the dependent only after that run is ok", () => {
    const publisher = task({ taskId: "publish-reflection-api", repo: "ai-core" });
    const dependent = task({
      taskId: "render-reflection",
      repo: "frontend",
      dependsOn: ["weekly-reflection-api"],
    });
    const obs = observation({
      tasks: [publisher, dependent],
      publishers: { [`${PLAN_ID}/weekly-reflection-api`]: "publish-reflection-api" },
    });

    assert.deepEqual(plan(obs), [
      { type: "launch", planId: PLAN_ID, taskId: "publish-reflection-api", repo: "ai-core" },
    ]);

    publisher.run = run("suspended");
    assert.deepEqual(plan(obs), []);
    assert.equal(taskPhase(dependent, obs), "blocked");

    publisher.run = run("failed");
    assert.deepEqual(plan(obs), []);

    publisher.run = run("ok");
    publisher.run.gateDecision = "reject";
    assert.equal(taskPhase(publisher, obs), "rejected");
    assert.deepEqual(plan(obs), []);
    assert.equal(taskPhase(dependent, obs), "blocked");

    publisher.run = run("ok");
    assert.equal(taskPhase(publisher, obs), "ok-undecided");
    assert.equal(taskPhase(dependent, obs), "blocked");
    assert.deepEqual(plan(obs), []);

    publisher.run.gateDecision = "approve";
    assert.equal(taskPhase(publisher, obs), "ok");
    assert.deepEqual(plan(obs), [
      { type: "launch", planId: PLAN_ID, taskId: "render-reflection", repo: "frontend" },
    ]);

    dependent.run = run("alive", "2026-10-24T00-00-01Z-bbbb");
    assert.deepEqual(plan(obs), []);
  });

  it("treats a task id dependency as met only when that task finished ok", () => {
    const first = task({ taskId: "publish", repo: "frontend" });
    const second = task({ taskId: "follow", repo: "frontend", dependsOn: ["publish"] });
    const obs = observation({ tasks: [first, second] });
    const firstAction = plan(obs)[0];
    assert.equal(firstAction?.type, "launch");
    if (firstAction?.type === "launch") assert.equal(firstAction.taskId, "publish");
    first.run = run("ok");
    assert.equal(taskPhase(second, obs), "blocked");
    first.run.gateDecision = "approve";
    const follow = plan(obs)[0];
    assert.equal(follow?.type, "launch");
    if (follow?.type === "launch") assert.equal(follow.taskId, "follow");
  });

  it("launches nothing when the ready task already has a run", () => {
    const obs = observation({
      tasks: [task({ taskId: "publish", repo: "ai-core", run: run("ok") })],
    });
    assert.deepEqual(plan(obs), []);
  });

  it("respects maxConcurrent and still launches at most one task per tick", () => {
    const tasks = ["calm-empty", "sunday-heading", "week-label"].map((taskId) =>
      task({ taskId, repo: "frontend" as Repo }),
    );
    const blocked = observation({ maxConcurrent: 1, tasks });
    assert.deepEqual(
      plan(blocked).filter((action) => action.type === "launch"),
      [{ type: "launch", planId: PLAN_ID, taskId: "calm-empty", repo: "frontend" }],
    );

    tasks[0]!.run = run("suspended");
    assert.deepEqual(plan(blocked), []);

    const open = observation({ maxConcurrent: 2, tasks });
    const secondLaunch = plan(open).find((action) => action.type === "launch");
    assert.equal(secondLaunch?.type, "launch");
    if (secondLaunch?.type === "launch") assert.equal(secondLaunch.taskId, "sunday-heading");

    const wide = observation({
      maxConcurrent: 5,
      tasks: tasks.map((item) => ({ ...item, run: undefined })),
    });
    const launches = plan(wide).filter((action) => action.type === "launch");
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.type, "launch");
    if (launches[0]?.type === "launch") assert.equal(launches[0].taskId, "calm-empty");
  });

  it("counts a launching breadcrumb as in flight and clears one once a run exists", () => {
    const obs = observation({
      maxConcurrent: 1,
      tasks: [
        task({ taskId: "publish", repo: "ai-core", launching: true }),
        task({ taskId: "other", repo: "frontend" }),
      ],
    });
    assert.deepEqual(plan(obs), []);

    obs.tasks[0]!.launching = false;
    obs.tasks[0]!.run = run("alive");
    obs.breadcrumbsToClear = [{ path: "/kiln/launching/publish.json" }];
    assert.deepEqual(plan(obs), [{ type: "clear-breadcrumb", path: "/kiln/launching/publish.json" }]);
  });

  it("does not relaunch a launch-failed task and does not let it take a slot", () => {
    const failed = task({ taskId: "calm-empty", repo: "frontend", launchFailed: true, logPath: "/kiln/logs/calm-empty.log" });
    const next = task({ taskId: "sunday-heading", repo: "frontend" });
    const obs = observation({ maxConcurrent: 1, tasks: [failed, next] });
    assert.equal(taskPhase(failed, obs), "launch-failed");
    assert.deepEqual(plan(obs), [
      { type: "launch", planId: PLAN_ID, taskId: "sunday-heading", repo: "frontend" },
    ]);
  });

  it("does not let an ok run with no gate decision unblock its dependent", () => {
    const publisher = task({ taskId: "publish", repo: "frontend", run: run("ok") });
    const dependent = task({ taskId: "follow", repo: "frontend", dependsOn: ["publish"] });
    const obs = observation({ tasks: [publisher, dependent] });
    assert.equal(publisher.run?.gateDecision, undefined);
    assert.equal(taskPhase(publisher, obs), "ok-undecided");
    assert.equal(taskPhase(dependent, obs), "blocked");
    assert.deepEqual(plan(obs), []);
  });

  it("does not let a dead run take a slot or satisfy a dependency", () => {
    const dead = task({ taskId: "publish", repo: "frontend", run: run("dead") });
    const next = task({ taskId: "follow", repo: "frontend", dependsOn: ["publish"] });
    const obs = observation({ maxConcurrent: 1, tasks: [dead, next] });
    assert.equal(taskPhase(dead, obs), "dead");
    assert.equal(taskPhase(next, obs), "blocked");

    const independent = task({ taskId: "sunday-heading", repo: "frontend" });
    const open = observation({ maxConcurrent: 1, tasks: [dead, independent] });
    assert.deepEqual(plan(open), [
      { type: "launch", planId: PLAN_ID, taskId: "sunday-heading", repo: "frontend" },
    ]);
  });
});

describe("contractPublishers", () => {
  it("maps a contract to the owner task that does not depend on it", () => {
    const planFile: Plan = {
      requirementId: PLAN_ID,
      contracts: [
        {
          id: "weekly-reflection-api",
          between: ["frontend", "ai-core"],
          owner: "ai-core",
          kind: "api",
          spec: "GET /v1/reflection",
        },
      ],
      tasks: [
        {
          id: "publish-reflection-api",
          repo: "ai-core",
          title: "Publish",
          description: "Publish the endpoint.",
          workflow: "feature",
          dependsOn: [],
          acceptance: ["The endpoint returns a paragraph."],
        },
        {
          id: "render-reflection",
          repo: "frontend",
          title: "Render",
          description: "Render the paragraph.",
          workflow: "feature",
          dependsOn: ["weekly-reflection-api"],
          acceptance: ["Sunday shows the paragraph."],
        },
      ],
    };
    assert.deepEqual(contractPublishers(PLAN_ID, planFile), {
      [`${PLAN_ID}/weekly-reflection-api`]: "publish-reflection-api",
    });
  });
});
