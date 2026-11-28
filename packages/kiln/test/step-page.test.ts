import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ActivityFeed } from "../src/activity.js";
import { buildAttention } from "../src/attention.js";
import { buildBoard, jobDetail } from "../src/board-view.js";
import type { KilnEvent } from "../src/events.js";
import { projectJob, startedPhaseIds } from "../src/job-view.js";
import { packageRoot } from "../src/paths.js";
import type { StatusJobView } from "../src/report.js";
import { renderApp, type StepPage } from "../src/serve-page.js";
import { readStepResult, type StepRead } from "../src/step-result.js";
import { workflowStepPlan } from "../src/workflow.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kiln-step-"));
  dirs.push(dir);
  mkdirSync(join(dir, "artifacts"));
  return dir;
}

function artifact(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, "artifacts", name), typeof value === "string" ? value : JSON.stringify(value));
}

/** The shape yak writes: loop bodies nested, agent steps carry `model`. */
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
      ],
    },
    { id: "approver", kind: "agent", model: "opus", produces: "decision" },
    { id: "approve", kind: "gate", produces: "approval" },
    { id: "land", kind: "command" },
  ],
};

describe("readStepResult", () => {
  it("reads each kind from the step's produces artifact, newest round first", () => {
    const dir = runDir();
    writeFileSync(join(dir, "workflow.json"), JSON.stringify(WORKFLOW));
    artifact(dir, "spec.json", { goal: "Ship it.", design: "Small.", acceptance: "- [ ] AC1" });
    artifact(dir, "build.1.json", { status: "BLOCKED", summary: "round one" });
    artifact(dir, "build.2.json", { status: "READY", summary: "round two" });
    artifact(dir, "build.10.json", { status: "READY", summary: "round ten" });
    artifact(dir, "verify.1.json", { stdout: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"), stderr: "boom", exitCode: 1 });
    artifact(dir, "security.1.json", { verdict: "CHANGES", findings: "- fix it" });
    artifact(dir, "decision.json", { decision: "APPROVE", reason: "All good." });

    assert.deepEqual(readStepResult(dir, "spec"), {
      result: { kind: "spec", goal: "Ship it.", design: "Small.", acceptance: "- [ ] AC1" },
      model: "opus",
      stepKind: "agent",
    });
    assert.deepEqual(readStepResult(dir, "build").result, { kind: "build", status: "READY", summary: "round ten" });
    const verify = readStepResult(dir, "verify");
    assert.equal(verify.stepKind, "command");
    assert.equal(verify.model, undefined);
    assert.equal(verify.result.kind, "verify");
    if (verify.result.kind === "verify") {
      assert.equal(verify.result.exitCode, 1);
      const lines = verify.result.tail.split("\n");
      assert.equal(lines.length, 40);
      assert.equal(lines[0], "line 12");
      assert.equal(lines.at(-1), "boom");
    }
    assert.deepEqual(readStepResult(dir, "security").result, { kind: "review", verdict: "CHANGES", findings: "- fix it" });
    assert.deepEqual(readStepResult(dir, "ux").result, { kind: "none" });
    assert.deepEqual(readStepResult(dir, "approver"), {
      result: { kind: "approver", decision: "APPROVE", reason: "All good." },
      model: "opus",
      stepKind: "agent",
    });
    assert.deepEqual(readStepResult(dir, "approve").result, { kind: "none" });
    assert.deepEqual(readStepResult(dir, "land"), { result: { kind: "none" }, stepKind: "command" });
  });

  it("reads a null exit code as killed and rejects malformed files", () => {
    const dir = runDir();
    artifact(dir, "verify.json", { stdout: "", stderr: "Killed", exitCode: null });
    artifact(dir, "build.json", { status: "READY" });
    artifact(dir, "spec.json", "{not json");
    assert.deepEqual(readStepResult(dir, "verify").result, { kind: "verify", exitCode: null, tail: "Killed" });
    assert.deepEqual(readStepResult(dir, "build").result, { kind: "none" });
    assert.deepEqual(readStepResult(dir, "spec").result, { kind: "none" });
    assert.deepEqual(readStepResult(undefined, "spec").result, { kind: "none" });
  });

  it("falls back to the step id without workflow.json and never uses a produces name that fails the check", () => {
    const outside = runDir();
    const dir = join(outside, "run");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    // A file one level up that a ../ produces name would reach.
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ decision: "APPROVE", reason: "leaked" }));
    artifact(dir, "approver.json", { decision: "ESCALATE", reason: "fallback" });
    assert.deepEqual(readStepResult(dir, "approver").result, { kind: "approver", decision: "ESCALATE", reason: "fallback" });

    writeFileSync(
      join(dir, "workflow.json"),
      JSON.stringify({ steps: [{ id: "approver", kind: "agent", model: "opus", produces: "../../secret" }] }),
    );
    const read = readStepResult(dir, "approver");
    assert.deepEqual(read.result, { kind: "none" });
    assert.equal(read.model, "opus");
    assert.deepEqual(readStepResult(dir, "../secret").result, { kind: "none" });
  });

  it("picks the kind by step id when produces names a different artifact", () => {
    const dir = runDir();
    writeFileSync(
      join(dir, "workflow.json"),
      JSON.stringify({
        steps: [
          { id: "build", kind: "agent", model: "opus", produces: "patch" },
          { id: "code", kind: "agent", model: "sonnet", produces: "code-review" },
        ],
      }),
    );
    artifact(dir, "patch.1.json", { status: "READY", summary: "from patch" });
    artifact(dir, "build.json", { status: "BLOCKED", summary: "wrong file" });
    artifact(dir, "code-review.json", { verdict: "PASS", findings: "none" });
    assert.deepEqual(readStepResult(dir, "build"), {
      result: { kind: "build", status: "READY", summary: "from patch" },
      model: "opus",
      stepKind: "agent",
    });
    assert.deepEqual(readStepResult(dir, "code").result, { kind: "review", verdict: "PASS", findings: "none" });
  });
});

