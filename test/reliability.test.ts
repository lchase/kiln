import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig } from "../src/config.js";
import { readStatus, runStatus, runTick, startupRecovery } from "../src/driver.js";
import { KilnConfigError } from "../src/errors.js";
import { writeJob } from "../src/jobs.js";
import { packageRoot } from "../src/paths.js";
import { isPidAlive, isStalled, readAttemptLedger, RETRY_BASE_MS, retryDelayMs, MAX_RETRY_BACKOFF_MS } from "../src/reliability.js";
import { scheduledRetry } from "../src/attention.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_STALL_TIMEOUT_MS } from "../src/schemas.js";

const root = packageRoot();
const keep: string[] = [];
const stray: number[] = [];

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  const fixtures = join(dir, "test", "fixtures", "kiln-feature");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(
    join(fixtures, "spec.json"),
    `${JSON.stringify([{ output: { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." } }])}\n`,
  );
  writeFileSync(join(fixtures, "build.json"), `${JSON.stringify([{ output: { summary: "Mock build.", status: "READY" } }])}\n`);
  for (const step of ["security", "ux", "ui", "code"]) {
    writeFileSync(join(fixtures, `${step}.json`), `${JSON.stringify([{ output: { verdict: "PASS", findings: "No must-fix findings." } }])}\n`);
  }
  writeFileSync(
    join(fixtures, "approver.json"),
    `${JSON.stringify([{ output: { decision: "APPROVE", reason: "Reviews passed." } }])}\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function kilnHome(dir: string, checkout: string, extra: Record<string, unknown> = {}): string {
  const configDir = join(dir, "kiln");
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "kiln.config.json");
  writeFileSync(
    path,
    `${JSON.stringify({ adapter: "mock", maxConcurrent: 2, repos: { web: { path: checkout, test: "node --test test.mjs" } }, ...extra }, null, 2)}\n`,
  );
  return path;
}

function load(dir: string, checkout: string, extra: Record<string, unknown> = {}) {
  return loadKilnConfig(kilnHome(dir, checkout, extra));
}

function add(config: ReturnType<typeof load>, title: string): string {
  const written = writeJob(config, {
    workflow: "feature",
    repo: "web",
    specText: `# ${title}\n\nDo the work.\n`,
    title,
    dependsOn: [],
    source: { kind: "prompt", ref: "inline" },
  });
  return written.job.id;
}

function journal(checkout: string, runId: string, lines: unknown[]): void {
  const dir = join(checkout, ".runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function pidNote(pid: number): string {
  let stat = "missing";
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  } catch (error) {
    stat = error instanceof Error ? error.message : String(error);
  }
  return `pid ${pid} stat=${stat}`;
}

function killGroup(pid: number | undefined): void {
  if (!pid || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function spawnTree(): Promise<{ parent: ChildProcess; parentPid: number; childPid: number }> {
  const parent = spawn("bash", ["-c", "sleep 300 & echo $!; wait"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (parent.pid) stray.push(parent.pid);
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`sleeper did not print a child pid\n${buf}`)), 3000);
    parent.stdout?.setEncoding("utf8");
    parent.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const line = buf.split("\n")[0]?.trim();
      if (line && /^\d+$/.test(line) && parent.pid) {
        clearTimeout(timer);
        resolve({ parent, parentPid: parent.pid, childPid: Number(line) });
      }
    });
    parent.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process still running")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runCli(args: string[], homeDir: string, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: homeDir, KILN_HOME: join(homeDir, "kiln-unused") },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

