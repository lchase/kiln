import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildBoard,
  changesSince,
  commitsFromLog,
  dayReport,
  isHand,
  isInbox,
  jobDetail,
  parseSeenQuery,
  parseStatsWindow,
  phaseFeed,
  readBranchCommits,
  statsFor,
  unseenChanges,
} from "../src/board-view.js";
import { appendEvent, readEvents } from "../src/events.js";
import { packageRoot } from "../src/paths.js";
import type { StatusJobView } from "../src/report.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const FP = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

function job(overrides: Partial<StatusJobView> & Pick<StatusJobView, "jobId" | "state">): StatusJobView {
  return {
    title: overrides.jobId,
    repo: "widget",
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

function at(dayOffset: number, hour = 12): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function remember(dir: string): string {
  keep.push(dir);
  return dir;
}

after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("board lists", () => {
  it("counts inbox gates separately from needs-a-hand stops", () => {
    const gate = job({
      jobId: "gate",
      state: "needs-human",
      canApprove: true,
      canReject: true,
      canRevise: true,
      gates: [{ stepId: "approve", prompt: "Approve the summary?", choices: ["approve", "reject"], artifacts: [], reviews: [] }],
    });
    const repeated = job({
      jobId: "repeated",
      state: "needs-human",
      stopReason: "fingerprint",
      title: "Repeat the type error",
    });
    const capped = job({ jobId: "capped", state: "needs-human", stopReason: "attempt-cap" });
    const retrying = job({
      jobId: "retrying",
      state: "failed",
      attemptCount: 1,
      maxAttempts: 3,
      lastFailureReason: "stalled",
      nextRetryAt: at(0, 18),
    });
    const done = job({ jobId: "done", state: "done" });
    const events = readEvents(seed(repeated.jobId, capped.jobId), { warn: () => {} });
    const board = buildBoard([gate, repeated, capped, retrying, done], events);
    assert.equal(board.inboxCount, 1);
    assert.equal(board.inbox[0]?.jobId, "gate");
    assert.equal(isInbox(gate), true);
    assert.equal(isInbox(repeated), false);
    assert.equal(isHand(retrying), false);
    assert.deepEqual(
      board.hand.map((item) => item.jobId),
      ["repeated", "capped"],
    );
    assert.match(board.hand[0]?.reason ?? "", /Same failure/);
    assert.match(board.hand[0]?.reason ?? "", /deterministic/);
    assert.match(board.hand[0]?.reason ?? "", /abcdef123456/);
    assert.equal(board.hand[0]?.fingerprint, "abcdef123456");
    assert.match(board.hand[1]?.reason ?? "", /Attempt cap/);
    assert.match(board.hand[1]?.reason ?? "", /budget/);
    assert.deepEqual(
      board.history.map((item) => item.jobId),
      ["done"],
    );
    assert.equal(board.repos[0]?.repo, "widget");
    assert.equal(board.repos[0]?.jobs.length, 5);
  });
});

describe("changes since last looked", () => {
  it("counts later events for a job and sums them on the inbox", () => {
    const dir = remember(mkdtempSync(join(tmpdir(), "kiln-seen-")));
    const seenAt = at(0, 9);
    appendEvent(dir, {
      job_id: "gate",
      event: "phase.finished",
      step: "spec",
      properties: { outcome: "completed" },
      ts: at(0, 8),
    });
    appendEvent(dir, {
      job_id: "gate",
      event: "phase.finished",
      step: "build",
      properties: { outcome: "completed" },
      ts: at(0, 10),
    });
    appendEvent(dir, {
      job_id: "gate",
      event: "gate.opened",
      step: "approve",
      properties: { prompt: "Approve?" },
      ts: at(0, 11),
    });
    appendEvent(dir, {
      job_id: "other",
      event: "phase.finished",
      step: "spec",
      properties: { outcome: "failed" },
      ts: at(0, 12),
    });
    const events = readEvents(dir, { warn: () => {} });
    assert.equal(changesSince(events, "gate", seenAt), 2);
    assert.equal(changesSince(events, "gate", at(0, 11)), 0);
    assert.equal(changesSince(events, "gate", undefined), 0);
    assert.equal(changesSince(events, "missing", seenAt), 0);
    const seen = parseSeenQuery([`gate|${seenAt}`, "bad", "nope|not-a-time"]);
    const unseen = unseenChanges(events, seen, new Set(["gate"]));
    assert.equal(unseen.inbox, 2);
    assert.deepEqual(unseen.jobs, [
      { jobId: "gate", count: 2 },
      { jobId: "other", count: 0 },
    ].filter((row) => row.count > 0));
  });
});

describe("phases, stats, and the day report", () => {
  it("builds the phase feed from events, including revise notes and failure evidence", () => {
    const dir = remember(mkdtempSync(join(tmpdir(), "kiln-phase-")));
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-1",
      event: "phase.started",
      step: "spec",
      properties: {},
      ts: at(0, 1),
    });
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-1",
      event: "phase.finished",
      step: "spec",
      properties: { outcome: "completed" },
      ts: at(0, 2),
    });
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-1",
      event: "phase.finished",
      step: "security",
      properties: { outcome: "completed", verdict: "CHANGES", detail: "Rename the control." },
      ts: at(0, 3),
    });
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-1",
      event: "phase.finished",
      step: "verify",
      properties: { outcome: "failed", test_command: "npm test", exit_code: 1, detail: "expected 1" },
      ts: at(0, 4),
    });
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-1",
      event: "gate.resolved",
      step: "approve",
      properties: { decision: "revise", by: "human", note: "Keep the empty state." },
      ts: at(0, 5),
    });
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-1",
      event: "run.failed",
      properties: { class: "deterministic", fingerprint: FP, usd: 0.4, detail: "expected 1" },
      ts: at(0, 6),
    });
    appendEvent(dir, {
      job_id: "job",
      run_id: "run-2",
      event: "pr.feedback",
      properties: { round: 1, trigger: "ci" },
      ts: at(0, 7),
    });
    const events = readEvents(dir, { warn: () => {} });
    const feed = phaseFeed(events, "job");
    assert.deepEqual(
      feed.map((card) => card.label),
      ["Spec", "Review · security", "Verify", "Revise", "Fix round 1 · CI"],
    );
    assert.equal(feed[1]?.verdict, "CHANGES");
    assert.equal(feed[1]?.detail, "Rename the control.");
    assert.equal(feed[2]?.testCommand, "npm test");
    assert.equal(feed[2]?.exitCode, 1);
    assert.equal(feed[2]?.failureClass, "deterministic");
    assert.equal(feed[2]?.fingerprint, "abcdef123456");
    assert.equal(feed[3]?.note, "Keep the empty state.");
    const detail = jobDetail({
      job: job({ jobId: "job", state: "needs-human", repo: "widget", attemptCount: 2, prUrl: "https://example.com/widget/pull/4", prNumber: 4 }),
      events,
      issue: "WID-14",
      maxFixRounds: 2,
    });
    assert.equal(detail.rail.issue, "WID-14");
    assert.equal(detail.rail.costUsd, 0.4);
    assert.equal(detail.rail.risk, "CHANGES");
    assert.equal(detail.rail.ci, "failing");
    assert.deepEqual(detail.rail.attempts, { used: 2, cap: 3 });
    assert.deepEqual(detail.rail.fixRounds, { used: 1, cap: 2 });
    assert.equal(detail.timeline.length, events.length);
  });

  it("rolls cost up by repo and phase and keeps today against the cap", () => {
    const dir = remember(mkdtempSync(join(tmpdir(), "kiln-stats-")));
    appendEvent(dir, {
      job_id: "a",
      event: "job.added",
      properties: { repo: "widget", workflow: "feature", title: "A" },
      ts: at(-40),
    });
    appendEvent(dir, {
      job_id: "b",
      event: "job.added",
      properties: { repo: "docs", workflow: "feature", title: "B" },
      ts: at(-3),
    });
    appendEvent(dir, {
      job_id: "a",
      run_id: "old",
      event: "run.started",
      properties: { kiln_version: "0.0.0", yak_version: "0.0.0", workflow: "feature", prompts_hash: "abc", repo: "widget" },
      ts: at(-40),
    });
    appendEvent(dir, {
      job_id: "a",
      run_id: "old",
      event: "run.finished",
      properties: { status: "ok", usd: 9 },
      ts: at(-40),
    });
    appendEvent(dir, {
      job_id: "a",
      run_id: "build-run",
      event: "run.started",
      properties: { kiln_version: "0.0.0", yak_version: "0.0.0", workflow: "feature", prompts_hash: "abc", repo: "widget" },
      ts: at(0, 8),
    });
    appendEvent(dir, {
      job_id: "a",
      run_id: "build-run",
      event: "phase.finished",
      step: "build",
      properties: { outcome: "completed" },
      ts: at(0, 9),
    });
    appendEvent(dir, {
      job_id: "a",
      run_id: "build-run",
      event: "run.finished",
      properties: { status: "ok", usd: 1.5 },
      ts: at(0, 10),
    });
    appendEvent(dir, {
      job_id: "b",
      run_id: "fix-run",
      event: "run.started",
      properties: { kiln_version: "0.0.0", yak_version: "0.0.0", workflow: "fix", prompts_hash: "def", repo: "docs" },
      ts: at(-2),
    });
    appendEvent(dir, {
      job_id: "b",
      run_id: "fix-run",
      event: "run.failed",
      properties: { class: "transient", fingerprint: FP, usd: 0.5 },
      ts: at(-2),
    });
    appendEvent(dir, {
      job_id: "b",
      event: "gate.resolved",
      step: "approve",
      properties: { decision: "reject", by: "human" },
      ts: at(0, 11),
    });
    const events = readEvents(dir, { warn: () => {} });
    const today = statsFor(events, { window: "today", cap: 10 });
    assert.equal(today.spend.usd, 1.5);
    assert.equal(today.spend.cap, 10);
    assert.equal(today.spend.blocked, false);
    assert.equal(today.windowUsd, 1.5);
    assert.deepEqual(today.costByRepo, [{ repo: "widget", usd: 1.5 }]);
    assert.deepEqual(today.costByPhase, [{ phase: "build", usd: 1.5 }]);
    assert.equal(today.runs.finished, 1);
    assert.equal(today.interventions.total, 1);
    const week = statsFor(events, { window: "7d", cap: 1 });
    assert.equal(week.spend.usd, 1.5);
    assert.equal(week.spend.blocked, true);
    assert.equal(week.windowUsd, 2);
    assert.deepEqual(week.costByRepo, [
      { repo: "docs", usd: 0.5 },
      { repo: "widget", usd: 1.5 },
    ]);
    assert.deepEqual(week.costByPhase, [
      { phase: "build", usd: 1.5 },
      { phase: "fix", usd: 0.5 },
    ]);
    assert.deepEqual(week.failuresByClass, [{ class: "transient", count: 1 }]);
    assert.equal(parseStatsWindow("nope"), undefined);
    assert.equal(parseStatsWindow(null), "today");
    const report = dayReport(events, { cap: 10 });
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0]?.outcome, "ok");
    assert.equal(report.runs[0]?.usd, 1.5);
    assert.equal(report.interventions.total, 1);
  });
});