function job(overrides: Partial<StatusJobView> & Pick<StatusJobView, "jobId" | "state">): StatusJobView {
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

function event(partial: Pick<KilnEvent, "event" | "properties"> & Partial<KilnEvent>): KilnEvent {
  return {
    id: partial.id ?? "evt",
    ts: partial.ts ?? "2026-11-09T04:00:00.000Z",
    job_id: "SAMPLE-1",
    run_id: "run-1",
    step: partial.step === undefined ? null : partial.step,
    ...partial,
  } as KilnEvent;
}

function featureJob(current: string): StatusJobView {
  const plan = workflowStepPlan("feature");
  const at = plan.indexOf(current);
  return job({
    jobId: "SAMPLE-1",
    state: "running",
    logPath: "/k/log.txt",
    steps: plan.map((id, index) => ({ id, phase: index < at ? ("done" as const) : index === at ? ("current" as const) : ("pending" as const) })),
  });
}

const EVENTS: KilnEvent[] = [
  event({ id: "s1", event: "phase.started", step: "spec", properties: {}, ts: "2026-11-09T04:00:00.000Z" }),
  event({ id: "s2", event: "phase.finished", step: "spec", properties: { outcome: "completed" }, ts: "2026-11-09T04:01:06.000Z" }),
  event({ id: "b1", event: "phase.started", step: "build", properties: { iteration: 1 }, ts: "2026-11-09T04:01:06.000Z" }),
  event({ id: "b2", event: "phase.finished", step: "build", properties: { outcome: "completed", iteration: 1 }, ts: "2026-11-09T04:05:00.000Z" }),
  event({ id: "v1", event: "phase.started", step: "verify", properties: { iteration: 1 }, ts: "2026-11-09T04:05:00.000Z" }),
  event({ id: "v2", event: "phase.finished", step: "verify", properties: { outcome: "completed", iteration: 1 }, ts: "2026-11-09T04:06:00.000Z" }),
  event({ id: "u1", event: "phase.started", step: "ux", properties: { iteration: 1 }, ts: "2026-11-09T04:06:00.000Z" }),
  event({ id: "x1", event: "phase.started", step: "security", properties: { iteration: 1 }, ts: "2026-11-09T04:06:00.000Z" }),
];

const FEED: ActivityFeed = {
  running: true,
  phase: "ux",
  cursor: "c1",
  raw: "",
  events: [
    { at: "2026-11-09T04:00:10.000Z", phase: "spec", kind: "command", role: "action", summary: "Ran ls" },
    { at: "2026-11-09T04:02:00.000Z", phase: "build", kind: "message", role: "note", summary: "Reading <script>alert(1)</script> the helper." },
    { at: "2026-11-09T04:02:10.000Z", phase: "build", kind: "command", role: "action", summary: "Ran npm test" },
    { at: "2026-11-09T04:02:20.000Z", phase: "build", kind: "command", role: "action", summary: "Ran npm run build" },
    { at: "2026-11-09T04:02:30.000Z", phase: "build", kind: "edit", role: "action", summary: "Edit src/a.ts +3 -1" },
    { at: "2026-11-09T04:02:40.000Z", phase: "build", kind: "edit", role: "action", summary: "Edit src/a.ts +1 -1" },
    { at: "2026-11-09T04:02:50.000Z", phase: "build", kind: "edit", role: "action", summary: "Write src/b.ts +9 -0" },
    { at: "2026-11-09T04:07:00.000Z", phase: "ux", kind: "message", role: "note", summary: "Looking at the page." },
  ],
};

const page = { csrf: "token", repos: [{ name: "web", path: "/repos/web" }], workflows: ["feature"], now: Date.parse("2026-11-09T04:10:00.000Z") };

function render(step: StepPage | undefined, status = featureJob("ux"), feed: ActivityFeed = FEED): string {
  const detail = jobDetail({ job: status, events: EVENTS, maxFixRounds: 2, diffFiles: [{ path: "src/a.ts", added: 3, removed: 1 }] });
  const html = renderApp({
    css: "",
    section: "job",
    board: buildBoard([status], EVENTS),
    attention: buildAttention([status]),
    page,
    detail,
    activity: feed,
    ...(step ? { step } : {}),
  });
  return html.slice(html.indexOf('<main class="main detail">'), html.indexOf("</main>"));
}

const NONE: StepRead = { result: { kind: "none" } };

function slice(html: string, from: string, to: string): string {
  const at = html.indexOf(from);
  assert.ok(at >= 0, `missing ${from}`);
  return html.slice(at, html.indexOf(to, at));
}

describe("step page", () => {
  it("lists every plan step in order, links started steps only, and marks the selected one", () => {
    const main = render({ id: "build", view: "activity", result: { ...NONE, model: "opus", stepKind: "agent" } });
    const nav = slice(main, '<nav class="step-nav" aria-label="Steps">', "</nav>");
    const names = [...nav.matchAll(/<span class="step-row-name">([^<]+)<\/span>/g)].map((match) => match[1]);
    assert.deepEqual(names, ["Spec", "Build", "Verify", "Security", "UX", "UI", "Code", "Approver", "Your decision", "Land"]);
    const reviews = slice(nav, '<li class="step-group">', "</ol>");
    assert.match(reviews, /<span class="step-group-label" id="step-group-reviews">Reviews<\/span>/);
    for (const name of ["Security", "UX", "UI", "Code"]) assert.match(reviews, new RegExp(`>${name}<`));
    assert.doesNotMatch(reviews, />Approver</);

    assert.equal(nav.split('aria-current="page"').length - 1, 1);
    assert.match(nav, /<a class="step-row done" href="\/jobs\/SAMPLE-1\/steps\/build" aria-current="page">/);
    for (const id of ["spec", "verify", "security", "ux"]) assert.match(nav, new RegExp(`href="/jobs/SAMPLE-1/steps/${id}"`), id);
    for (const id of ["ui", "code", "approver", "approve", "land"]) {
      assert.doesNotMatch(nav, new RegExp(`/steps/${id}"`), id);
    }
    assert.match(nav, /<span class="step-row upcoming"><span class="step-ring" aria-hidden="true"><\/span><span class="step-row-name">Land<\/span>/);
    assert.match(nav, /<a class="step-row current" href="\/jobs\/SAMPLE-1\/steps\/ux"><span class="step-dot" aria-hidden="true"><\/span>/);
    assert.match(nav, /href="\/jobs\/SAMPLE-1#changes">Changes so far, 1 file</);
    assert.match(nav, /href="\/jobs\/SAMPLE-1#timeline">Event history</);

    assert.ok(main.indexOf('aria-label="Steps"') < main.indexOf('<section class="step-view"'), "the step list comes before the step");
    assert.match(main, /<h1><a class="title-link" href="\/jobs\/SAMPLE-1">SAMPLE-1<\/a><\/h1>/);
    assert.match(main, /attempt 1 of 5/);
  });

  it("shows round, state, duration, agent and model, counts, and the view links", () => {
    const main = render({ id: "build", view: "activity", result: { ...NONE, model: "opus", stepKind: "agent" } });
    assert.match(
      main,
      /<h2 id="step-title">Build<\/h2><span class="meta">round 1, done in 3m 54s<\/span><span class="step-agent">builder, opus<\/span>/,
    );
    assert.match(main, /<dt>Commands run<\/dt><dd>2<\/dd>/);
    assert.match(main, /<dt>Files edited<\/dt><dd>2<\/dd>/);
    const views = slice(main, '<nav class="step-views" aria-label="Build views">', "</nav>");
    assert.match(views, /<a href="\/jobs\/SAMPLE-1\/steps\/build" aria-current="page">Activity<\/a>/);
    assert.match(views, /<a href="\/jobs\/SAMPLE-1\/steps\/build\?view=result">Result<\/a>/);
    assert.match(views, /<a href="\/jobs\/SAMPLE-1\/log">Raw log<\/a>/);
    assert.doesNotMatch(views, /Prompt/);

    const running = render({ id: "ux", view: "activity", result: { ...NONE, model: "sonnet" } });
    assert.match(running, /<h2 id="step-title">UX<\/h2><span class="meta">round 1, running 4m<\/span><span class="step-agent">review-ux, sonnet<\/span>/);
    const verify = render({ id: "verify", view: "activity", result: { ...NONE, stepKind: "command" } });
    assert.match(verify, /<span class="step-agent">command<\/span>/);
  });

  it("emits the job page's live log markup, filtered to the step, and pins it", () => {
    const main = render({ id: "build", view: "activity", result: NONE });
    assert.match(main, /<div class="step-live" id="live" data-running="false" data-cursor="c1" data-phase="build" data-pin="true">/);
    assert.match(main, /<ol id="live-feed" class="activity" tabindex="0" aria-label="Build activity, scrolls">/);
    assert.match(main, /<span id="follow-status" role="status">Following the latest line<\/span><button type="button" class="btn" id="jump-latest">Jump to latest<\/button><button type="button" class="btn" id="expand-log" aria-pressed="false" aria-controls="live-feed">Expand<\/button>/);
    const feed = slice(main, '<ol id="live-feed"', "</ol>");
    assert.match(feed, /Ran npm test/);
    assert.doesNotMatch(feed, /Ran ls|Looking at the page/);
    assert.doesNotMatch(main, /<script>alert/);
    assert.match(main, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

    const running = render({ id: "ux", view: "activity", result: NONE });
    assert.match(running, /id="live" data-running="true" data-cursor="c1" data-phase="ux" data-pin="true"/);

    // The job page's open step uses the same feed markup, without the pin.
    const jobPage = render(undefined);
    const shared = (html: string) => slice(html, '<div class="follow-bar">', "</div>");
    assert.equal(shared(jobPage), shared(main));
    assert.match(jobPage, /<ol id="live-feed" class="activity" tabindex="0" aria-label="UX activity, scrolls">/);
    assert.doesNotMatch(jobPage, /data-pin/);
  });

  it("renders each result kind, escaped", () => {
    const result = (read: StepRead["result"], id = "build") => slice(render({ id, view: "result", result: { result: read } }), '<div class="step-result">', '</section>');
    const spec = result({ kind: "spec", goal: "Goal <script>x</script>", design: "Use **tokens**.", acceptance: "- [ ] AC1: works" }, "spec");
    assert.match(spec, /<h3>Goal<\/h3>/);
    assert.match(spec, /Goal &lt;script&gt;x&lt;\/script&gt;/);
    assert.doesNotMatch(spec, /<script>/);
    assert.match(spec, /<strong>tokens<\/strong>/);
    assert.match(spec, /AC1: works/);

    const build = result({ kind: "build", status: "READY", summary: "Changed <b>two</b> files." });
    assert.match(build, /<dt>Status<\/dt><dd>READY<\/dd>/);
    assert.match(build, /Changed &lt;b&gt;two&lt;\/b&gt; files\./);

    const failed = result({ kind: "verify", exitCode: 1, tail: "not ok 1 <img src=x>" }, "verify");
    assert.match(failed, /<dd>failed, exit 1<\/dd>/);
    assert.match(failed, /<pre class="text">not ok 1 &lt;img src=x&gt;<\/pre>/);
    const killed = result({ kind: "verify", exitCode: null, tail: "" }, "verify");
    assert.match(killed, /<dd>killed, no exit code<\/dd>/);
    assert.match(killed, /No output\./);
    assert.match(result({ kind: "verify", exitCode: 0, tail: "ok" }, "verify"), /<dd>passed, exit 0<\/dd>/);

    const review = result({ kind: "review", verdict: "CHANGES", findings: "- **blocking** `src/a.ts:3` fix <this>\n- nit: rename" }, "security");
    assert.match(review, /<dt>Verdict<\/dt><dd>CHANGES<\/dd>/);
    assert.match(review, /fix &lt;this&gt;/);
    assert.match(review, /nit: rename/);

    const decision = result({ kind: "approver", decision: "ESCALATE", reason: "Needs a person <now>." }, "approver");
    assert.match(decision, /<dt>Decision<\/dt><dd>ESCALATE<\/dd>/);
    assert.match(decision, /Needs a person &lt;now&gt;\./);

    assert.match(result({ kind: "none" }, "land"), /<p class="empty">This step has no result to show\.<\/p>/);
    const main = render({ id: "build", view: "result", result: NONE });
    assert.doesNotMatch(main, /id="live-feed"/);
    assert.match(main, /<a href="\/jobs\/SAMPLE-1\/steps\/build\?view=result" aria-current="page">Result<\/a>/);
  });

  it("links the job page's progress names and step headings for started steps only", () => {
    const main = render(undefined);
    const progress = slice(main, 'aria-label="Progress"', "</section>");
    assert.match(progress, /<a href="\/jobs\/SAMPLE-1\/steps\/spec">Spec<\/a>/);
    assert.match(progress, /<a href="\/jobs\/SAMPLE-1\/steps\/verify">Verify<\/a>/);
    // Each review is its own pill. A started one links to its step, one that has not started is plain text.
    for (const [step, label] of [["security", "Security"], ["ux", "UX"]]) {
      assert.match(progress, new RegExp(`<a href="/jobs/SAMPLE-1/steps/${step}">${label}</a>`), label);
    }
    for (const label of ["UI", "Code"]) {
      assert.match(progress, new RegExp(`<span class="ph-name">${label}<span class="sr-only">`), label);
      assert.doesNotMatch(progress, new RegExp(`>${label}</a>`), label);
    }
    for (const label of ["Approver", "Your decision", "Land"]) {
      assert.match(progress, new RegExp(`<span class="ph-name">${label}<span class="sr-only">`), label);
    }
    assert.match(main, /<h2 id="step-ux"><a href="\/jobs\/SAMPLE-1\/steps\/ux">UX<\/a><\/h2>/);
    assert.match(main, /<h2 id="step-spec"><a href="\/jobs\/SAMPLE-1\/steps\/spec">Spec<\/a><\/h2>/);
  });

  it("uses one started rule for sections, the step list, and the route", () => {
    const view = projectJob(featureJob("ux"), EVENTS);
    assert.deepEqual([...startedPhaseIds(view, FEED)].sort(), ["build", "security", "spec", "ux", "verify"]);
    // Output alone starts a step, and a job waiting out a backoff has no live phase.
    const quiet = projectJob({ ...featureJob("ux"), state: "queued" }, []);
    assert.deepEqual([...startedPhaseIds(quiet, { phase: "ux", events: [] })], []);
    assert.deepEqual([...startedPhaseIds(quiet, { phase: "ux", events: [FEED.events[0]!] })], ["spec"]);
  });
});

describe("step page script", () => {
  const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");
  it("has one follow implementation and skips the reload when pinned", () => {
    assert.equal(script.split("function startLive(").length - 1, 1);
    assert.equal(script.split("function follow(").length - 1, 1);
    assert.match(script, /var pinned = root\.getAttribute\("data-pin"\) === "true";/);
    const place = script.slice(script.indexOf("function place(event)"));
    const skip = place.indexOf("if (pinned) return;");
    assert.ok(skip > 0, "place() drops another phase's event when pinned");
    assert.ok(skip < place.indexOf("location.reload()"), "the pin check comes before the reload");
  });
});
