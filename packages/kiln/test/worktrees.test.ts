import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { writeDelivery } from "../src/delivery.js";
import { cleanWorktrees, readStatus, runStatus, runTick } from "../src/driver.js";
import { readEvents } from "../src/events.js";
import { writeFeedbackLedger } from "../src/feedback.js";
import type { KilnHost, PullRequestState } from "../src/host.js";
import { jobFilePath, markJobCancelled, writeJob } from "../src/jobs.js";
import { packageRoot } from "../src/paths.js";
import { pauseFactory } from "../src/rails.js";
import type { Job } from "../src/schemas.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const DEAD_PID = 2_147_483_646;
const NOW = new Date("2026-11-20T00:00:00.000Z");

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function gitStatus(dir: string, args: string[]): number {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).status ?? 1;
}

/** A checkout with an `origin` bare remote, `main` pushed. */
function repoWithOrigin(dir: string, name = "web"): string {
  const remote = join(dir, `${name}-origin.git`);
  const checkout = join(dir, name);
  git(dir, ["init", "--bare", "-q", remote]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "kiln-test@example.com"]);
  git(checkout, ["config", "user.name", "Kiln Test"]);
  git(checkout, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(checkout, "README.md"), "fixture\n");
  writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "initial"]);
  git(checkout, ["remote", "add", "origin", remote]);
  git(checkout, ["push", "-q", "-u", "origin", "main"]);
  return checkout;
}

interface Bench {
  dir: string;
  checkout: string;
  config: LoadedKilnConfig;
  configPath: string;
}

function bench(prefix: string, repo: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Bench {
  const dir = mkdtempSync(join(tmpdir(), `kiln-wt-${prefix}-`));
  keep.push(dir);
  const checkout = repoWithOrigin(dir);
  const configDir = join(dir, "kiln");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "kiln.config.json");
  const repos = (extra.repos as Record<string, unknown> | undefined) ?? {};
  writeFileSync(
    configPath,
    `${JSON.stringify({ adapter: "mock", ...extra, repos: { web: { path: checkout, test: "true", ...repo }, ...repos } }, null, 2)}\n`,
  );
  const config = loadKilnConfig(configPath);
  // No test may launch yak: paused ticks still recover, deliver, and clean.
  pauseFactory(config.kilnDir);
  return { dir, checkout, config, configPath };
}

function addJob(config: LoadedKilnConfig, title: string, options: { dependsOn?: string[]; stack?: boolean; repo?: string } = {}): string {
  return writeJob(config, {
    workflow: "feature",
    repo: options.repo ?? "web",
    specText: `# ${title}\n\nDo the work.\n`,
    title,
    dependsOn: options.dependsOn ?? [],
    ...(options.stack ? { stack: true } : {}),
    source: { kind: "prompt", ref: "inline" },
  }).job.id;
}

type RunShape =
  | { status: "ok"; decision?: "approve" | "reject" }
  | { status: "failed" }
  | { status: "suspended" }
  | { status: "alive" };

