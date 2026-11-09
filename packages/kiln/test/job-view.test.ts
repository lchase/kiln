import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { projectJob } from "../src/job-view.js";
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
