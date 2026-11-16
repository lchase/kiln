import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { QUIET_AFTER_MS, activityLiveness, projectJob, type PipelineColumn } from "../src/job-view.js";
import { buildBoard, jobDetail } from "../src/board-view.js";
import { renderApp } from "../src/serve-page.js";
import { renderMarkdown } from "../src/markdown.js";
import { kilnVersion } from "../src/project.js";
import type { StatusJobView } from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";
import type { KilnEvent } from "../src/events.js";

const FP = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

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
    assert.equal(view.currentPhase, "Approve");
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
      lastActivityAt: new Date(now - 45_000).toISOString(),
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
      lastActivityAt: new Date(now - 4 * 60_000).toISOString(),
    });
    const stalled = job({
      jobId: "API-23",
      title: "Wait on a stalled run",
      repo: "api",
      state: "running",
      steps: plan,
      lastActivityAt: new Date(now - stall - 1).toISOString(),
    });
    const queued = job({
      jobId: "WEB-104",
      title: "Queue the weekly digest",
      state: "queued",
      lastActivityAt: new Date(now - 5_000).toISOString(),
      steps: plan.map((step) => ({ ...step, phase: "pending" as const })),
    });
    const projected = projectJob(working, []);
    assert.equal(projected.lastActivityAt, working.lastActivityAt);
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
    const jobHtml = renderApp({ css: "", section: "job", board, attention, page, detail, tab: "overview" });
    const stepper = jobHtml.slice(jobHtml.indexOf('class="steps steps-full"'), jobHtml.indexOf("</ol>"));
    assert.match(stepper, /Spec/);
    assert.match(stepper, /aria-current="step"[\s\S]*Build/);
    assert.match(stepper, /Verify/);
    assert.match(stepper, /Land/);
    assert.match(jobHtml, /class="liveness working"/);
    assert.match(jobHtml, /class="text-btn" href="\/jobs\/WEB-118\/spec"/);
    assert.match(jobHtml, /class="text-btn" href="\/jobs\/WEB-118\/log"/);
    assert.match(jobHtml, />Spec</);
    assert.match(jobHtml, />Log</);
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
