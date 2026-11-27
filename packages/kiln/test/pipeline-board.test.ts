import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { buildBoard, jobDetail } from "../src/board-view.js";
import type { KilnEvent } from "../src/events.js";
import { ICON_LUCIDE, ICONS } from "../src/icons.js";
import { QUIET_AFTER_MS, doneMetrics } from "../src/job-view.js";
import type { StatusJobView, StatusState } from "../src/report.js";
import { needsYouSentence, renderApp, repoTone, stepTrackHtml, workflowLabel } from "../src/serve-page.js";

const now = Date.parse("2026-11-20T12:00:00.000Z");
const stall = 15 * 60 * 1000;

const NINE = ["spec", "build", "verify", "security", "ux", "ui", "code", "approver", "land"];

function job(id: string, state: StatusState, extra: Partial<StatusJobView> = {}): StatusJobView {
  return {
    jobId: id,
    title: `Title ${id}`,
    repo: "web",
    workflow: "feature",
    state,
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
    ...extra,
  };
}

function steps(current: number, phase: "current" | "failed" = "current"): StatusJobView["steps"] {
  return NINE.map((id, index) => ({ id, phase: index < current ? "done" : index === current ? phase : "pending" }));
}

let seq = 0;
function event(jobId: string, name: string, ts: string, properties: Record<string, unknown> = {}): KilnEvent {
  seq += 1;
  return { id: `e${seq}`, ts, run_id: "run-1", step: null, event: name, job_id: jobId, properties } as unknown as KilnEvent;
}

function render(jobs: StatusJobView[], events: KilnEvent[] = [], diff?: (job: StatusJobView) => { path: string; added: number; removed: number }[] | undefined): string {
  return renderApp({
    css: "",
    section: "pipeline",
    board: buildBoard(jobs, events, diff),
    attention: buildAttention(jobs),
    page: { csrf: "tok", repos: [], workflows: ["feature"], stallTimeoutMs: stall, now },
  });
}

function card(html: string, id: string): string {
  const start = html.indexOf(`id="job-${id}"`);
  assert.ok(start >= 0, `missing card ${id}`);
  return html.slice(start, html.indexOf("</article>", start));
}