describe("commit trailers", () => {
  it("reads Kiln-Round from a commit body", () => {
    const parsed = commitsFromLog(
      ["aaa111", "kiln: Show the summary", "Kiln-Job: job-1\nKiln-Round: 2\nKiln-Prompts-Hash: abc\n"].join("\x1f") + "\x1e",
    );
    assert.equal(parsed[0]?.round, 2);
    assert.equal(parsed[0]?.kilnJob, "job-1");
    const dir = remember(mkdtempSync(join(tmpdir(), "kiln-commits-")));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "kiln-test@example.com"]);
    git(dir, ["config", "user.name", "Kiln Test"]);
    writeFileSync(join(dir, "readme.md"), "start\n");
    git(dir, ["add", "readme.md"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    git(dir, ["checkout", "-q", "-b", "wid-14-summary"]);
    writeFileSync(join(dir, "readme.md"), "changed\n");
    git(dir, ["add", "readme.md"]);
    git(dir, [
      "commit",
      "-q",
      "-m",
      "kiln: Show the summary",
      "--trailer",
      "Kiln-Job: job-1",
      "--trailer",
      "Kiln-Round: 2",
      "--trailer",
      "Kiln-Prompts-Hash: abc",
    ]);
    const commits = readBranchCommits(dir, "wid-14-summary");
    assert.equal(commits[0]?.round, 2);
    assert.equal(commits[0]?.subject, "kiln: Show the summary");
    assert.equal(readBranchCommits(dir, "missing-branch").length, 0);
  });
});

