import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ActivityFeed } from "../src/activity.js";
import { buildAttention } from "../src/attention.js";
import { buildBoard, jobDetail } from "../src/board-view.js";
import type { KilnEvent } from "../src/events.js";
import { formatStepUsage, projectJob } from "../src/job-view.js";
import { packageRoot } from "../src/paths.js";
import type { Observation, ObservedJob } from "../src/reconcile.js";
import { renderStatus, statusView, type StatusJobView } from "../src/report.js";
import { renderApp, type StepPage } from "../src/serve-page.js";
import { readStepUsage, stepUsageReads, type StepUsage } from "../src/step-usage.js";

const FIXTURES = join(packageRoot(), "test", "fixtures", "usage");
const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const WORKFLOW = {
  name: "kiln-feature",
  version: "1",
  steps: [
    { id: "spec", kind: "agent", model: "opus", produces: "spec" },
    {
      id: "revise",
      kind: "loop",
      produces: "rounds",
      body: [
        { id: "build", kind: "agent", model: "opus", produces: "build" },
        { id: "verify", kind: "command", produces: "verify" },
        { id: "security", kind: "agent", model: "opus", produces: "security" },
        { id: "ux", kind: "agent", model: "sonnet", produces: "ux" },
        { id: "ui", kind: "agent", model: "sonnet", produces: "ui" },
        { id: "code", kind: "agent", model: "sonnet", produces: "code" },
      ],
    },
    { id: "approver", kind: "agent", model: "opus", produces: "decision" },
    { id: "approve", kind: "gate", produces: "approval" },
    { id: "land", kind: "command" },
  ],
};

const PLAN = ["spec", "build", "verify", "security", "ux", "ui", "code", "approver", "approve", "land"];

/** `workflow.json` and the named fixtures copied into `sessions/`. */
function fillRun(dir: string, sessions: readonly string[]): string {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "workflow.json"), JSON.stringify(WORKFLOW));
  for (const name of sessions) copyFileSync(join(FIXTURES, `${name}.jsonl`), join(dir, "sessions", `${name}.jsonl`));
  return dir;
}

function runDir(sessions: readonly string[]): string {
  const base = mkdtempSync(join(tmpdir(), "kiln-usage-"));
  dirs.push(base);
  return fillRun(join(base, "run"), sessions);
}

/** Everything through `approver` has run. */
function finishedPlan(): { id: string; phase: string }[] {
  return PLAN.map((id) => ({ id, phase: id === "approve" || id === "land" ? "pending" : "done" }));
}

function byId(usage: readonly StepUsage[]): Map<string, StepUsage> {
  return new Map(usage.map((step) => [step.stepId, step]));
}

const ALL = ["spec", "build", "security", "ux", "code", "approver"];

