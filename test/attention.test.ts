import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import {
  latestStepFailure,
  renderStatus,
  statusView,
  stepProgress,
  type StatusJobView,
  type StepEvent,
} from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";
import type { Observation, ObservedJob } from "../src/reconcile.js";
import { leafStepIds, workflowLeafSteps, workflowStepPlan } from "../src/workflow.js";

function job(overrides: Partial<StatusJobView> & Pick<StatusJobView, "jobId" | "state">): StatusJobView {
  return {
    title: overrides.title ?? overrides.jobId,
    repo: "web",
    workflow: "feature",
    dependsOn: [],
    stack: false,
    launchFailed: false,
    prPending: false,
    prClosedUnmerged: false,
    noReadableApproval: false,
    gates: [],
    canApprove: false,
    canReject: false,
    steps: [],
    ...overrides,
  };
}

describe("step progress", () => {
  it("marks done, current, and pending from yak events and ignores a loop container", () => {
    const steps = stepProgress(
      ["spec", "build", "verify", "approve"],
      [
        { t: "step.started", stepId: "spec" },
        { t: "step.completed", stepId: "spec" },
        { t: "step.started", stepId: "revise" },
        { t: "step.started", stepId: "build" },
        { t: "step.completed", stepId: "build" },
        { t: "step.started", stepId: "build" },
      ],
    );
    assert.deepEqual(steps, [
      { id: "spec", phase: "done" },
      { id: "build", phase: "current" },
      { id: "verify", phase: "pending" },
      { id: "approve", phase: "pending" },
    ]);
  });

  it("keeps a failed step failed until a later start", () => {
    const events: StepEvent[] = [
      { t: "step.started", stepId: "spec" },
      { t: "step.failed", stepId: "spec", detail: "builder exploded (command-failed)" },
    ];
    assert.equal(stepProgress(["spec"], events)[0]?.phase, "failed");
    assert.equal(latestStepFailure(events), "builder exploded (command-failed)");
    const restarted: StepEvent[] = [...events, { t: "step.started", stepId: "spec" }];
    assert.equal(stepProgress(["spec"], restarted)[0]?.phase, "current");
    assert.equal(latestStepFailure(restarted), undefined);
  });
});

describe("workflow leaf steps", () => {
  it("lists the feature and investigation steps a run actually starts", () => {
    const feature = workflowLeafSteps(readFileSync(join(packageRoot(), "workflows", "feature.yaml"), "utf8"));
    assert.deepEqual(feature, ["spec", "build", "verify", "security", "ux", "ui", "code", "approver", "approve", "land"]);
    assert.deepEqual(workflowStepPlan("investigation"), ["explore", "approve"]);
    assert.deepEqual(workflowStepPlan("../feature"), []);
    assert.deepEqual(
      leafStepIds([
        { id: "spec", kind: "agent" },
        { id: "revise", kind: "loop", body: [{ id: "build", kind: "agent" }, { id: "verify", kind: "command" }] },
        { id: "approve", kind: "gate" },
      ]),
      ["spec", "build", "verify", "approve"],
    );
  });
});

