import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { QUIET_AFTER_MS, activityLiveness, progressSegments, projectJob, type PipelineColumn } from "../src/job-view.js";
import type { ActivityFeed } from "../src/activity.js";
import { buildBoard, jobDetail } from "../src/board-view.js";
import { renderApp } from "../src/serve-page.js";
import { renderMarkdown } from "../src/markdown.js";
import { kilnVersion } from "../src/project.js";
import type { StatusJobView } from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";
import type { KilnEvent } from "../src/events.js";
import { workflowStepPlan } from "../src/workflow.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FP = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

describe("newest note", () => {
  it("carries the newest note for a running job and omits it otherwise", () => {
    const note = { latestNote: "Tests pass. The token [redacted] is not needed.", latestNoteAt: "2026-11-26T21:40:11.000Z" };
    const running = projectJob(job({ jobId: "WEB-1", state: "running", ...note }), []);
    assert.equal(running.column, "running");
    assert.equal(running.latestNote, note.latestNote);
    assert.equal(running.latestNoteAt, note.latestNoteAt);

    const silent = projectJob(job({ jobId: "WEB-2", state: "running" }), []);
    assert.equal("latestNote" in silent, false);
    assert.equal("latestNoteAt" in silent, false);

    const done = projectJob(job({ jobId: "WEB-3", state: "done", ...note }), []);
    assert.notEqual(done.column, "running");
    assert.equal("latestNote" in done, false);
    assert.equal("latestNoteAt" in done, false);
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
    attemptCount: 0,
    maxAttempts: 3,
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
    job_id: partial.job_id === undefined ? "SAMPLE-1" : partial.job_id,
    run_id: partial.run_id === undefined ? "run-1" : partial.run_id,
    step: partial.step === undefined ? null : partial.step,
    ...partial,
  } as KilnEvent;
}

describe("job view", () => {
  it("projects a review job into one deliverable with findings", () => {
    const markdown = [
      "# Draft review",
      "",
      "The helper swallows errors.",
      "",
      "**Verdict:** Request changes",
      "",
      "- **warning** `src/app.ts:12` — Rename the helper.",
      "- **blocking** `src/auth.ts:4` — Do not log the token.",
    ].join("\n");
    const raw = JSON.stringify({
      markdown,
      findings: [
        { severity: "warning", file: "src/app.ts", line: 12, comment: "Rename the helper." },
        { severity: "blocking", file: "src/auth.ts", line: 4, comment: "Do not log the token." },
      ],
    });
    const rendered = `Draft review for "SAMPLE-1"?\n\nApproving posts this draft as a pull request comment. Kiln does not approve the pull request or merge it.\n\n${markdown}`;
    const reviewJob = job({
      jobId: "SAMPLE-1",
      title: "SAMPLE-1 Tighten the helper",
      repo: "web",
      workflow: "review",
      state: "needs-human",
      canApprove: true,
      canReject: true,
      canRevise: true,
      source: { kind: "trigger", ref: "review:web:18:abcdef1234567890" },
      gates: [
        {
          stepId: "approve",
          prompt: 'Draft review for "SAMPLE-1"?',
          rendered,
          choices: ["approve", "reject"],
          artifacts: [
            { name: "input", summary: "title: SAMPLE-1 Tighten the helper" },
            { name: "draft", summary: raw },
          ],
          reviews: [],
        },
      ],
      steps: [
        { id: "draft", phase: "done" },
        { id: "approve", phase: "current" },
      ],
      files: [
        {
          id: "spec",
          group: "Job",
          label: "spec.md",
          text: "Pull request: https://example.com/web/pull/18\nNumber: 18\nHead: abcdef1234567890\n",
        },
      ],
    });
    const view = projectJob(
      reviewJob,
      [
        event({
          event: "phase.started",
          step: "draft",
          properties: {},
          ts: "2026-11-09T04:00:00.000Z",
        }),
        event({
          event: "phase.finished",
          step: "draft",
          properties: { outcome: "completed" },
          ts: "2026-11-09T04:02:00.000Z",
        }),
        event({
          event: "run.finished",
          step: null,
          properties: { status: "ok", usd: 0.42 },
          ts: "2026-11-09T04:03:00.000Z",
        }),
      ],
    );

    assert.equal(view.column, "needs-you");
    assert.equal(view.ask, 'Draft review for "SAMPLE-1"?');
    assert.equal(view.costUsd, 0.42);
    assert.equal(view.currentPhase, "Your decision");
    assert.deepEqual(
      view.phases.map((phase) => [phase.id, phase.status]),
      [
        ["draft", "done"],
        ["approve", "running"],
      ],
    );
    assert.equal(view.phases[0]?.durationMs, 120_000);
    assert.equal(view.deliverable?.kind, "review");
    if (view.deliverable?.kind !== "review") return;
    assert.equal(view.deliverable.verdict, "Request changes");
    assert.equal(view.deliverable.prNumber, 18);
    assert.equal(view.deliverable.prUrl, "https://example.com/web/pull/18");
    assert.equal(view.deliverable.headSha, "abcdef1234567890");
    assert.deepEqual(
      view.deliverable.findings.map((finding) => [finding.severity, finding.file, finding.line]),
      [
        ["blocking", "src/auth.ts", 4],
        ["warning", "src/app.ts", 12],
      ],
    );
    assert.match(view.deliverable.markdown, /The helper swallows errors/);
    assert.doesNotMatch(view.deliverable.markdown, /Draft review for "SAMPLE-1"/);
    assert.doesNotMatch(view.deliverable.markdown, /title:/);
    assert.equal(view.deliverable.markdown.includes("Do not log the token"), false);
    assert.equal(view.deliverable.raw, raw);
    assert.equal(view.evidence.filter((line) => line.includes("title:")).length, 0);
    assert.equal(view.evidence.filter((line) => line === raw).length, 0);

    const html = renderConsole("", buildAttention([reviewJob]), {
      csrf: "token",
      repos: [],
      workflows: [],
      section: "inbox",
    });
    const card = html.slice(html.indexOf('id="job-SAMPLE-1"'), html.indexOf("</article>"));
    const ask = "Draft review for &quot;SAMPLE-1&quot;?";
    assert.equal(card.split(ask).length - 1, 1);
    assert.equal(card.split("Approving posts this draft").length - 1, 1);
    assert.match(card, /<h1>Draft review<\/h1>/);
    assert.match(card, /src\/auth\.ts:4/);
    assert.match(card, /<h3>blocking<\/h3>[\s\S]*<h3>warning<\/h3>/);
    assert.match(card, /<details class="raw"><summary>Raw output<\/summary><pre class="text">/);
    assert.equal((card.match(/<pre/g) ?? []).length, 1);
    assert.match(card, /web#18/);
    assert.match(card, />abcdef1</);
    assert.match(card, /href="https:\/\/example\.com\/web\/pull\/18"/);
    assert.match(card, /action="\/api\/jobs\/SAMPLE-1\/approve"/);
    assert.doesNotMatch(card, /title:/);
    assert.doesNotMatch(card, /<script>/);
  });

  it("projects a failed job with a fingerprint into needs a hand", () => {
    const view = projectJob(
      job({
        jobId: "SAMPLE-2",
        title: "SAMPLE-2 Type error",
        state: "needs-human",
        stopReason: "fingerprint",
      }),
      [
        event({
          id: "fail",
          job_id: "SAMPLE-2",
          event: "run.failed",
          step: null,
          properties: { class: "deterministic", fingerprint: FP, detail: "type error" },
        }),
      ],
    );
    assert.equal(view.column, "needs-hand");
    assert.equal(view.hand, true);
    assert.equal(view.inbox, false);
    assert.equal(view.failureClass, "deterministic");
    assert.equal(view.fingerprint, "abcdef123456");
    assert.match(view.reason, /Same failure/);
    assert.match(view.reason, /deterministic/);
    assert.match(view.reason, /abcdef123456/);
    assert.equal(view.phases.at(-1)?.fingerprint, "abcdef123456");
  });

  it("projects a queued job into the queued column", () => {
    const view = projectJob(
      job({
        jobId: "SAMPLE-3",
        title: "SAMPLE-3 Wait",
        state: "queued",
        createdAt: "2026-11-09T03:00:00.000Z",
      }),
      [],
    );
    assert.equal(view.column, "queued");
    assert.equal(view.inbox, false);
    assert.equal(view.hand, false);
    assert.equal(view.phases.length, 0);
    assert.match(view.reason, /Queued/);
    assert.equal(view.since, "2026-11-09T03:00:00.000Z");
    assert.equal(view.costUsd, null);
    assert.equal(view.deliverable, undefined);
  });

  it("puts a queued job blocked on a missing test command in needs a hand", () => {
    const blocked = job({
      jobId: "SAMPLE-4",
      title: "SAMPLE-4 Missing test",
      repo: "web",
      state: "queued",
      launchBlock: {
        reason: "web has no test command",
        fix: { kind: "repo-setting", repo: "web", field: "test" },
      },
    });
    const view = projectJob(
      blocked,
      [
        event({
          id: "block",
          job_id: "SAMPLE-4",
          run_id: null,
          event: "launch.blocked",
          step: null,
          properties: {
            reason: "web has no test command",
            fix: { kind: "repo-setting", repo: "web", field: "test" },
          },
        }),
      ],
    );
    assert.equal(view.column, "needs-hand");
    assert.equal(view.hand, true);
    assert.equal(view.inbox, false);
    assert.equal(view.retry, false);
    assert.equal(view.reason, "Blocked: web has no test command");
    assert.equal(view.timeline[0]?.entries[0]?.summary, "Blocked · web has no test command");
    const html = renderConsole("", buildAttention([blocked]), {
      csrf: "token",
      repos: [{ name: "web", path: "/tmp/web", hasTest: false }],
      workflows: ["feature", "investigation"],
      workflowsNeedingTest: ["feature"],
      section: "hand",
    });
    assert.match(html, /Blocked: web has no test command/);
    assert.match(html, /href="\/settings\/repos\?repo=web&amp;field=test"/);
    assert.match(html, /Edit web in Settings/);
    assert.match(html, /id="intake-warn"/);
    assert.match(html, /data-workflow="feature"[^>]*data-needs-test="true"/);
    assert.match(html, /data-workflow="investigation"[^>]*data-needs-test="false"/);
    assert.match(html, /data-repo="web"[^>]*data-has-test="false"/);
    assert.doesNotMatch(html, /action="\/api\/jobs\/SAMPLE-4\/retry"/);
  });
});

describe("activity liveness", () => {
  const now = Date.parse("2026-11-15T18:00:00.000Z");
  const stall = 15 * 60 * 1000;

  it("classifies lastActivityAt as working, quiet, or stalled", () => {
    const running = (iso?: string, stallTimeoutMs = stall) =>
      activityLiveness({
        column: "running",
        ...(iso ? { lastActivityAt: iso } : {}),
        now,
        stallTimeoutMs,
      });
    assert.deepEqual(running(new Date(now - 30_000).toISOString()), { liveness: "working", label: "Working" });
    assert.deepEqual(running(new Date(now - QUIET_AFTER_MS).toISOString()), { liveness: "working", label: "Working" });
    assert.deepEqual(running(new Date(now - QUIET_AFTER_MS - 1).toISOString()), { liveness: "quiet", label: "quiet 2m" });
    assert.deepEqual(running(new Date(now - 4 * 60_000).toISOString()), { liveness: "quiet", label: "quiet 4m" });
    assert.deepEqual(running(new Date(now - stall).toISOString()), { liveness: "quiet", label: "quiet 15m" });
    assert.deepEqual(running(new Date(now - stall - 1).toISOString()), { liveness: "stalled", label: "stalled" });
    assert.deepEqual(running(new Date(now - 60 * 60_000).toISOString(), 0), { liveness: "quiet", label: "quiet 60m" });
    assert.equal(running(undefined).liveness, "idle");
    assert.equal(running("not-a-time").liveness, "idle");
    const fresh = new Date(now - 5_000).toISOString();
    for (const column of ["queued", "needs-you", "needs-hand", "done"] as const satisfies readonly PipelineColumn[]) {
      assert.equal(activityLiveness({ column, lastActivityAt: fresh, now, stallTimeoutMs: stall }).liveness, "idle", column);
    }
  });

  it("renders a step bar on the pipeline and the full stepper on the job", () => {
    const plan = [
      { id: "spec", phase: "done" as const },
      { id: "build", phase: "current" as const },
      { id: "verify", phase: "pending" as const },
      { id: "land", phase: "pending" as const },
    ];
    const working = job({
      jobId: "WEB-118",
      title: "Ship the weekly summary",
      state: "running",
      steps: plan,
      stallActivityAt: new Date(now - 45_000).toISOString(),
      specPath: "/tmp/spec.md",
      logPath: "/tmp/log.txt",
    });
    const quiet = job({
      jobId: "API-22",
      title: "Index the public catalog",
      repo: "api",
      state: "running",
      steps: [
        { id: "spec", phase: "done" },
        { id: "build", phase: "done" },
        { id: "verify", phase: "current" },
        { id: "land", phase: "pending" },
      ],
      stallActivityAt: new Date(now - 4 * 60_000).toISOString(),
    });
    const stalled = job({
      jobId: "API-23",
      title: "Wait on a stalled run",
      repo: "api",
      state: "running",
      steps: plan,
      stallActivityAt: new Date(now - stall - 1).toISOString(),
    });
    const queued = job({
      jobId: "WEB-104",
      title: "Queue the weekly digest",
      state: "queued",
      stallActivityAt: new Date(now - 5_000).toISOString(),
      steps: plan.map((step) => ({ ...step, phase: "pending" as const })),
    });
    const projected = projectJob(working, []);
    assert.equal(projected.stallActivityAt, working.stallActivityAt);
    assert.deepEqual(
      projected.steps.map((step) => [step.label, step.status]),
      [
        ["Spec", "done"],
        ["Build", "running"],
        ["Verify", "pending"],
        ["Land", "pending"],
      ],
    );

    const jobs = [working, quiet, stalled, queued];
    const attention = buildAttention(jobs);
    const board = buildBoard(jobs, []);
    const page = {
      csrf: "token",
      repos: [
        { name: "web", path: "/repos/web" },
        { name: "api", path: "/repos/api" },
      ],
      workflows: ["feature"],
      stallTimeoutMs: stall,
      now,
    };
    const html = renderApp({ css: "", section: "pipeline", board, attention, page });
    const slice = (id: string) => html.slice(html.indexOf(`id="job-${id}"`), html.indexOf("</article>", html.indexOf(`id="job-${id}"`)));
    const workingCard = slice("WEB-118");
    assert.match(workingCard, /class="steps"/);
    assert.doesNotMatch(workingCard, /steps-full/);
    assert.match(workingCard, /class="step-now current"/);
    assert.match(workingCard, />Build</);
    assert.match(workingCard, /class="liveness working"/);
    assert.match(workingCard, /data-activity="2026-11-15T17:59:15.000Z"/);
    assert.match(slice("API-22"), /class="liveness quiet"[\s\S]*quiet 4m/);
    const stalledCard = slice("API-23");
    assert.match(stalledCard, /class="liveness stalled"/);
    assert.match(stalledCard, />stalled</);
    assert.doesNotMatch(stalledCard, /live-dot/);
    assert.doesNotMatch(slice("WEB-104"), /liveness/);
    assert.match(html, /class="repo-f"/);
    assert.match(html, /class="chip"/);

    const detail = jobDetail({ job: working, events: [], maxFixRounds: 2 });
    const jobHtml = renderApp({ css: "", section: "job", board, attention, page, detail });
    const progress = jobHtml.slice(jobHtml.indexOf('aria-label="Progress"'), jobHtml.indexOf("</section>", jobHtml.indexOf('aria-label="Progress"')));
    assert.match(progress, /Spec/);
    assert.match(progress, /aria-current="step"[\s\S]*Build/);
    assert.match(progress, /Verify/);
    assert.match(progress, /Land/);
    assert.match(jobHtml, /class="liveness working"/);
    assert.match(jobHtml, /class="text-btn" href="\/jobs\/WEB-118\/spec"/);
    assert.match(jobHtml, /class="text-btn" href="\/jobs\/WEB-118\/log"/);
    assert.match(jobHtml, /<span>Spec<\/span>/);
    assert.match(jobHtml, /<span>Raw log<\/span>/);
    assert.doesNotMatch(jobHtml, />spec</);
  });
});

describe("markdown", () => {
  it("escapes html and does not link javascript urls", () => {
    const html = renderMarkdown(
      [
        "# Hi",
        "",
        "<script>alert(1)</script>",
        "",
        '<img src=x onerror="alert(1)">',
        "",
        "[x](javascript:alert(1))",
        "",
        "[ok](https://example.com/a)",
        "",
        "Use `&` in `a < b`.",
      ].join("\n"),
    );
    assert.match(html, /<h1>Hi<\/h1>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.match(html, /href="https:\/\/example\.com\/a"/);
    assert.match(html, /<code>a &lt; b<\/code>/);
    assert.match(html, /&amp;/);
  });
});

describe("version badge", () => {
  it("reads the running package version", () => {
    const html = renderConsole("", buildAttention([]), { csrf: "", repos: [], workflows: [] });
    const version = kilnVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.match(html, new RegExp(`class="ver">v${version}</span>`));
  });
});

const FEATURE_LABELS = ["Spec", "Build", "Verify", "Security", "UX", "UI", "Code", "Approver", "Your decision", "Land"];

function featureJob(current: string): StatusJobView {
  const plan = workflowStepPlan("feature");
  const at = plan.indexOf(current);
  return job({
    jobId: "SAMPLE-1",
    state: "running",
    steps: plan.map((id, index) => ({ id, phase: index < at ? ("done" as const) : index === at ? ("current" as const) : ("pending" as const) })),
  });
}

function loopEvents(): KilnEvent[] {
  return [
    event({ id: "s1", event: "phase.started", step: "spec", properties: {}, ts: "2026-11-09T04:00:00.000Z" }),
    event({ id: "s2", event: "phase.finished", step: "spec", properties: { outcome: "completed" }, ts: "2026-11-09T04:01:00.000Z" }),
    event({ id: "r1", event: "phase.started", step: "revise", properties: {}, ts: "2026-11-09T04:01:00.000Z" }),
    event({ id: "b1", event: "phase.started", step: "build", properties: { iteration: 1 }, ts: "2026-11-09T04:01:00.000Z" }),
    event({ id: "b2", event: "phase.finished", step: "build", properties: { outcome: "completed", iteration: 1 }, ts: "2026-11-09T04:05:00.000Z" }),
    event({ id: "b3", event: "phase.started", step: "build", properties: { iteration: 2 }, ts: "2026-11-09T04:10:00.000Z" }),
    event({ id: "r2", event: "phase.finished", step: "revise", properties: { outcome: "completed" }, ts: "2026-11-09T04:11:00.000Z" }),
  ];
}

describe("step list", () => {
  it("names each feature step once and leaves the revise loop out", () => {
    const view = projectJob(featureJob("build"), loopEvents());
    assert.deepEqual(
      view.steps.map((step) => step.label),
      FEATURE_LABELS,
    );
    assert.deepEqual(
      view.phases.map((phase) => phase.label),
      FEATURE_LABELS,
    );
    assert.equal(new Set(view.phases.map((phase) => phase.label)).size, view.phases.length);
    assert.equal(view.phases.some((phase) => phase.label === "Revise" || phase.id === "revise"), false);
  });

  it("keeps Build current with its round in round 2", () => {
    const view = projectJob(featureJob("build"), loopEvents());
    const build = view.phases.find((phase) => phase.id === "build");
    assert.equal(build?.status, "running");
    assert.equal(build?.iteration, 2);
    assert.equal(view.currentPhase, "Build");
    assert.equal(view.steps.find((step) => step.status === "running")?.label, "Build");
  });

  it("keeps a revise note on the gate phase", () => {
    const events = [
      ...loopEvents(),
      event({
        id: "g1",
        event: "gate.resolved",
        step: "approve",
        properties: { decision: "revise", note: "Split the helper." },
        ts: "2026-11-09T04:09:00.000Z",
      } as Pick<KilnEvent, "event" | "properties"> & Partial<KilnEvent>),
    ];
    const view = projectJob(featureJob("build"), events);
    const gate = view.phases.find((phase) => phase.label === "Your decision");
    assert.equal(gate?.note, "Split the helper.");
    assert.deepEqual(
      view.phases.map((phase) => phase.label),
      FEATURE_LABELS,
    );
  });

  it("renders Approver and Your decision once and no Revise in each step list", () => {
    const featured = featureJob("build");
    const events = loopEvents();
    const attention = buildAttention([featured]);
    const board = buildBoard([featured], events);
    const page = { csrf: "token", repos: [{ name: "web", path: "/repos/web" }], workflows: ["feature"] };
    const count = (html: string, text: string) => html.split(`>${text}<`).length - 1;
    const between = (html: string, start: string) => {
      const from = html.indexOf(start);
      assert.ok(from >= 0, `missing ${start}`);
      return html.slice(from, html.indexOf("</ol>", from));
    };

    const pipeline = renderApp({ css: "", section: "pipeline", board, attention, page });
    const card = pipeline.slice(pipeline.indexOf('id="job-SAMPLE-1"'), pipeline.indexOf("</article>", pipeline.indexOf('id="job-SAMPLE-1"')));
    const detail = jobDetail({ job: featured, events, maxFixRounds: 2 });
    const jobHtml = renderApp({ css: "", section: "job", board, attention, page, detail });
    const lists = {
      card: between(card, 'class="steps"'),
      page: between(jobHtml, 'class="prog"'),
    };
    for (const [name, html] of Object.entries(lists)) {
      assert.equal(count(html, "Approver"), 1, `${name} Approver`);
      assert.equal(count(html, "Your decision"), 1, `${name} Your decision`);
      assert.equal(count(html, "Approve"), 0, `${name} Approve`);
      assert.doesNotMatch(html, /Revise/, `${name} Revise`);
    }
    assert.match(jobHtml, /<h2 id="step-build"><a href="\/jobs\/SAMPLE-1\/steps\/build">Build<\/a><\/h2><span class="meta">round 2, /);
  });

  it("leaves a local overlay workflow's loop out of the step list", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-loop-"));
    try {
      writeFileSync(
        join(dir, "cycle.yaml"),
        [
          "name: kiln-cycle",
          'version: "1"',
          "steps:",
          "  - id: plan",
          "    agent: { prompt: plan }",
          "  - id: cycle",
          "    loop:",
          "      body:",
          "        - id: work",
          "          agent: { prompt: work }",
          "        - id: check",
          "          agent: { prompt: check }",
          "  - id: ship",
          "    agent: { prompt: ship }",
          "",
        ].join("\n"),
      );
      const plan = workflowStepPlan("cycle", dir);
      assert.deepEqual(plan, ["plan", "work", "check", "ship"]);
      const looped = job({
        jobId: "SAMPLE-1",
        workflow: "cycle",
        state: "running",
        steps: plan.map((id, index) => ({ id, phase: index === 0 ? ("done" as const) : index === 1 ? ("current" as const) : ("pending" as const) })),
      });
      const view = projectJob(looped, [
        event({ id: "c1", event: "phase.started", step: "cycle", properties: {} }),
        event({ id: "w1", event: "phase.started", step: "work", properties: { iteration: 1 } }),
        event({ id: "c2", event: "phase.finished", step: "cycle", properties: { outcome: "completed" } }),
      ]);
      assert.deepEqual(
        view.phases.map((phase) => phase.label),
        ["Plan", "Work", "Check", "Ship"],
      );
      assert.equal(view.phases.some((phase) => phase.id === "cycle"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("progress segments", () => {
  const steps = (marks: [string, "done" | "current" | "failed" | "pending"][]) => marks.map(([id, phase]) => ({ id, phase }));
  const timed = (step: string, minutes: number): KilnEvent[] => [
    event({ id: `${step}-s`, event: "phase.started", step, properties: {}, ts: "2026-11-09T04:00:00.000Z" }),
    event({
      id: `${step}-f`,
      event: "phase.finished",
      step,
      properties: { outcome: "completed" },
      ts: new Date(Date.parse("2026-11-09T04:00:00.000Z") + minutes * 60_000).toISOString(),
    }),
  ];

  it("folds security, ux, ui, and code into one Reviews segment", () => {
    const plan = workflowStepPlan("feature");
    const view = projectJob(featureJob("verify"), []);
    const segments = progressSegments(view);
    assert.deepEqual(
      segments.map((segment) => segment.label),
      ["Spec", "Build", "Verify", "Reviews", "Approver", "Your decision", "Land"],
    );
    assert.equal(segments.find((segment) => segment.id === "reviews")?.status, "pending");
    assert.ok(plan.includes("security"));

    const fold = (marks: ("done" | "current" | "failed" | "pending")[]) =>
      progressSegments(
        projectJob(
          job({
            jobId: "SAMPLE-1",
            state: "running",
            steps: steps([
              ["security", marks[0] ?? "pending"],
              ["ux", marks[1] ?? "pending"],
              ["ui", marks[2] ?? "pending"],
              ["code", marks[3] ?? "pending"],
            ]),
          }),
          [],
        ),
      );
    assert.equal(fold(["done", "failed", "current", "pending"])[0]?.status, "failed");
    assert.equal(fold(["done", "current", "pending", "pending"])[0]?.status, "running");
    assert.equal(fold(["done", "done", "done", "done"])[0]?.status, "done");
    assert.equal(fold(["done", "done", "pending", "pending"])[0]?.status, "pending");
    assert.equal(fold(["done", "done", "done", "done"]).length, 1);
  });

  it("sets a duration only once a segment is done or failed", () => {
    const events = [...timed("spec", 1), ...timed("security", 2), ...timed("ux", 3), ...timed("build", 4)];
    const view = projectJob(
      job({
        jobId: "SAMPLE-1",
        state: "running",
        steps: steps([
          ["spec", "done"],
          ["build", "current"],
          ["security", "done"],
          ["ux", "done"],
          ["ui", "done"],
          ["code", "done"],
          ["land", "failed"],
          ["after", "pending"],
        ]),
      }),
      events,
    );
    const byId = new Map(progressSegments(view).map((segment) => [segment.id, segment]));
    assert.equal(byId.get("spec")?.durationMs, 60_000);
    assert.equal(byId.get("build")?.status, "running");
    assert.equal(byId.get("build")?.durationMs, undefined);
    assert.equal(byId.get("reviews")?.status, "done");
    assert.equal(byId.get("reviews")?.durationMs, 5 * 60_000);
    assert.equal(byId.get("land")?.status, "failed");
    assert.equal(byId.get("land")?.durationMs, undefined);
    assert.equal(byId.get("after")?.durationMs, undefined);
  });
});

describe("job page", () => {
  const page = { csrf: "token", repos: [{ name: "web", path: "/repos/web" }], workflows: ["feature"], now: Date.parse("2026-11-09T04:12:00.000Z") };
  const render = (status: StatusJobView, events: KilnEvent[], activity?: ActivityFeed, extra: Partial<Parameters<typeof jobDetail>[0]> = {}) => {
    const detail = jobDetail({ job: status, events, maxFixRounds: 2, ...extra });
    return renderApp({
      css: "",
      section: "job",
      board: buildBoard([status], events),
      attention: buildAttention([status]),
      page,
      detail,
      ...(activity ? { activity } : {}),
    });
  };
  const section = (html: string, label: string) => {
    const at = html.indexOf(`aria-label="${label}"`);
    assert.ok(at >= 0, `missing ${label}`);
    return html.slice(at, html.indexOf("</section>", at));
  };
  const sideOf = (html: string) => html.slice(html.indexOf('aria-label="Job facts"'), html.indexOf("</aside>", html.indexOf('aria-label="Job facts"')));
  const mainOf = (html: string) => html.slice(html.indexOf('<main class="main detail">'), html.indexOf("</main>"));
  const loopFeed: ActivityFeed = {
    running: true,
    phase: "build",
    cursor: "c1",
    raw: "",
    events: [
      { at: "2026-11-09T04:00:10.000Z", phase: "spec", kind: "command", role: "action", summary: "Ran ls" },
      { at: "2026-11-09T04:10:05.000Z", phase: "build", kind: "message", role: "note", summary: "Reading the helper." },
      { at: "2026-11-09T04:10:20.000Z", phase: "build", kind: "command", role: "action", summary: "Ran npm test" },
    ],
  };

  it("reads top to bottom for a running job, with no tabs and the current step open", () => {
    const status = { ...featureJob("build"), specPath: "/k/spec.md", logPath: "/k/log.txt", attemptCount: 1, maxAttempts: 5, startedAt: "2026-11-09T04:00:00.000Z" };
    const html = render(status, loopEvents(), loopFeed, { diffFiles: [{ path: "src/a.ts", added: 84, removed: 12 }], diffStat: "1 file changed" });
    const main = mainOf(html);
    assert.doesNotMatch(main, /class="tabs"/);
    assert.doesNotMatch(main, /progress-meta|step-now/);
    assert.match(main, /aria-label="Progress"/);
    assert.match(main, /class="step-section open"/);
    assert.match(main, /aria-label="Now"/);
    assert.match(main, /aria-label="Job facts"/);
    assert.match(main, /attempt 1 of 5/);
    assert.match(main, /started <time/);

    const now = section(main, "Now");
    assert.match(now, /Now, in Build/);
    assert.match(now, /<code class="now-command" id="now-command">npm test<\/code>/);
    assert.match(now, /id="now-note"/);

    assert.match(main, /<ol id="live-feed" class="activity" tabindex="0" aria-label="Build activity, scrolls">/);
    assert.match(main, /id="jump-latest">Jump to latest</);
    assert.match(main, /id="expand-log" aria-pressed="false"/);
    assert.match(main, /<h2 id="step-build"><a href="\/jobs\/SAMPLE-1\/steps\/build">Build<\/a><\/h2><span class="meta">round 2, running 2m, 1 command<\/span>/);
    assert.match(main, /<h2 id="step-spec"><a href="\/jobs\/SAMPLE-1\/steps\/spec">Spec<\/a><\/h2><span class="meta">done in 1m, 1 command<\/span><a href="\/jobs\/SAMPLE-1\/spec">Read the spec<\/a>/);
    assert.match(main, /<details class="step-activity"><summary>Show activity<\/summary>[\s\S]*Ran ls/);
    assert.ok(main.indexOf('id="step-build"') < main.indexOf('id="step-spec"'), "newest step first");
    assert.match(main, /data-running="true" data-cursor="c1" data-phase="build"/);

    const progressAt = main.indexOf('aria-label="Progress"');
    // The side column's "Spec" is the spec file link, not the step.
    const outside = main.slice(0, progressAt) + main.slice(main.indexOf("</section>", progressAt), main.indexOf('aria-label="Job facts"'));
    for (const label of ["Spec", "Build"]) assert.equal(outside.split(`>${label}<`).length - 1, 1, label);
    assert.doesNotMatch(main, /pending/i);
    assert.match(section(main, "Progress"), /class="prog-step upcoming"><span class="prog-bar" aria-hidden="true"><\/span><span class="prog-name">Verify<\/span><\/li>/);
    assert.match(section(main, "Progress"), /class="prog-step done"><span class="prog-bar" aria-hidden="true"><\/span><span class="prog-name"><svg[^]*?<\/svg><a href="\/jobs\/SAMPLE-1\/steps\/spec">Spec<\/a><\/span><span class="prog-note">1m<\/span>/);

    const side = sideOf(html);
    assert.match(side, /src\/a\.ts<\/span><span class="mono file-count">\+84 -12</);
    assert.match(side, /href="#changes">Open the diff</);
    assert.match(side, /href="\/jobs\/SAMPLE-1\/spec"/);
    assert.match(side, /href="\/jobs\/SAMPLE-1\/log"/);
    assert.match(side, /href="#timeline"/);
    assert.match(side, /Verify, then Reviews, then Approver, then Your decision, then Land\./);
    assert.match(main, /<details class="job-more" id="changes">/);
    assert.match(main, /<details class="job-more" id="timeline">/);
    assert.match(main, /action="\/api\/jobs\/SAMPLE-1\/cancel"/);
    assert.doesNotMatch(main, /\/approve"|\/reject"|\/revise"|\/retry"/);
  });

  it("says No changes yet without a diff", () => {
    const html = render(featureJob("build"), loopEvents(), loopFeed);
    assert.match(sideOf(html), /No changes yet\./);
  });

  it("shows the decision with verdicts and the three gate actions for a needs-you job", () => {
    const status = { ...featureJob("approve"), state: "needs-human" as const, canApprove: true, canReject: true, canRevise: true };
    const verdict = (step: string, text: string) =>
      event({ id: `${step}-v`, event: "phase.finished", step, properties: { outcome: "completed", verdict: text } });
    const events = [
      ...loopEvents(),
      verdict("security", "No must-fix findings"),
      verdict("ux", "Pass"),
      verdict("ui", "Pass with nits"),
      verdict("code", "Pass"),
      verdict("approver", "APPROVE"),
    ];
    const html = render(status, events, { ...loopFeed, running: false });
    const main = mainOf(html);
    assert.doesNotMatch(main, /aria-label="Now"/);
    const decision = main.slice(main.indexOf('aria-label="Your decision"'), main.indexOf("</section>", main.indexOf('aria-label="Your decision"')));
    for (const [label, text] of [
      ["Approver", "APPROVE"],
      ["Security", "No must-fix findings"],
      ["UX", "Pass"],
      ["UI", "Pass with nits"],
      ["Code", "Pass"],
    ]) {
      assert.match(decision, new RegExp(`<dt>${label}</dt><dd>${text}</dd>`));
    }
    for (const action of ["approve", "reject", "revise"]) {
      assert.match(decision, new RegExp(`<form method="post" action="/api/jobs/SAMPLE-1/${action}" class="act ${action}"><input type="hidden" name="csrf" value="token">`));
      assert.equal(main.split(`action="/api/jobs/SAMPLE-1/${action}"`).length - 1, 1, action);
    }
    assert.match(decision, /<input name="note" type="text" required/);
    assert.doesNotMatch(main, /id="live-feed"/);
  });

  it("shows the failure and Retry for a failed job", () => {
    const status = { ...featureJob("build"), state: "failed" as const, steps: featureJob("build").steps.map((step) => (step.id === "build" ? { ...step, phase: "failed" as const } : step)) };
    const events = [
      event({ id: "b1", event: "phase.started", step: "build", properties: {}, ts: "2026-11-09T04:01:00.000Z" }),
      event({ id: "b2", event: "phase.finished", step: "build", properties: { outcome: "failed", detail: "npm test exited 1" }, ts: "2026-11-09T04:03:00.000Z" }),
      event({ id: "f1", event: "run.failed", properties: { class: "deterministic", fingerprint: FP, detail: "npm test exited 1" } }),
    ];
    const main = mainOf(render(status, events));
    assert.doesNotMatch(main, /aria-label="Now"/);
    const failure = section(main, "What went wrong");
    assert.match(failure, /deterministic · abcdef123456/);
    assert.match(failure, /Failed in Build/);
    assert.match(failure, /npm test exited 1/);
    assert.match(failure, /<form method="post" action="\/api\/jobs\/SAMPLE-1\/retry" class="act retry"><input type="hidden" name="csrf" value="token">/);
    assert.equal(main.split('action="/api/jobs/SAMPLE-1/retry"').length - 1, 1);
    assert.match(main, /Remove job/);
  });

  it("shows no middle card and no gate or retry actions for a done job", () => {
    const plan = workflowStepPlan("feature");
    const status = job({ jobId: "SAMPLE-1", state: "done", steps: plan.map((id) => ({ id, phase: "done" as const })) });
    const main = mainOf(render(status, loopEvents()));
    assert.doesNotMatch(main, /aria-label="Now"|aria-label="Your decision"|aria-label="What went wrong"/);
    assert.doesNotMatch(main, /\/approve"|\/reject"|\/revise"|\/retry"/);
    assert.doesNotMatch(main, /Stop job/);
    assert.match(main, /action="\/api\/jobs\/SAMPLE-1\/remove"/);
    assert.doesNotMatch(main, /class="step-section open"/);
    assert.match(sideOf(main), /Nothing\. This job is finished\./);
  });

  it("keeps Run next, Hold, Release, Stop job, and Remove job for a queued job", () => {
    const queued = job({ jobId: "SAMPLE-1", state: "queued", queuePosition: 2 });
    const main = mainOf(render(queued, []));
    for (const action of ["next", "hold", "cancel", "remove"]) {
      assert.match(main, new RegExp(`action="/api/jobs/SAMPLE-1/${action}"`), action);
    }
    const held = mainOf(render({ ...queued, held: true }, []));
    assert.match(held, /action="\/api\/jobs\/SAMPLE-1\/release"/);
  });
});
