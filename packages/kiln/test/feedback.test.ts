import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { writeDelivery } from "../src/delivery.js";
import { readStatus, retryJob, runStatus, runTick } from "../src/driver.js";
import { readEvents } from "../src/events.js";
import { projectJob } from "../src/job-view.js";
import { ledgerRows } from "../src/ledger.js";
import {
  readFeedbackLedger,
  writeFeedbackLedger,
  type PullRequestFeedback,
} from "../src/feedback.js";
import { realGitRemote, type GitHubHost, type KilnHost, type PullRequestState } from "../src/host.js";
import { writeJob } from "../src/jobs.js";
import { renderConsole } from "../src/serve-page.js";

/**
 * Synthetic checkout and pull request only. No company repo, login, or token.
 * GitHub is a stub. The fix agent is a sleep process, not yak.
 */

const keep: string[] = [];
const children: ChildProcess[] = [];

after(() => {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

class ClosedGitHub implements GitHubHost {
  creates = 0;

  findByHead(): null {
    return null;
  }

  createDraft(): never {
    this.creates += 1;
    throw new Error("feedback must not open a pull request");
  }

  view(): { state: PullRequestState; mergedAt: string | null } {
    return { state: "OPEN", mergedAt: null };
  }
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initRepo(parent: string): { checkout: string; origin: string; head: string } {
  const origin = join(parent, "origin.git");
  const checkout = join(parent, "checkout");
  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "kiln-test@example.com"]);
  git(checkout, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(checkout, "README.md"), "Sample widget.\n");
  git(checkout, ["add", "README.md"]);
  git(checkout, ["commit", "-q", "-m", "initial"]);
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-q", "-u", "origin", "main"]);
  const head = git(checkout, ["rev-parse", "HEAD"]).trim();
  return { checkout, origin, head };
}

interface World {
  config: LoadedKilnConfig;
  checkout: string;
  origin: string;
  head: string;
  jobId: string;
  github: ClosedGitHub;
  reads: PullRequestFeedback[];
  starts: string[][];
  host: KilnHost;
}

interface WorldOptions {
  maxFixRounds?: number;
  test?: string;
  deliver?: "pr" | "local";
  prState?: PullRequestState;
}

function world(options: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), "kiln-feedback-"));
  keep.push(root);
  const { checkout, origin, head } = initRepo(root);
  const kilnDir = join(root, "kiln");
  mkdirSync(kilnDir, { recursive: true });
  const configPath = join(kilnDir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        adapter: "mock",
        maxConcurrent: 2,
        maxFixRounds: options.maxFixRounds ?? 2,
        repos: {
          sample: {
            path: checkout,
            test: options.test ?? "node --test test.mjs",
            deliver: options.deliver ?? "pr",
            base: "main",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const config = loadKilnConfig(configPath, { cwd: root, home: root });
  const written = writeJob(config, {
    id: "widget",
    workflow: "feature",
    repo: "sample",
    title: "Sample widget",
    specText: "Show the weekly summary for the sample widget.\n",
    dependsOn: [],
    source: { kind: "prompt", ref: "inline" },
    now: new Date("2026-10-26T00:00:00.000Z"),
  });
  const jobId = written.job.id;
  const runId = "base01";
  const runDir = join(checkout, ".runs", runId, "artifacts");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(checkout, ".runs", runId, "journal.jsonl"),
    [
      JSON.stringify({ t: "run.started", tag: `kiln:${jobId}`, pid: 1, at: "2026-10-26T00:00:00.000Z" }),
      JSON.stringify({ t: "run.finished", status: "ok", at: "2026-10-26T00:01:00.000Z" }),
      "",
    ].join("\n"),
  );
  writeFileSync(join(runDir, "approval.json"), `${JSON.stringify({ decision: "approve" })}\n`);
  writeDelivery(config.kilnDir, {
    jobId,
    runId,
    branch: `yak/${runId}`,
    base: "main",
    sha: head,
    pushed: true,
    prNumber: 4,
    prUrl: "https://example.com/sample/widget/pull/4",
  });
  const github = new ClosedGitHub();
  if (options.prState) {
    const state = options.prState;
    github.view = () => ({ state, mergedAt: state === "MERGED" ? "2026-10-26T00:30:00Z" : null });
  }
  const reads: PullRequestFeedback[] = [];
  const starts: string[][] = [];
  const feedback = {
    read(_checkout: string, prNumber: number): PullRequestFeedback {
      assert.equal(prNumber, 4);
      const snapshot = reads[0];
      assert.ok(snapshot, "a tick read feedback with no snapshot queued");
      return snapshot;
    },
  };
  const host: KilnHost = {
    github,
    git: realGitRemote,
    feedback,
    startAgent(spec) {
      starts.push(spec.args);
      const child = spawn("sleep", ["120"], { stdio: "ignore" });
      children.push(child);
      child.unref();
      return { pid: child.pid ?? 0 };
    },
  };
  return { config, checkout, origin, head, jobId, github, reads, starts, host };
}

function failingCheck(head: string): PullRequestFeedback {
  const noise = Array.from({ length: 80 }, () => "noise-line").join("\n");
  return {
    operatorLogin: "kiln-operator",
    headSha: head,
    checks: [
      {
        name: "sample-check",
        status: "completed",
        conclusion: "failure",
        url: "https://example.com/sample/widget/pull/4/checks/sample-check",
        logExcerpt: `HEAD-OF-LOG-SHOULD-DROP\n${noise}\nwidget missing`,
      },
    ],
    reviews: [],
    comments: [],
  };
}

describe("pull request feedback", { concurrency: 1 }, () => {
  it("starts one fix run for a failing check and ignores the same state on the next tick", () => {
    const box = world();
    box.reads.push(failingCheck(box.head));
    const first = runTick(box.config, box.host, { now: new Date("2026-10-26T01:00:00.000Z") });
    assert.match(first, /fix widget/);
    assert.equal(box.starts.length, 1);
    assert.equal(box.github.creates, 0);
    const args = box.starts[0] ?? [];
    const from = args.indexOf("--from");
    assert.equal(args[from + 1], box.head);
    const isolation = args.indexOf("--isolation");
    assert.equal(args[isolation + 1], "worktree");
    const tag = args.indexOf("--tag");
    assert.equal(args[tag + 1], "kiln:widget");
    assert.ok(args.some((arg) => arg.endsWith("fix.yaml")));
    assert.equal(args.includes("--force"), false);
    assert.equal(args.some((arg) => arg.includes("pr create")), false);
    const description = args.find((arg) => arg.startsWith("description=")) ?? "";
    assert.match(description, /Show the weekly summary for the sample widget/);
    assert.match(description, /sample-check failed/);
    assert.match(description, /widget missing/);
    assert.doesNotMatch(description, /HEAD-OF-LOG-SHOULD-DROP/);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds.length, 1);
    assert.equal(ledger.rounds[0]?.trigger, "ci");
    assert.equal(ledger.rounds[0]?.headSha, box.head);
    assert.equal(ledger.rounds[0]?.outcome, undefined);

    const second = runTick(box.config, box.host, { now: new Date("2026-10-26T01:00:05.000Z") });
    assert.match(second, /nothing to launch/);
    assert.equal(box.starts.length, 1);
    const again = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(again && again !== "corrupt");
    assert.equal(again.rounds.length, 1);
  });

  it("starts a round when a reviewer requests changes, including the comment file and line", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [{ name: "sample-check", status: "completed", conclusion: "success" }],
      reviews: [
        {
          id: "r1",
          author: "ada",
          state: "CHANGES_REQUESTED",
          body: "Rename the export.",
          submittedAt: "2026-10-26T02:00:00.000Z",
          url: "https://example.com/sample/widget/pull/4#pullrequestreview-1",
        },
      ],
      comments: [
        {
          id: "c1",
          author: "ada",
          body: "Use the public name.",
          path: "src/widget.ts",
          line: 12,
          submittedAt: "2026-10-26T02:00:01.000Z",
          url: "https://example.com/sample/widget/pull/4#discussion_r1",
          resolved: false,
        },
      ],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T02:05:00.000Z") });
    assert.match(tick, /fix widget/);
    assert.equal(box.starts.length, 1);
    const description = (box.starts[0] ?? []).find((arg) => arg.startsWith("description=")) ?? "";
    assert.match(description, /Rename the export/);
    assert.match(description, /src\/widget\.ts:12/);
    assert.match(description, /Use the public name/);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds[0]?.trigger, "review");
  });

  it("starts a round from the operator's inline comment", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [{ name: "sample-check", status: "completed", conclusion: "success" }],
      reviews: [],
      comments: [
        {
          id: "c-inline",
          author: "kiln-operator",
          body: "Rename the export.",
          path: "src/widget.ts",
          line: 12,
          submittedAt: "2026-10-26T03:00:00.000Z",
          url: "https://example.com/sample/widget/pull/4#discussion_r2",
          resolved: false,
        },
      ],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T03:05:00.000Z") });
    assert.match(tick, /fix widget/);
    assert.equal(box.starts.length, 1);
    const description = (box.starts[0] ?? []).find((arg) => arg.startsWith("description=")) ?? "";
    assert.match(description, /src\/widget\.ts:12/);
    assert.match(description, /Rename the export/);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds.length, 1);
    assert.equal(ledger.rounds[0]?.trigger, "review");
  });

  it("ignores an operator top-level LGTM and bot comments", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [{ name: "sample-check", status: "completed", conclusion: "success" }],
      reviews: [
        {
          id: "r-lgtm",
          author: "kiln-operator",
          state: "COMMENTED",
          body: "LGTM, merging tomorrow",
          submittedAt: "2026-10-26T03:10:00.000Z",
        },
      ],
      comments: [
        {
          id: "c-lgtm",
          author: "kiln-operator",
          body: "LGTM, merging tomorrow",
          submittedAt: "2026-10-26T03:10:01.000Z",
          resolved: false,
        },
        {
          id: "c-ada-note",
          author: "ada",
          body: "Looks good from here.",
          submittedAt: "2026-10-26T03:10:01.500Z",
          resolved: false,
        },
        {
          id: "c-bot",
          author: "kiln[bot]",
          body: "Posted by the factory.",
          path: "src/widget.ts",
          line: 4,
          submittedAt: "2026-10-26T03:10:02.000Z",
          resolved: false,
        },
        {
          id: "c-other-bot",
          author: "reviewer[bot]",
          body: "Also ignore this.",
          path: "src/widget.ts",
          line: 8,
          submittedAt: "2026-10-26T03:10:03.000Z",
          resolved: false,
        },
      ],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T03:15:00.000Z") });
    assert.match(tick, /nothing to launch/);
    assert.equal(box.starts.length, 0);
    assert.equal(readFeedbackLedger(box.config.kilnDir, box.jobId), undefined);
    assert.match(runStatus(box.config, box.jobId, box.host), /in-review/);
  });

  it("starts a round from an operator /kiln note and strips the prefix", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [{ name: "sample-check", status: "completed", conclusion: "success" }],
      reviews: [],
      comments: [
        {
          id: "c-cmd",
          author: "kiln-operator",
          body: "/kiln fix the empty state copy",
          submittedAt: "2026-10-26T03:20:00.000Z",
          url: "https://example.com/sample/widget/pull/4#issuecomment-1",
          resolved: false,
        },
      ],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T03:25:00.000Z") });
    assert.match(tick, /fix widget/);
    assert.equal(box.starts.length, 1);
    const description = (box.starts[0] ?? []).find((arg) => arg.startsWith("description=")) ?? "";
    assert.match(description, /fix the empty state copy/);
    assert.doesNotMatch(description, /\/kiln/);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds[0]?.items[0]?.summary, "fix the empty state copy");
  });

  it("does not start a round from a resolved operator thread", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [{ name: "sample-check", status: "completed", conclusion: "success" }],
      reviews: [],
      comments: [
        {
          id: "c-resolved",
          author: "kiln-operator",
          body: "Rename the export.",
          path: "src/widget.ts",
          line: 12,
          submittedAt: "2026-10-26T03:30:00.000Z",
          resolved: true,
        },
      ],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T03:35:00.000Z") });
    assert.match(tick, /nothing to launch/);
    assert.equal(box.starts.length, 0);
    assert.equal(readFeedbackLedger(box.config.kilnDir, box.jobId), undefined);
    assert.match(runStatus(box.config, box.jobId, box.host), /in-review/);
  });

  it("moves the job to needs-human once maxFixRounds is used", () => {
    const box = world({ maxFixRounds: 2 });
    const older = "a".repeat(40);
    const previous = "b".repeat(40);
    writeFeedbackLedger(box.config.kilnDir, {
      jobId: box.jobId,
      rounds: [
        {
          round: 1,
          headSha: older,
          trigger: "ci",
          items: [{ kind: "check", source: `check:${older}:sample-check`, summary: "sample-check failed" }],
          at: "2026-10-26T04:00:00.000Z",
          outcome: "pushed",
          fixRunId: "fix01",
        },
        {
          round: 2,
          headSha: previous,
          trigger: "review",
          items: [{ kind: "review", source: "review:r9", summary: "Changes requested" }],
          at: "2026-10-26T05:00:00.000Z",
          outcome: "fixed",
          fixRunId: "fix02",
        },
      ],
    });
    box.reads.push(failingCheck("c".repeat(40)));
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T06:00:00.000Z") });
    assert.match(tick, /feedback-exhausted widget/);
    assert.equal(box.starts.length, 0);
    assert.equal(box.github.creates, 0);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.exhausted, true);
    assert.equal(ledger.rounds.length, 2);
    const status = readStatus(box.config, box.jobId, box.host);
    assert.equal(status.jobs[0]?.state, "needs-human");
    assert.equal(status.jobs[0]?.feedbackReason, "feedback-exhausted");
    assert.match(runStatus(box.config, box.jobId, box.host), /reason feedback-exhausted/);
  });

  it("leaves the job in review when CI is green and nothing was requested", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [
        { name: "sample-check", status: "completed", conclusion: "success" },
        { name: "still-running", status: "in_progress", conclusion: null },
      ],
      reviews: [],
      comments: [],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T07:00:00.000Z") });
    assert.match(tick, /nothing to launch/);
    assert.equal(box.starts.length, 0);
    assert.equal(readFeedbackLedger(box.config.kilnDir, box.jobId), undefined);
    const status = readStatus(box.config, box.jobId, box.host);
    assert.equal(status.jobs[0]?.state, "in-review");
  });

  it("fast-forwards the pull request branch when the fix run finishes, and refuses a force push", () => {
    const box = world();
    const remoteName = "kiln/sample-widget-widget";
    writeDelivery(box.config.kilnDir, {
      jobId: box.jobId,
      runId: "base01",
      branch: remoteName,
      base: "main",
      sha: box.head,
      pushed: true,
      prNumber: 4,
      prUrl: "https://example.com/sample/widget/pull/4",
    });
    git(box.checkout, ["branch", "yak/base01", "HEAD"]);
    git(box.checkout, ["push", "-q", "origin", `yak/base01:${remoteName}`]);
    const work = mkdtempSync(join(tmpdir(), "kiln-fix-wt-"));
    keep.push(work);
    git(box.checkout, ["worktree", "add", "-q", "-b", "yak/fix01", work, "HEAD"]);
    writeFileSync(join(work, "widget.txt"), "fixed\n");
    git(work, ["add", "widget.txt"]);
    git(work, ["commit", "-q", "-m", "kiln: Sample widget"]);
    const fixSha = git(work, ["rev-parse", "HEAD"]).trim();
    git(box.checkout, ["worktree", "remove", "--force", work]);

    const fixDir = join(box.checkout, ".runs", "fix01");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(
      join(fixDir, "journal.jsonl"),
      [
        JSON.stringify({ t: "run.started", tag: "kiln:widget", pid: 1, at: "2026-10-26T08:00:00.000Z" }),
        JSON.stringify({ t: "run.finished", status: "ok", at: "2026-10-26T08:05:00.000Z" }),
        "",
      ].join("\n"),
    );
    writeFeedbackLedger(box.config.kilnDir, {
      jobId: box.jobId,
      rounds: [
        {
          round: 1,
          headSha: box.head,
          trigger: "ci",
          items: [{ kind: "check", source: `check:${box.head}:sample-check`, summary: "sample-check failed" }],
          fixRunId: "fix01",
          at: "2026-10-26T08:00:00.000Z",
        },
      ],
    });
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: fixSha,
      checks: [{ name: "sample-check", status: "in_progress", conclusion: null }],
      reviews: [],
      comments: [],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T08:06:00.000Z") });
    assert.match(tick, /pushed widget/);
    assert.equal(box.starts.length, 0);
    assert.equal(box.github.creates, 0);
    const published = git(box.checkout, ["ls-remote", "origin", `refs/heads/${remoteName}`]).split(/\s+/)[0];
    assert.equal(published, fixSha);
    assert.equal(git(box.checkout, ["ls-remote", "origin", "refs/heads/yak/fix01"]).trim(), "");
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds[0]?.outcome, "pushed");

    git(box.checkout, ["branch", "yak/old01", box.head]);
    assert.throws(
      () => realGitRemote.publishBranch(box.checkout, "yak/old01", remoteName, "main"),
      /non-fast-forward|rejected|Could not push/,
    );
    assert.throws(
      () => realGitRemote.publishBranch(box.checkout, "main", "yak/base01", "main"),
      /base branch/,
    );
    assert.throws(
      () => realGitRemote.publishBranch(box.checkout, "yak/base01", "main", "main"),
      /base branch/,
    );
    const still = git(box.checkout, ["ls-remote", "origin", `refs/heads/${remoteName}`]).split(/\s+/)[0];
    assert.equal(still, fixSha);
  });

  it("renders feedback rounds on the PR review card and Needs a decision only when exhausted", () => {
    const box = world();
    writeFeedbackLedger(box.config.kilnDir, {
      jobId: box.jobId,
      rounds: [
        {
          round: 1,
          headSha: box.head,
          trigger: "ci",
          items: [
            {
              kind: "check",
              source: `check:${box.head}:sample-check`,
              summary: "sample-check failed\n\nwidget missing",
              url: "https://example.com/sample/widget/pull/4/checks/sample-check",
            },
          ],
          outcome: "pushed",
          fixRunId: "fix01",
          at: "2026-10-26T08:00:00.000Z",
        },
        {
          round: 2,
          headSha: box.head,
          trigger: "review",
          items: [
            {
              kind: "comment",
              source: "comment:c1",
              summary: "src/widget.ts:12\n\nUse the public name.",
              url: "https://example.com/sample/widget/pull/4#discussion_r1",
            },
          ],
          outcome: "fixed",
          fixRunId: "fix02",
          at: "2026-10-26T09:00:00.000Z",
        },
      ],
    });
    const open = readStatus(box.config, box.jobId, box.host);
    const openHtml = renderConsole("", buildAttention(open.jobs), { csrf: "", repos: [], workflows: [], section: "repos" });
    assert.match(openHtml, /CI failed · pushed/);
    assert.match(openHtml, /changes requested · fixed/);
    assert.match(openHtml, /https:\/\/example\.com\/sample\/widget\/pull\/4\/checks\/sample-check/);
    assert.match(openHtml, /data-state="in-review"/);
    assert.match(openHtml, /PR review/);
    assert.doesNotMatch(openHtml, /Needs a decision/);

    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    writeFeedbackLedger(box.config.kilnDir, { ...ledger, exhausted: true });
    const closed = readStatus(box.config, box.jobId, box.host);
    const closedHtml = renderConsole("", buildAttention(closed.jobs), { csrf: "", repos: [], workflows: [], section: "hand" });
    assert.equal(closed.jobs[0]?.state, "needs-human");
    assert.match(closedHtml, /Needs a decision/);
    assert.match(closedHtml, /data-state="needs-human"/);
    assert.match(closedHtml, /Fix round cap/);
  });
});

