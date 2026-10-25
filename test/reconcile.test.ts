import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, jobState, type Observation, type ObservedJob, type ObservedRun } from "../src/reconcile.js";

function run(status: ObservedRun["status"], runId = "2026-10-24T00-00-00Z-aaaa"): ObservedRun {
  return { runId, checkout: "/tmp/checkout", status, gates: [] };
}

function job(overrides: Partial<ObservedJob> & Pick<ObservedJob, "jobId" | "repo">): ObservedJob {
  return {
    workflow: "feature",
    title: overrides.jobId,
    dependsOn: [],
    launching: false,
    launchFailed: false,
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    maxConcurrent: 2,
    jobs: [],
    breadcrumbsToClear: [],
    ...overrides,
  };
}

describe("decide", () => {
  it("keeps a dependent blocked until the upstream job is done", () => {
    const first = job({ jobId: "job-a", repo: "api" });
    const second = job({ jobId: "job-b", repo: "web", dependsOn: ["job-a"] });
    const obs = observation({ jobs: [first, second] });

    assert.equal(jobState(first, obs), "queued");
    assert.equal(jobState(second, obs), "blocked");
    assert.deepEqual(decide(obs), [{ type: "launch", jobId: "job-a", repo: "api" }]);

    first.run = run("suspended");
    first.run.gates = [{ stepId: "approve", prompt: "Approve?", choices: ["approve", "reject"] }];
    assert.equal(jobState(first, obs), "needs-human");
    assert.equal(jobState(second, obs), "blocked");
    assert.deepEqual(decide(obs), []);

    first.run = run("ok");
    first.run.gateDecision = "reject";
    assert.equal(jobState(first, obs), "rejected");
    assert.equal(jobState(second, obs), "blocked");
    assert.deepEqual(decide(obs), []);

    first.run = run("ok");
    assert.equal(jobState(first, obs), "failed");
    assert.equal(jobState(second, obs), "blocked");
    assert.deepEqual(decide(obs), []);

    first.run.gateDecision = "approve";
    assert.equal(jobState(first, obs), "done");
    assert.deepEqual(decide(obs), [{ type: "launch", jobId: "job-b", repo: "web" }]);
  });

  it("calls an in-flight approve 'approved' and does not unblock on it", () => {
    const first = job({ jobId: "job-a", repo: "api", run: run("alive") });
    first.run!.gateDecision = "approve";
    const second = job({ jobId: "job-b", repo: "web", dependsOn: ["job-a"] });
    const obs = observation({ jobs: [first, second] });
    assert.equal(jobState(first, obs), "approved");
    assert.equal(jobState(second, obs), "blocked");
    assert.deepEqual(decide(obs), []);
  });

  it("respects maxConcurrent and still launches at most one job per tick", () => {
    const jobs = ["calm-empty", "sunday-heading", "week-label"].map((jobId) => job({ jobId, repo: "web" }));
    const blocked = observation({ maxConcurrent: 1, jobs });
    assert.deepEqual(
      decide(blocked).filter((action) => action.type === "launch"),
      [{ type: "launch", jobId: "calm-empty", repo: "web" }],
    );

    jobs[0]!.run = run("suspended");
    assert.deepEqual(decide(blocked), []);

    const open = observation({ maxConcurrent: 2, jobs });
    const secondLaunch = decide(open).find((action) => action.type === "launch");
    assert.equal(secondLaunch?.type, "launch");
    if (secondLaunch?.type === "launch") assert.equal(secondLaunch.jobId, "sunday-heading");

    const wide = observation({
      maxConcurrent: 5,
      jobs: jobs.map((item) => ({ ...item, run: undefined })),
    });
    const launches = decide(wide).filter((action) => action.type === "launch");
    assert.equal(launches.length, 1);
  });

  it("counts a launching job as running and clears the breadcrumb once a run exists", () => {
    const obs = observation({
      maxConcurrent: 1,
      jobs: [
        job({ jobId: "publish", repo: "api", launching: true }),
        job({ jobId: "other", repo: "web" }),
      ],
    });
    assert.equal(jobState(obs.jobs[0]!, obs), "running");
    assert.deepEqual(decide(obs), []);

    obs.jobs[0]!.launching = false;
    obs.jobs[0]!.run = run("alive");
    obs.breadcrumbsToClear = [{ path: "/kiln/launching/publish.json" }];
    assert.deepEqual(decide(obs), [{ type: "clear-breadcrumb", path: "/kiln/launching/publish.json" }]);
  });

  it("does not relaunch a launch that died before a journal and does not let it take a slot", () => {
    const failed = job({
      jobId: "calm-empty",
      repo: "web",
      launchFailed: true,
      logPath: "/kiln/logs/calm-empty.log",
    });
    const next = job({ jobId: "sunday-heading", repo: "web" });
    const obs = observation({ maxConcurrent: 1, jobs: [failed, next] });
    assert.equal(jobState(failed, obs), "failed");
    assert.deepEqual(decide(obs), [{ type: "launch", jobId: "sunday-heading", repo: "web" }]);
  });

  it("does not let a dead run take a slot or satisfy a dependency", () => {
    const dead = job({ jobId: "publish", repo: "web", run: run("dead") });
    const next = job({ jobId: "follow", repo: "web", dependsOn: ["publish"] });
    const obs = observation({ maxConcurrent: 1, jobs: [dead, next] });
    assert.equal(jobState(dead, obs), "dead");
    assert.equal(jobState(next, obs), "blocked");

    const independent = job({ jobId: "sunday-heading", repo: "web" });
    const open = observation({ maxConcurrent: 1, jobs: [dead, independent] });
    assert.deepEqual(decide(open), [{ type: "launch", jobId: "sunday-heading", repo: "web" }]);
  });
});