describe("attention view", () => {
  it("orders sections by what needs a person, then what is moving, then what finished", () => {
    const jobs = [
      job({ jobId: "queued", state: "queued", createdAt: "2026-10-26T00:00:00.000Z" }),
      job({ jobId: "done-old", state: "done", finishedAt: "2026-10-20T00:00:00.000Z" }),
      job({
        jobId: "human",
        state: "needs-human",
        canApprove: true,
        canReject: true,
        gates: [
          {
            stepId: "approve",
            prompt: "Approve the summary?",
            choices: ["approve", "reject"],
            artifacts: [],
            reviews: [],
          },
        ],
      }),
      job({
        jobId: "down",
        state: "blocked",
        dependsOn: [{ jobId: "review", state: "in-review", blockedDetail: "waiting for PR #3 to merge" }],
      }),
      job({
        jobId: "failed",
        state: "failed",
        launchError: "builder exploded",
        logTail: "verify: expected 1 received 0",
      }),
      job({
        jobId: "running",
        state: "running",
        startedAt: "2026-10-26T01:00:00.000Z",
        steps: [
          { id: "spec", phase: "done" },
          { id: "build", phase: "current" },
          { id: "verify", phase: "pending" },
        ],
      }),
      job({
        jobId: "review",
        state: "in-review",
        prNumber: 12,
        prUrl: "https://github.com/example/web/pull/12",
      }),
      job({ jobId: "dead", state: "dead", failureDetail: "process gone" }),
      job({ jobId: "approved", state: "approved" }),
      job({ jobId: "rejected", state: "rejected" }),
      job({ jobId: "done-new", state: "done", finishedAt: "2026-10-25T00:00:00.000Z", prUrl: "https://github.com/example/web/pull/9" }),
      job({ jobId: "invalid", state: "invalid", invalidReason: "Job state is derived and must not be stored." }),
      job({
        jobId: "stacked",
        state: "blocked",
        stack: true,
        dependsOn: [{ jobId: "running", state: "running", blockedDetail: "waiting for running to land" }],
      }),
      job({
        jobId: "orphan",
        state: "blocked",
        dependsOn: [{ jobId: "missing-job", state: "missing" }],
      }),
    ];

    const attention = buildAttention(jobs);
    assert.deepEqual(
      attention.needsYou.map((item) => item.job.jobId),
      ["human", "dead", "failed", "review", "invalid"],
    );
    assert.deepEqual(
      attention.inFlight.map((item) => item.job.jobId),
      ["running", "approved", "queued", "down", "stacked", "orphan"],
    );
    assert.deepEqual(
      attention.doneRecently.map((item) => item.job.jobId),
      ["done-new", "done-old", "rejected"],
    );
    assert.equal(attention.needsYouCount, 5);

    assert.equal(attention.needsYou[0]?.reason, "Gate: Approve the summary?");
    assert.equal(attention.needsYou[1]?.reason, "Run died before it finished");
    assert.equal(attention.needsYou[1]?.errorTail, "process gone");
    assert.equal(attention.needsYou[1]?.retry, true);
    assert.equal(attention.needsYou[2]?.reason, "Failed: builder exploded");
    assert.match(attention.needsYou[2]?.errorTail ?? "", /builder exploded/);
    assert.match(attention.needsYou[2]?.errorTail ?? "", /expected 1 received 0/);
    assert.equal(attention.needsYou[2]?.retry, true);
    assert.equal(attention.needsYou[3]?.reason, "Pull request #12 is open");
    assert.equal(attention.needsYou[3]?.retry, false);
    assert.match(attention.needsYou[4]?.reason ?? "", /Invalid: Job state is derived/);

    assert.equal(attention.inFlight[0]?.reason, "Running build");
    assert.equal(attention.inFlight[0]?.since, "2026-10-26T01:00:00.000Z");
    assert.equal(attention.inFlight[2]?.reason, "Queued, ready to launch");
    assert.equal(attention.inFlight[2]?.since, "2026-10-26T00:00:00.000Z");
    assert.equal(attention.inFlight[3]?.reason, "waiting for PR #3 to merge");
    assert.equal(attention.inFlight[4]?.reason, "waiting for running to land");
    assert.equal(attention.inFlight[5]?.reason, "Waiting on missing-job (missing)");
    assert.equal(attention.doneRecently[0]?.reason, "Merged");
    assert.equal(attention.doneRecently[2]?.reason, "Rejected");

    const edge = (from: string, to: string) => attention.graph.edges.find((item) => item.from === from && item.to === to);
    assert.equal(edge("review", "down")?.stack, false);
    assert.equal(edge("running", "stacked")?.stack, true);
    assert.equal(edge("missing-job", "orphan")?.stack, false);
    assert.equal(attention.graph.nodes.find((node) => node.jobId === "missing-job")?.state, "missing");
    assert.equal(attention.graph.nodes.find((node) => node.jobId === "running")?.state, "running");

    const again = buildAttention(jobs);
    assert.equal(again.revision, attention.revision);
    const changed = jobs.map((item) => (item.jobId === "queued" ? { ...item, state: "running" as const } : item));
    assert.notEqual(buildAttention(changed).revision, attention.revision);

    const html = renderConsole("/* kiln-serve */", attention);
    assert.match(html, /\(5\) Kiln/);
    assert.match(html, /class="edge stack"/);
    assert.match(html, /marker-end="url\(#arrow-stack\)"/);
    assert.match(html, /marker-end="url\(#arrow\)"/);
    assert.match(html, /<details class="done-recent">/);
    assert.doesNotMatch(html, /<details class="done-recent" open/);
  });

  it("derives a stacked wait and a step strip from the same status view the CLI prints", () => {
    const running = observed({
      jobId: "run-1",
      repo: "web",
      title: "Show the summary",
      createdAt: "2026-10-26T00:00:00.000Z",
      stepPlan: ["spec", "build", "verify"],
      run: {
        runId: "run-1",
        checkout: "/tmp/web",
        status: "alive",
        gates: [],
        startedAt: "2026-10-26T01:00:00.000Z",
        stepPlan: ["spec", "build", "verify"],
        stepEvents: [
          { t: "step.started", stepId: "spec" },
          { t: "step.completed", stepId: "spec" },
          { t: "step.started", stepId: "build" },
          { t: "step.failed", stepId: "build", detail: "builder exploded" },
        ],
      },
    });
    const blocked = observed({
      jobId: "down",
      repo: "api",
      title: "Wire the summary",
      dependsOn: ["run-1"],
      stack: true,
      stepPlan: ["spec", "build"],
    });
    const failed = observed({
      jobId: "boom",
      repo: "web",
      title: "Broken",
      launchFailed: true,
      launchError: "origin fetch failed",
      logTail: "origin fetch failed\nexit 1",
    });
    const view = statusView({ maxConcurrent: 2, jobs: [running, blocked, failed], breadcrumbsToClear: [] });
    assert.equal(view.jobs[0]?.state, "running");
    assert.deepEqual(
      view.jobs[0]?.steps.map((step) => [step.id, step.phase]),
      [
        ["spec", "done"],
        ["build", "failed"],
        ["verify", "pending"],
      ],
    );
    assert.equal(view.jobs[0]?.failureDetail, "builder exploded");
    assert.match(renderStatus(view), /run-1 {2}web {2}feature {2}running/);
    assert.doesNotMatch(renderStatus(view), /Running build/);

    const attention = buildAttention(view.jobs);
    assert.deepEqual(
      attention.needsYou.map((item) => item.job.jobId),
      ["boom"],
    );
    assert.equal(attention.needsYou[0]?.retry, true);
    assert.equal(attention.needsYou[0]?.reason, "Failed: origin fetch failed");
    assert.deepEqual(
      attention.inFlight.map((item) => item.job.jobId),
      ["run-1", "down"],
    );
    assert.equal(attention.inFlight[0]?.reason, "Running build");
    assert.equal(attention.inFlight[1]?.reason, "waiting for run-1 to land");
    assert.deepEqual(attention.graph.edges, [{ from: "run-1", to: "down", stack: true }]);
    assert.deepEqual(
      attention.inFlight[1]?.job.steps.map((step) => step.phase),
      ["pending", "pending"],
    );
  });

  it("puts investigation findings on the gate item and a feature diff on the job", () => {
    const probe = observed({
      jobId: "probe",
      repo: "web",
      workflow: "investigation",
      title: "Probe the facts",
      diffSummary: "should not show for an investigation",
      run: {
        runId: "run-p",
        checkout: "/tmp/web",
        status: "suspended",
        gates: [
          {
            stepId: "approve",
            prompt: 'Approve findings for "Probe the facts"?',
            rendered: 'Approve findings for "Probe the facts"?\n\n## Questions\n\nWhich runner?\n',
            choices: ["approve", "reject"],
          },
        ],
      },
    });
    const feature = observed({
      jobId: "feat",
      repo: "web",
      title: "Show the summary",
      diffSummary: " src/summary.ts | 4 ++++",
      run: {
        runId: "run-f",
        checkout: "/tmp/web",
        status: "suspended",
        gates: [
          {
            stepId: "approve",
            prompt: 'Approve "Show the summary"? Agent decision: APPROVE.',
            choices: ["approve", "reject"],
            reviews: [{ name: "security", summary: "PASS — No must-fix findings." }],
          },
        ],
      },
    });
    const attention = buildAttention(statusView(observation([probe, feature])).jobs);
    assert.equal(attention.needsYou[0]?.job.jobId, "probe");
    assert.match(attention.needsYou[0]?.findings ?? "", /## Questions/);
    assert.match(attention.needsYou[0]?.findings ?? "", /Which runner\?/);
    assert.equal(attention.needsYou[1]?.job.diffSummary, " src/summary.ts | 4 ++++");
    assert.equal(attention.needsYou[1]?.findings, undefined);
    const html = renderConsole("", attention);
    assert.match(html, /Which runner\?/);
    assert.match(html, /src\/summary\.ts/);
    assert.match(html, /No must-fix findings/);
    assert.match(html, /<h3>Diff<\/h3>/);
    assert.match(html, /<h3>Findings<\/h3>/);
  });
});

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