/** A yak journal for `runId` tagged to `jobId`. `alive` uses this process's pid. */
function journal(checkout: string, jobId: string, runId: string, shape: RunShape): void {
  const dir = join(checkout, ".runs", runId);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  const pid = shape.status === "alive" ? process.pid : DEAD_PID;
  const lines: unknown[] = [{ t: "run.started", at: "2026-11-19T00:00:00.000Z", runId, tag: `kiln:${jobId}`, pid }];
  if (shape.status !== "alive") lines.push({ t: "run.finished", at: "2026-11-19T00:00:01.000Z", status: shape.status, runId });
  writeFileSync(join(dir, "journal.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (shape.status === "ok" && shape.decision) {
    writeFileSync(join(dir, "artifacts", "approval.json"), `${JSON.stringify({ decision: shape.decision })}\n`);
  }
}

function addTree(checkout: string, runId: string, from = "HEAD"): string {
  const tree = join(checkout, ".yak", "worktrees", runId);
  git(checkout, ["worktree", "add", "-q", "-b", `yak/${runId}`, tree, from]);
  return tree;
}

function commitIn(tree: string, file: string, body: string, message: string): string {
  writeFileSync(join(tree, file), body);
  git(tree, ["add", file]);
  git(tree, ["-c", "user.email=kiln-test@example.com", "-c", "user.name=Kiln Test", "commit", "-q", "-m", message]);
  return git(tree, ["rev-parse", "HEAD"]).trim();
}

function branchExists(checkout: string, runId: string): boolean {
  return gitStatus(checkout, ["show-ref", "--verify", "--quiet", `refs/heads/yak/${runId}`]) === 0;
}

function worktreeEvents(config: LoadedKilnConfig, kind: "worktree.cleaned" | "worktree.kept", runId?: string) {
  return readEvents(config.kilnDir, { warn: () => {} }).filter(
    (event) => event.event === kind && (runId === undefined || event.run_id === runId),
  );
}

function host(views: Record<number, PullRequestState> = {}): KilnHost {
  const offline = (): never => {
    throw new Error("offline in this test");
  };
  return {
    github: {
      findByHead: () => null,
      createDraft: offline,
      view: (_checkout, number) => ({
        state: views[number] ?? "OPEN",
        mergedAt: views[number] === "MERGED" ? "2026-11-19T00:00:00Z" : null,
      }),
    },
    git: {
      fetch: offline,
      revParse: (checkout, ref) => git(checkout, ["rev-parse", ref]).trim(),
      remoteBranchSha: () => null,
      pushBranch: offline,
      publishBranch: offline,
      isAncestor: (checkout, ancestor, descendant) =>
        gitStatus(checkout, ["merge-base", "--is-ancestor", ancestor, descendant]) === 0,
      defaultBranch: () => "main",
    },
  };
}

function tick(b: Bench, h: KilnHost = host(), minutes = 0): string {
  return runTick(b.config, h, { startup: false, now: new Date(NOW.getTime() + minutes * 60_000) });
}

describe("worktree cleanup on tick", () => {
  it("removes a merged pull request's worktree and branch, records it once, and a second tick records nothing", () => {
    const b = bench("merged", { deliver: "pr", base: "main" });
    const jobId = addJob(b.config, "Merged work");
    const runId = "2026-11-19T00-00-00Z-merged";
    journal(b.checkout, jobId, runId, { status: "ok", decision: "approve" });
    const tree = addTree(b.checkout, runId);
    commitIn(tree, "feature.txt", "done\n", "feat: merged work");
    git(tree, ["push", "-q", "origin", `HEAD:refs/heads/kiln/merged-work`]);
    git(b.checkout, ["fetch", "-q", "origin"]);
    writeDelivery(b.config.kilnDir, {
      jobId,
      runId,
      branch: "kiln/merged-work",
      base: "main",
      pushed: true,
      prNumber: 7,
      prUrl: "https://github.com/example/repo/pull/7",
    });
    const h = host({ 7: "MERGED" });
    assert.equal(readStatus(b.config, jobId, h).jobs[0]?.state, "done");

    const out = tick(b, h);
    assert.match(out, new RegExp(`cleaned ${runId}`));
    assert.equal(existsSync(tree), false);
    assert.equal(branchExists(b.checkout, runId), false);
    const cleaned = worktreeEvents(b.config, "worktree.cleaned", runId);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0]?.job_id, jobId);
    assert.deepEqual(
      { branch: (cleaned[0]?.properties as { branch?: string }).branch, reason: (cleaned[0]?.properties as { reason?: string }).reason },
      { branch: "deleted", reason: "job done" },
    );

    const before = readFileSync(join(b.config.kilnDir, "events.jsonl"), "utf8");
    const again = tick(b, h, 1);
    assert.doesNotMatch(again, /cleaned /);
    assert.equal(readFileSync(join(b.config.kilnDir, "events.jsonl"), "utf8"), before);
    // The journal stays.
    assert.equal(existsSync(join(b.checkout, ".runs", runId, "journal.jsonl")), true);
  });

  it("removes a deliver: local job's worktree and branch once it landed in the base", () => {
    const b = bench("local");
    const jobId = addJob(b.config, "Local work");
    const runId = "2026-11-19T00-00-00Z-local";
    journal(b.checkout, jobId, runId, { status: "ok", decision: "approve" });
    const tree = addTree(b.checkout, runId);
    commitIn(tree, "feature.txt", "done\n", "feat: local work");
    git(b.checkout, ["merge", "-q", "--ff-only", `yak/${runId}`]);

    tick(b);
    assert.equal(existsSync(tree), false);
    assert.equal(branchExists(b.checkout, runId), false);
    assert.equal(worktreeEvents(b.config, "worktree.cleaned", runId).length, 1);
    assert.equal(readFileSync(join(b.checkout, "feature.txt"), "utf8"), "done\n");
  });

  it("removes an earlier attempt after a retry started a new run and keeps its unique branch", () => {
    const b = bench("retry");
    const jobId = addJob(b.config, "Retried work");
    const oldRun = "2026-11-19T00-00-00Z-first";
    const newRun = "2026-11-19T00-00-05Z-second";
    journal(b.checkout, jobId, oldRun, { status: "failed" });
    journal(b.checkout, jobId, newRun, { status: "alive" });
    const oldTree = addTree(b.checkout, oldRun);
    const unique = commitIn(oldTree, "notes.txt", "only here\n", "wip: only here");
    const newTree = addTree(b.checkout, newRun);

    tick(b);
    assert.equal(existsSync(oldTree), false);
    assert.equal(git(b.checkout, ["rev-parse", `yak/${oldRun}`]).trim(), unique);
    assert.equal(existsSync(newTree), true, "the live retry keeps its worktree");
    const cleaned = worktreeEvents(b.config, "worktree.cleaned", oldRun);
    assert.equal((cleaned[0]?.properties as { branch?: string }).branch, "kept");
    assert.equal((cleaned[0]?.properties as { reason?: string }).reason, "run replaced by a later run");
  });

  it("removes rejected, cancelled, settled-fix, and landed-and-pushed worktrees", () => {
    const b = bench("finished", { deliver: "pr", base: "main" });
    const rejected = addJob(b.config, "Rejected work");
    const rejectedRun = "2026-11-19T00-00-00Z-rejected";
    journal(b.checkout, rejected, rejectedRun, { status: "ok", decision: "reject" });
    const rejectedTree = addTree(b.checkout, rejectedRun);

    const cancelled = addJob(b.config, "Cancelled work");
    const cancelledRun = "2026-11-19T00-00-01Z-cancelled";
    journal(b.checkout, cancelled, cancelledRun, { status: "failed" });
    const cancelledTree = addTree(b.checkout, cancelledRun);
    markJobCancelled(b.config, JSON.parse(readFileSync(jobFilePath(b.config.jobsDir, cancelled), "utf8")) as Job);

    const reviewed = addJob(b.config, "Reviewed work");
    const landedRun = "2026-11-19T00-00-02Z-landed";
    const fixRun = "2026-11-19T00-00-03Z-fix";
    journal(b.checkout, reviewed, landedRun, { status: "ok", decision: "approve" });
    journal(b.checkout, reviewed, fixRun, { status: "ok" });
    const landedTree = addTree(b.checkout, landedRun);
    const head = commitIn(landedTree, "feature.txt", "v1\n", "feat: reviewed work");
    git(landedTree, ["push", "-q", "origin", "HEAD:refs/heads/kiln/reviewed-work"]);
    const fixTree = addTree(b.checkout, fixRun, head);
    commitIn(fixTree, "feature.txt", "v2\n", "fix: review");
    git(fixTree, ["push", "-q", "origin", "HEAD:refs/heads/kiln/reviewed-work"]);
    git(b.checkout, ["fetch", "-q", "origin"]);
    writeDelivery(b.config.kilnDir, {
      jobId: reviewed,
      runId: landedRun,
      branch: "kiln/reviewed-work",
      base: "main",
      pushed: true,
      prNumber: 9,
    });
    writeFeedbackLedger(b.config.kilnDir, {
      jobId: reviewed,
      rounds: [
        {
          round: 1,
          headSha: head,
          trigger: "review",
          items: [{ kind: "review", source: "someone", summary: "rename it" }],
          fixRunId: fixRun,
          outcome: "pushed",
          at: "2026-11-19T00:00:02.000Z",
        },
      ],
    });
    assert.equal(readStatus(b.config, reviewed, host()).jobs[0]?.state, "in-review");

    tick(b);
    for (const tree of [rejectedTree, cancelledTree, landedTree, fixTree]) {
      assert.equal(existsSync(tree), false, tree);
    }
    const reasons = Object.fromEntries(
      worktreeEvents(b.config, "worktree.cleaned").map((event) => [event.run_id, (event.properties as { reason?: string }).reason]),
    );
    assert.deepEqual(reasons, {
      [rejectedRun]: "gate rejected",
      [cancelledRun]: "job cancelled",
      [landedRun]: "landed and pushed",
      [fixRun]: "run replaced by a later run",
    });
    // Tips on origin, or on the base, go with the worktree.
    assert.equal(branchExists(b.checkout, landedRun), false);
    assert.equal(branchExists(b.checkout, fixRun), false);
    assert.equal(branchExists(b.checkout, rejectedRun), false);
  });

  it("snapshots uncommitted tracked and untracked changes onto the branch before removing, and pushes nothing", () => {
    const b = bench("dirty");
    const jobId = addJob(b.config, "Dirty work");
    const runId = "2026-11-19T00-00-00Z-dirty";
    journal(b.checkout, jobId, runId, { status: "ok", decision: "approve" });
    const tree = addTree(b.checkout, runId);
    writeFileSync(join(tree, "README.md"), "edited, not committed\n");
    writeFileSync(join(tree, "new.txt"), "brand new\n");
    mkdirSync(join(tree, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(tree, "node_modules", "dep", "index.js"), "ignored\n");
    const remoteBefore = git(b.checkout, ["ls-remote", "origin"]);

    const plan = cleanWorktrees(b.config, {}, host());
    assert.match(plan, new RegExp(`${runId}  web  ${jobId}  done  \\S+  snapshot-remove: job done`));
    tick(b);

    assert.equal(existsSync(tree), false);
    assert.equal(git(b.checkout, ["show", `yak/${runId}:README.md`]), "edited, not committed\n");
    assert.equal(git(b.checkout, ["show", `yak/${runId}:new.txt`]), "brand new\n");
    assert.notEqual(gitStatus(b.checkout, ["cat-file", "-e", `yak/${runId}:node_modules/dep/index.js`]), 0);
    const message = git(b.checkout, ["log", "-1", "--format=%an <%ae>%n%B", `yak/${runId}`]);
    assert.match(message, /^kiln <kiln@localhost>/);
    assert.match(message, /kiln: snapshot uncommitted changes before removing worktree/);
    assert.match(message, /Made by Kiln, not pushed\./);
    assert.equal(branchExists(b.checkout, runId), true, "the snapshot exists only locally, so the branch stays");
    assert.equal(git(b.checkout, ["ls-remote", "origin"]), remoteBefore);
    const cleaned = worktreeEvents(b.config, "worktree.cleaned", runId)[0]?.properties as { snapshot?: string; branch?: string };
    assert.equal(cleaned.snapshot, git(b.checkout, ["rev-parse", `yak/${runId}`]).trim());
    assert.equal(cleaned.branch, "kept");
    // The checkout itself is untouched.
    assert.equal(readFileSync(join(b.checkout, "README.md"), "utf8"), "fixture\n");
  });
});

