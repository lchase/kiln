import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { writeDelivery } from "../src/delivery.js";
import { readStatus, runStatus, runTick } from "../src/driver.js";
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

function world(options: { maxFixRounds?: number } = {}): World {
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
            test: "node --test test.mjs",
            deliver: "pr",
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

  it("ignores comments from the operator and from kiln", () => {
    const box = world();
    box.reads.push({
      operatorLogin: "kiln-operator",
      headSha: box.head,
      checks: [{ name: "sample-check", status: "completed", conclusion: "success" }],
      reviews: [
        {
          id: "r-self",
          author: "kiln-operator",
          state: "CHANGES_REQUESTED",
          body: "I left this on my own pull request.",
          submittedAt: "2026-10-26T03:00:00.000Z",
        },
      ],
      comments: [
        {
          id: "c-bot",
          author: "kiln[bot]",
          body: "Posted by the factory.",
          path: "src/widget.ts",
          line: 4,
          submittedAt: "2026-10-26T03:00:01.000Z",
          resolved: false,
        },
      ],
    });
    const tick = runTick(box.config, box.host, { now: new Date("2026-10-26T03:05:00.000Z") });
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
    git(box.checkout, ["branch", "yak/base01", "HEAD"]);
    git(box.checkout, ["push", "-q", "origin", "yak/base01"]);
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
    const published = git(box.checkout, ["ls-remote", "origin", "refs/heads/yak/base01"]).split(/\s+/)[0];
    assert.equal(published, fixSha);
    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    assert.equal(ledger.rounds[0]?.outcome, "pushed");

    git(box.checkout, ["branch", "yak/old01", box.head]);
    assert.throws(
      () => realGitRemote.publishBranch(box.checkout, "yak/old01", "yak/base01", "main"),
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
    const still = git(box.checkout, ["ls-remote", "origin", "refs/heads/yak/base01"]).split(/\s+/)[0];
    assert.equal(still, fixSha);
  });

  it("renders feedback rounds on the PR review card and your call only when exhausted", () => {
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
    const openHtml = renderConsole("", buildAttention(open.jobs));
    assert.match(openHtml, /CI failed · pushed/);
    assert.match(openHtml, /changes requested · fixed/);
    assert.match(openHtml, /https:\/\/example\.com\/sample\/widget\/pull\/4\/checks\/sample-check/);
    assert.match(openHtml, /data-stage="pr-review"/);
    assert.match(openHtml, /R1 CI\.md/);
    assert.doesNotMatch(openHtml, /your call/);
    assert.doesNotMatch(openHtml, /chip[^>]*>PR review</);

    const ledger = readFeedbackLedger(box.config.kilnDir, box.jobId);
    assert.ok(ledger && ledger !== "corrupt");
    writeFeedbackLedger(box.config.kilnDir, { ...ledger, exhausted: true });
    const closed = readStatus(box.config, box.jobId, box.host);
    const closedHtml = renderConsole("", buildAttention(closed.jobs));
    assert.equal(closed.jobs[0]?.state, "needs-human");
    assert.match(closedHtml, /your call/);
    assert.match(closedHtml, /data-stage="needs-human"/);
    assert.match(closedHtml, /feedback-exhausted/);
  });
});
