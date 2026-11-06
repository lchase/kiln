import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildBoard } from "../src/board-view.js";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { answerJob, readStatus, reviseJob, runTick } from "../src/driver.js";
import { readEvents } from "../src/events.js";
import {
  realGitHub,
  realGitRemote,
  submitCommentReview,
  type GitHubHost,
  type KilnHost,
  type PullRequestCommentReview,
  type ReviewRequest,
} from "../src/host.js";
import { pauseFactory, resumeFactory } from "../src/rails.js";
import { buildCommentReview, parseReviewDraft, postApprovedReview } from "../src/review-post.js";

const keep: string[] = [];
const SHA = "abc1234abc1234abc1234abc1234abc1234abc12";

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  keep.push(dir);
  return dir;
}

function draftFile(checkout: string, runId: string, draft: unknown): void {
  const dir = join(checkout, ".runs", runId, "artifacts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), `${JSON.stringify(draft)}\n`);
}

class RecordingGitHub implements GitHubHost {
  readonly calls: PullRequestCommentReview[] = [];
  creates = 0;
  fail: Error | undefined;

  findByHead(): null {
    return null;
  }

  createDraft(): never {
    this.creates += 1;
    throw new Error("refusing to create, approve, or merge a pull request");
  }

  view(): { state: "OPEN"; mergedAt: null } {
    return { state: "OPEN", mergedAt: null };
  }

  postCommentReview(input: PullRequestCommentReview) {
    this.calls.push(input);
    if (this.fail) throw this.fail;
    return { id: "4242", url: "https://example.com/sample/pull/7#pullrequestreview-4242" };
  }
}

function hostFor(github: GitHubHost, reviews?: ReviewRequest[]): KilnHost {
  return {
    github,
    git: realGitRemote,
    ...(reviews ? { reviews: { list: () => reviews } } : {}),
  };
}

function inputFor(kilnDir: string, checkout: string, github: GitHubHost, extra: { paused?: boolean; spendBlocked?: boolean; sourceRef?: string } = {}) {
  return {
    kilnDir,
    jobId: "job-sample",
    runId: "run-sample",
    repo: "web",
    sourceRef: extra.sourceRef === undefined ? `review:web:7:${SHA}` : extra.sourceRef,
    checkout,
    host: hostFor(github),
    paused: extra.paused === true,
    spendBlocked: extra.spendBlocked === true,
  };
}

const warning = "Name the empty state before rendering it.";
const nit = "Prefer a named constant for the delay.";
const unlocated = "Say what is unconfirmed.";

function sampleDraft(includeUnlocatedInMarkdown: boolean) {
  const markdown = [
    "# Draft review: Sample heading",
    "",
    `**warning** src/sample.ts:12 — ${warning}`,
    `**nit** src/sample.ts:14 — ${nit}`,
    ...(includeUnlocatedInMarkdown ? [`**note** — ${unlocated}`] : []),
    "",
  ].join("\n");
  return {
    markdown,
    findings: [
      { severity: "warning", file: "src/sample.ts", line: 12, comment: warning },
      { severity: "nit", file: "src/sample.ts", line: 14, comment: nit },
      { severity: "note", file: " ", line: 1, comment: unlocated },
      { severity: "note", comment: "No file was cited." },
    ],
  };
}

describe("comment review body", () => {
  it("posts located findings inline and folds the rest into the body", () => {
    const draft = parseReviewDraft(sampleDraft(false));
    assert.ok(draft);
    const review = buildCommentReview(draft);
    assert.equal(review.findings, 4);
    assert.equal(review.inline, 2);
    assert.equal(review.skipped, 2);
    assert.deepEqual(
      review.comments.map((comment) => comment.path),
      ["src/sample.ts", "src/sample.ts"],
    );
    assert.deepEqual(
      review.comments.map((comment) => comment.line),
      [12, 14],
    );
    assert.match(review.comments[0]?.body ?? "", /^\*\*warning\*\*\n\nName the empty state/);
    assert.match(review.comments[1]?.body ?? "", /^\*\*nit\*\* \(not blocking\)/);
    assert.equal((review.comments[1]?.body ?? "").startsWith("**blocking**"), false);
    assert.match(review.body, /## Not posted on a line/);
    assert.match(review.body, /Say what is unconfirmed/);
    assert.match(review.body, /No file was cited/);
    assert.equal(review.body.split(unlocated).length - 1, 1);
  });

  it("does not repeat a finding the markdown already includes", () => {
    const draft = parseReviewDraft(sampleDraft(true));
    assert.ok(draft);
    const review = buildCommentReview(draft);
    assert.equal(review.body.split(unlocated).length - 1, 1);
    assert.equal(review.body.includes("## Not posted on a line"), true);
    assert.match(review.body, /No file was cited/);
  });

  it("still builds a body when every finding lacks a location", () => {
    const review = buildCommentReview({
      markdown: "No line to cite.\n",
      findings: [{ severity: "note", comment: "Describe the empty state." }],
    });
    assert.equal(review.comments.length, 0);
    assert.match(review.body, /No line to cite/);
    assert.match(review.body, /Describe the empty state/);
  });

  it("ignores absolute paths and parent segments and keeps a leading dot-slash", () => {
    const review = buildCommentReview({
      markdown: "Draft.\n",
      findings: [
        { severity: "warning", file: "/etc/passwd", line: 1, comment: "Do not cite this." },
        { severity: "warning", file: "../secret.ts", line: 2, comment: "Do not walk up." },
        { severity: "warning", file: "./src/sample.ts", line: 4, comment: "Keep the relative path." },
      ],
    });
    assert.equal(review.inline, 1);
    assert.equal(review.comments[0]?.path, "src/sample.ts");
    assert.match(review.body, /Do not cite this/);
    assert.match(review.body, /Do not walk up/);
  });
});

describe("postApprovedReview", () => {
  it("posts one COMMENT review and records review.posted", () => {
    const kilnDir = tempDir("kiln-post-");
    const checkout = tempDir("kiln-checkout-");
    draftFile(checkout, "run-sample", sampleDraft(true));
    const github = new RecordingGitHub();
    postApprovedReview(inputFor(kilnDir, checkout, github));
    assert.equal(github.calls.length, 1);
    assert.equal(github.creates, 0);
    const call = github.calls[0];
    assert.equal(call?.number, 7);
    assert.equal(call?.commitId, SHA);
    assert.equal(call?.comments.length, 2);
    const posted = readEvents(kilnDir, { warn: () => {} }).filter((event) => event.event === "review.posted");
    assert.equal(posted.length, 1);
    if (posted[0]?.event !== "review.posted") return;
    assert.equal(posted[0].properties.repo, "web");
    assert.equal(posted[0].properties.number, 7);
    assert.equal(posted[0].properties.sha, SHA);
    assert.equal(posted[0].properties.review_id, "4242");
    assert.equal(posted[0].properties.url, "https://example.com/sample/pull/7#pullrequestreview-4242");
    assert.equal(posted[0].properties.findings, 4);
    assert.equal(posted[0].properties.inline, 2);
    assert.equal(posted[0].properties.skipped, 2);
    assert.equal(posted[0].properties.dedupe, `review:web:7:${SHA}`);
    const raw = JSON.stringify(github.calls);
    assert.equal(raw.includes("APPROVE"), false);
    assert.equal(raw.includes("REQUEST_CHANGES"), false);
    assert.equal(raw.includes("merge"), false);
  });

  it("does not post again for the same head SHA", () => {
    const kilnDir = tempDir("kiln-post-");
    const checkout = tempDir("kiln-checkout-");
    draftFile(checkout, "run-sample", sampleDraft(true));
    const github = new RecordingGitHub();
    const input = inputFor(kilnDir, checkout, github);
    postApprovedReview(input);
    postApprovedReview({ ...input, jobId: "job-again", runId: "run-again" });
    assert.equal(github.calls.length, 1);
    const posted = readEvents(kilnDir, { warn: () => {} }).filter((event) => event.event === "review.posted");
    assert.equal(posted.length, 1);
  });

  it("records a classified failure and does not claim success", () => {
    const kilnDir = tempDir("kiln-post-");
    const checkout = tempDir("kiln-checkout-");
    draftFile(checkout, "run-sample", sampleDraft(true));
    const github = new RecordingGitHub();
    github.fail = new Error("502 Bad Gateway ghp_abcdefghijklmnopqrstuvwxyz123456");
    assert.throws(() => postApprovedReview(inputFor(kilnDir, checkout, github)), /Could not post the review \(transient\)/);
    assert.equal(github.calls.length, 1);
    assert.equal(github.creates, 0);
    const events = readEvents(kilnDir, { warn: () => {} });
    const failed = events.filter((event) => event.event === "review.failed");
    const posted = events.filter((event) => event.event === "review.posted");
    const human = events.filter((event) => event.event === "needs-human");
    assert.equal(posted.length, 0);
    assert.equal(failed.length, 1);
    if (failed[0]?.event !== "review.failed") return;
    assert.equal(failed[0].properties.class, "transient");
    assert.match(failed[0].properties.detail, /502 Bad Gateway/);
    assert.equal(failed[0].properties.detail.includes("ghp_"), false);
    assert.equal(human.some((event) => event.event === "needs-human" && event.properties.reason === "review-post"), true);
    const raw = readFileSync(join(kilnDir, "events.jsonl"), "utf8");
    assert.equal(raw.includes("ghp_"), false);
    assert.equal(raw.includes("APPROVE"), false);
  });

  it("does not call gh while paused or over the daily cap", () => {
    const kilnDir = tempDir("kiln-post-");
    const checkout = tempDir("kiln-checkout-");
    draftFile(checkout, "run-sample", sampleDraft(true));
    const paused = new RecordingGitHub();
    assert.throws(() => postApprovedReview(inputFor(kilnDir, checkout, paused, { paused: true })), /Paused/);
    assert.equal(paused.calls.length, 0);
    const capped = new RecordingGitHub();
    assert.throws(() => postApprovedReview(inputFor(kilnDir, checkout, capped, { spendBlocked: true })), /Daily cap/);
    assert.equal(capped.calls.length, 0);
    const names = readEvents(kilnDir, { warn: () => {} }).map((event) => event.event);
    assert.equal(names.includes("review.posted"), false);
    assert.equal(names.includes("review.failed"), false);
  });

  it("redacts a token in the review body before it is posted", () => {
    const kilnDir = tempDir("kiln-post-");
    const checkout = tempDir("kiln-checkout-");
    draftFile(checkout, "run-sample", {
      markdown: "Token ghp_abcdefghijklmnopqrstuvwxyz123456 in the draft.\n",
      findings: [{ severity: "warning", file: "src/sample.ts", line: 3, comment: "Drop ghp_abcdefghijklmnopqrstuvwxyz123456." }],
    });
    const github = new RecordingGitHub();
    postApprovedReview(inputFor(kilnDir, checkout, github));
    const raw = JSON.stringify(github.calls);
    assert.equal(raw.includes("ghp_"), false);
    assert.match(raw, /\[redacted\]/);
  });
});

describe("gh review command", () => {
  it("submits event COMMENT and never approve or merge", () => {
    const dir = tempDir("kiln-gh-");
    const log = join(dir, "gh.log");
    const body = join(dir, "body.json");
    const bin = join(dir, "gh");
    writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "repo" ]; then
  printf '%s\\n' "sample/widget"
  exit 0
fi
cat > "$GH_BODY"
printf '%s\\n' '{"id":4242,"html_url":"https://example.com/sample/pull/7#pullrequestreview-4242"}'
`,
    );
    spawnSync("chmod", ["+x", bin]);
    const previousGh = process.env.KILN_GH;
    const previousLog = process.env.GH_LOG;
    const previousBody = process.env.GH_BODY;
    process.env.KILN_GH = bin;
    process.env.GH_LOG = log;
    process.env.GH_BODY = body;
    try {
      const posted = submitCommentReview({
        checkout: dir,
        number: 7,
        commitId: SHA,
        body: "Sample review.\n",
        comments: [{ path: "src/sample.ts", line: 12, body: "**warning**\n\nName the empty state before rendering it." }],
      });
      assert.equal(posted.id, "4242");
      assert.equal(posted.url, "https://example.com/sample/pull/7#pullrequestreview-4242");
      const payload = JSON.parse(readFileSync(body, "utf8")) as {
        event?: string;
        commit_id?: string;
        comments?: { path?: string; line?: number; side?: string }[];
      };
      assert.equal(payload.event, "COMMENT");
      assert.equal(payload.commit_id, SHA);
      assert.equal(payload.comments?.[0]?.path, "src/sample.ts");
      assert.equal(payload.comments?.[0]?.line, 12);
      assert.equal(payload.comments?.[0]?.side, "RIGHT");
      const trace = readFileSync(log, "utf8");
      assert.match(trace, /repos\/sample\/widget\/pulls\/7\/reviews/);
      assert.equal(trace.includes("merge"), false);
      assert.equal(trace.includes("approve"), false);
      assert.equal(trace.includes("APPROVE"), false);
      assert.equal(trace.includes("REQUEST_CHANGES"), false);
      assert.equal(typeof realGitHub.postCommentReview, "function");
    } finally {
      if (previousGh === undefined) delete process.env.KILN_GH;
      else process.env.KILN_GH = previousGh;
      if (previousLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = previousLog;
      if (previousBody === undefined) delete process.env.GH_BODY;
      else process.env.GH_BODY = previousBody;
    }
  });
});

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function local(year: number, month: number, day: number, hour: number): Date {
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

describe("approving a review gate", () => {
  it("posts once from approve, and reject, revise, pause, and failure do not claim a post", { timeout: 180_000 }, () => {
    const cwd = tempDir("kiln-review-gate-");
    const origin = join(cwd, "origin.git");
    const checkout = join(cwd, "checkout");
    mkdirSync(origin, { recursive: true });
    git(origin, ["init", "--bare", "-q", "-b", "main"]);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    mkdirSync(checkout, { recursive: true });
    git(checkout, ["init", "-q", "-b", "main"]);
    git(checkout, ["config", "user.email", "kiln-test@example.com"]);
    git(checkout, ["config", "user.name", "Kiln Test"]);
    writeFileSync(join(checkout, "test.mjs"), "import test from 'node:test';\ntest('sample', () => {});\n");
    const fixture = join(checkout, "test", "fixtures", "kiln-review");
    mkdirSync(fixture, { recursive: true });
    const markdown = [
      "# Draft review: Sample heading",
      "",
      "## Findings",
      "",
      `- **warning** \`src/sample.ts:12\``,
      `  Suggested comment: ${warning}`,
      "",
      `- **nit** \`src/sample.ts:14\``,
      `  Suggested comment: ${nit}`,
      "",
      `- **note**`,
      `  Suggested comment: ${unlocated}`,
      "",
    ].join("\n");
    writeFileSync(
      join(fixture, "draft.json"),
      `${JSON.stringify([
        {
          output: {
            markdown,
            findings: [
              { severity: "warning", file: "src/sample.ts", line: 12, comment: warning },
              { severity: "nit", file: "src/sample.ts", line: 14, comment: nit },
              { severity: "note", file: " ", line: 1, comment: unlocated },
            ],
          },
        },
      ])}\n`,
    );
    git(checkout, ["add", "-A"]);
    git(checkout, ["commit", "-q", "-m", "initial"]);
    git(checkout, ["remote", "add", "origin", origin]);
    git(checkout, ["push", "-q", "-u", "origin", "main"]);
    const sha = git(checkout, ["rev-parse", "HEAD"]).trim();
    const home = join(cwd, "kiln");
    mkdirSync(home, { recursive: true });
    const configPath = join(home, "kiln.config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        adapter: "mock",
        maxConcurrent: 4,
        repos: { web: { path: checkout, test: "node --test test.mjs", deliver: "pr", base: "main" } },
      })}\n`,
    );
    const config = loadKilnConfig(configPath, { home });
    const github = new RecordingGitHub();
    let pending: ReviewRequest[] = [];
    const host: KilnHost = {
      git: realGitRemote,
      github,
      reviews: { list: () => pending },
    };
    let hour = 15;

    const openDraft = (number: number): string => {
      const before = new Set(readStatus(config, undefined, host).jobs.map((job) => job.jobId));
      pending = [{ repo: "web", number, title: "Sample heading", url: `https://example.com/sample/pull/${number}`, headSha: sha }];
      const now = local(2026, 11, 3, hour);
      hour += 1;
      runTick(config, host, { startup: false, triggerStartup: hour === 16, now });
      return waitForNewGate(config, host, before);
    };

    const approved = openDraft(7);
    const output = answerJob(config, approved, "approve", host);
    assert.equal(github.calls.length, 1);
    assert.equal(github.creates, 0);
    const call = github.calls[0];
    assert.equal(call?.number, 7);
    assert.equal(call?.commitId, sha);
    assert.equal(call?.comments.length, 2);
    assert.match(call?.comments[0]?.body ?? "", /^\*\*warning\*\*/);
    assert.match(call?.comments[1]?.body ?? "", /^\*\*nit\*\* \(not blocking\)/);
    assert.match(call?.body ?? "", new RegExp(unlocated));
    assert.equal((call?.body ?? "").split(unlocated).length - 1, 1);
    const wire = JSON.stringify(github.calls);
    assert.equal(wire.includes("APPROVE"), false);
    assert.equal(wire.includes("REQUEST_CHANGES"), false);
    assert.equal(wire.includes("merge"), false);
    const posted = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "review.posted");
    assert.equal(posted.length, 1);
    if (posted[0]?.event === "review.posted") {
      assert.equal(posted[0].properties.repo, "web");
      assert.equal(posted[0].properties.number, 7);
      assert.equal(posted[0].properties.sha, sha);
      assert.equal(posted[0].properties.dedupe, `review:web:7:${sha}`);
      assert.equal(posted[0].properties.inline, 2);
      assert.equal(posted[0].properties.skipped, 1);
    }
    assert.equal(readStatus(config, approved, host).jobs[0]?.state, "done");
    assert.match(output, /\S/);
    assert.throws(() => answerJob(config, approved, "approve", host), /not needs-human/);
    assert.equal(github.calls.length, 1);

    const seeded = openDraft(8);
    const before = github.calls.length;
    answerJob(config, seeded, "approve", host);
    assert.equal(github.calls.length, before + 1, "a different pull request still posts");
    const sameHead = readEvents(config.kilnDir, { warn: () => {} }).filter(
      (event) => event.event === "review.posted" && event.properties.sha === sha && event.properties.number === 8,
    );
    assert.equal(sameHead.length, 1);

    const rejected = openDraft(9);
    const callsBeforeReject = github.calls.length;
    answerJob(config, rejected, "reject", host);
    assert.equal(github.calls.length, callsBeforeReject);
    assert.equal(readStatus(config, rejected, host).jobs[0]?.state, "rejected");

    const revised = openDraft(10);
    const callsBeforeRevise = github.calls.length;
    reviseJob(config, revised, "Tighten the warning.", host);
    assert.equal(github.calls.length, callsBeforeRevise);
    waitForGate(config, host, revised);

    const failed = openDraft(11);
    github.fail = new Error("502 Bad Gateway");
    assert.throws(() => answerJob(config, failed, "approve", host), /Could not post the review \(transient\)/);
    github.fail = undefined;
    const failedStatus = readStatus(config, failed, host);
    assert.equal(failedStatus.jobs[0]?.state, "needs-human");
    assert.match(failedStatus.jobs[0]?.reviewPostError ?? "", /Could not post the review \(transient\)/);
    const board = buildBoard(failedStatus.jobs, readEvents(config.kilnDir, { warn: () => {} }));
    assert.equal(board.hand.some((job) => job.jobId === failed), true);
    assert.equal(board.inbox.some((job) => job.jobId === failed), false);
    assert.equal(
      readEvents(config.kilnDir, { warn: () => {} }).some(
        (event) => event.event === "review.posted" && event.job_id === failed,
      ),
      false,
    );
    assert.equal(
      readEvents(config.kilnDir, { warn: () => {} }).some(
        (event) => event.event === "review.failed" && event.job_id === failed && event.properties.class === "transient",
      ),
      true,
    );
    const callsBeforeRetry = github.calls.length;
    answerJob(config, failed, "approve", host);
    assert.equal(github.calls.length, callsBeforeRetry + 1);
    assert.equal(readStatus(config, failed, host).jobs[0]?.state, "done");

    const held = openDraft(12);
    pauseFactory(config.kilnDir);
    try {
      const callsBeforePause = github.calls.length;
      assert.throws(() => answerJob(config, held, "approve", host), /Paused/);
      assert.equal(github.calls.length, callsBeforePause);
      assert.equal(readStatus(config, held, host).jobs[0]?.state, "needs-human");
    } finally {
      resumeFactory(config.kilnDir);
    }
  });
});

function waitForNewGate(config: LoadedKilnConfig, host: KilnHost, before: ReadonlySet<string>): string {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 60_000) {
    const status = readStatus(config, undefined, host);
    const fresh = status.jobs.find((job) => !before.has(job.jobId));
    last = fresh
      ? `${fresh.jobId} ${fresh.state} ${fresh.launchError ?? ""} ${fresh.failureDetail ?? ""}`
      : `jobs ${status.jobs.map((job) => `${job.jobId}:${job.state}`).join(",")}`;
    if (fresh?.state === "needs-human" && fresh.gates.length > 0) return fresh.jobId;
    if (fresh?.state === "failed" || fresh?.state === "dead") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.fail(`review draft did not reach a gate: ${last}`);
}

function waitForGate(config: LoadedKilnConfig, host: KilnHost, jobId: string): string {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 60_000) {
    const job = readStatus(config, jobId, host).jobs[0];
    last = `${job?.state ?? ""} ${job?.launchError ?? ""} ${job?.failureDetail ?? ""}`;
    if (job?.state === "needs-human" && job.gates.length > 0) return job.jobId;
    if (job?.state === "failed" || job?.state === "dead") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.fail(`review draft ${jobId} did not reach a gate: ${last}`);
}