function column(html: string, name: string): string {
  const start = html.indexOf(`<section class="col" data-column="${name}"`);
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("pipeline board", () => {
  it("draws five columns with icons, counts, and a status line", () => {
    const html = render([
      job("run-1", "running", { steps: steps(1), stallActivityAt: new Date(now - 10_000).toISOString() }),
      job("gate-1", "needs-human", { canApprove: true, canReject: true, steps: steps(8) }),
      job("dead-1", "dead", { steps: steps(1, "failed") }),
    ]);
    const columns = [...html.matchAll(/<section class="col" data-column="([^"]+)" aria-label="([^"]+)">/g)].map((match) => match[1]);
    assert.deepEqual(columns, ["queued", "running", "needs-you", "needs-hand", "done"]);
    for (const name of columns) {
      assert.match(column(html, name ?? ""), /<h2><svg class="icon col-icon [a-z-]+" viewBox="0 0 24 24" aria-hidden="true">/);
    }
    assert.match(column(html, "queued"), /<span class="col-sub">in launch order<\/span>/);
    assert.match(html, /<p class="board-status" id="board-status"><span class="board-pulse" aria-hidden="true"><\/span><span>1 running, 1 needs you, 1 needs a hand<\/span><\/p>/);
    const idle = render([job("q-1", "queued", { queuePosition: 1, queueReason: "ready" })]);
    assert.match(idle, /<p class="board-status" id="board-status"><span>0 running, 0 need you, 0 need a hand<\/span><\/p>/);
  });

  it("draws a running card with one sweeping segment, step N of M, and the newest note", () => {
    const started = new Date(now - 7 * 60_000).toISOString();
    const events = [event("run-1", "phase.started", started)];
    (events[0] as { step: string | null }).step = "build";
    const running = job("run-1", "running", {
      steps: steps(1),
      stallActivityAt: new Date(now - 10_000).toISOString(),
      latestNote: "Edit src/reliability.ts +42 -6",
      latestNoteAt: new Date(now - 10_000).toISOString(),
    });
    const html = render([running, job("run-2", "running", { steps: steps(1), stallActivityAt: new Date(now - 10_000).toISOString() })], events);
    const live = card(html, "run-1");
    const track = live.slice(live.indexOf('<div class="track"'), live.indexOf("</div>", live.indexOf('<div class="track"')));
    assert.match(track, /role="img" aria-label="Step 2 of 9: Build"/);
    assert.equal((track.match(/class="seg /g) ?? []).length, 9);
    assert.equal((track.match(/class="seg current sweep"/g) ?? []).length, 1);
    assert.equal((track.match(/sweep/g) ?? []).length, 1);
    assert.equal((track.match(/class="seg done"/g) ?? []).length, 1);
    assert.match(live, /<span class="step-pulse" aria-hidden="true"><\/span><span class="run-step">Build<\/span><span class="run-meta">step 2 of 9, 7m<\/span>/);
    assert.match(live, /<p class="run-note">Edit src\/reliability\.ts \+42 -6<\/p>/);
    assert.doesNotMatch(card(html, "run-2"), /run-note/);
    assert.match(live, /<a class="job-title" href="\/jobs\/run-1">Title run-1<\/a>/);
    assert.doesNotMatch(live, /<a [^>]*class="card/);
    assert.match(live, /<span class="card-repo repo-\d">/);
    assert.match(live, /<span class="card-flow">Feature<\/span>/);
  });

  it("says quiet for Nm or stalled on a running card, and nothing while it works", () => {
    const html = render([
      job("busy", "running", { steps: steps(1), stallActivityAt: new Date(now - 10_000).toISOString() }),
      job("quiet", "running", { steps: steps(1), stallActivityAt: new Date(now - QUIET_AFTER_MS - 3 * 60_000).toISOString() }),
      job("stuck", "running", { steps: steps(1), stallActivityAt: new Date(now - stall - 1).toISOString() }),
    ]);
    assert.match(card(html, "quiet"), /<span class="liveness quiet"><span class="liveness-label">quiet for 5m<\/span><\/span>/);
    assert.match(card(html, "stuck"), /<span class="liveness stalled"><span class="liveness-label">stalled<\/span><\/span>/);
    // Working is visually hidden (STYLE.md), so the card shows no liveness words.
    assert.match(card(html, "busy"), /<span class="liveness working"><span class="liveness-label">Working<\/span><\/span>/);
  });

  it("draws queued cards in launch order with their position and reason, and no track", () => {
    const html = render([
      job("q-3", "queued", { queuePosition: 3, queueReason: "ready" }),
      job("q-1", "queued", { queuePosition: 1, queueReason: "moved to front" }),
      job("q-2", "blocked", { queuePosition: 2, queueReason: "waits for q-1", dependsOn: [{ jobId: "q-1", state: "queued" }] }),
      job("q-4", "blocked", { queuePosition: 4, queueReason: "waits for gone-1", dependsOn: [{ jobId: "gone-1", state: "missing" }] }),
      job("q-5", "queued", { queuePosition: 5, queueReason: "held", held: true }),
    ]);
    const queued = column(html, "queued");
    const order = [...queued.matchAll(/<article class="card queued" id="job-([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(order, ["q-1", "q-2", "q-3", "q-4", "q-5"]);
    assert.match(card(html, "q-1"), /<span class="queue-pos"><span class="sr-only">Position <\/span>1<\/span><span class="queue-why">Next up<\/span>/);
    assert.match(card(html, "q-3"), /<span class="queue-why">Ready<\/span>/);
    const waits = card(html, "q-2");
    assert.match(waits, /<span class="queue-why waits"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">[^]*?<\/svg><span>Waits for Title q-1<\/span><\/span>/);
    assert.ok(waits.includes(ICONS.lock));
    assert.match(card(html, "q-4"), /Waits for gone-1/);
    assert.match(card(html, "q-5"), /<span class="chip">Held<\/span>/);
    for (const id of ["q-1", "q-2", "q-3", "q-4", "q-5"]) assert.doesNotMatch(card(html, id), /class="track"/);
  });

  it("draws a needs-you card with the sentence, cost, and a Review link to the job page that holds the gate forms", () => {
    const gate = job("gate-1", "needs-human", {
      canApprove: true,
      canReject: true,
      canRevise: true,
      steps: steps(8),
      gates: [{ stepId: "approve", prompt: "Approve?", choices: ["approve", "reject"], artifacts: [], reviews: [] }],
    });
    const events = [event("gate-1", "run.failed", "2026-11-20T10:00:00.000Z", { usd: 15.64 })];
    const html = render([gate], events);
    const view = card(html, "gate-1");
    assert.match(view, /<div class="track" role="img" aria-label="Step 9 of 9: Land">/);
    assert.doesNotMatch(view, /current|sweep/);
    assert.match(view, /<span>Waiting for your decision on the build<\/span>/);
    assert.match(view, /<span class="card-cost"><span class="sr-only">Cost <\/span>\$15\.64<\/span>/);
    assert.match(view, /<a class="card-btn" href="\/jobs\/gate-1">Review<\/a>/);
    assert.doesNotMatch(view, /<form/);

    const page = renderApp({
      css: "",
      section: "job",
      board: buildBoard([gate], events),
      attention: buildAttention([gate]),
      detail: jobDetail({ job: gate, events, maxFixRounds: 2 }),
      page: { csrf: "tok", repos: [], workflows: [] },
    });
    for (const action of ["approve", "reject", "revise"]) {
      assert.match(page, new RegExp(`<form method="post" action="/api/jobs/gate-1/${action}" class="act ${action}"><input type="hidden" name="csrf" value="tok">`));
    }
  });

  it("words the needs-you reason for a pull request", () => {
    const base = { state: "in-review", reason: "Pull request #92 is open", prNumber: 92, steps: [] };
    assert.equal(needsYouSentence(base), "Pull request #92 is ready to merge");
    assert.equal(needsYouSentence({ ...base, state: "needs-human", reason: "Conflicts with main: a.ts", prNumber: 91 }), "Pull request #91 conflicts with main");
    assert.equal(needsYouSentence({ ...base, state: "needs-human", reason: "Gate: approve?", prNumber: undefined }), "Waiting for your decision");
  });

  it("draws a needs-a-hand card with the failed step, the reason, and a Retry form with the CSRF token", () => {
    const html = render([job("dead-1", "failed", { steps: steps(1, "failed"), launchError: "builder exploded" })]);
    const view = card(html, "dead-1");
    assert.match(view, /<div class="track" role="img" aria-label="Failed at Build">/);
    assert.equal((view.match(/class="seg failed"/g) ?? []).length, 1);
    assert.doesNotMatch(view, /sweep|current/);
    assert.match(view, /<p class="card-reason"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">[^]*?<\/svg><span>Failed: builder exploded<\/span><\/p>/);
    assert.ok(view.includes(ICONS["triangle-alert"]));
    assert.match(view, /<form method="post" action="\/api\/jobs\/dead-1\/retry" class="act retry"><input type="hidden" name="csrf" value="tok"><button type="submit">Retry<\/button><\/form>/);
  });

  it("draws a merged done card with every metric and a cancelled one with no metrics line", () => {
    const events = [
      event("merged", "run.started", "2026-11-20T09:00:00.000Z"),
      event("merged", "run.failed", "2026-11-20T09:20:00.000Z", { usd: 7.73 }),
      event("merged", "run.started", "2026-11-20T09:30:00.000Z"),
      event("merged", "run.finished", "2026-11-20T10:12:00.000Z", { status: "ok", usd: 20 }),
      event("merged", "pr.feedback", "2026-11-20T11:00:00.000Z", { round: 1, trigger: "ci" }),
    ];
    const html = render(
      [job("merged", "done", { prNumber: 88 }), job("stopped", "cancelled")],
      events,
      (item) => (item.jobId === "merged" ? [
        { path: "a.ts", added: 400, removed: 30 },
        { path: "b.ts", added: 12, removed: 8 },
      ] : undefined),
    );
    const merged = card(html, "merged");
    assert.match(merged, /<span class="outcome-word done"><svg[^>]*aria-hidden="true">[^]*?<\/svg><span>Merged #88<\/span><\/span>/);
    assert.ok(merged.includes(ICONS["git-merge"]));
    assert.match(merged, /title="Cost"><svg[^]*?<\/svg><span class="sr-only">Cost <\/span>\$27\.73<\/span>/);
    assert.match(merged, /title="Run time"><svg[^]*?<\/svg><span class="sr-only">Run time <\/span>1h 12m<\/span>/);
    assert.match(merged, /<span class="added">\+412<\/span> <span class="removed">-38<\/span>/);
    assert.match(merged, /title="Files changed"><svg[^]*?<\/svg><span class="sr-only">Files changed <\/span>2<\/span>/);
    assert.match(merged, /title="Fix rounds"><svg[^]*?<\/svg><span class="sr-only">Fix rounds <\/span>1<\/span>/);
    assert.doesNotMatch(merged, /class="track"/);
    const stopped = card(html, "stopped");
    assert.match(stopped, /<span>Cancelled<\/span>/);
    assert.doesNotMatch(stopped, /class="metrics"/);
    assert.match(card(render([job("local", "done")]), "local"), /<span>Landed locally<\/span>/);
    assert.match(card(render([job("no", "rejected")]), "no"), /<span>Rejected<\/span>/);
  });

  it("names every new icon in Lucide and keeps decorative marks hidden", () => {
    for (const name of [
      "hourglass",
      "eye",
      "circle-check",
      "circle-x",
      "ban",
      "lock",
      "triangle-alert",
      "git-pull-request",
      "git-merge",
      "coins",
      "clock",
      "file-diff",
      "files",
      "wrench",
    ] as const) {
      assert.ok(ICONS[name], name);
      assert.equal(ICON_LUCIDE[name], name);
    }
    const html = render([
      job("run-1", "running", { steps: steps(1) }),
      job("dead-1", "dead", { steps: steps(1, "failed") }),
      job("done-1", "done", { prNumber: 3 }),
    ]);
    const board = html.slice(html.indexOf('id="board"'));
    for (const svg of board.match(/<svg[^>]*>/g) ?? []) assert.match(svg, /aria-hidden="true"/);
    for (const track of board.match(/<div class="track"[^>]*>/g) ?? []) assert.match(track, /role="img" aria-label="[^"]+"/);
  });

  it("projects the track, the tone, and the workflow label", () => {
    const base = { state: "running", workflow: "feature", inbox: false };
    assert.equal(stepTrackHtml({ ...base, steps: [] }, "running"), "");
    const two = [{ id: "a", label: "A", status: "done" as const }, { id: "b", label: "B", status: "done" as const }];
    const done = stepTrackHtml({ ...base, state: "approved", steps: two }, "needs-you");
    assert.match(done, /aria-label="All 2 steps done"/);
    const review = stepTrackHtml({ ...base, state: "in-review", prNumber: 91, steps: two }, "needs-you");
    assert.match(review, /aria-label="Pull request #91 open"/);
    assert.equal(workflowLabel("investigation"), "Investigation");
    assert.equal(repoTone("kiln"), repoTone("kiln"));
    for (const name of ["a", "kiln", "ai-core-backend", "web", "api"]) assert.ok(repoTone(name) >= 1 && repoTone(name) <= 6);
  });
});

describe("stepper outcome", () => {
  const finished = (): StatusJobView["steps"] => NINE.map((id) => ({ id, phase: "done" as const }));
  const progress = (html: string, id: string): string => {
    const row = card(html, id);
    return row.slice(row.indexOf('<div class="progress">'), row.indexOf("</div></div>", row.indexOf('<div class="progress">')) + 12);
  };
  const history = (jobs: StatusJobView[]): string =>
    renderApp({
      css: "",
      section: "history",
      board: buildBoard(jobs, []),
      attention: buildAttention(jobs),
      page: { csrf: "tok", repos: [], workflows: ["feature"], stallTimeoutMs: stall, now },
    });

  it("names the outcome of a finished history row, with no current step", () => {
    const html = history([
      job("merged", "done", { prNumber: 88, deliver: "pr", steps: finished() }),
      job("no", "rejected", { steps: steps(8) }),
      job("stop", "cancelled", { steps: steps(1) }),
      job("local", "done", { deliver: "local", steps: finished() }),
    ]);
    for (const [id, word] of [["merged", "Merged #88"], ["no", "Rejected"], ["stop", "Cancelled"], ["local", "Landed locally"]] as const) {
      const row = progress(html, id);
      assert.match(row, new RegExp(`<span class="step-now outcome">${word}</span>`), id);
      assert.doesNotMatch(row, /aria-current/, id);
      assert.doesNotMatch(row, /class="step-now[^"]*"[^>]*>Land</, id);
      assert.doesNotMatch(row, /step-now outcome" aria-hidden/, id);
    }
  });

  it("keeps a running and a failed row's step label and current mark", () => {
    const html = renderApp({
      css: "",
      section: "repos",
      board: buildBoard([job("run", "running", { steps: steps(1) }), job("dead", "dead", { steps: steps(2, "failed") })], []),
      attention: buildAttention([]),
      page: { csrf: "tok", repos: [], workflows: ["feature"], stallTimeoutMs: stall, now },
    });
    const run = progress(html, "run");
    assert.match(run, /<li class="step current" aria-current="step"><span class="name">Build<\/span>/);
    assert.match(run, /<span class="step-now current" aria-hidden="true">Build<\/span>/);
    const dead = progress(html, "dead");
    assert.match(dead, /<li class="step failed" aria-current="step"><span class="name">Verify<\/span>/);
    assert.match(dead, /<span class="step-now failed" aria-hidden="true">Verify<\/span>/);
  });

  it("keeps the track label of a running and a failed card", () => {
    const html = render([job("run", "running", { steps: steps(1) }), job("dead", "dead", { steps: steps(2, "failed") })]);
    assert.match(card(html, "run"), /aria-label="Step 2 of 9: Build"/);
    assert.match(card(html, "dead"), /aria-label="Failed at Verify"/);
  });

  it("gives an in-review card its pull request in the track label", () => {
    const html = render([job("pr", "in-review", { prNumber: 92, deliver: "pr", steps: finished() })]);
    assert.match(card(html, "pr"), /role="img" aria-label="Pull request #92 open"/);
    assert.doesNotMatch(card(html, "pr"), /All 9 steps done/);
  });

  it("words the done card from the same rule", () => {
    const html = render([
      job("merged", "done", { prNumber: 88, deliver: "pr", steps: finished() }),
      job("no", "rejected", { steps: steps(8) }),
      job("stop", "cancelled", { steps: steps(1) }),
      job("find", "done", { workflow: "investigation", deliver: "pr", steps: [] }),
    ]);
    assert.match(card(html, "merged"), /<span>Merged #88<\/span>/);
    assert.match(card(html, "no"), /<span>Rejected<\/span>/);
    assert.match(card(html, "stop"), /<span>Cancelled<\/span>/);
    assert.match(card(html, "find"), /<span>Findings approved<\/span>/);
    for (const id of ["merged", "no", "stop"]) assert.doesNotMatch(card(html, id), /aria-current|<span>Land<\/span>/, id);
  });
});

describe("done metrics", () => {
  const view = { jobId: "j1", costUsd: 3.5, prNumber: 7 };
  const run = [
    event("j1", "run.started", "2026-11-20T09:00:00.000Z"),
    event("j1", "run.finished", "2026-11-20T09:45:00.000Z", { status: "ok" }),
    event("other", "run.finished", "2026-11-20T12:00:00.000Z", { status: "ok" }),
  ];

  it("reads cost, run time, diff, files, and fix rounds", () => {
    const metrics = doneMetrics(view, [...run, event("j1", "pr.feedback", "2026-11-20T10:00:00.000Z")], [{ added: 3, removed: 1 }]);
    assert.deepEqual(metrics, { costUsd: 3.5, runMs: 45 * 60_000, added: 3, removed: 1, files: 1, fixRounds: 1 });
  });

  it("leaves each metric out when its source is missing", () => {
    assert.equal(doneMetrics({ ...view, costUsd: null }, run).costUsd, undefined);
    assert.equal(doneMetrics(view, run.filter((item) => item.event !== "run.finished")).runMs, undefined);
    assert.equal(doneMetrics(view, run.filter((item) => item.event !== "run.started")).runMs, undefined);
    const noDiff = doneMetrics(view, run);
    assert.equal(noDiff.added, undefined);
    assert.equal(noDiff.removed, undefined);
    assert.equal(noDiff.files, undefined);
    assert.equal(doneMetrics({ jobId: "j1", costUsd: 1 }, run).fixRounds, undefined);
    assert.equal(doneMetrics(view, run).fixRounds, 0);
    assert.deepEqual(doneMetrics({ jobId: "j1", costUsd: null }, []), {});
  });
});