const PR_BRANCH = "kiln/sample-widget";

/**
 * Open pull request on `kiln/sample-widget` that changed `widget.txt`. Then the base moves:
 * `same` edits that line too, `other` edits a different file.
 */
function conflictWorld(change: "same" | "other", options: WorldOptions = {}): World & { prHead: string } {
  const box = world(options);
  writeFileSync(join(box.checkout, "widget.txt"), "base\n");
  git(box.checkout, ["add", "widget.txt"]);
  git(box.checkout, ["commit", "-q", "-m", "widget"]);
  git(box.checkout, ["push", "-q", "origin", "main"]);
  git(box.checkout, ["checkout", "-q", "-b", "pr-work"]);
  writeFileSync(join(box.checkout, "widget.txt"), "from the pull request\n");
  git(box.checkout, ["commit", "-q", "-am", "pull request change"]);
  const prHead = git(box.checkout, ["rev-parse", "HEAD"]).trim();
  git(box.checkout, ["push", "-q", "origin", `HEAD:refs/heads/${PR_BRANCH}`]);
  git(box.checkout, ["checkout", "-q", "main"]);
  if (change === "same") {
    writeFileSync(join(box.checkout, "widget.txt"), "from the base\n");
    git(box.checkout, ["commit", "-q", "-am", "base change"]);
  } else {
    writeFileSync(join(box.checkout, "other.txt"), "base only\n");
    git(box.checkout, ["add", "other.txt"]);
    git(box.checkout, ["commit", "-q", "-m", "base change"]);
  }
  git(box.checkout, ["push", "-q", "origin", "main"]);
  writeDelivery(box.config.kilnDir, {
    jobId: box.jobId,
    runId: "base01",
    branch: PR_BRANCH,
    base: "main",
    sha: prHead,
    pushed: true,
    prNumber: 4,
    prUrl: "https://example.com/sample/widget/pull/4",
  });
  return { ...box, prHead };
}

