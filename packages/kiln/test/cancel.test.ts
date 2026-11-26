import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { cancelJob, cancelQueuedJobs, readStatus, removeJob, runTick } from "../src/driver.js";
import { readEvents, type KilnEvent } from "../src/events.js";
import { realGitRemote, type KilnHost } from "../src/host.js";
import { writeJob } from "../src/jobs.js";
import { renderLedger } from "../src/ledger.js";
import { assertJobId, packageRoot } from "../src/paths.js";
import { isPidAlive } from "../src/reliability.js";

const keep: string[] = [];
const children: ChildProcess[] = [];
/** Process groups this file spawned. The after hook kills only these. */
const spawnedGroups: number[] = [];

after(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const pid of spawnedGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function harness(): { dir: string; config: LoadedKilnConfig } {
  const dir = mkdtempSync(join(tmpdir(), "kiln-cancel-"));
  keep.push(dir);
  const checkout = join(dir, "web");
  const api = join(dir, "api");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(api, { recursive: true });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "kiln-test@example.com"]);
  git(checkout, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(checkout, "readme.md"), "sample\n");
  git(checkout, ["add", "readme.md"]);
  git(checkout, ["commit", "-q", "-m", "sample"]);
  git(checkout, ["branch", "yak/sample"]);
  const configPath = join(dir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      adapter: "mock",
      repos: {
        web: { path: checkout, test: "node --test test.mjs" },
        api: { path: api, test: "node --test test.mjs" },
      },
    }, null, 2)}\n`,
  );
  return { dir, config: loadKilnConfig(configPath, { home: dir }) };
}

function queue(config: LoadedKilnConfig, workflow: string, repo: string, title: string, dependsOn: string[] = []): string {
  return writeJob(config, {
    workflow,
    repo,
    specText: `# ${title}\n`,
    title,
    dependsOn,
    source: { kind: "prompt", ref: "inline" },
  }).job.id;
}

function cancelledEvents(config: LoadedKilnConfig): number {
  return readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "job.cancelled").length;
}

describe("cancel queued jobs", () => {
  it("cancels only queued jobs, keeps branches, and is idempotent", () => {
    const { config } = harness();
    const queued = queue(config, "feature", "web", "SAMPLE-1");
    const waiting = queue(config, "feature", "web", "SAMPLE-2", [queued]);
    const review = queue(config, "review", "web", "SAMPLE-3");
    const running = queue(config, "review", "api", "SAMPLE-4");
    mkdirSync(join(config.kilnDir, "launching"), { recursive: true });
    writeFileSync(
      join(config.kilnDir, "launching", `${running}.json`),
      `${JSON.stringify({ jobId: running, pid: process.pid, logPath: "" })}\n`,
    );

    const reviewOnly = cancelQueuedJobs(config, { workflow: "review" });
    assert.deepEqual(reviewOnly.cancelled, [review]);
    assert.equal(readStatus(config, running).jobs[0]?.state, "running");
    assert.equal(readStatus(config, queued).jobs[0]?.state, "queued");
    const runningFile = JSON.parse(readFileSync(join(config.jobsDir, `${running}.json`), "utf8")) as { cancelledAt?: string };
    assert.equal(runningFile.cancelledAt, undefined);

    const webOnly = cancelQueuedJobs(config, { repo: "web" });
    assert.deepEqual(webOnly.cancelled, [queued]);
    assert.equal(readStatus(config, waiting).jobs[0]?.state, "blocked");
    assert.equal(readStatus(config, review).jobs[0]?.state, "cancelled");
    assert.equal(readStatus(config, queued).jobs[0]?.state, "cancelled");

    const again = cancelQueuedJobs(config, {});
    assert.deepEqual(again.cancelled, []);
    assert.equal(cancelledEvents(config), 2);
    const stored = JSON.parse(readFileSync(join(config.jobsDir, `${queued}.json`), "utf8")) as { cancelledAt?: string };
    assert.ok(stored.cancelledAt);
    assert.match(git(config.repos.web?.path ?? "", ["branch", "--list", "yak/sample"]), /yak\/sample/);
    assert.throws(() => cancelQueuedJobs(config, { repo: "missing" }), /Unknown repo missing/);
  });
});