describe("readStepUsage", () => {
  it("reads the exact model from each session and falls back to the workflow family", () => {
    const usage = byId(readStepUsage(runDir(ALL), finishedPlan()));
    assert.equal(usage.get("spec")?.model, "claude-opus-5-5");
    assert.equal(usage.get("spec")?.modelSource, "session");
    assert.equal(usage.get("ux")?.model, "claude-sonnet-4-6");
    assert.equal(usage.get("ux")?.modelSource, "session");
    // No assistant line: the configured family.
    assert.equal(usage.get("security")?.model, "opus");
    assert.equal(usage.get("security")?.modelSource, "workflow");
    // An agent step that ran but wrote no session yet.
    assert.deepEqual(usage.get("ui"), { stepId: "ui", model: "sonnet", modelSource: "workflow", rounds: [] });
    // Command and gate steps have no session and no entry.
    for (const id of ["verify", "approve", "land"]) assert.equal(usage.has(id), false, id);
    assert.deepEqual([...usage.keys()], ["spec", "build", "security", "ux", "ui", "code", "approver"]);
  });

  it("sets cost and tokens only when the session reports them, and sums rounds", () => {
    const usage = byId(readStepUsage(runDir(ALL), finishedPlan()));
    assert.deepEqual(usage.get("spec"), {
      stepId: "spec",
      model: "claude-opus-5-5",
      modelSource: "session",
      rounds: [{ usd: 0.42, tokens: 1500 }],
      usd: 0.42,
      tokens: 1500,
    });
    const code = usage.get("code");
    assert.deepEqual(code?.rounds, [{}]);
    assert.equal(code?.usd, undefined);
    assert.equal(code?.tokens, undefined);
    assert.equal("usd" in (code ?? {}), false);

    const build = usage.get("build");
    assert.equal(build?.rounds.length, 2);
    assert.deepEqual(build?.rounds, [{ usd: 0.4, tokens: 1000 }, { usd: 0.25, tokens: 600 }]);
    assert.ok(Math.abs((build?.usd ?? 0) - 0.65) < 1e-9);
    assert.equal(build?.tokens, 1600);
  });

  it("skips step ids that are not safe file names", () => {
    const dir = runDir(["spec"]);
    assert.deepEqual(readStepUsage(dir, [{ id: "../run/sessions/spec", phase: "done" }]), []);
    assert.deepEqual(readStepUsage(undefined, finishedPlan()), []);
  });

  it("never surfaces a secret-shaped model and falls back to the workflow family", () => {
    const usage = readStepUsage(runDir(["approver"]), finishedPlan());
    const approver = byId(usage).get("approver");
    assert.equal(approver?.model, "opus");
    assert.equal(approver?.modelSource, "workflow");
    assert.equal(approver?.usd, 0.05);
    assert.doesNotMatch(JSON.stringify(usage), /ghp_/);
  });

  it("drops a model that does not look like a model id", () => {
    const dir = runDir([]);
    writeFileSync(
      join(dir, "sessions", "spec.jsonl"),
      `${JSON.stringify({ type: "assistant", message: { model: "<b>opus</b>", content: [] } })}\n` +
        `${JSON.stringify({ type: "assistant", message: { model: "x".repeat(101), content: [] } })}\n`,
    );
    const spec = byId(readStepUsage(dir, finishedPlan())).get("spec");
    assert.equal(spec?.model, "opus");
    assert.equal(spec?.modelSource, "workflow");
  });

  it("does not read an unchanged session again, and reads only appended bytes after it grows", () => {
    const dir = runDir(["spec"]);
    const plan = [{ id: "spec", phase: "done" }];
    const first = stepUsageReads();
    readStepUsage(dir, plan);
    const second = stepUsageReads();
    assert.ok(second.reads > first.reads, "the first poll reads the file");
    readStepUsage(dir, plan);
    readStepUsage(dir, plan);
    assert.deepEqual(stepUsageReads(), second, "an unchanged file is not read again");

    const line = `${JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 5 } })}\n`;
    appendFileSync(join(dir, "sessions", "spec.jsonl"), line);
    const grown = byId(readStepUsage(dir, plan)).get("spec");
    const third = stepUsageReads();
    assert.equal(third.bytes - second.bytes, Buffer.byteLength(line), "only the appended bytes are read");
    assert.equal(grown?.rounds.length, 2);
    assert.ok(Math.abs((grown?.usd ?? 0) - 0.52) < 1e-9);
    assert.equal(grown?.tokens, 1515);

    // A partial line is not a round yet; it is read again once complete.
    const half = line.slice(0, 20);
    appendFileSync(join(dir, "sessions", "spec.jsonl"), half);
    assert.equal(byId(readStepUsage(dir, plan)).get("spec")?.rounds.length, 2);
    appendFileSync(join(dir, "sessions", "spec.jsonl"), line.slice(20));
    assert.equal(byId(readStepUsage(dir, plan)).get("spec")?.rounds.length, 3);
  });

  it("rescans a session that shrank", () => {
    const dir = runDir(["build"]);
    const plan = [{ id: "build", phase: "done" }];
    assert.equal(byId(readStepUsage(dir, plan)).get("build")?.rounds.length, 2);
    copyFileSync(join(FIXTURES, "ux.jsonl"), join(dir, "sessions", "build.jsonl"));
    const build = byId(readStepUsage(dir, plan)).get("build");
    assert.equal(build?.rounds.length, 1);
    assert.equal(build?.model, "claude-sonnet-4-6");
  });
});

