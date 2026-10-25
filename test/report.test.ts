import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { Observation, ObservedJob, ObservedRun } from "../src/reconcile.js";
import { gateAnswerCommand, renderStatus, statusView, yakCliPath } from "../src/report.js";

describe("yakCliPath", () => {
  it("points at the installed @lchase/yak bin", () => {
    const bin = yakCliPath();
    assert.equal(existsSync(bin), true);
    let dir = dirname(bin);
    let pkg: { name?: string } | undefined;
    for (let i = 0; i < 5; i += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    assert.equal(pkg?.name, "@lchase/yak");
  });
});

function run(status: ObservedRun["status"], runId = "run-1"): ObservedRun {
  return { runId, checkout: "/tmp/checkout", status, gates: [] };
}

function observed(overrides: Partial<ObservedJob> & Pick<ObservedJob, "jobId" | "repo">): ObservedJob {
  return {
    workflow: "feature",
    title: overrides.title ?? overrides.jobId,
    dependsOn: [],
    launching: false,
    launchFailed: false,
    ...overrides,
  };
}

function observation(jobs: ObservedJob[]): Observation {
  return { maxConcurrent: 2, jobs, breadcrumbsToClear: [] };
}

describe("statusView", () => {
  it("returns the derived state kiln status prints, including approved", () => {
    const upstream = observed({
      jobId: "job-a",
      repo: "api",
      title: "Show the summary",
      run: run("alive"),
    });
    upstream.run!.gateDecision = "approve";
    const downstream = observed({
      jobId: "job-b",
      repo: "web",
      title: "Wire the summary",
      dependsOn: ["job-a"],
      stack: true,
    });
    const view = statusView(observation([upstream, downstream]));
    assert.equal(view.jobs[0]?.state, "approved");
    assert.equal(view.jobs[1]?.state, "blocked");
    assert.equal(view.jobs[1]?.stack, true);
    assert.equal(view.jobs[1]?.dependsOn[0]?.jobId, "job-a");
    assert.equal(view.jobs[1]?.dependsOn[0]?.state, "approved");
    assert.equal(view.jobs[1]?.dependsOn[0]?.blockedDetail, "waiting for job-a to land");

    const text = renderStatus(view);
    assert.match(text, /job-a {2}api {2}feature {2}approved {2}run run-1/);
    assert.match(text, /job-b {2}web {2}feature {2}blocked/);
    assert.match(text, /waiting for job-a to land/);
    assert.doesNotMatch(text, /Wire the summary/);
  });

  it("keeps launch errors, the log, and the pull request on the same view", () => {
    const failed = observed({
      jobId: "job-f",
      repo: "web",
      title: "Broken launch",
      launchFailed: true,
      launchError: "origin fetch failed",
      logPath: "/tmp/kiln/logs/job-f.log",
    });
    const review = observed({
      jobId: "job-r",
      repo: "web",
      title: "Open the summary",
      deliver: "pr",
      run: run("ok", "run-9"),
      delivery: {
        prNumber: 4,
        prUrl: "https://github.com/example/repo/pull/4",
        merged: false,
        prState: "OPEN",
      },
    });
    review.run!.gateDecision = "approve";
    const missing = observed({
      jobId: "job-m",
      repo: "web",
      title: "After a missing job",
      dependsOn: ["missing-job"],
    });
    const human = observed({
      jobId: "job-h",
      repo: "web",
      title: "Needs a person",
      run: run("suspended", "run-h"),
    });
    human.run!.gates = [
      {
        stepId: "approve",
        prompt: 'Approve "Needs a person"? Agent decision: APPROVE.',
        choices: ["approve", "reject"],
        artifacts: [{ name: "decision", summary: "APPROVE — Reviews passed." }],
        reviews: [{ name: "security", summary: "PASS — No must-fix findings." }],
      },
    ];

    const view = statusView(observation([failed, review, missing, human]));
    assert.equal(view.jobs[0]?.state, "failed");
    assert.equal(view.jobs[0]?.launchError, "origin fetch failed");
    assert.equal(view.jobs[0]?.logPath, "/tmp/kiln/logs/job-f.log");
    assert.equal(view.jobs[1]?.state, "in-review");
    assert.equal(view.jobs[1]?.prUrl, "https://github.com/example/repo/pull/4");
    assert.equal(view.jobs[1]?.branch, "yak/run-9");
    assert.equal(view.jobs[2]?.state, "blocked");
    assert.equal(view.jobs[2]?.dependsOn[0]?.blockedDetail, "blocked on missing job missing-job");
    assert.equal(view.jobs[3]?.state, "needs-human");
    assert.equal(view.jobs[3]?.canApprove, true);
    assert.equal(view.jobs[3]?.canReject, true);
    assert.equal(view.jobs[3]?.gates[0]?.reviews[0]?.summary, "PASS — No must-fix findings.");

    const text = renderStatus(view);
    assert.match(text, /job-f {2}web {2}feature {2}failed/);
    assert.match(text, /log \/tmp\/kiln\/logs\/job-f\.log/);
    assert.match(text, /origin fetch failed/);
    assert.match(text, /job-r {2}web {2}feature {2}in-review {2}run run-9 {2}branch yak\/run-9 {2}pr https:\/\/github.com\/example\/repo\/pull\/4/);
    assert.match(text, /blocked on missing job missing-job/);
    assert.match(text, /gate approve: Approve "Needs a person"\? Agent decision: APPROVE\./);
    assert.match(text, /approve: kiln approve job-h/);
    assert.match(text, /reject: kiln reject job-h/);
    assert.doesNotMatch(text, /No must-fix findings/);
  });
});

describe("gateAnswerCommand", () => {
  it("answers the gate with the resolved node and yak binaries", () => {
    const command = gateAnswerCommand(
      "/tmp/checkout",
      "run-1",
      { stepId: "approve", prompt: "Approve?", answerField: "decision", choices: ["approve", "reject"] },
      "approve",
      "Show the summary",
    );
    assert.match(command, new RegExp(yakCliPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(command, /\{"decision":"approve"\}/);
    assert.match(command, /KILN_TASK_TITLE=/);
    assert.doesNotMatch(command, /node_modules\/\.bin/);
  });
});