describe("worktrees that stay", () => {
  it("keeps a live run, a gated run, an open fix round, and a branch a stacked job will be cut from", () => {
    const b = bench("stay", { deliver: "pr", base: "main" });
    const live = addJob(b.config, "Live work");
    const liveRun = "2026-11-19T00-00-00Z-live";
    journal(b.checkout, live, liveRun, { status: "alive" });
    const liveTree = addTree(b.checkout, liveRun);
    writeFileSync(join(liveTree, "wip.txt"), "in progress\n");

    const gated = addJob(b.config, "Gated work");
    const gatedRun = "2026-11-19T00-00-01Z-gated";
    journal(b.checkout, gated, gatedRun, { status: "suspended" });
    const gatedTree = addTree(b.checkout, gatedRun);

    const fixing = addJob(b.config, "Work under review");
    const landedRun = "2026-11-19T00-00-02Z-landed";
    const fixRun = "2026-11-19T00-00-03Z-fixing";
    journal(b.checkout, fixing, landedRun, { status: "ok", decision: "approve" });
    journal(b.checkout, fixing, fixRun, { status: "ok" });
    const landedTree = addTree(b.checkout, landedRun);
    const head = commitIn(landedTree, "feature.txt", "v1\n", "feat: under review");
    git(landedTree, ["push", "-q", "origin", "HEAD:refs/heads/kiln/under-review"]);
    const fixTree = addTree(b.checkout, fixRun, head);
    commitIn(fixTree, "feature.txt", "v2\n", "fix: not published yet");
    writeDelivery(b.config.kilnDir, { jobId: fixing, runId: landedRun, branch: "kiln/under-review", base: "main", pushed: true, prNumber: 11 });
    writeFeedbackLedger(b.config.kilnDir, {
      jobId: fixing,
      rounds: [
        {
          round: 1,
          headSha: head,
          trigger: "review",
          items: [{ kind: "review", source: "someone", summary: "rename it" }],
          fixRunId: fixRun,
          at: "2026-11-19T00:00:02.000Z",
        },
      ],
    });

    const upstream = addJob(b.config, "Upstream work");
    const upstreamRun = "2026-11-19T00-00-04Z-upstream";
    journal(b.checkout, upstream, upstreamRun, { status: "ok", decision: "approve" });
    const upstreamTree = addTree(b.checkout, upstreamRun);
    commitIn(upstreamTree, "upstream.txt", "base for the stack\n", "feat: upstream");
    git(upstreamTree, ["push", "-q", "origin", `HEAD:refs/heads/kiln/upstream-work`]);
    git(b.checkout, ["fetch", "-q", "origin"]);
    writeDelivery(b.config.kilnDir, { jobId: upstream, runId: upstreamRun, branch: "kiln/upstream-work", base: "main", pushed: true, prNumber: 12 });
    const stacked = addJob(b.config, "Stacked work", { dependsOn: [upstream], stack: true });
    assert.equal(readStatus(b.config, stacked, host()).jobs[0]?.state, "queued");

    tick(b);
    assert.equal(existsSync(liveTree), true, "live run");
    assert.equal(readFileSync(join(liveTree, "wip.txt"), "utf8"), "in progress\n");
    assert.equal(existsSync(gatedTree), true, "gated run");
    assert.equal(existsSync(fixTree), true, "open fix round");
    // The landed run's tree goes (the fix round has its own), its pushed branch too.
    assert.equal(existsSync(landedTree), false);
    // The upstream tree goes, but its branch stays for the stacked job.
    assert.equal(existsSync(upstreamTree), false);
    assert.equal(branchExists(b.checkout, upstreamRun), true, "stacked job still needs yak/<upstream run>");
    assert.equal(
      (worktreeEvents(b.config, "worktree.cleaned", upstreamRun)[0]?.properties as { branch?: string }).branch,
      "kept",
    );
    for (const runId of [liveRun, gatedRun, fixRun]) {
      assert.equal(worktreeEvents(b.config, "worktree.cleaned", runId).length, 0, runId);
      assert.equal(worktreeEvents(b.config, "worktree.kept", runId).length, 0, runId);
    }
    const plan = cleanWorktrees(b.config, {}, host());
    assert.match(plan, new RegExp(`${liveRun} .* keep: run is alive`));
    assert.match(plan, new RegExp(`${gatedRun} .* keep: run is waiting on a gate`));
    assert.match(plan, new RegExp(`${fixRun} .* keep: fix round in progress`));
  });

  it("leaves a directory no Kiln job owns in place and lists it as unowned", () => {
    const b = bench("unowned");
    const stray = "2026-11-19T00-00-00Z-stray";
    const tree = addTree(b.checkout, stray);
    mkdirSync(join(b.checkout, ".yak", "worktrees", "not a run id"), { recursive: true });

    tick(b);
    assert.equal(existsSync(tree), true);
    assert.equal(branchExists(b.checkout, stray), true);
    const plan = cleanWorktrees(b.config, { apply: true }, host());
    assert.match(plan, new RegExp(`${stray}  web  -  -  \\S+  unowned: no Kiln job owns this run`));
    assert.match(plan, /not a run id {2}web {2}- {2}- {2}\S+ {2}unowned/);
    assert.match(plan, /cleaned 0/);
    assert.equal(existsSync(tree), true);
    assert.equal(worktreeEvents(b.config, "worktree.cleaned").length, 0);
  });
});