function statusJob(overrides: Partial<StatusJobView> & Pick<StatusJobView, "jobId" | "state">): StatusJobView {
  return {
    title: overrides.jobId,
    repo: "web",
    workflow: "feature",
    dependsOn: [],
    stack: false,
    launchFailed: false,
    attemptCount: 1,
    maxAttempts: 5,
    prPending: false,
    prClosedUnmerged: false,
    noReadableApproval: false,
    gates: [],
    canApprove: false,
    canReject: false,
    canRevise: false,
    steps: [],
    ...overrides,
  };
}

function finished(usd: number): KilnEvent {
  return {
    id: "done",
    ts: "2026-11-09T05:00:00.000Z",
    job_id: "SAMPLE-1",
    run_id: "run-1",
    step: null,
    event: "run.finished",
    properties: { status: "ok", usd },
  } as KilnEvent;
}

function finishedJob(stepUsage: StepUsage[]): StatusJobView {
  return statusJob({
    jobId: "SAMPLE-1",
    state: "needs-human",
    logPath: "/k/log.txt",
    steps: finishedPlan().map((step) => ({ id: step.id, phase: step.phase === "done" ? ("done" as const) : ("pending" as const) })),
    stepUsage,
  });
}

describe("projectJob step usage", () => {
  const usage = readStepUsage(runDir(ALL), finishedPlan());

  it("copies the model, cost, tokens and rounds onto each phase", () => {
    const view = projectJob(finishedJob(usage), [finished(1)]);
    const phase = (id: string) => view.phases.find((item) => item.id === id);
    assert.equal(phase("spec")?.model, "claude-opus-5-5");
    assert.equal(phase("spec")?.modelSource, "session");
    assert.equal(phase("spec")?.costUsd, 0.42);
    assert.equal(phase("spec")?.tokens, 1500);
    assert.equal(phase("spec")?.rounds, undefined, "one round is not listed");
    assert.equal(phase("ux")?.model, "claude-sonnet-4-6");
    assert.equal(phase("security")?.model, "opus");
    assert.equal(phase("security")?.modelSource, "workflow");
    assert.equal(phase("code")?.costUsd, undefined);
    assert.equal(phase("build")?.rounds?.length, 2);
    assert.equal(phase("verify")?.model, undefined);
    assert.equal(phase("verify")?.costUsd, undefined);
  });

  it("is not partial when every agent step has a cost and they add up to the total", () => {
    const priced = usage.filter((step) => step.usd !== undefined);
    const sum = priced.reduce((total, step) => total + (step.usd ?? 0), 0);
    const view = projectJob(finishedJob(priced), [finished(sum)]);
    assert.equal(view.costPartial, false);
    assert.ok(Math.abs((view.stepCostUsd ?? 0) - sum) < 1e-9);
    assert.equal(projectJob(finishedJob(priced), [finished(sum + 0.004)]).costPartial, false, "under half a cent agrees");
  });

  it("is partial when an agent step has no cost or the sum differs by half a cent", () => {
    const priced = usage.filter((step) => step.usd !== undefined);
    const sum = priced.reduce((total, step) => total + (step.usd ?? 0), 0);
    assert.equal(projectJob(finishedJob(usage), [finished(sum)]).costPartial, true, "code has no cost");
    assert.equal(projectJob(finishedJob(priced), [finished(sum + 0.005)]).costPartial, true);
    // No total yet: nothing to call partial.
    assert.equal(projectJob(finishedJob(usage), []).costPartial, false);
  });

  it("does not let a command step make the total partial", () => {
    const spec = usage.filter((step) => step.stepId === "spec");
    const view = projectJob(finishedJob(spec), [finished(0.42)]);
    assert.equal(view.phases.find((phase) => phase.id === "verify")?.status, "done");
    assert.equal(view.costPartial, false);
  });
});