/** `null` leaves `mergeable` out, the way an older gh answer would. */
function conflicting(headSha: string, mergeable: PullRequestFeedback["mergeable"] | null = "CONFLICTING"): PullRequestFeedback {
  return {
    operatorLogin: "kiln-operator",
    headSha,
    checks: [],
    reviews: [],
    comments: [],
    ...(mergeable ? { mergeable } : {}),
    base: "main",
  };
}

function originHead(box: World): string {
  return git(box.checkout, ["ls-remote", "origin", `refs/heads/${PR_BRANCH}`]).split(/\s+/)[0] ?? "";
}

function eventsNamed(box: World, name: string) {
  return readEvents(box.config.kilnDir, { warn: () => {} }).filter((event) => event.event === name);
}

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "console.log('BOOM-TEST-OUTPUT'); process.exit(1)"`;

describe("pull request conflicts with the base", { concurrency: 1 }, () => {
  it("starts one conflict round naming the base and the file, and nothing more on the same head", () => {
    const box = conflictWorld("same", { test: PASS });
    box.reads.push(conflicting(box.prHead));
    const first = runTick(box.config, box.host, { now: new Date("2026-10-27T01:00:00.000Z") });
    assert.match(first, /fix widget/);
    assert.equal(box.starts.length, 1);
    assert.equal(originHead(box), box.prHead);
    const conflicted = eventsNamed(box, "pr.conflicted");
    assert.equal(conflicted.length, 1);
    assert.deepEqual(conflicted[0]?.properties, {
      headSha: box.prHead,
      base: "main",
      once: `pr.conflicted:${box.prHead}`,
    });
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds.length, 1);
    assert.equal(ledger.rounds[0]?.trigger, "conflict");
    assert.equal(ledger.rounds[0]?.headSha, box.prHead);
    assert.deepEqual(ledger.conflict, { headSha: box.prHead, base: "main", files: ["widget.txt"] });
    const description = (box.starts[0] ?? []).find((arg) => arg.startsWith("description=")) ?? "";
    assert.match(description, /git merge origin\/main/);
    assert.match(description, /Do not rebase/);
    assert.match(description, /Conflicts with main/);
    assert.match(description, /widget\.txt/);

    const status = readStatus(box.config, box.jobId, box.host);
    const job = status.jobs[0];
    assert.ok(job);
    const view = projectJob(job, readEvents(box.config.kilnDir, { warn: () => {} }));
    assert.equal(view.column, "running");
    assert.equal(view.reason, "Conflicts with main, fixing");
    assert.equal(buildAttention(status.jobs).needsYouCount, 0);

    box.reads[0] = conflicting(box.prHead);
    runTick(box.config, box.host, { now: new Date("2026-10-27T01:00:05.000Z") });
    assert.equal(box.starts.length, 1);
    const again = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(again && again !== "corrupt");
    assert.equal(again.rounds.length, 1);
    assert.equal(eventsNamed(box, "pr.conflicted").length, 1);
  });

  it("merges a base that changed another file, runs the tests, and pushes with no agent", () => {
    const box = conflictWorld("other", { test: PASS });
    box.reads.push(conflicting(box.prHead));
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-27T02:00:00.000Z") });
    assert.match(tick, /merged main into widget/);
    assert.equal(box.starts.length, 0);
    assert.equal(readFeedbackLedger(box.config.kilnDir, box.jobId), undefined);
    const pushed = originHead(box);
    assert.notEqual(pushed, box.prHead);
    git(box.checkout, ["fetch", "-q", "origin"]);
    assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", box.prHead, pushed], { cwd: box.checkout }).status, 0);
    const mainHead = git(box.checkout, ["rev-parse", "origin/main"]).trim();
    const parents = git(box.checkout, ["rev-list", "--parents", "-n", "1", pushed]).trim().split(" ").slice(1);
    assert.deepEqual(parents, [box.prHead, mainHead]);
    const updated = eventsNamed(box, "pr.updated");
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0]?.properties, { from: box.prHead, sha: pushed, agent: false, once: `pr.updated:${pushed}` });
    assert.equal(git(box.checkout, ["worktree", "list"]).trim().split("\n").length, 1);
    const status = readStatus(box.config, box.jobId, box.host);
    assert.equal(status.jobs[0]?.state, "in-review");
    assert.equal(status.jobs[0]?.prConflict, undefined);
  });

  it("starts a conflict round with the failing output when the merge is clean but the tests fail", () => {
    const box = conflictWorld("other", { test: FAIL });
    box.reads.push(conflicting(box.prHead));
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-27T03:00:00.000Z") });
    assert.match(tick, /fix widget/);
    assert.equal(box.starts.length, 1);
    assert.equal(originHead(box), box.prHead);
    assert.equal(eventsNamed(box, "pr.updated").length, 0);
    const description = (box.starts[0] ?? []).find((arg) => arg.startsWith("description=")) ?? "";
    assert.match(description, /Tests failed after merging main/);
    assert.match(description, /BOOM-TEST-OUTPUT/);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds[0]?.trigger, "conflict");
  });

  it("changes nothing on UNKNOWN, a missing answer, or a failed read, and reads again next tick", () => {
    for (const mergeable of ["UNKNOWN", null] as const) {
      const box = conflictWorld("same", { test: PASS });
      box.reads.push(conflicting(box.prHead, mergeable));
      runTick(box.config, box.host, { now: new Date("2026-10-27T04:00:00.000Z") });
      runTick(box.config, box.host, { now: new Date("2026-10-27T04:00:05.000Z") });
      assert.equal(box.starts.length, 0);
      assert.equal(readFeedbackLedger(box.config.kilnDir, box.jobId), undefined);
      assert.equal(eventsNamed(box, "pr.conflicted").length, 0);
      assert.equal(originHead(box), box.prHead);
    }
    const box = conflictWorld("same", { test: PASS });
    let reads = 0;
    box.host.feedback = {
      read() {
        reads += 1;
        throw new Error("gh is down");
      },
    };
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-27T04:10:00.000Z") });
    assert.match(tick, /feedback widget failed: gh is down/);
    runTick(box.config, box.host, { now: new Date("2026-10-27T04:10:05.000Z") });
    assert.equal(reads, 2);
    assert.equal(box.starts.length, 0);
    assert.equal(readFeedbackLedger(box.config.kilnDir, box.jobId), undefined);
    assert.equal(eventsNamed(box, "pr.conflicted").length, 0);
  });

  it("never reads or merges a merged, closed, or deliver=local job", () => {
    for (const options of [{ prState: "MERGED" }, { prState: "CLOSED" }, { deliver: "local" }] as const) {
      const box = conflictWorld("other", { test: PASS, ...options });
      let reads = 0;
      box.host.feedback = {
        read() {
          reads += 1;
          return conflicting(box.prHead);
        },
      };
      runTick(box.config, box.host, { now: new Date("2026-10-27T05:00:00.000Z") });
      assert.equal(reads, 0, JSON.stringify(options));
      assert.equal(originHead(box), box.prHead);
      assert.equal(eventsNamed(box, "pr.conflicted").length, 0);
    }
  });

  it("stops at needs-human pr-conflict after maxFixRounds, and kiln retry lets a round start again", () => {
    const box = conflictWorld("same", { test: PASS, maxFixRounds: 1 });
    const older = "a".repeat(40);
    writeFeedbackLedger(box.config.kilnDir, {
      jobId: box.jobId,
      rounds: [
        {
          round: 1,
          headSha: older,
          trigger: "conflict",
          items: [{ kind: "conflict", source: `conflict:${older}`, summary: "Conflicts with main" }],
          at: "2026-10-27T05:00:00.000Z",
          outcome: "pushed",
          fixRunId: "fix01",
        },
      ],
    });
    box.reads.push(conflicting(box.prHead));
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-27T06:00:00.000Z") });
    assert.match(tick, /pr-conflict widget/);
    assert.equal(box.starts.length, 0);
    const status = readStatus(box.config, box.jobId, box.host);
    const job = status.jobs[0];
    assert.ok(job);
    assert.equal(job.state, "needs-human");
    assert.equal(job.feedbackReason, "pr-conflict");
    const view = projectJob(job, readEvents(box.config.kilnDir, { warn: () => {} }));
    assert.equal(view.column, "needs-hand");
    assert.equal(view.reason, "Conflicts with main: widget.txt");
    assert.equal(view.retry, true);
    const hand = renderConsole("", buildAttention(status.jobs), { csrf: "", repos: [], workflows: [], section: "hand" });
    assert.match(hand, /Conflicts with main: widget\.txt/);
    const needsHuman = eventsNamed(box, "needs-human");
    assert.equal(needsHuman.length, 1);

    runTick(box.config, box.host, { now: new Date("2026-10-27T06:00:05.000Z") });
    assert.equal(box.starts.length, 0);

    const retried = retryJob(box.config, box.jobId, box.host);
    assert.match(retried, /retry widget/);
    const cleared = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(cleared && cleared !== "corrupt");
    assert.equal(cleared.exhausted, undefined);
    assert.equal(cleared.conflict, undefined);
    assert.equal(cleared.retryFrom, 1);
    assert.equal(box.starts.length, 0);

    const next = runTick(box.config, box.host, { now: new Date("2026-10-27T06:10:00.000Z") });
    assert.match(next, /fix widget/);
    assert.equal(box.starts.length, 1);
    const reopened = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(reopened && reopened !== "corrupt");
    assert.equal(reopened.rounds.length, 2);
    assert.equal(reopened.rounds[1]?.trigger, "conflict");
  });

  it("keeps a recorded conflict out of needs-you and out of the intervention ledger", () => {
    const box = conflictWorld("same", { test: PASS });
    writeFeedbackLedger(box.config.kilnDir, {
      jobId: box.jobId,
      rounds: [],
      conflict: { headSha: box.prHead, base: "main", files: ["widget.txt"] },
    });
    const status = readStatus(box.config, box.jobId, box.host);
    const job = status.jobs[0];
    assert.ok(job);
    assert.equal(job.state, "in-review");
    const attention = buildAttention(status.jobs);
    assert.equal(attention.needsYouCount, 0);
    assert.equal(attention.inFlight.length, 1);
    assert.equal(attention.inFlight[0]?.reason, "Conflicts with main, fixing");
    const view = projectJob(job, []);
    assert.equal(view.column, "running");
    assert.equal(view.reason, "Conflicts with main, fixing");

    const other = conflictWorld("other", { test: PASS });
    other.reads.push(conflicting(other.prHead));
    runTick(other.config, other.host, { now: new Date("2026-10-27T07:00:00.000Z") });
    const events = readEvents(other.config.kilnDir, { warn: () => {} });
    assert.ok(events.some((event) => event.event === "pr.conflicted"));
    assert.ok(events.some((event) => event.event === "pr.updated"));
    assert.deepEqual(ledgerRows(events), []);
  });
});