after(() => {
  for (const pid of stray) killGroup(pid);
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("retry delay", () => {
  it("uses 10s × 2^(n-1) capped at 5 minutes", () => {
    assert.equal(retryDelayMs(1), RETRY_BASE_MS);
    assert.equal(retryDelayMs(2), 20_000);
    assert.equal(retryDelayMs(3), 40_000);
    assert.equal(retryDelayMs(6), MAX_RETRY_BACKOFF_MS);
    assert.equal(retryDelayMs(20), MAX_RETRY_BACKOFF_MS);
    assert.equal(isStalled(1_000, 1_000 + 15 * 60 * 1000, 15 * 60 * 1000), false);
    assert.equal(isStalled(1_000, 1_000 + 15 * 60 * 1000 + 1, 15 * 60 * 1000), true);
    assert.equal(isStalled(1_000, 9_000, 0), false);
    assert.equal(DEFAULT_STALL_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  });
});

describe("kiln config reliability keys", () => {
  it("defaults stallTimeoutMs and maxAttempts and rejects a zero attempt budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-cfg-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    mkdirSync(checkout);
    const loaded = load(dir, checkout);
    assert.equal(loaded.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS);
    assert.equal(loaded.maxAttempts, DEFAULT_MAX_ATTEMPTS);

    const custom = load(dir, checkout, { stallTimeoutMs: 0, maxAttempts: 5 });
    assert.equal(custom.stallTimeoutMs, 0);
    assert.equal(custom.maxAttempts, 5);

    const broken = join(dir, "kiln", "bad.json");
    writeFileSync(broken, `${JSON.stringify({ maxAttempts: 0, repos: { web: { path: checkout } } })}\n`);
    assert.throws(() => loadKilnConfig(broken), KilnConfigError);
  });
});

describe("run reliability", () => {
  it("kills a stalled process tree and retries it after backoff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-stall-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { stallTimeoutMs: 1000, maxAttempts: 3 });
    const id = add(config, "Stall the agent");
    const tree = await spawnTree();
    const runId = "2000-01-01T00-00-00Z-stall";
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    journal(checkout, runId, [
      { t: "run.started", at: stale, runId, tag: `kiln:${id}`, pid: tree.parentPid },
      { t: "step.started", at: stale, stepId: "build", pid: tree.parentPid },
    ]);
    const journalPath = join(checkout, ".runs", runId, "journal.jsonl");
    const staleDate = new Date(stale);
    utimesSync(journalPath, staleDate, staleDate);
    const now = new Date();
    const first = runTick(config, undefined, { startup: true, now });
    assert.match(
      first,
      new RegExp(`stall ${id}  stalled  attempt 1`),
      `${first}\nalive=${isPidAlive(tree.parentPid)} eventStale=${isStalled(Date.parse(stale), now.getTime(), 1000)}\n${pidNote(tree.parentPid)}\n${readFileSync(journalPath, "utf8")}`,
    );
    assert.doesNotMatch(first, new RegExp(`retry ${id}`));
    await waitForExit(tree.parent);
    assert.equal(existsSync(`/proc/${tree.childPid}`), false);

    const status = readStatus(config, id);
    assert.equal(status.jobs[0]?.state, "failed");
    assert.equal(status.jobs[0]?.attemptCount, 1);
    assert.equal(status.jobs[0]?.lastFailureReason, "stalled");
    assert.equal(typeof status.jobs[0]?.nextRetryAt, "string");
    const text = runStatus(config, id);
    assert.match(text, /attempts 1/);
    assert.match(text, /reason stalled/);
    assert.match(text, /next retry /);

    const again = runTick(config, undefined, { startup: true, now });
    assert.doesNotMatch(again, new RegExp(`stall ${id}`));
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 1);
    assert.equal(attemptsOf(config.kilnDir, id).nextRetryAt, status.jobs[0]?.nextRetryAt);

    const due = new Date(now.getTime() + 10_000 + 50);
    const retried = runTick(config, undefined, { startup: true, now: due });
    assert.match(retried, new RegExp(`retry ${id}\\s+web`));
    const pid = Number(retried.match(/pid (\d+)/)?.[1]);
    assert.ok(pid > 1, retried);
    stray.push(pid);
    killGroup(pid);
    const jobFile = JSON.parse(readFileSync(join(config.jobsDir, `${id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("state" in jobFile, false);
    assert.equal("attempts" in jobFile, false);
  });

  it("does not stall when the log is fresh or stall detection is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-quiet-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { stallTimeoutMs: 1000 });
    const id = add(config, "Still writing");
    const tree = await spawnTree();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    journal(checkout, "2000-01-01T00-00-00Z-log", [
      { t: "run.started", at: stale, runId: "2000-01-01T00-00-00Z-log", tag: `kiln:${id}`, pid: tree.parentPid },
    ]);
    const logPath = join(config.kilnDir, "logs", `${id}.log`);
    mkdirSync(join(config.kilnDir, "logs"), { recursive: true });
    writeFileSync(logPath, "still going\n");
    const tick = runTick(config, undefined, { startup: true, now: new Date() });
    assert.doesNotMatch(tick, /stall /);
    assert.equal(readAttemptLedger(config.kilnDir, id), undefined);
    assert.equal(tree.parent.exitCode, null);

    const disabled = load(join(dir, "off"), checkout, { stallTimeoutMs: 0 });
    const other = add(disabled, "Disabled stall");
    journal(checkout, "2000-01-01T00-00-01Z-off", [
      { t: "run.started", at: stale, runId: "2000-01-01T00-00-01Z-off", tag: `kiln:${other}`, pid: tree.parentPid },
    ]);
    const skipped = runTick(disabled, undefined, { startup: true, now: new Date() });
    assert.doesNotMatch(skipped, new RegExp(`stall ${other}`));
    assert.equal(readStatus(disabled, other).jobs[0]?.state, "running");
    killGroup(tree.parentPid);
    await waitForExit(tree.parent);
  });

  it("marks an orphan at startup, cleans only safe worktrees, and a second pass does not retry twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-orphan-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const head = git(checkout, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(checkout, "scratch.txt"), "mine\n");
    git(checkout, ["branch", "keep-me"]);
    const config = load(dir, checkout, { maxAttempts: 3 });
    const gone = add(config, "Orphan with an empty tree");
    const saved = add(config, "Orphan with unpushed work");
    const emptyRun = "2000-02-01T00-00-00Z-empty";
    const savedRun = "2000-02-01T00-00-01Z-saved";
    const deadPid = 2_147_483_646;
    journal(checkout, emptyRun, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId: emptyRun, tag: `kiln:${gone}`, pid: deadPid }]);
    journal(checkout, savedRun, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId: savedRun, tag: `kiln:${saved}`, pid: deadPid }]);
    const emptyTree = join(checkout, ".yak", "worktrees", emptyRun);
    const savedTree = join(checkout, ".yak", "worktrees", savedRun);
    git(checkout, ["worktree", "add", "-b", `yak/${emptyRun}`, emptyTree, "HEAD"]);
    git(checkout, ["worktree", "add", "-b", `yak/${savedRun}`, savedTree, "HEAD"]);
    writeFileSync(join(savedTree, "notes.txt"), "keep this\n");
    git(savedTree, ["add", "notes.txt"]);
    git(savedTree, ["commit", "-q", "-m", "unpushed"]);

    const now = new Date("2026-04-01T00:00:00.000Z");
    startupRecovery(config, undefined, now);
    const emptyStatus = readStatus(config, gone).jobs[0];
    const savedStatus = readStatus(config, saved).jobs[0];
    assert.equal(emptyStatus?.state, "failed");
    assert.equal(emptyStatus?.lastFailureReason, "orphaned");
    assert.equal(emptyStatus?.attemptCount, 1);
    assert.equal(savedStatus?.lastFailureReason, "orphaned");
    assert.equal(savedStatus?.attemptCount, 1);
    assert.equal(existsSync(emptyTree), false);
    assert.equal(git(checkout, ["branch", "--list", `yak/${emptyRun}`]).trim(), "");
    assert.equal(existsSync(savedTree), true);
    assert.match(git(checkout, ["log", "-1", "--format=%s", `yak/${savedRun}`]), /unpushed/);
    assert.equal(readFileSync(join(checkout, "scratch.txt"), "utf8"), "mine\n");
    assert.equal(git(checkout, ["rev-parse", "HEAD"]).trim(), head);
    assert.match(git(checkout, ["branch", "--list", "keep-me"]), /keep-me/);
    assert.match(git(checkout, ["status", "--porcelain"]), /scratch\.txt/);

    const firstNext = attemptsOf(config.kilnDir, gone).nextRetryAt;
    startupRecovery(config, undefined, new Date(now.getTime() + 60_000));
    assert.equal(attemptsOf(config.kilnDir, gone).attempts.length, 1);
    assert.equal(attemptsOf(config.kilnDir, gone).nextRetryAt, firstNext);
    assert.equal(attemptsOf(config.kilnDir, saved).attempts.length, 1);
    assert.equal(existsSync(savedTree), true);
    assert.equal(existsSync(emptyTree), false);
  });

  it("detects an orphan when kiln serve starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-serve-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const home = join(dir, "home");
    mkdirSync(home);
    const config = load(dir, checkout);
    const id = add(config, "Gone before serve");
    const runId = "2000-03-01T00-00-00Z-serve";
    journal(checkout, runId, [
      { t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 },
    ]);
    const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", "--port", "0", "--no-tick", "--config", config.configPath], {
      cwd: dir,
      env: { ...process.env, HOME: home },
    });
    if (child.pid) stray.push(child.pid);
    let stdout = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve did not listen\n${stdout}`)), 10_000);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("listening ")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited ${code}\n${stdout}`));
        });
      });
      const status = readStatus(config, id).jobs[0];
      assert.equal(status?.state, "failed");
      assert.equal(status?.lastFailureReason, "orphaned");
      assert.equal(status?.attemptCount, 1);
      assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 1);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child).catch(() => killGroup(child.pid));
      }
    }
  });

  it("retries a crash until the budget is spent and then stays dead", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-crash-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { maxAttempts: 3, stallTimeoutMs: 60_000 });
    const id = add(config, "Crash the agent");
    const deadPid = 2_147_483_646;
    const runs = ["2000-04-01T00-00-00Z-a", "2000-04-01T00-00-01Z-b", "2000-04-01T00-00-02Z-c"];
    const start = new Date("2026-05-01T00:00:00.000Z");
    journal(checkout, runs[0]!, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId: runs[0], tag: `kiln:${id}`, pid: deadPid }]);

    const first = runTick(config, undefined, { startup: false, now: start });
    assert.match(first, new RegExp(`crash ${id}  crashed  attempt 1`));
    assert.doesNotMatch(first, new RegExp(`retry ${id}`));
    const view = readStatus(config, id).jobs[0];
    assert.equal(view?.state, "failed");
    assert.equal(view?.lastFailureReason, "crashed");
    assert.equal(view?.attemptCount, 1);
    const firstNext = Date.parse(view?.nextRetryAt ?? "");
    assert.equal(firstNext - start.getTime(), 10_000);

    const repeat = runTick(config, undefined, { startup: false, now: new Date(start.getTime() + 1000) });
    assert.doesNotMatch(repeat, new RegExp(`crash ${id}`));
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 1);
    assert.equal(attemptsOf(config.kilnDir, id).nextRetryAt, view?.nextRetryAt);

    journal(checkout, runs[1]!, [{ t: "run.started", at: "2020-01-01T00:00:01.000Z", runId: runs[1], tag: `kiln:${id}`, pid: deadPid }]);
    const secondNow = new Date(start.getTime() + 10_000);
    const second = runTick(config, undefined, { startup: false, now: secondNow });
    assert.match(second, new RegExp(`crash ${id}  crashed  attempt 2`));
    assert.doesNotMatch(second, new RegExp(`retry ${id}`));
    const mid = readStatus(config, id).jobs[0];
    assert.equal(mid?.state, "failed");
    assert.equal(mid?.attemptCount, 2);
    assert.equal(Date.parse(mid?.nextRetryAt ?? "") - secondNow.getTime(), 20_000);

    journal(checkout, runs[2]!, [{ t: "run.started", at: "2020-01-01T00:00:02.000Z", runId: runs[2], tag: `kiln:${id}`, pid: deadPid }]);
    const thirdNow = new Date(secondNow.getTime() + 20_000);
    const third = runTick(config, undefined, { startup: false, now: thirdNow });
    assert.match(third, new RegExp(`crash ${id}  crashed  attempt 3  dead`));
    assert.doesNotMatch(third, new RegExp(`retry ${id}`));
    const dead = readStatus(config, id).jobs[0];
    assert.equal(dead?.state, "dead");
    assert.equal(dead?.attemptCount, 3);
    assert.equal(dead?.lastFailureReason, "crashed");
    assert.equal(dead?.nextRetryAt, undefined);
    assert.match(runStatus(config, id), new RegExp(`retry: kiln retry ${id}`));

    const later = runTick(config, undefined, { startup: false, now: new Date(thirdNow.getTime() + 60 * 60 * 1000) });
    assert.match(later, /nothing to launch/);
    assert.doesNotMatch(later, new RegExp(`retry ${id}|crash ${id}`));
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 3);
    const stored = JSON.parse(readFileSync(join(config.jobsDir, `${id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("state" in stored, false);
  });

  it("launches a due crash retry once", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-dispatch-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { maxAttempts: 3 });
    const id = add(config, "Dispatch the retry");
    const runId = "2000-05-01T00-00-00Z-due";
    journal(checkout, runId, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 }]);
    const now = new Date("2026-06-01T00:00:00.000Z");
    runTick(config, undefined, { startup: false, now });
    const retried = runTick(config, undefined, { startup: false, now: new Date(now.getTime() + 10_000) });
    assert.match(retried, new RegExp(`retry ${id}\\s+web`));
    const pid = Number(retried.match(/pid (\d+)/)?.[1]);
    stray.push(pid);
    killGroup(pid);
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 1);
  });

  it("does not retry a rejected gate, a missing approval, or a cancelled run", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-reject-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout);
    const rejected = add(config, "Reject the gate");
    const unread = add(config, "No approval");
    const cancelled = add(config, "Cancel the run");
    const failed = add(config, "Non zero exit");
    const rejectRun = "2000-06-01T00-00-00Z-reject";
    const unreadRun = "2000-06-01T00-00-01Z-unread";
    const cancelRun = "2000-06-01T00-00-02Z-cancel";
    const failRun = "2000-06-01T00-00-03Z-fail";
    for (const [runId, id] of [
      [rejectRun, rejected],
      [unreadRun, unread],
      [cancelRun, cancelled],
      [failRun, failed],
    ] as const) {
      journal(checkout, runId, [
        { t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 },
      ]);
    }
    const finish = (runId: string, status: string, reason?: string): void => {
      writeFileSync(
        join(checkout, ".runs", runId, "journal.jsonl"),
        `${JSON.stringify({ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: readTag(checkout, runId), pid: 1 })}\n${JSON.stringify({ t: "run.finished", at: "2020-01-01T00:00:01.000Z", status, ...(reason ? { reason } : {}) })}\n`,
      );
    };
    finish(rejectRun, "ok");
    mkdirSync(join(checkout, ".runs", rejectRun, "artifacts"), { recursive: true });
    writeFileSync(join(checkout, ".runs", rejectRun, "artifacts", "approval.json"), `${JSON.stringify({ decision: "reject" })}\n`);
    finish(unreadRun, "ok");
    finish(cancelRun, "failed", "cancelled");
    finish(failRun, "failed");

    const now = new Date("2026-07-01T00:00:00.000Z");
    const tick = runTick(config, undefined, { startup: true, now });
    assert.match(tick, new RegExp(`fail ${failed}  failed  attempt 1`));
    assert.doesNotMatch(tick, new RegExp(`retry ${rejected}|orphan ${rejected}|crash ${rejected}`));
    assert.doesNotMatch(tick, new RegExp(`${unread}|${cancelled}`));
    assert.equal(readStatus(config, rejected).jobs[0]?.state, "rejected");
    assert.equal(readStatus(config, rejected).jobs[0]?.attemptCount, 0);
    assert.equal(readAttemptLedger(config.kilnDir, rejected), undefined);
    assert.equal(readStatus(config, unread).jobs[0]?.state, "failed");
    assert.equal(readStatus(config, unread).jobs[0]?.nextRetryAt, undefined);
    assert.equal(readAttemptLedger(config.kilnDir, unread), undefined);
    assert.equal(readAttemptLedger(config.kilnDir, cancelled), undefined);
    assert.equal(readStatus(config, failed).jobs[0]?.lastFailureReason, "failed");
    assert.equal(readStatus(config, failed).jobs[0]?.state, "failed");

    const later = runTick(config, undefined, { startup: true, now: new Date(now.getTime() + 60_000) });
    assert.doesNotMatch(later, new RegExp(`retry ${rejected}|retry ${unread}|retry ${cancelled}`));
    assert.match(later, new RegExp(`retry ${failed}\\s+web`));
    const pid = Number(later.match(/pid (\d+)/)?.[1]);
    stray.push(pid);
    killGroup(pid);
  });

  it("kiln retry clears attempts and lets the next tick launch", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-manual-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const home = join(dir, "home");
    mkdirSync(home);
    const config = load(dir, checkout, { maxAttempts: 3 });
    const id = add(config, "Retry by hand");
    const runId = "2000-07-01T00-00-00Z-hand";
    journal(checkout, runId, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 }]);
    runTick(config, undefined, { startup: false, now: new Date("2026-08-01T00:00:00.000Z") });
    assert.equal(readStatus(config, id).jobs[0]?.attemptCount, 1);

    const cli = runCli(["retry", id, "--config", config.configPath], home, dir);
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    assert.match(cli.stdout, new RegExp(`retry ${id}\\s+web`));
    assert.match(cli.stdout, /cleared 1 attempt/);
    const pid = Number(cli.stdout.match(/pid (\d+)/)?.[1]);
    assert.ok(pid > 1, cli.stdout);
    stray.push(pid);
    const cleared = readStatus(config, id).jobs[0];
    assert.equal(cleared?.attemptCount, 0);
    assert.equal(cleared?.lastFailureReason, undefined);
    assert.equal(cleared?.nextRetryAt, undefined);
    assert.equal(cleared?.state, "running");
    killGroup(pid);
    const stored = JSON.parse(readFileSync(join(config.jobsDir, `${id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("state" in stored, false);
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 0);

    const running = add(config, "Still running");
    const live = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    if (live.pid) stray.push(live.pid);
    journal(checkout, "2000-07-01T00-00-01Z-live", [
      { t: "run.started", at: new Date().toISOString(), runId: "2000-07-01T00-00-01Z-live", tag: `kiln:${running}`, pid: live.pid },
    ]);
    const refused = runCli(["retry", running, "--config", config.configPath], home, dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /running/);
    killGroup(live.pid);
  });

  it("kiln retry on a dead job clears the ledger and relaunches it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-dead-retry-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const home = join(dir, "home");
    mkdirSync(home);
    const config = load(dir, checkout, { maxAttempts: 3 });
    const id = add(config, "Dead and retry");
    const runId = "2000-07-02T00-00-00Z-dead";
    journal(checkout, runId, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 }]);
    mkdirSync(join(config.kilnDir, "attempts"), { recursive: true });
    writeFileSync(
      join(config.kilnDir, "attempts", `${id}.json`),
      `${JSON.stringify({
        jobId: id,
        attempts: [1, 2, 3].map((n) => ({
          n,
          at: "2026-08-01T00:00:00.000Z",
          reason: "crashed",
          runId,
          detail: "process exited",
        })),
      })}\n`,
    );
    const before = readStatus(config, id).jobs[0];
    assert.equal(before?.state, "dead");
    assert.equal(before?.attemptCount, 3);
    assert.equal(before?.lastFailureReason, "crashed");

    const cli = runCli(["retry", id, "--config", config.configPath], home, dir);
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    assert.match(cli.stdout, new RegExp(`retry ${id}\\s+web`));
    assert.match(cli.stdout, /cleared 3 attempts/);
    const pid = Number(cli.stdout.match(/pid (\d+)/)?.[1]);
    assert.ok(pid > 1, cli.stdout);
    stray.push(pid);
    const after = readStatus(config, id).jobs[0];
    assert.equal(after?.attemptCount, 0);
    assert.equal(after?.state, "running");
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 0);
    const stored = JSON.parse(readFileSync(join(config.jobsDir, `${id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("state" in stored, false);
    killGroup(pid);
  });

  it("two overlapping ticks record a single orphan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-lock-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const home = join(dir, "home");
    mkdirSync(home);
    const config = load(dir, checkout);
    const id = add(config, "Overlap cleanup");
    const runId = "2000-08-01T00-00-00Z-lock";
    journal(checkout, runId, [{ t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 }]);
    const [left, right] = await Promise.all([
      runCliAsync(["tick", "--config", config.configPath], home, dir),
      runCliAsync(["tick", "--config", config.configPath], home, dir),
    ]);
    assert.equal(attemptsOf(config.kilnDir, id).attempts.length, 1);
    const outputs = [left, right].map((result) => `${result.status}\n${result.stdout}\n${result.stderr}`).join("\n---\n");
    const orphans = [left, right].filter((result) => result.status === 0 && result.stdout.includes(`orphan ${id}`));
    assert.equal(orphans.length, 1, outputs);
  });

  it("does not retry a run that failed with sandbox-error", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-sandbox-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { maxAttempts: 3, stallTimeoutMs: 60_000 });
    const id = add(config, "Sandbox stopped the container");
    const runId = "2000-09-01T00-00-00Z-sandbox";
    const detail = 'docker run exited 125 for command "npm test" (image "node:22") — the container never started';
    journal(checkout, runId, [
      { t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 },
      { t: "step.started", at: "2020-01-01T00:00:01.000Z", stepId: "verify" },
      {
        t: "step.failed",
        at: "2020-01-01T00:00:02.000Z",
        stepId: "verify",
        failure: { reason: "sandbox-error", detail, recoverable: false },
      },
      { t: "run.finished", at: "2020-01-01T00:00:03.000Z", status: "failed", runId },
    ]);
    const output = runTick(config, undefined, { startup: false, now: new Date("2026-05-01T00:00:00.000Z") });
    assert.doesNotMatch(output, new RegExp(`retry ${id}`));
    assert.doesNotMatch(output, new RegExp(`fail ${id}`));
    assert.equal(readAttemptLedger(config.kilnDir, id), undefined);
    const status = readStatus(config, id);
    const job = status.jobs[0];
    assert.equal(job?.state, "failed");
    assert.equal(job?.nextRetryAt, undefined);
    assert.match(job?.sandboxError ?? "", /container never started/);
    assert.equal(job?.attemptCount, 0);
    const item = status.attention.needsYou.find((entry) => entry.job.jobId === id);
    assert.match(item?.reason ?? "", /^Sandbox: docker run exited 125/);
  });

  it("clears a scheduled retry when the current run failed in the sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rel-sandbox-hold-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { maxAttempts: 3 });
    const id = add(config, "Do not retry the sandbox");
    const runId = "2000-09-02T00-00-00Z-sandbox";
    mkdirSync(join(config.kilnDir, "attempts"), { recursive: true });
    writeFileSync(
      join(config.kilnDir, "attempts", `${id}.json`),
      `${JSON.stringify({
        jobId: id,
        attempts: [{ n: 1, at: "2026-05-01T00:00:00.000Z", reason: "crashed", detail: "process exited" }],
        nextRetryAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    journal(checkout, runId, [
      { t: "run.started", at: "2020-01-01T00:00:00.000Z", runId, tag: `kiln:${id}`, pid: 2_147_483_646 },
      {
        t: "step.failed",
        at: "2020-01-01T00:00:02.000Z",
        stepId: "spec",
        failure: { reason: "sandbox-error", detail: "proxy image missing", recoverable: false },
      },
      { t: "run.finished", at: "2020-01-01T00:00:03.000Z", status: "failed", runId },
    ]);
    const output = runTick(config, undefined, { startup: false, now: new Date("2026-06-01T00:00:00.000Z") });
    assert.doesNotMatch(output, new RegExp(`retry ${id}`));
    const ledger = readAttemptLedger(config.kilnDir, id);
    assert.notEqual(ledger, undefined);
    assert.notEqual(ledger, "corrupt");
    if (ledger && ledger !== "corrupt") assert.equal(ledger.nextRetryAt, undefined);
    const job = readStatus(config, id).jobs[0];
    assert.equal(job?.state, "failed");
    assert.equal(job?.nextRetryAt, undefined);
    assert.equal(scheduledRetry(job ?? { state: "failed" }), false);
  });
});

function attemptsOf(kilnDir: string, jobId: string) {
  const read = readAttemptLedger(kilnDir, jobId);
  if (read === undefined || read === "corrupt") {
    assert.fail(`expected an attempt ledger for ${jobId}, got ${String(read)}`);
  }
  return read;
}

function readTag(checkout: string, runId: string): string | undefined {
  const text = readFileSync(join(checkout, ".runs", runId, "journal.jsonl"), "utf8");
  const line = text.split("\n").find((entry) => entry.includes("run.started"));
  if (!line) return undefined;
  return (JSON.parse(line) as { tag?: string }).tag;
}

function runCliAsync(
  args: string[],
  homeDir: string,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist", "cli.js"), ...args], {
      cwd,
      env: { ...process.env, HOME: homeDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