describe("kiln cancel", () => {
  it("cancels queued jobs from the CLI and the board API, then does nothing the second time", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cancel-cli-"));
    keep.push(cwd);
    const home = join(cwd, "home");
    const checkout = join(cwd, "web");
    mkdirSync(home, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    git(checkout, ["init", "-q", "-b", "main"]);
    git(checkout, ["config", "user.email", "kiln-test@example.com"]);
    git(checkout, ["config", "user.name", "Kiln Test"]);
    writeFileSync(join(checkout, "readme.md"), "sample\n");
    git(checkout, ["add", "readme.md"]);
    git(checkout, ["commit", "-q", "-m", "sample"]);
    git(checkout, ["branch", "yak/sample"]);

    const added = runCli(["repo", "add", "web", checkout, "--test", "node --test test.mjs"], { cwd, home });
    assert.equal(added.status, 0, added.stderr);
    const created = runCli(["add", "feature", "--repo", "web", "--prompt", "Show the empty state.", "--title", "SAMPLE-1"], { cwd, home });
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(id);

    const usage = runCli(["cancel"], { cwd, home });
    assert.equal(usage.status, 2);

    const first = runCli(["cancel", "--queued", "--repo", "web", "--workflow", "feature"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`cancelled ${id}`));
    const status = runCli(["status", id], { cwd, home });
    assert.match(status.stdout, new RegExp(`${id}\\s+web\\s+feature\\s+cancelled`));
    assert.match(git(checkout, ["branch", "--list", "yak/sample"]), /yak\/sample/);

    const second = runCli(["cancel", "--queued"], { cwd, home });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /cancelled 0/);
    const events = readEvents(join(home, ".kiln"), { warn: () => {} }).filter((event) => event.event === "job.cancelled");
    assert.equal(events.length, 1);

    const server = await startServe(["--no-tick", "--port", "0"], { cwd, home });
    try {
      const page = await text(`${server.url}/`);
      const csrf = page.body.match(/data-csrf="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      const denied = await text(`${server.url}/api/jobs/cancel`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "Content-Type": "application/json", "X-Kiln-CSRF": csrf },
        body: JSON.stringify({ queued: false }),
      });
      assert.equal(denied.status, 400);
      const third = await text(`${server.url}/api/jobs/cancel`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "Content-Type": "application/json", "X-Kiln-CSRF": csrf },
        body: JSON.stringify({ queued: true, repo: "web", workflow: "feature" }),
      });
      assert.equal(third.status, 200, third.body);
      assert.deepEqual(JSON.parse(third.body), { ok: true, cancelled: [] });
      assert.equal(readEvents(join(home, ".kiln"), { warn: () => {} }).filter((event) => event.event === "job.cancelled").length, 1);
    } finally {
      await stop(server.child);
    }
  });
});

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function runCli(args: string[], options: { cwd: string; home: string }): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home };
  delete env.KILN_HOME;
  const result = spawnSync(process.execPath, [join(packageRoot(), "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function startServe(args: string[], options: { cwd: string; home: string }): Promise<{ url: string; child: ChildProcess }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home };
  delete env.KILN_HOME;
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(packageRoot(), "dist", "cli.js"), "serve", ...args], {
    cwd: options.cwd,
    env,
  });
  children.push(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`serve did not listen\n${output.stdout}\n${output.stderr}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: string) => {
      output.stdout += chunk;
      const match = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match?.[1] || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: match[1], child });
    });
    child.stderr?.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}\n${output.stdout}\n${output.stderr}`));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function text(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

/** A config whose kiln home is `dir`, with one git checkout `web` that has branch `yak/<branch>`. */
function stopBox(options: { deliver?: "local" | "pr"; maxConcurrent?: number; branch?: string } = {}): {
  dir: string;
  checkout: string;
  configPath: string;
  config: LoadedKilnConfig;
} {
  const dir = mkdtempSync(join(tmpdir(), "kiln-stop-"));
  keep.push(dir);
  const checkout = join(dir, "web");
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "kiln-test@example.com"]);
  git(checkout, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(checkout, "readme.md"), "sample\n");
  git(checkout, ["add", "readme.md"]);
  git(checkout, ["commit", "-q", "-m", "sample"]);
  if (options.branch) git(checkout, ["branch", `yak/${options.branch}`]);
  const configPath = join(dir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      adapter: "mock",
      maxConcurrent: options.maxConcurrent ?? 1,
      repos: { web: { path: checkout, test: "node --test test.mjs", ...(options.deliver ? { deliver: options.deliver, base: "main" } : {}) } },
    }, null, 2)}\n`,
  );
  return { dir, checkout, configPath, config: loadKilnConfig(configPath, { home: dir }) };
}

function add(config: LoadedKilnConfig, title: string, extra: { dependsOn?: string[]; stack?: boolean } = {}): string {
  return writeJob(config, {
    workflow: "feature",
    repo: "web",
    specText: `# ${title}\n`,
    title,
    dependsOn: extra.dependsOn ?? [],
    ...(extra.stack ? { stack: true } : {}),
    source: { kind: "prompt", ref: "inline" },
  }).job.id;
}