describe("formatStepUsage", () => {
  it("prints the model, cost and tokens, marks a configured model, and never prints $0.00 for a missing cost", () => {
    assert.equal(formatStepUsage({ model: "claude-opus-5-5", modelSource: "session", costUsd: 0.42, tokens: 1500 }), "claude-opus-5-5, $0.42, 1500 tokens");
    assert.equal(formatStepUsage({ model: "opus", modelSource: "workflow" }), "opus (configured), cost unknown");
    assert.equal(
      formatStepUsage({ model: "claude-opus-5-5", modelSource: "session", costUsd: 0.65, tokens: 1600, rounds: [{ usd: 0.4 }, { usd: 0.25 }] }),
      "claude-opus-5-5, round 1 $0.40, round 2 $0.25, total $0.65, 1600 tokens",
    );
    assert.equal(formatStepUsage({ model: "x", rounds: [{ usd: 0.4 }, {}] }), "x, round 1 $0.40, round 2 cost unknown, total cost unknown");
  });
});

const FEED: ActivityFeed = { running: false, cursor: "", raw: "", events: [] };
const page = { csrf: "token", repos: [{ name: "web", path: "/repos/web" }], workflows: ["feature"], now: Date.parse("2026-11-09T05:10:00.000Z") };
const PHASE_EVENTS: KilnEvent[] = PLAN.slice(0, 8).flatMap((id, index) => [
  { id: `${id}-s`, ts: `2026-11-09T04:0${index}:00.000Z`, job_id: "SAMPLE-1", run_id: "run-1", step: id, event: "phase.started", properties: {} },
  { id: `${id}-f`, ts: `2026-11-09T04:0${index}:30.000Z`, job_id: "SAMPLE-1", run_id: "run-1", step: id, event: "phase.finished", properties: { outcome: "completed" } },
] as KilnEvent[]);

function render(status: StatusJobView, events: KilnEvent[], step?: StepPage): string {
  const detail = jobDetail({ job: status, events, maxFixRounds: 2, diffFiles: [] });
  const html = renderApp({
    css: "",
    section: "job",
    board: buildBoard([status], events),
    attention: buildAttention([status]),
    page,
    detail,
    activity: FEED,
    ...(step ? { step } : {}),
  });
  return html.slice(html.indexOf('<main class="main detail">'), html.indexOf("</main>"));
}

function section(html: string, id: string): string {
  const at = html.indexOf(`data-phase="${id}"`);
  assert.ok(at >= 0, `missing ${id}`);
  return html.slice(at, html.indexOf("</header>", at));
}

describe("job page step usage", () => {
  const usage = readStepUsage(runDir(ALL), finishedPlan());

  it("shows each run step's model and cost, rounds, and partial beside the unchanged total", () => {
    const main = render(finishedJob(usage), [...PHASE_EVENTS, finished(2)]);
    assert.match(section(main, "spec"), /claude-opus-5-5, \$0\.42, 1500 tokens/);
    assert.match(section(main, "ux"), /claude-sonnet-4-6, \$0\.08, 900 tokens/);
    assert.match(section(main, "security"), /opus \(configured\), \$0\.10, 450 tokens/);
    assert.match(section(main, "build"), /claude-opus-5-5, round 1 \$0\.40, round 2 \$0\.25, total \$0\.65, 1600 tokens/);
    assert.match(section(main, "code"), /claude-sonnet-4-6, cost unknown/);
    assert.doesNotMatch(section(main, "verify"), /cost|configured/);
    assert.doesNotMatch(main, /\$0\.00/);
    assert.doesNotMatch(main, /ghp_/);
    const meta = main.slice(main.indexOf('<div class="job-meta">'), main.indexOf("</div>", main.indexOf('<div class="job-meta">')));
    assert.match(meta, /<span>\$2\.00<\/span><span class="meta" title="[^"]*">partial<\/span>/);
    assert.equal(meta.match(/\$\d/g)?.length, 1, "no other dollar figure is invented");
  });

  it("shows no partial when the step costs add up to the total", () => {
    const priced = usage.filter((step) => step.usd !== undefined);
    const sum = priced.reduce((total, step) => total + (step.usd ?? 0), 0);
    const main = render(finishedJob(priced), [...PHASE_EVENTS, finished(sum)]);
    const meta = main.slice(main.indexOf('<div class="job-meta">'), main.indexOf("</div>", main.indexOf('<div class="job-meta">')));
    assert.doesNotMatch(meta, /partial/);
  });

  it("puts the observed model and the rounds in the step view header", () => {
    const main = render(finishedJob(usage), [...PHASE_EVENTS, finished(2)], { id: "build", view: "activity", result: { result: { kind: "none" }, model: "opus", stepKind: "agent" } });
    assert.match(main, /<span class="step-agent">builder, claude-opus-5-5, round 1 \$0\.40, round 2 \$0\.25, total \$0\.65, 1600 tokens<\/span>/);
    const security = render(finishedJob(usage), [...PHASE_EVENTS, finished(2)], { id: "security", view: "activity", result: { result: { kind: "none" }, model: "opus", stepKind: "agent" } });
    assert.match(security, /<span class="step-agent">review-security, opus \(configured\), \$0\.10, 450 tokens<\/span>/);
  });
});

