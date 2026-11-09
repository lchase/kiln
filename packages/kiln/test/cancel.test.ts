import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { cancelQueuedJobs, readStatus } from "../src/driver.js";
import { readEvents } from "../src/events.js";
import { writeJob } from "../src/jobs.js";
import { packageRoot } from "../src/paths.js";

const keep: string[] = [];
const children: ChildProcess[] = [];

after(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
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