function journal(checkout: string, runId: string, jobId: string, lines: Record<string, unknown>[], pid?: number): string {
  const runDir = join(checkout, ".runs", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  const at = new Date().toISOString();
  const all = [{ t: "run.started", at, runId, tag: `kiln:${jobId}`, ...(pid ? { pid } : {}) }, ...lines].map((line) => ({ at, ...line }));
  writeFileSync(join(runDir, "journal.jsonl"), `${all.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return runDir;
}

/** A run waiting on an approve/reject gate. */
function gatedRun(checkout: string, runId: string, jobId: string): string {
  const runDir = journal(checkout, runId, jobId, [
    { t: "gate.opened", stepId: "approve" },
    { t: "run.finished", status: "suspended" },
  ]);
  mkdirSync(join(runDir, "pending"), { recursive: true });
  writeFileSync(
    join(runDir, "pending", "approve.request.json"),
    `${JSON.stringify({
      rendered: "Approve the change?",
      answerSchema: { type: "object", required: ["decision"], properties: { decision: { enum: ["approve", "reject"] } } },
    })}\n`,
  );
  return runDir;
}

/** A run that finished ok with an approve decision: landed. */
function landedRun(checkout: string, runId: string, jobId: string): void {
  const runDir = journal(checkout, runId, jobId, [{ t: "run.finished", status: "ok" }]);
  writeFileSync(join(runDir, "artifacts", "approval.json"), `${JSON.stringify({ decision: "approve" })}\n`);
}

/** bash parent + sleep child in their own process group. Only this file signals them. */
function spawnTree(): Promise<{ parent: ChildProcess; parentPid: number; childPid: number }> {
  const parent = spawn("bash", ["-c", "sleep 300 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  if (parent.pid) spawnedGroups.push(parent.pid);
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no child pid\n${buf}`)), 3000);
    parent.stdout?.setEncoding("utf8");
    parent.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const line = buf.split("\n")[0]?.trim();
      if (line && /^\d+$/.test(line) && parent.pid) {
        clearTimeout(timer);
        resolve({ parent, parentPid: parent.pid, childPid: Number(line) });
      }
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process still running")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function eventsFor(config: LoadedKilnConfig, jobId: string, name: string): KilnEvent[] {
  return readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.job_id === jobId && event.event === name);
}

