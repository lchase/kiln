import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { after, describe, it } from "node:test";
import { resolveKilnConfig } from "../src/config.js";

delete process.env.KILN_HOME;
import { writeDelivery } from "../src/delivery.js";
import { answerJob, runStatus, runTick } from "../src/driver.js";
import {
  realGitRemote,
  type GitHubHost,
  type GitRemote,
  type PullRequestRef,
  type PullRequestState,
  HostError,
} from "../src/host.js";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const keep: string[] = [];
const testCommand = "node --test test.mjs && printf '%s\\n' landed > kiln-landed.txt";

interface StoredPull extends PullRequestRef {
  title: string;
  body: string;
}

class FakeGitHub implements GitHubHost {
  pulls: StoredPull[] = [];
  creates = 0;
  finds = 0;
  failMessage: string | null = null;

  findByHead(_checkout: string, branch: string): PullRequestRef | null {
    this.finds += 1;
    if (this.failMessage) throw new HostError(this.failMessage);
    return this.pulls.find((pr) => pr.head === branch) ?? null;
  }

  createDraft(input: {
    checkout: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): PullRequestRef {
    this.creates += 1;
    if (this.failMessage) throw new HostError(this.failMessage);
    const number = this.pulls.reduce((max, pr) => Math.max(max, pr.number), 0) + 1;
    const pr: StoredPull = {
      number,
      url: `https://github.com/example/repo/pull/${number}`,
      state: "OPEN",
      mergedAt: null,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    };
    this.pulls.push(pr);
    return pr;
  }

  view(_checkout: string, number: number): { state: PullRequestState; mergedAt: string | null } {
    if (this.failMessage) throw new HostError(this.failMessage);
    const pr = this.pulls.find((item) => item.number === number);
    if (!pr) throw new HostError(`no pull request #${number}`);
    return { state: pr.state, mergedAt: pr.mergedAt };
  }

  merge(number: number): void {
    const pr = this.pulls.find((item) => item.number === number);
    assert.ok(pr);
    pr.state = "MERGED";
    pr.mergedAt = "2026-10-25T03:00:00Z";
  }
}

function recordingGit(): { git: GitRemote; pushes: string[] } {
  const pushes: string[] = [];
  const git: GitRemote = {
    fetch: (checkout) => realGitRemote.fetch(checkout),
    revParse: (checkout, ref) => realGitRemote.revParse(checkout, ref),
    remoteBranchSha: (checkout, branch) => realGitRemote.remoteBranchSha(checkout, branch),
    pushBranch: (checkout, branch, base) => {
      pushes.push(branch);
      realGitRemote.pushBranch(checkout, branch, base);
    },
    publishBranch: (checkout, source, target, base) => {
      pushes.push(`${source}->${target}`);
      realGitRemote.publishBranch(checkout, source, target, base);
    },
    isAncestor: (checkout, ancestor, descendant) => realGitRemote.isAncestor(checkout, ancestor, descendant),
    defaultBranch: (checkout) => realGitRemote.defaultBranch(checkout),
  };
  return { git, pushes };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function runCli(
  args: string[],
  options: { cwd: string; home: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: kilnEnv(options.home),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function workDir(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-deliver-"));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home };
}

function writeFixtures(checkout: string): void {
  writeFileSync(
    join(checkout, "test.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('checkout', () => { assert.equal(true, true); });",
      "",
    ].join("\n"),
  );
  const fixtures = join(checkout, "test", "fixtures", "kiln-feature");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(
    join(fixtures, "spec.json"),
    `${JSON.stringify([{ output: { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." } }])}\n`,
  );
  writeFileSync(
    join(fixtures, "build.json"),
    `${JSON.stringify([{ output: { summary: "Mock build.", status: "READY" } }])}\n`,
  );
  for (const step of ["security", "ux", "ui", "code"]) {
    writeFileSync(
      join(fixtures, `${step}.json`),
      `${JSON.stringify([{ output: { verdict: "PASS", findings: "No must-fix findings." } }])}\n`,
    );
  }
  writeFileSync(
    join(fixtures, "approver.json"),
    `${JSON.stringify([{ output: { decision: "APPROVE", reason: "Reviews passed." } }])}\n`,
  );
}

/** Checkout plus a local bare origin. No network. */
function initOrigin(parent: string): { checkout: string; origin: string } {
  const origin = join(parent, "origin.git");
  const checkout = join(parent, "checkout");
  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "-q", "-b", "main"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "kiln-test@example.com"]);
  git(checkout, ["config", "user.name", "Kiln Test"]);
  writeFixtures(checkout);
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "initial"]);
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-q", "-u", "origin", "main"]);
  git(checkout, ["remote", "set-head", "origin", "main"]);
  return { checkout, origin };
}