function observation(checkout: string): Observation {
  const job: ObservedJob = {
    jobId: "SAMPLE-1",
    repo: "web",
    workflow: "feature",
    title: "Sample",
    dependsOn: [],
    launching: false,
    launchFailed: false,
    stepPlan: PLAN,
    run: {
      runId: "run-1",
      checkout,
      status: "alive",
      gates: [],
      stepEvents: PLAN.slice(0, 8).flatMap((stepId) => [
        { t: "step.started" as const, stepId },
        { t: "step.completed" as const, stepId },
      ]),
    },
  };
  return { maxConcurrent: 2, maxAttempts: 3, jobs: [job], breadcrumbsToClear: [] };
}

describe("status step usage", () => {
  it("carries stepUsage without renaming or removing a field, and prints step lines only when asked", () => {
    const checkout = mkdtempSync(join(tmpdir(), "kiln-usage-status-"));
    dirs.push(checkout);
    mkdirSync(join(checkout, ".runs"), { recursive: true });
    const before = statusView(observation(checkout));
    const plain = renderStatus(before);
    assert.equal(before.jobs[0]?.stepUsage, undefined);

    fillRun(join(checkout, ".runs", "run-1"), ALL);

    const view = statusView(observation(checkout));
    const job = view.jobs[0];
    assert.ok(job?.stepUsage);
    const beforeKeys = Object.keys(before.jobs[0] ?? {});
    const afterKeys = new Set(Object.keys(job));
    for (const key of beforeKeys) assert.ok(afterKeys.has(key), `${key} is still there`);
    assert.ok(afterKeys.has("stepUsage"));
    assert.doesNotMatch(JSON.stringify(view), /ghp_/);

    // `kiln status` with no id: byte-for-byte what it printed before.
    assert.equal(renderStatus(view), plain);
    assert.equal(renderStatus(view), "SAMPLE-1  web  feature  running  run run-1\n");

    const text = renderStatus(view, { steps: true });
    const steps = text.split("\n").filter((line) => line.startsWith("  step "));
    assert.deepEqual(steps, [
      "  step spec claude-opus-5-5, $0.42, 1500 tokens",
      "  step build claude-opus-5-5, round 1 $0.40, round 2 $0.25, total $0.65, 1600 tokens",
      "  step security opus (configured), $0.10, 450 tokens",
      "  step ux claude-sonnet-4-6, $0.08, 900 tokens",
      "  step ui sonnet (configured), cost unknown",
      "  step code claude-sonnet-4-6, cost unknown",
      "  step approver opus (configured), $0.05, 320 tokens",
    ]);
    assert.doesNotMatch(text, /\$0\.00|ghp_/);
    assert.equal(text.includes(FAKE_TOKEN), false);
  });
});