/** A host that records every GitHub and feedback call and never reaches gh. */
function recordingHost(calls: string[], starts: number[]): KilnHost {
  return {
    github: {
      findByHead: () => {
        calls.push("findByHead");
        return null;
      },
      createDraft: () => {
        calls.push("createDraft");
        throw new Error("createDraft must not be called");
      },
      view: () => {
        calls.push("view");
        return { state: "OPEN", mergedAt: null };
      },
      postCommentReview: () => {
        calls.push("postCommentReview");
        throw new Error("postCommentReview must not be called");
      },
    },
    git: realGitRemote,
    feedback: {
      read: () => {
        calls.push("feedback.read");
        throw new Error("feedback.read must not be called");
      },
    },
    startAgent() {
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      if (child.pid) spawnedGroups.push(child.pid);
      children.push(child);
      child.unref();
      starts.push(child.pid ?? 0);
      return { pid: child.pid ?? 0 };
    },
  };
}

describe("kiln cancel <jobId>", () => {
  it("kills a running run's process tree, is idempotent, frees the slot, and keeps dependents blocked", async () => {
    const box = stopBox({ maxConcurrent: 1 });
    const running = add(box.config, "SAMPLE-RUN");
    const queued = add(box.config, "SAMPLE-NEXT");
    const after = add(box.config, "SAMPLE-AFTER", { dependsOn: [running] });
    const stacked = add(box.config, "SAMPLE-STACK", { dependsOn: [running], stack: true });
    const tree = await spawnTree();
    const runId = "2000-01-01T00-00-00Z-run";
    journal(box.checkout, runId, running, [], tree.parentPid);
    assert.equal(readStatus(box.config, running).jobs[0]?.state, "running");

    const first = runCli(["cancel", running, "--config", box.configPath], { cwd: box.dir, home: box.dir });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`cancelled ${running} \\(was running\\)`));
    await waitForExit(tree.parent);
    assert.equal(isPidAlive(tree.parentPid), false);
    assert.equal(isPidAlive(tree.childPid), false, `child ${tree.childPid} survived`);
    const status = runCli(["status", running, "--config", box.configPath], { cwd: box.dir, home: box.dir });
    assert.match(status.stdout, new RegExp(`${running}\\s+web\\s+feature\\s+cancelled`));
    const cancelled = eventsFor(box.config, running, "job.cancelled");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.event === "job.cancelled" ? cancelled[0].properties.was : undefined, "running");

    const second = runCli(["cancel", running, "--config", box.configPath], { cwd: box.dir, home: box.dir });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, new RegExp(`${running} already cancelled`));
    assert.equal(eventsFor(box.config, running, "job.cancelled").length, 1);

    const calls: string[] = [];
    const starts: number[] = [];
    const tick = runTick(box.config, recordingHost(calls, starts), { startup: true, now: new Date() });
    assert.match(tick, new RegExp(`launch ${queued}\\s+web`));
    assert.doesNotMatch(tick, new RegExp(`(launch|retry|stall) ${running}`));
    assert.equal(starts.length, 1);
    assert.equal(eventsFor(box.config, running, "job.retried").length, 0);
    // `yak cancel` closes the journal as failed/cancelled and that is projected as is. Recovery records nothing.
    const failed = eventsFor(box.config, running, "run.failed");
    assert.deepEqual(failed.map((event) => (event.event === "run.failed" ? event.properties.reason : "")), ["cancelled"]);
    assert.equal(existsSync(join(box.config.kilnDir, "attempts", `${running}.json`)), false);
    assert.equal(readStatus(box.config, running).jobs[0]?.state, "cancelled");
    assert.equal(readStatus(box.config, after).jobs[0]?.state, "blocked");
    assert.equal(readStatus(box.config, stacked).jobs[0]?.state, "blocked");

    const ledger = renderLedger(readEvents(box.config.kilnDir, { warn: () => {} }));
    assert.match(ledger, new RegExp(`${running}  1\\n    stopped by hand  1`));
  });

  it("closes a gate without answering it and posts or delivers nothing", () => {
    const box = stopBox({ deliver: "pr" });
    const gated = add(box.config, "SAMPLE-GATE");
    const runDir = gatedRun(box.checkout, "2000-01-01T00-00-01Z-gate", gated);
    const calls: string[] = [];
    const host = recordingHost(calls, []);
    assert.equal(readStatus(box.config, gated, host).jobs[0]?.canApprove, true);

    const result = cancelJob(box.config, gated, host);
    assert.deepEqual([result.outcome, result.was], ["cancelled", "needs-human"]);
    assert.deepEqual(calls, []);
    assert.equal(eventsFor(box.config, gated, "gate.resolved").length, 0);
    assert.equal(existsSync(join(runDir, "pending", "approve.answer.json")), false);
    assert.doesNotMatch(readFileSync(join(runDir, "journal.jsonl"), "utf8"), /gate\.answered/);
    const view = readStatus(box.config, gated, host).jobs[0];
    assert.equal(view?.state, "cancelled");
    assert.equal(view?.canApprove, false);
    assert.equal(view?.canReject, false);
    assert.equal(existsSync(join(box.config.kilnDir, "deliveries", `${gated}.json`)), false);
    const ledger = renderLedger(readEvents(box.config.kilnDir, { warn: () => {} }));
    assert.match(ledger, /stopped by hand  1/);
  });

  it("stops watching an in-review pull request and leaves the delivery record alone", () => {
    const box = stopBox({ deliver: "pr" });
    const review = add(box.config, "SAMPLE-REVIEW");
    const runId = "2000-01-01T00-00-02Z-pr";
    landedRun(box.checkout, runId, review);
    const delivery = join(box.config.kilnDir, "deliveries", `${review}.json`);
    mkdirSync(dirname(delivery), { recursive: true });
    const record = `${JSON.stringify({ jobId: review, runId, branch: `yak/${runId}`, base: "main", pushed: true, prNumber: 7, prUrl: "https://example.com/pull/7" }, null, 2)}\n`;
    writeFileSync(delivery, record);
    const calls: string[] = [];
    const host = recordingHost(calls, []);
    assert.equal(readStatus(box.config, review, host).jobs[0]?.state, "in-review");

    const result = cancelJob(box.config, review, host);
    assert.deepEqual([result.outcome, result.was], ["cancelled", "in-review"]);
    calls.length = 0;
    runTick(box.config, host, { startup: false, now: new Date() });
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(delivery, "utf8"), record);
    assert.equal(readStatus(box.config, review, host).jobs[0]?.state, "cancelled");
    const ledger = renderLedger(readEvents(box.config.kilnDir, { warn: () => {} }));
    assert.match(ledger, /0 interventions/);
  });

  it("reports nothing to stop on done and rejected jobs and writes nothing", () => {
    const box = stopBox();
    const done = add(box.config, "SAMPLE-DONE");
    landedRun(box.checkout, "2000-01-01T00-00-03Z-done", done);
    const rejected = add(box.config, "SAMPLE-REJECTED");
    const runDir = journal(box.checkout, "2000-01-01T00-00-04Z-rej", rejected, [{ t: "run.finished", status: "ok" }]);
    writeFileSync(join(runDir, "artifacts", "approval.json"), `${JSON.stringify({ decision: "reject" })}\n`);
    const before = readFileSync(join(box.config.jobsDir, `${done}.json`), "utf8");
    const out = runCli(["cancel", done, "--config", box.configPath], { cwd: box.dir, home: box.dir });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`${done} is done; nothing to stop`));
    assert.equal(cancelJob(box.config, rejected).outcome, "finished");
    assert.equal(readFileSync(join(box.config.jobsDir, `${done}.json`), "utf8"), before);
    assert.equal(eventsFor(box.config, done, "job.cancelled").length + eventsFor(box.config, rejected, "job.cancelled").length, 0);
    const queuedCancel = add(box.config, "SAMPLE-QUEUED");
    assert.equal(cancelJob(box.config, queuedCancel).was, "queued");
    assert.match(renderLedger(readEvents(box.config.kilnDir, { warn: () => {} })), /0 interventions/);
  });
});