describe("board HTTP", () => {
  it("serves inbox, hand reasons, cost, unseen counts, and job detail", async () => {
    const cwd = remember(mkdtempSync(join(tmpdir(), "kiln-board-http-")));
    const home = join(cwd, "home");
    mkdirSync(home);
    const repo = join(cwd, "widget");
    mkdirSync(repo);
    const added = runCli(["repo", "add", "widget", repo, "--test", "true"], cwd, home);
    assert.equal(added.status, 0, added.stderr);
    const configPath = join(home, ".kiln", "kiln.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.adapter = "mock";
    config.dailyDollarCap = 10;
    config.maxConcurrent = 1;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const gateSpec = join(cwd, "gate.md");
    writeFileSync(gateSpec, "# Show the weekly summary\n\nList it.\n");
    const gate = runCli(
      ["add", "feature", "--repo", "widget", "--spec", gateSpec, "--title", "Show the weekly summary", "--issue", "WID-14"],
      cwd,
      home,
    );
    assert.equal(gate.status, 0, gate.stderr);
    const gateId = gate.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(gateId);
    const handSpec = join(cwd, "hand.md");
    writeFileSync(handSpec, "# Repeat the type error\n\nStop.\n");
    const hand = runCli(
      ["add", "feature", "--repo", "widget", "--spec", handSpec, "--title", "Repeat the type error"],
      cwd,
      home,
    );
    assert.equal(hand.status, 0, hand.stderr);
    const handId = hand.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(handId);
    const runDir = join(repo, ".runs", "run-gate");
    mkdirSync(join(runDir, "pending"), { recursive: true });
    writeFileSync(
      join(runDir, "journal.jsonl"),
      [
        JSON.stringify({ t: "run.started", at: at(0, 1), runId: "run-gate", tag: `kiln:${gateId}`, pid: 1, workflow: "kiln-feature" }),
        JSON.stringify({ t: "step.started", at: at(0, 1), stepId: "spec" }),
        JSON.stringify({ t: "step.completed", at: at(0, 2), stepId: "spec" }),
        JSON.stringify({ t: "gate.opened", at: at(0, 3), stepId: "approve" }),
        JSON.stringify({ t: "run.finished", at: at(0, 4), status: "suspended", reason: "gate" }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(runDir, "pending", "approve.request.json"),
      `${JSON.stringify({
        rendered: "Approve the summary?\n\nLook at the list.",
        answerSchema: { type: "object", properties: { decision: { enum: ["approve", "reject", "revise"] } }, required: ["decision"] },
      })}\n`,
    );
    const kilnDir = join(home, ".kiln");
    appendEvent(kilnDir, {
      job_id: handId,
      run_id: "run-hand",
      event: "run.failed",
      properties: { class: "deterministic", fingerprint: FP, usd: 1.25, reason: "failed" },
      ts: at(0, 8),
    });
    appendEvent(kilnDir, {
      job_id: handId,
      event: "needs-human",
      properties: { reason: "fingerprint" },
      ts: at(0, 9),
    });
    const server = await startServe(cwd, home);
    try {
      const board = await json(`${server.url}/api/board`);
      assert.equal(board.status, 200);
      const body = board.body as {
        inboxCount: number;
        handCount: number;
        hand: { jobId: string; reason: string; failureClass?: string; fingerprint?: string }[];
        inbox: { jobId: string }[];
      };
      assert.equal(body.inboxCount, 1);
      assert.equal(body.inbox[0]?.jobId, gateId);
      assert.equal(body.handCount, 1);
      assert.equal(body.hand[0]?.jobId, handId);
      assert.equal(body.hand[0]?.failureClass, "deterministic");
      assert.equal(body.hand[0]?.fingerprint, "abcdef123456");
      assert.match(body.hand[0]?.reason ?? "", /Same failure/);

      const stats = await json(`${server.url}/api/stats?window=today`);
      assert.equal(stats.status, 200);
      const spend = stats.body as { spend: { usd: number; cap: number | null }; windowUsd: number; costByRepo: { repo: string; usd: number }[] };
      assert.equal(spend.spend.cap, 10);
      assert.ok(spend.spend.usd >= 1.25);
      assert.ok(spend.costByRepo.some((row) => row.repo === "widget" && row.usd >= 1.25));

      const bad = await json(`${server.url}/api/stats?window=year`);
      assert.equal(bad.status, 400);

      const unseen = await json(`${server.url}/api/unseen?seen=${encodeURIComponent(`${gateId}|${at(-1)}`)}`);
      assert.equal(unseen.status, 200);
      const seenBody = unseen.body as { inbox: number; jobs: { jobId: string; count: number }[] };
      assert.ok(seenBody.inbox >= 1);
      assert.ok(seenBody.jobs.some((row) => row.jobId === gateId && row.count >= 1));

      const report = await json(`${server.url}/api/report`);
      assert.equal(report.status, 200);
      const day = report.body as { runs: { jobId: string }[]; spend: { usd: number } };
      assert.ok(day.spend.usd >= 1.25);

      const detail = await json(`${server.url}/api/jobs/${gateId}/detail`);
      assert.equal(detail.status, 200);
      const view = detail.body as { overview: { step: string }[]; rail: { issue?: string; attempts: { cap: number } }; timeline: unknown[] };
      assert.ok(view.overview.some((card) => card.step === "spec"));
      assert.equal(view.rail.issue, "WID-14");
      assert.equal(view.rail.attempts.cap, 3);
      assert.ok(view.timeline.length > 0);

      const missing = await json(`${server.url}/api/jobs/missing-job/detail`);
      assert.equal(missing.status, 404);

      const page = await text(`${server.url}/inbox`);
      assert.equal(page.status, 200);
      assert.match(page.body, /Show the weekly summary/);
      assert.match(page.body, /action="\/api\/jobs\/[^"]+\/approve"/);
      assert.match(page.body, /Needs a hand/);
    } finally {
      if (server.child.exitCode === null) server.child.kill("SIGTERM");
    }
  });
});

function seed(repeated: string, capped: string): string {
  const dir = remember(mkdtempSync(join(tmpdir(), "kiln-board-seed-")));
  appendEvent(dir, {
    job_id: repeated,
    event: "job.added",
    properties: { repo: "widget", workflow: "feature", title: "Repeat the type error" },
    ts: at(0, 1),
  });
  appendEvent(dir, {
    job_id: repeated,
    run_id: "run-r",
    event: "run.failed",
    properties: { class: "deterministic", fingerprint: FP },
    ts: at(0, 2),
  });
  appendEvent(dir, {
    job_id: capped,
    run_id: "run-c",
    event: "run.failed",
    properties: { class: "budget", fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ts: at(0, 3),
  });
  return dir;
}

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

function runCli(args: string[], cwd: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function startServe(cwd: string, home: string): Promise<{ url: string; child: ChildProcess }> {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", "--port", "0", "--no-tick"], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  children.push(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not listen\n${output.stdout}\n${output.stderr}`)), 10_000);
    child.stdout?.on("data", (chunk: string) => {
      output.stdout += chunk;
      const match = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ url: match[1], child });
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}\n${output.stdout}\n${output.stderr}`));
    });
  });
}

async function json(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function text(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}
