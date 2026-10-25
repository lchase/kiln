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

  it("opens a pull request for a landed deliver=pr job and stacks before that pull request merges", () => {
    const upstream = job({
      jobId: "publish",
      repo: "web",
      deliver: "pr",
      run: run("ok"),
    });
    upstream.run!.gateDecision = "approve";
    const stacked = job({
      jobId: "stack",
      repo: "web",
      deliver: "pr",
      stack: true,
      dependsOn: ["publish"],
    });
    const afterMerged = job({
      jobId: "after",
      repo: "web",
      deliver: "pr",
      dependsOn: ["publish"],
    });
    const pending = observation({ jobs: [upstream, stacked, afterMerged] });
    assert.equal(jobState(upstream, pending), "in-review");
    assert.equal(jobState(stacked, pending), "queued");
    assert.equal(jobState(afterMerged, pending), "blocked");
    assert.deepEqual(
      decide(pending).filter((action) => action.type === "deliver"),
      [{ type: "deliver", jobId: "publish", repo: "web" }],
    );

    upstream.delivery = {
      merged: false,
      prNumber: 7,
      prUrl: "https://github.com/example/repo/pull/7",
      prState: "OPEN",
    };
    const open = observation({ jobs: [upstream, stacked, afterMerged] });
    assert.equal(jobState(upstream, open), "in-review");
    assert.equal(jobState(afterMerged, open), "blocked");
    assert.deepEqual(decide(open), [{ type: "launch", jobId: "stack", repo: "web" }]);

    upstream.delivery = {
      merged: true,
      prNumber: 7,
      prUrl: "https://github.com/example/repo/pull/7",
      prState: "MERGED",
    };
    const merged = observation({ jobs: [upstream, stacked, afterMerged] });
    assert.equal(jobState(upstream, merged), "done");
    assert.equal(jobState(afterMerged, merged), "queued");
  });

  it("keeps deliver=local done on land and records a pull request failure without taking a slot", () => {
    const landed = job({ jobId: "publish", repo: "web", run: run("ok") });
    landed.run!.gateDecision = "approve";
    const next = job({ jobId: "follow", repo: "web", dependsOn: ["publish"] });
    const local = observation({ jobs: [landed, next] });
    assert.equal(jobState(landed, local), "done");
    assert.equal(jobState(next, local), "queued");
    assert.deepEqual(
      decide(local).filter((action) => action.type === "deliver"),
      [],
    );

    const broken = job({
      jobId: "publish",
      repo: "web",
      deliver: "pr",
      run: run("ok"),
      delivery: { merged: false, error: "gh is not installed" },
    });
    broken.run!.gateDecision = "approve";
    const other = job({ jobId: "other", repo: "web" });
    const failed = observation({ maxConcurrent: 1, jobs: [broken, other] });
    assert.equal(jobState(broken, failed), "failed");
    assert.deepEqual(decide(failed), [
      { type: "deliver", jobId: "publish", repo: "web" },
      { type: "launch", jobId: "other", repo: "web" },
    ]);
  });

  it("treats an approved investigation as done and does not open a pull request", () => {
    const upstream = job({
      jobId: "probe",
      repo: "web",
      workflow: "investigation",
      deliver: "pr",
      run: run("ok"),
    });
    upstream.run!.gateDecision = "approve";
    const follow = job({
      jobId: "follow",
      repo: "web",
      deliver: "pr",
      dependsOn: ["probe"],
    });
    const pending = observation({ jobs: [upstream, follow] });
    assert.equal(jobState(upstream, pending), "done");
    assert.equal(jobState(follow, pending), "queued");
    assert.deepEqual(decide(pending), [
      { type: "record-findings", jobId: "probe" },
      { type: "launch", jobId: "follow", repo: "web" },
    ]);

    upstream.findingsPath = "/tmp/kiln/findings/probe.md";
    const stored = observation({ jobs: [upstream, follow] });
    assert.deepEqual(decide(stored), [{ type: "launch", jobId: "follow", repo: "web" }]);

    upstream.findingsPath = undefined;
    upstream.run = run("ok");
    upstream.run.gateDecision = "reject";
    const rejected = observation({ jobs: [upstream, follow] });
    assert.equal(jobState(upstream, rejected), "rejected");
    assert.equal(jobState(follow, rejected), "blocked");
    assert.deepEqual(decide(rejected), []);
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