describe("kiln remove <jobId>", () => {
  it("refuses active jobs and jobs with dependents, then removes Kiln's records and keeps the branch", async () => {
    const runId = "2000-01-01T00-00-05Z-old";
    const box = stopBox({ deliver: "pr", branch: runId });
    const cli = (args: string[]) => runCli([...args, "--config", box.configPath], { cwd: box.dir, home: box.dir });

    const launching = add(box.config, "SAMPLE-LAUNCHING");
    mkdirSync(join(box.config.kilnDir, "launching"), { recursive: true });
    writeFileSync(
      join(box.config.kilnDir, "launching", `${launching}.json`),
      `${JSON.stringify({ jobId: launching, pid: process.pid, logPath: "" })}\n`,
    );
    const gated = add(box.config, "SAMPLE-GATED");
    gatedRun(box.checkout, "2000-01-01T00-00-06Z-gate", gated);
    const review = add(box.config, "SAMPLE-INREVIEW");
    landedRun(box.checkout, "2000-01-01T00-00-07Z-pr", review);
    for (const [id, state] of [[launching, "running"], [gated, "needs-human"], [review, "in-review"]] as const) {
      const out = cli(["remove", id]);
      assert.equal(out.status, 1, out.stdout);
      assert.match(out.stderr, new RegExp(`Job ${id} is ${state}\\. Run kiln cancel ${id} first\\.`));
      assert.ok(existsSync(join(box.config.jobsDir, `${id}.json`)));
    }

    const upstream = add(box.config, "SAMPLE-UPSTREAM");
    const downstream = add(box.config, "SAMPLE-DOWNSTREAM", { dependsOn: [upstream] });
    const refused = cli(["remove", upstream]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`Job ${upstream} is needed by ${downstream}\\. Remove or cancel those first\\.`));

    const target = add(box.config, "SAMPLE-REMOVE");
    journal(box.checkout, runId, target, [{ t: "run.finished", status: "failed" }]);
    assert.equal(readStatus(box.config, target).jobs[0]?.state, "failed");
    const k = box.config.kilnDir;
    const files = [
      join(box.config.jobsDir, `${target}.json`),
      join(k, "specs", `${target}.md`),
      join(k, "rendered", target, "feature.yaml"),
      join(k, "attempts", `${target}.json`),
      join(k, "feedback", `${target}.json`),
      join(k, "deliveries", `${target}.json`),
      join(k, "logs", `${target}.log`),
    ];
    for (const file of files.slice(2)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{}\n");
    }
    for (const file of files) assert.ok(existsSync(file), file);
    const eventsBefore = readEvents(k, { warn: () => {} }).filter((event) => event.job_id === target).length;

    const removed = cli(["remove", target]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(
      removed.stdout,
      `removed ${target}\nbranch yak/${runId} left in place; delete it with git branch -D yak/${runId}\n`,
    );
    for (const file of files) assert.equal(existsSync(file), false, file);
    assert.equal(existsSync(join(k, "rendered", target)), false);
    const status = cli(["status"]);
    assert.doesNotMatch(status.stdout, new RegExp(target));
    const after = readEvents(k, { warn: () => {} }).filter((event) => event.job_id === target);
    assert.equal(after.length, eventsBefore + 1);
    assert.equal(after.at(-1)?.event, "job.removed");
    assert.match(git(box.checkout, ["branch", "--list", `yak/${runId}`]), new RegExp(`yak/${runId}`));
    assert.throws(() => removeJob(box.config, target), /No job/);

    const server = await startServe(["--no-tick", "--port", "0", "--config", box.configPath], { cwd: box.dir, home: box.dir });
    try {
      const board = await text(`${server.url}/api/board`);
      assert.equal(board.status, 200);
      assert.doesNotMatch(board.body, new RegExp(target));
    } finally {
      await stop(server.child);
    }
  });
});