describe("kiln clean", () => {
  function snapshot(b: Bench, checkouts: string[]): string {
    const events = existsSync(join(b.config.kilnDir, "events.jsonl")) ? readFileSync(join(b.config.kilnDir, "events.jsonl"), "utf8") : "";
    return [
      ...checkouts.flatMap((checkout) => [git(checkout, ["worktree", "list", "--porcelain"]), git(checkout, ["branch", "--list", "--format=%(refname) %(objectname)"])]),
      events,
    ].join("\n---\n");
  }

  it("lists without changing anything, --apply removes exactly the removable entries, a second --apply removes nothing, and --repo filters", () => {
    const b = bench("clean", {}, { keepWorktrees: true });
    const api = repoWithOrigin(b.dir, "api");
    const raw = JSON.parse(readFileSync(b.configPath, "utf8")) as { repos: Record<string, unknown> };
    raw.repos.api = { path: api, test: "true" };
    writeFileSync(b.configPath, `${JSON.stringify(raw, null, 2)}\n`);
    const config = loadKilnConfig(b.configPath);
    assert.equal(config.keepWorktrees, true);
    const c: Bench = { ...b, config };

    const done = addJob(config, "Done work");
    const doneRun = "2026-11-19T00-00-00Z-done";
    journal(b.checkout, done, doneRun, { status: "ok", decision: "approve" });
    const doneTree = addTree(b.checkout, doneRun);
    const live = addJob(config, "Live work");
    const liveRun = "2026-11-19T00-00-01Z-live";
    journal(b.checkout, live, liveRun, { status: "alive" });
    const liveTree = addTree(b.checkout, liveRun);
    const failed = addJob(config, "Failed api work", { repo: "api" });
    const failedRun = "2026-11-19T00-00-02Z-apifail";
    journal(api, failed, failedRun, { status: "failed" });
    const failedTree = addTree(api, failedRun);

    // keepWorktrees: the tick removes nothing.
    tick(c);
    assert.equal(existsSync(doneTree), true);
    assert.equal(existsSync(failedTree), true);
    assert.equal(worktreeEvents(config, "worktree.cleaned").length, 0);

    const before = snapshot(c, [b.checkout, api]);
    const listed = cleanWorktrees(config, {}, host());
    assert.equal(snapshot(c, [b.checkout, api]), before);
    assert.match(listed, new RegExp(`${doneRun}  web  ${done}  done  \\S+  remove: job done`));
    assert.match(listed, new RegExp(`${liveRun}  web  ${live}  running  \\S+  keep: run is alive`));
    assert.match(listed, new RegExp(`${failedRun}  api  ${failed}  failed  \\S+  remove: run failed`));

    const webOnly = cleanWorktrees(config, { repo: "web" }, host());
    assert.doesNotMatch(webOnly, /  api  /);
    assert.match(webOnly, new RegExp(doneRun));
    assert.throws(() => cleanWorktrees(config, { repo: "nope" }, host()), /Repo nope is not registered/);

    const applied = cleanWorktrees(config, { apply: true }, host());
    const removed = [...applied.matchAll(/^cleaned (\S+)/gm)].map((match) => match[1]).sort();
    assert.deepEqual(removed, [doneRun, failedRun].sort());
    assert.equal(existsSync(doneTree), false);
    assert.equal(existsSync(failedTree), false);
    assert.equal(existsSync(liveTree), true);

    const second = cleanWorktrees(config, { apply: true }, host());
    assert.doesNotMatch(second, /^cleaned (?!0$)\S/m);
    assert.match(second, /cleaned 0/);
    assert.equal(worktreeEvents(config, "worktree.cleaned").length, 2);
  });

  it("runs from the CLI: no flags lists, --apply removes, an unknown repo exits 1", () => {
    const b = bench("cli");
    const jobId = addJob(b.config, "Done work");
    const runId = "2026-11-19T00-00-00Z-cli";
    journal(b.checkout, jobId, runId, { status: "ok", decision: "approve" });
    const tree = addTree(b.checkout, runId);
    const cli = (args: string[]) =>
      spawnSync(process.execPath, [join(root, "dist", "cli.js"), "clean", ...args, "--config", b.configPath], { encoding: "utf8" });

    const listed = cli([]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`${runId}  web  ${jobId}  done  \\S+  remove: job done`));
    assert.equal(existsSync(tree), true);
    const unknown = cli(["--repo", "nope"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Repo nope is not registered/);
    const applied = cli(["--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, new RegExp(`cleaned ${runId}`));
    assert.equal(existsSync(tree), false);
  });
});

describe("keepWorktrees config", () => {
  it("defaults to false and loads true", () => {
    const off = bench("cfg-off");
    assert.equal(off.config.keepWorktrees, false);
    const on = bench("cfg-on", {}, { keepWorktrees: true });
    assert.equal(on.config.keepWorktrees, true);
  });
});

describe("a finished job after cleanup", () => {
  it("renders the job page with a note that changes are gone, and kiln status still prints", async () => {
    const b = bench("page");
    const jobId = addJob(b.config, "Finished work");
    const runId = "2026-11-19T00-00-00Z-page";
    journal(b.checkout, jobId, runId, { status: "ok", decision: "approve" });
    const tree = addTree(b.checkout, runId);
    commitIn(tree, "feature.txt", "done\n", "feat: finished");
    git(b.checkout, ["merge", "-q", "--ff-only", `yak/${runId}`]);
    tick(b);
    assert.equal(existsSync(tree), false);
    assert.equal(branchExists(b.checkout, runId), false);

    const status = runStatus(b.config, undefined, host());
    assert.match(status, new RegExp(`${jobId}  web  feature  done .*branch yak/${runId}`));

    const server = await serve(b.configPath);
    try {
      const page = await fetch(`${server}/jobs/${jobId}?tab=changes`);
      const body = await page.text();
      assert.equal(page.status, 200, body);
      assert.match(body, new RegExp(`Branch yak/${runId} was removed after the job finished; changes are no longer available locally\\.`));
      const overview = await fetch(`${server}/jobs/${jobId}?tab=timeline`);
      assert.equal(overview.status, 200);
      assert.match(await overview.text(), /Worktree cleaned · branch deleted/);
    } finally {
      for (const child of children.splice(0)) child.kill("SIGKILL");
    }
  });
});

function serve(configPath: string): Promise<string> {
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", "--port", "0", "--no-tick", "--config", configPath], {
    encoding: "utf8",
  } as never);
  children.push(child);
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    out += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not listen\n${out}`)), 10_000);
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const match = out.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}\n${out}`));
    });
  });
}