function commitFile(checkout: string, file: string, contents: string, message: string): string {
  writeFileSync(join(checkout, file), contents);
  git(checkout, ["add", file]);
  git(checkout, ["commit", "-q", "-m", message]);
  return git(checkout, ["rev-parse", "HEAD"]).trim();
}

/** Commit on `branch` without moving the checkout HEAD or its files. */
function commitOnBranch(checkout: string, branch: string, file: string, contents: string, message: string): string {
  const wt = mkdtempSync(join(tmpdir(), "kiln-wt-"));
  keep.push(wt);
  git(checkout, ["worktree", "add", "-q", "-b", branch, wt, "HEAD"]);
  writeFileSync(join(wt, file), contents);
  git(wt, ["add", file]);
  git(wt, ["commit", "-q", "-m", message]);
  const sha = git(wt, ["rev-parse", "HEAD"]).trim();
  git(checkout, ["worktree", "remove", "--force", wt]);
  return sha;
}

function kilnEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  return env;
}

function useMock(home: string): void {
  const path = join(home, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = 2;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function addJob(
  cwd: string,
  home: string,
  repo: string,
  title: string,
  after: string[] = [],
  stack = false,
): string {
  const spec = join(cwd, `${title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.md`);
  writeFileSync(spec, `# ${title}\n\nShip the weekly summary for ${title}.\n`);
  const args = ["add", "feature", "--repo", repo, "--spec", spec, "--title", title];
  for (const id of after) args.push("--after", id);
  if (stack) args.push("--stack");
  const created = runCli(args, { cwd, home });
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/^added (\S+)/m)?.[1];
  assert.ok(id, created.stdout);
  return id;
}

function landRun(checkout: string, jobId: string, runId: string): void {
  const runDir = join(checkout, ".runs", runId);
  const artifacts = join(runDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(runDir, "journal.jsonl"),
    [
      JSON.stringify({ t: "run.started", runId, tag: `kiln:${jobId}`, pid: process.pid }),
      JSON.stringify({ t: "run.finished", status: "ok" }),
      "",
    ].join("\n"),
  );
  writeFileSync(join(artifacts, "approval.json"), `${JSON.stringify({ decision: "approve" })}\n`);
  writeFileSync(
    join(artifacts, "spec.json"),
    `${JSON.stringify({ goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "Checks pass." })}\n`,
  );
  for (const step of ["security", "ux", "ui", "code"]) {
    writeFileSync(
      join(artifacts, `${step}.1.json`),
      `${JSON.stringify({ verdict: "PASS", findings: "No must-fix findings." })}\n`,
    );
  }
  writeFileSync(
    join(artifacts, "decision.json"),
    `${JSON.stringify({ decision: "APPROVE", reason: "Reviews passed." })}\n`,
  );
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

/** PATH of the yak process Kiln spawned. The child is still starting when tick returns. */
function childPath(pid: number): string {
  const start = Date.now();
  let lastError = "process not visible yet";
  while (Date.now() - start < 2000) {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`);
      const path = raw
        .toString("utf8")
        .split("\0")
        .find((entry) => entry.startsWith("PATH="));
      assert.ok(path, "yak child has no PATH");
      return path.slice("PATH=".length);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      sleep(0.05);
    }
  }
  throw new Error(`could not read yak child PATH for pid ${pid}: ${lastError}`);
}

function waitForWorktree(checkout: string, kilnDir: string, timeoutMs = 60000): { runId: string; head: string } {
  const start = Date.now();
  let log = "";
  while (Date.now() - start < timeoutMs) {
    const runs = join(checkout, ".runs");
    if (existsSync(runs)) {
      for (const runId of readdirSync(runs)) {
        const wt = join(checkout, ".yak", "worktrees", runId);
        if (!existsSync(join(wt, "test.mjs"))) continue;
        return { runId, head: git(wt, ["rev-parse", "HEAD"]).trim() };
      }
    }
    sleep(0.1);
  }
  const logs = join(kilnDir, "logs");
  if (existsSync(logs)) {
    for (const name of readdirSync(logs)) log += readFileSync(join(logs, name), "utf8");
  }
  throw new Error(`timed out waiting for a worktree\n${log}`);
}

function stopJob(kilnDir: string, jobId: string): void {
  const path = join(kilnDir, "launching", `${jobId}.json`);
  if (!existsSync(path)) return;
  try {
    const crumb = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    if (crumb.pid && crumb.pid > 0) process.kill(crumb.pid, "SIGTERM");
  } catch {
    // The launch process has already exited.
  }
}

function assertCheckoutUntouched(
  checkout: string,
  before: { head: string; branch: string; tracked: string },
): void {
  const after = snapshotCheckout(checkout);
  assert.equal(after.head, before.head);
  assert.equal(after.branch, before.branch);
  assert.equal(after.tracked, before.tracked);
  assert.match(after.status, /tracked\.txt/);
}

function snapshotCheckout(checkout: string): { head: string; branch: string; status: string; tracked: string } {
  return {
    head: git(checkout, ["rev-parse", "HEAD"]).trim(),
    branch: git(checkout, ["branch", "--show-current"]).trim(),
    status: git(checkout, ["status", "--porcelain"]),
    tracked: readFileSync(join(checkout, "tracked.txt"), "utf8"),
  };
}

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("delivery", { concurrency: 1 }, () => {
  it("opens one pull request across repeated ticks and does not push the base", () => {
    const { cwd, home } = workDir();
    const { checkout, origin } = initOrigin(join(cwd, "repos"));
    const mainBefore = git(origin, ["rev-parse", "refs/heads/main"]).trim();
    const added = runCli(
      ["repo", "add", "web", checkout, "--test", testCommand, "--deliver", "pr"],
      { cwd, home },
    );
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /deliver pr/);
    useMock(home);
    const id = addJob(cwd, home, "web", "Show the weekly summary");
    const runId = "2026-10-25T00-00-00Z-pr01";
    commitOnBranch(checkout, `yak/${runId}`, "landed.txt", "landed\n", "kiln: Show the weekly summary");
    landRun(checkout, id, runId);
    writeFileSync(
      join(checkout, ".runs", runId, "artifacts", "security.2.json"),
      `${JSON.stringify({ verdict: "CHANGES", findings: "round 2" })}\n`,
    );

    const github = new FakeGitHub();
    const remote = recordingGit();
    const host = { github, git: remote.git };
    const config = resolveKilnConfig({ cwd, home });
    assert.equal(config.repos.web?.deliver, "pr");
    assert.equal(config.repos.web?.base, undefined);

    const first = runTick(config, host);
    assert.match(first, new RegExp(`deliver ${id}\\s+web\\s+https://github.com/example/repo/pull/1`));
    assert.equal(github.creates, 1);
    assert.deepEqual(remote.pushes, [`yak/${runId}`]);
    assert.equal(github.pulls[0]?.title, "Show the weekly summary");
    assert.equal(github.pulls[0]?.base, "main");
    assert.match(github.pulls[0]?.body ?? "", /Ship the weekly summary/);
    assert.match(github.pulls[0]?.body ?? "", new RegExp(`Kiln job: ${id}`));
    assert.match(github.pulls[0]?.body ?? "", /- security: CHANGES/);
    assert.match(github.pulls[0]?.body ?? "", /- ux: PASS/);
    assert.match(github.pulls[0]?.body ?? "", /- approver: APPROVE/);
    const jobFile = JSON.parse(readFileSync(join(home, ".kiln", "jobs", `${id}.json`), "utf8")) as {
      state?: unknown;
      prUrl?: unknown;
    };
    assert.equal(jobFile.state, undefined);
    assert.equal(jobFile.prUrl, undefined);
    const record = JSON.parse(readFileSync(join(home, ".kiln", "deliveries", `${id}.json`), "utf8")) as {
      branch: string;
      prNumber: number;
      prUrl: string;
    };
    assert.equal(record.branch, `yak/${runId}`);
    assert.equal(record.prNumber, 1);

    const second = runTick(config, host);
    assert.doesNotMatch(second, /deliver /);
    assert.equal(github.creates, 1);
    assert.deepEqual(remote.pushes, [`yak/${runId}`]);

    rmSync(join(home, ".kiln", "deliveries", `${id}.json`));
    const third = runTick(config, host);
    assert.match(third, /pull\/1/);
    assert.equal(github.creates, 1);
    assert.deepEqual(remote.pushes, [`yak/${runId}`]);
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]).trim(), mainBefore);
    assert.equal(git(origin, ["rev-parse", `refs/heads/yak/${runId}`]).trim().length, 40);
    const status = runStatus(config, id, host);
    assert.match(status, new RegExp(`${id}\\s+web\\s+feature\\s+in-review`));
    assert.match(status, /pr https:\/\/github.com\/example\/repo\/pull\/1/);
  });

  it("keeps an after-merged job blocked until the pull request merges, then starts from origin/base", () => {
    const { cwd, home } = workDir();
    const { checkout, origin } = initOrigin(join(cwd, "repos"));
    const upstreamRun = "2026-10-25T00-00-00Z-up01";
    const upstreamTip = commitOnBranch(checkout, `yak/${upstreamRun}`, "upstream.txt", "upstream\n", "kiln: upstream");
    const originMain = commitFile(checkout, "squashed.txt", "squashed\n", "squash result");
    git(checkout, ["push", "-q", "origin", "main"]);
    const checkoutHead = commitFile(checkout, "local-only.txt", "local\n", "not pushed");
    writeFileSync(join(checkout, "tracked.txt"), "original\n");
    git(checkout, ["add", "tracked.txt"]);
    git(checkout, ["commit", "-q", "-m", "track"]);
    const head = git(checkout, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(checkout, "tracked.txt"), "dirty\n");
    assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", upstreamTip, "origin/main"], { cwd: checkout }).status, 0);
    assert.notEqual(head, originMain);
    assert.notEqual(head, checkoutHead);

    assert.equal(
      runCli(["repo", "add", "web", checkout, "--test", testCommand, "--deliver", "pr", "--base", "main"], { cwd, home }).status,
      0,
    );
    useMock(home);
    const upstream = addJob(cwd, home, "web", "Publish the summary");
    const downstream = addJob(cwd, home, "web", "Show the summary", [upstream]);
    landRun(checkout, upstream, upstreamRun);
    const github = new FakeGitHub();
    github.pulls.push({
      number: 4,
      url: "https://github.com/example/repo/pull/4",
      state: "OPEN",
      mergedAt: null,
      head: `yak/${upstreamRun}`,
      base: "main",
      title: "Publish the summary",
      body: "already open",
    });
    const config = resolveKilnConfig({ cwd, home });
    writeDelivery(config.kilnDir, {
      jobId: upstream,
      runId: upstreamRun,
      branch: `yak/${upstreamRun}`,
      base: "main",
      pushed: true,
      prNumber: 4,
      prUrl: "https://github.com/example/repo/pull/4",
    });
    const remote = recordingGit();
    const host = { github, git: remote.git };
    const before = snapshotCheckout(checkout);

    const blocked = runStatus(config, undefined, host);
    assert.match(blocked, new RegExp(`${downstream}\\s+web\\s+feature\\s+blocked`));
    assert.match(blocked, /waiting for PR #4 to merge/);
    assert.match(blocked, new RegExp(`${upstream}\\s+web\\s+feature\\s+in-review`));
    const idle = runTick(config, host);
    assert.match(idle, /nothing to launch/);
    assert.equal(github.creates, 0);

    github.merge(4);
    const launched = runTick(config, host);
    assert.match(launched, new RegExp(`launch ${downstream}\\s+web`));
    const work = waitForWorktree(checkout, join(home, ".kiln"));
    const input = JSON.parse(
      readFileSync(join(checkout, ".runs", work.runId, "artifacts", "input.json"), "utf8"),
    ) as { baseRef?: string };
    assert.equal(input.baseRef, originMain);
    assert.equal(work.head, originMain);
    assert.notEqual(work.head, upstreamTip);
    assert.notEqual(work.head, before.head);
    assertCheckoutUntouched(checkout, before);
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]).trim(), originMain);
    stopJob(config.kilnDir, downstream);
  });

  it("starts a stacked job from the upstream branch and targets that branch", () => {
    const { cwd, home } = workDir();
    const { checkout, origin } = initOrigin(join(cwd, "repos"));
    const mainBefore = git(origin, ["rev-parse", "refs/heads/main"]).trim();
    const upstreamRun = "2026-10-25T00-00-00Z-stk1";
    const upstreamTip = commitOnBranch(checkout, `yak/${upstreamRun}`, "upstream.txt", "upstream\n", "kiln: upstream");
    writeFileSync(join(checkout, "tracked.txt"), "original\n");
    git(checkout, ["add", "tracked.txt"]);
    git(checkout, ["commit", "-q", "-m", "track"]);
    writeFileSync(join(checkout, "tracked.txt"), "dirty\n");
    const before = snapshotCheckout(checkout);

    assert.equal(
      runCli(["repo", "add", "web", checkout, "--test", testCommand, "--deliver", "pr", "--base", "main"], { cwd, home }).status,
      0,
    );
    useMock(home);
    const upstream = addJob(cwd, home, "web", "Publish the summary");
    const downstream = addJob(cwd, home, "web", "Show the summary", [upstream], true);
    landRun(checkout, upstream, upstreamRun);
    const github = new FakeGitHub();
    github.pulls.push({
      number: 2,
      url: "https://github.com/example/repo/pull/2",
      state: "OPEN",
      mergedAt: null,
      head: `yak/${upstreamRun}`,
      base: "main",
      title: "Publish the summary",
      body: "open",
    });
    const config = resolveKilnConfig({ cwd, home });
    writeDelivery(config.kilnDir, {
      jobId: upstream,
      runId: upstreamRun,
      branch: `yak/${upstreamRun}`,
      base: "main",
      pushed: true,
      prNumber: 2,
      prUrl: "https://github.com/example/repo/pull/2",
    });
    const remote = recordingGit();
    const host = { github, git: remote.git };

    const launched = runTick(config, host);
    assert.match(launched, new RegExp(`launch ${downstream}\\s+web`));
    assert.equal(github.creates, 0);
    const started = waitForStatus(config, host, downstream, /needs-human/);
    const runId = started.match(/run (\S+)/)?.[1];
    assert.ok(runId);
    const worktree = join(checkout, ".yak", "worktrees", runId);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]).trim(), upstreamTip);
    const input = JSON.parse(readFileSync(join(checkout, ".runs", runId, "artifacts", "input.json"), "utf8")) as {
      baseRef?: string;
    };
    assert.equal(input.baseRef, upstreamTip);
    assertCheckoutUntouched(checkout, before);

    const answered = answerJob(config, downstream, "approve", host);
    assert.match(answered, /finished: ok/);
    const delivered = runTick(config, host);
    assert.match(delivered, new RegExp(`deliver ${downstream}`));
    assert.equal(github.creates, 1);
    assert.equal(github.pulls[1]?.base, `yak/${upstreamRun}`);
    assert.equal(github.pulls[1]?.head, `yak/${runId}`);
    assert.equal(github.pulls[0]?.state, "OPEN");
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]).trim(), mainBefore);
    assertCheckoutUntouched(checkout, before);
    const status = runStatus(config, downstream, host);
    assert.match(status, /in-review/);
    assert.match(status, /pr https:\/\/github.com\/example\/repo\/pull\/3/);
  });

  it("rejects stack unless there is exactly one dependency in the same repo", () => {
    const { cwd, home } = workDir();
    const web = join(cwd, "web");
    const api = join(cwd, "api");
    mkdirSync(web, { recursive: true });
    mkdirSync(api, { recursive: true });
    assert.equal(runCli(["repo", "add", "web", web, "--test", "npm test"], { cwd, home }).status, 0);
    assert.equal(runCli(["repo", "add", "api", api, "--test", "npm test"], { cwd, home }).status, 0);
    const spec = join(cwd, "spec.md");
    writeFileSync(spec, "# Show the summary\n\nShip it.\n");
    const first = addJob(cwd, home, "web", "First slice");
    const second = addJob(cwd, home, "web", "Second slice");
    const otherRepo = addJob(cwd, home, "api", "API slice");

    const two = runCli(
      ["add", "feature", "--repo", "web", "--spec", spec, "--after", first, "--after", second, "--stack"],
      { cwd, home },
    );
    assert.equal(two.status, 1);
    assert.match(two.stderr, /stack needs exactly one dependency/);
    assert.match(two.stderr, /Got 2/);

    const zero = runCli(["add", "feature", "--repo", "web", "--spec", spec, "--stack"], { cwd, home });
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /Got 0/);

    const cross = runCli(
      ["add", "feature", "--repo", "web", "--spec", spec, "--after", otherRepo, "--stack"],
      { cwd, home },
    );
    assert.equal(cross.status, 1);
    assert.match(cross.stderr, /same repo|repo web/);

    const dir = join(cwd, "tickets");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "01-one.md"),
      "# 01: One\n\n**What to build:** First.\n\n**Blocked by:** None\n",
    );
    writeFileSync(
      join(dir, "02-two.md"),
      "# 02: Two\n\n**What to build:** Second.\n\n**Blocked by:** None\n",
    );
    writeFileSync(
      join(dir, "03-both.md"),
      "# 03: Both\n\n**What to build:** Needs both.\n\n**Blocked by:**\n- 01: One\n- 02: Two\n",
    );
    const imported = runCli(["import", dir, "--repo", "web", "--stack"], { cwd, home });
    assert.equal(imported.status, 1);
    assert.match(imported.stderr, /03-both\.md/);
    assert.match(imported.stderr, /2 dependencies/);
    const names = existsSync(join(home, ".kiln", "jobs")) ? readdirSync(join(home, ".kiln", "jobs")) : [];
    assert.deepEqual(
      names.filter((name) => name !== `${first}.json` && name !== `${second}.json` && name !== `${otherRepo}.json`),
      [],
    );
  });

  it("leaves deliver=local on the landed branch and does not call gh or push", () => {
    const { cwd, home } = workDir();
    const checkout = join(cwd, "repos", "web");
    mkdirSync(checkout, { recursive: true });
    git(checkout, ["init", "-q", "-b", "main"]);
    git(checkout, ["config", "user.email", "kiln-test@example.com"]);
    git(checkout, ["config", "user.name", "Kiln Test"]);
    writeFileSync(join(checkout, "readme.md"), "local\n");
    git(checkout, ["add", "readme.md"]);
    git(checkout, ["commit", "-q", "-m", "initial"]);
    assert.equal(runCli(["repo", "add", "web", checkout, "--test", testCommand], { cwd, home }).status, 0);
    useMock(home);
    const id = addJob(cwd, home, "web", "Show the weekly summary");
    const runId = "2026-10-25T00-00-00Z-local";
    commitOnBranch(checkout, `yak/${runId}`, "landed.txt", "landed\n", "kiln: local");
    landRun(checkout, id, runId);
    const github = new FakeGitHub();
    github.failMessage = "gh must not be called";
    const remote = recordingGit();
    const config = resolveKilnConfig({ cwd, home });
    const tick = runTick(config, { github, git: remote.git });
    assert.match(tick, /nothing to launch/);
    assert.equal(github.creates, 0);
    assert.equal(github.finds, 0);
    assert.deepEqual(remote.pushes, []);
    const status = runStatus(config, id, { github, git: remote.git });
    assert.match(status, new RegExp(`${id}\\s+web\\s+feature\\s+done\\s+run ${runId}\\s+branch yak/${runId}`));
    assert.doesNotMatch(status, /in-review|pull\//);
  });

  it("records a gh failure on the job and still launches another ready job", () => {
    const { cwd, home } = workDir();
    const { checkout } = initOrigin(join(cwd, "repos"));
    assert.equal(
      runCli(["repo", "add", "web", checkout, "--test", testCommand, "--deliver", "pr", "--base", "main"], { cwd, home }).status,
      0,
    );
    useMock(home);
    const broken = addJob(cwd, home, "web", "Publish the summary");
    const other = addJob(cwd, home, "web", "Show the summary");
    const runId = "2026-10-25T00-00-00Z-gh01";
    commitOnBranch(checkout, `yak/${runId}`, "landed.txt", "landed\n", "kiln: publish");
    landRun(checkout, broken, runId);
    const github = new FakeGitHub();
    github.failMessage = "authentication required. Run gh auth login";
    const remote = recordingGit();
    const config = resolveKilnConfig({ cwd, home });
    const host = { github, git: remote.git };
    let tick = "";
    assert.doesNotThrow(() => {
      tick = runTick(config, host);
    });
    assert.match(tick, new RegExp(`deliver ${broken}\\s+web\\s+failed:`));
    assert.match(tick, /gh auth login/);
    assert.match(tick, new RegExp(`launch ${other}\\s+web`));
    assert.equal(github.creates, 0);
    assert.deepEqual(remote.pushes, []);
    const status = runStatus(config, broken, host);
    assert.match(status, new RegExp(`${broken}\\s+web\\s+feature\\s+failed`));
    assert.match(status, /gh auth login/);
    const again = runTick(config, host);
    assert.match(again, /failed:/);
    assert.equal(github.creates, 0);
    assert.deepEqual(remote.pushes, []);
    stopJob(config.kilnDir, other);
  });

  it("does not put a kiln bin directory on the yak child's PATH, and refuses to push the base branch", () => {
    const { cwd, home } = workDir();
    const { checkout } = initOrigin(join(cwd, "repos"));
    assert.equal(
      runCli(["repo", "add", "web", checkout, "--test", testCommand, "--deliver", "pr", "--base", "main"], { cwd, home }).status,
      0,
    );
    useMock(home);
    const id = addJob(cwd, home, "web", "Show the weekly summary");
    const config = resolveKilnConfig({ cwd, home });
    const github = new FakeGitHub();
    const remote = recordingGit();
    const launched = runTick(config, { github, git: remote.git });
    assert.match(launched, new RegExp(`launch ${id}\\s+web`));
    const crumb = JSON.parse(readFileSync(join(config.kilnDir, "launching", `${id}.json`), "utf8")) as { pid?: number };
    assert.ok(crumb.pid && crumb.pid > 0);
    const pathEnv = childPath(crumb.pid);
    const kilnBin = join(config.kilnDir, "bin");
    assert.equal(existsSync(kilnBin), false);
    for (const entry of pathEnv.split(delimiter)) {
      assert.notEqual(entry, kilnBin);
      assert.equal(entry.endsWith(`${sep}.kiln${sep}bin`), false, entry);
    }
    assert.throws(() => realGitRemote.pushBranch(checkout, "main", "main"), /Refusing to push main/);
    assert.throws(() => realGitRemote.pushBranch(checkout, "feature", "main"), /only pushes yak/);
    stopJob(config.kilnDir, id);
  });
});

function waitForStatus(
  config: ReturnType<typeof resolveKilnConfig>,
  host: { github: GitHubHost; git: GitRemote },
  jobId: string,
  pattern: RegExp,
  timeoutMs = 60000,
): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    last = runStatus(config, jobId, host);
    if (pattern.test(last)) return last;
    sleep(0.2);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${last}`);
}