describe("job id validation and board routes", () => {
  it("rejects bad ids everywhere and guards both routes with CSRF and POST", async () => {
    const box = stopBox();
    const cli = (args: string[]) => runCli([...args, "--config", box.configPath], { cwd: box.dir, home: box.dir });
    for (const bad of ["a/b", "..", "a..b", "%2e%2e"]) {
      assert.throws(() => assertJobId(bad), /is not valid/);
      assert.throws(() => cancelJob(box.config, bad), /is not valid/);
      assert.throws(() => removeJob(box.config, bad), /is not valid/);
      for (const command of ["cancel", "remove"]) {
        const out = cli([command, bad]);
        assert.equal(out.status, 1, `${command} ${bad}: ${out.stdout}`);
        assert.match(out.stderr, /is not valid/);
      }
    }
    assert.equal(existsSync(join(box.config.kilnDir, "events.jsonl")), false);

    const stoppable = add(box.config, "SAMPLE-STOP");
    const removable = add(box.config, "SAMPLE-REMOVABLE");
    const server = await startServe(["--no-tick", "--port", "0", "--config", box.configPath], { cwd: box.dir, home: box.dir });
    try {
      const page = await text(`${server.url}/jobs/${stoppable}`);
      assert.equal(page.status, 200);
      const csrf = page.body.match(/data-csrf="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      assert.match(page.body, /<details class="act confirm stop"><summary>Stop job<\/summary><form method="post" action="\/api\/jobs\/[^"]+\/cancel"/);
      assert.match(page.body, /<button type="submit">Confirm stop<\/button>/);
      assert.match(page.body, /<details class="act confirm remove"><summary>Remove job<\/summary>/);
      assert.match(page.body, /<button type="submit">Confirm remove<\/button>/);
      const headers = { Origin: server.url, Accept: "application/json", "Content-Type": "application/json", "X-Kiln-CSRF": csrf };

      for (const bad of ["a%2Fb", "..", "a..b", "%2e%2e"]) {
        for (const action of ["cancel", "remove"]) {
          const res = await text(`${server.url}/api/jobs/${bad}/${action}`, { method: "POST", headers, body: "{}" });
          assert.ok(res.status === 404 || res.status === 400, `${bad}/${action} -> ${res.status}`);
        }
      }
      for (const action of ["cancel", "remove"]) {
        const noToken = await text(`${server.url}/api/jobs/${stoppable}/${action}`, {
          method: "POST",
          headers: { Origin: server.url, Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
        });
        assert.equal(noToken.status, 403);
        const viaGet = await text(`${server.url}/api/jobs/${stoppable}/${action}`);
        assert.notEqual(viaGet.status, 200);
      }
      assert.equal(readStatus(box.config, stoppable).jobs[0]?.state, "queued");
      assert.ok(existsSync(join(box.config.jobsDir, `${stoppable}.json`)));

      const stopped = await text(`${server.url}/api/jobs/${stoppable}/cancel`, { method: "POST", headers, body: "{}" });
      assert.equal(stopped.status, 200, stopped.body);
      assert.equal((JSON.parse(stopped.body) as { was?: string }).was, "queued");
      assert.equal(readStatus(box.config, stoppable).jobs[0]?.state, "cancelled");
      const after = await text(`${server.url}/jobs/${stoppable}`);
      assert.doesNotMatch(after.body, /Stop job/);
      assert.match(after.body, /Remove job/);

      const gone = await text(`${server.url}/api/jobs/${removable}/remove`, { method: "POST", headers, body: "{}" });
      assert.equal(gone.status, 200, gone.body);
      assert.equal(existsSync(join(box.config.jobsDir, `${removable}.json`)), false);
      const missing = await text(`${server.url}/api/jobs/${removable}/remove`, { method: "POST", headers, body: "{}" });
      assert.equal(missing.status, 404);
      const form = await fetch(`${server.url}/api/jobs/${stoppable}/remove`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: server.url, "Content-Type": "application/x-www-form-urlencoded" },
        body: `csrf=${csrf}`,
      });
      assert.equal(form.status, 303);
      assert.equal(form.headers.get("location"), "/");
    } finally {
      await stop(server.child);
    }
  });
});
