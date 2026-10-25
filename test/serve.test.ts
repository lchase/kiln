import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { renderBoard, renderInbox } from "../src/serve-page.js";
import type { StatusJobView } from "../src/report.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const TOKEN = "kiln-test-jira-token-do-not-render";
const testCommand = "node --test test.mjs";

function kilnEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  return env;
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

function workDir(prefix: string): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(
    join(dir, "test.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('checkout', () => { assert.equal(true, true); });",
      "",
    ].join("\n"),
  );
  const fixtures = join(dir, "test", "fixtures", "kiln-feature");
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
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function useMock(home: string): void {
  const path = join(home, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = 2;
  raw.jira = {
    baseUrl: "https://example.atlassian.net",
    email: "dev@example.com",
    apiToken: TOKEN,
  };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function addJob(cwd: string, home: string, repo: string, title: string, after: string[] = []): string {
  const spec = join(cwd, `${title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.md`);
  writeFileSync(spec, `# ${title}\n\nDo the work for ${title}.\n`);
  const args = ["add", "feature", "--repo", repo, "--spec", spec, "--title", title];
  for (const id of after) args.push("--after", id);
  const created = runCli(args, { cwd, home });
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/^added (\S+)/m)?.[1];
  assert.ok(id, created.stdout);
  return id;
}

function waitForStatus(cwd: string, home: string, jobId: string, pattern: RegExp): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 60_000) {
    const status = runCli(["status", jobId], { cwd, home });
    last = `${status.stdout}${status.stderr}`;
    if (status.status === 0 && pattern.test(status.stdout)) return status.stdout;
    spawnSync("sleep", ["0.1"]);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${last}`);
}

interface RunningServe {
  url: string;
  child: ChildProcess;
  output: { stdout: string; stderr: string };
}

function startServe(args: string[], options: { cwd: string; home: string }): Promise<RunningServe> {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", ...args], {
    cwd: options.cwd,
    env: kilnEnv(options.home),
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
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: string) => {
      output.stdout += chunk;
      const match = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(() => resolve({ url: match[1], child, output }));
    });
    child.stderr?.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => reject(new Error(`serve exited ${code}\n${output.stdout}\n${output.stderr}`)));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function text(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

function viewJob(overrides: Partial<StatusJobView> & Pick<StatusJobView, "jobId" | "state">): StatusJobView {
  return {
    title: overrides.jobId,
    repo: "web",
    workflow: "feature",
    dependsOn: [],
    stack: false,
    launchFailed: false,
    prPending: false,
    prClosedUnmerged: false,
    noReadableApproval: false,
    gates: [],
    canApprove: false,
    canReject: false,
    ...overrides,
  };
}

after(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("serve pages", () => {
  it("escapes job text and does not link a javascript pull request url", () => {
    const css = "/* kiln-serve */";
    const inbox = renderInbox(css, {
      jobs: [
        viewJob({
          jobId: "job-1",
          state: "needs-human",
          title: "<script>alert(1)</script>",
          canApprove: true,
          canReject: true,
          gates: [
            {
              stepId: "approve",
              prompt: "<b>Approve?</b>",
              choices: ["approve", "reject"],
              artifacts: [{ name: "decision", summary: "APPROVE — ok" }],
              reviews: [],
            },
          ],
        }),
      ],
    });
    assert.match(inbox, /\/\* kiln-serve \*\//);
    assert.match(inbox, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(inbox, /&lt;b&gt;Approve\?&lt;\/b&gt;/);
    assert.doesNotMatch(inbox, /<script>alert/);
    assert.match(inbox, /action="\/api\/jobs\/job-1\/approve"/);

    const board = renderBoard(css, {
      jobs: [viewJob({ jobId: "job-1", state: "done", title: "Done", prUrl: "javascript:alert(1)" })],
    });
    assert.match(board, /javascript:alert\(1\)/);
    assert.doesNotMatch(board, /href="javascript:/);
  });

  it("links findings for an investigation job on the inbox and the board", () => {
    const css = "/* kiln-serve */";
    const probe = viewJob({
      jobId: "probe-1",
      workflow: "investigation",
      state: "needs-human",
      title: "Probe the unconfirmed platform facts",
      findingsPath: "/tmp/kiln/findings/probe-1.md",
    });
    const feature = viewJob({
      jobId: "feat-1",
      state: "needs-human",
      title: "Render the empty state",
    });
    const inbox = renderInbox(css, { jobs: [probe, feature] });
    assert.match(inbox, /href="\/jobs\/probe-1\/findings"/);
    assert.match(inbox, />Findings</);
    assert.doesNotMatch(inbox, /href="\/jobs\/feat-1\/findings"/);

    const board = renderBoard(css, {
      jobs: [
        { ...probe, state: "done" },
        { ...feature, state: "queued" },
      ],
    });
    assert.match(board, /href="\/jobs\/probe-1\/findings"/);
    assert.doesNotMatch(board, /href="\/jobs\/feat-1\/findings"/);
  });
});

describe("kiln serve", () => {
  it("rejects a bad port, a combined tick flag, and serve flags on status", () => {
    const { cwd, home } = workDir("kiln-serve-usage-");
    const missing = runCli(["serve", "--port"], { cwd, home });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /kiln serve/);

    const both = runCli(["serve", "--tick", "5", "--no-tick"], { cwd, home });
    assert.equal(both.status, 2);

    const zero = runCli(["serve", "--tick", "0"], { cwd, home });
    assert.equal(zero.status, 2);

    const status = runCli(["status", "--port", "1"], { cwd, home });
    assert.equal(status.status, 2);
  });

  it("binds 127.0.0.1, serves the inbox, and rejects a cross-origin POST", async () => {
    const { cwd, home } = workDir("kiln-serve-empty-");
    const repo = join(cwd, "web");
    mkdirSync(repo);
    assert.equal(runCli(["repo", "add", "web", repo, "--test", "true"], { cwd, home }).status, 0);
    useMock(home);

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const homePage = await text(server.url);
      assert.equal(homePage.status, 200);
      assert.match(homePage.body, /kiln-serve/);
      assert.match(homePage.body, /Inbox/);
      assert.doesNotMatch(homePage.body, new RegExp(TOKEN));

      const jobs = await text(`${server.url}/api/jobs`);
      assert.equal(jobs.status, 200);
      assert.match(jobs.body, /"jobs": \[\]/);
      assert.doesNotMatch(jobs.body, new RegExp(TOKEN));
      assert.doesNotMatch(jobs.body, /apiToken/);

      const denied = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: "http://evil.example", Accept: "application/json" },
      });
      assert.equal(denied.status, 403);
      assert.match(denied.body, /Cross-origin request rejected/);

      const wrongPort = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:1", Accept: "application/json" },
      });
      assert.equal(wrongPort.status, 403);

      const missing = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json" },
      });
      assert.equal(missing.status, 404);
    } finally {
      await stop(server.child);
    }
  });

  it(
    "lists a needs-human job, approves it the same way as the CLI, and shows a blocked dependency",
    { timeout: 120_000 },
    async () => {
    const { cwd, home } = workDir("kiln-serve-jobs-");
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
    useMock(home);
    const upstream = addJob(cwd, home, "web", "Show the weekly summary");
    const downstream = addJob(cwd, home, "web", "List the weekly summary", [upstream]);
    assert.equal(runCli(["tick"], { cwd, home }).status, 0);
    const suspended = waitForStatus(cwd, home, upstream, new RegExp(`${upstream}\\s+web\\s+feature\\s+needs-human`));
    assert.match(suspended, /Agent decision: APPROVE/);

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const inbox = await text(`${server.url}/`);
      assert.equal(inbox.status, 200);
      assert.match(inbox.body, /Show the weekly summary/);
      assert.match(inbox.body, /web/);
      assert.match(inbox.body, /feature/);
      assert.match(inbox.body, /Agent decision: APPROVE/);
      assert.match(inbox.body, /No must-fix findings/);
      assert.match(inbox.body, /Reviews passed/);
      assert.match(inbox.body, new RegExp(`action="/api/jobs/${upstream}/approve"`));
      assert.match(inbox.body, new RegExp(`action="/api/jobs/${upstream}/reject"`));
      assert.match(inbox.body, new RegExp(`href="/jobs/${upstream}/spec"`));
      assert.match(inbox.body, new RegExp(`href="/jobs/${upstream}/log"`));
      assert.doesNotMatch(inbox.body, new RegExp(TOKEN));

      const spec = await text(`${server.url}/jobs/${upstream}/spec`);
      assert.equal(spec.status, 200);
      assert.match(spec.body, /Show the weekly summary/);
      const log = await text(`${server.url}/jobs/${upstream}/log`);
      assert.equal(log.status, 200);

      const board = await text(`${server.url}/board`);
      assert.equal(board.status, 200);
      assert.match(board.body, /state-blocked">blocked</);
      assert.match(board.body, new RegExp(`id="job-${downstream}"`));
      assert.match(board.body, new RegExp(`href="/board#job-${upstream}"`));
      assert.match(board.body, /List the weekly summary/);
      assert.match(board.body, /depends on/);

      const listed = JSON.parse((await text(`${server.url}/api/jobs`)).body) as {
        jobs: { jobId: string; state: string; dependsOn: { jobId: string; state: string }[]; stack: boolean }[];
      };
      const blocked = listed.jobs.find((job) => job.jobId === downstream);
      assert.ok(blocked, JSON.stringify(listed));
      assert.equal(blocked.state, "blocked");
      assert.equal(blocked.dependsOn[0]?.jobId, upstream);
      assert.equal(blocked.dependsOn[0]?.state, "needs-human");
      assert.equal(listed.jobs.find((job) => job.jobId === upstream)?.state, "needs-human");
      assert.doesNotMatch(JSON.stringify(listed), new RegExp(TOKEN));

      const one = await text(`${server.url}/api/jobs/${upstream}`);
      assert.equal(one.status, 200);
      assert.match(one.body, /"state": "needs-human"/);

      const denied = await text(`${server.url}/api/jobs/${upstream}/approve`, {
        method: "POST",
        headers: { Origin: "https://evil.example", Accept: "application/json" },
      });
      assert.equal(denied.status, 403);
      const still = JSON.parse((await text(`${server.url}/api/jobs/${upstream}`)).body) as { state: string };
      assert.equal(still.state, "needs-human");

      const approved = await text(`${server.url}/api/jobs/${upstream}/approve`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json" },
      });
      assert.equal(approved.status, 200, approved.body);
      const body = JSON.parse(approved.body) as { ok: boolean; job: { state: string } };
      assert.equal(body.ok, true);
      const cli = runCli(["status", upstream], { cwd, home });
      assert.equal(cli.status, 0, cli.stderr);
      const cliState = cli.stdout.match(new RegExp(`${upstream}\\s+web\\s+feature\\s+(\\S+)`))?.[1];
      assert.equal(body.job.state, cliState, cli.stdout);
      assert.notEqual(body.job.state, "needs-human");
      // deliver=local lands when yak resume finishes, so the settled state is done.
      // `approved` is that same view while the resumed run is still alive.
      assert.equal(body.job.state, "done");
      assert.match(cli.stdout, new RegExp(`${upstream}\\s+web\\s+feature\\s+done`));

      const again = await text(`${server.url}/api/jobs/${upstream}/approve`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: server.url, "Content-Type": "application/x-www-form-urlencoded" },
      });
      assert.equal(again.status, 409);
      assert.match(again.body, /<!DOCTYPE html>/);
      assert.match(again.body, /not needs-human/);
      assert.doesNotMatch(again.body, new RegExp(TOKEN));
    } finally {
      await stop(server.child);
    }
  },
  );

  it("serves escaped findings for an investigation job and links them on the board", async () => {
    const { cwd, home } = workDir("kiln-serve-findings-");
    const repo = join(cwd, "web");
    mkdirSync(repo);
    assert.equal(runCli(["repo", "add", "web", repo, "--test", "true"], { cwd, home }).status, 0);
    useMock(home);

    const spec = join(cwd, "probe.md");
    writeFileSync(spec, "# Probe the unconfirmed platform facts\n\nNo product code.\n");
    const created = runCli(
      ["add", "investigation", "--repo", "web", "--spec", spec, "--title", "Probe the unconfirmed platform facts"],
      { cwd, home },
    );
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(id, created.stdout);

    const featureSpec = join(cwd, "follow.md");
    writeFileSync(featureSpec, "# Render the empty state\n\nShow a sentence.\n");
    const feature = runCli(
      ["add", "feature", "--repo", "web", "--spec", featureSpec, "--title", "Render the empty state"],
      { cwd, home },
    );
    assert.equal(feature.status, 0, feature.stderr);
    const featureId = feature.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(featureId, feature.stdout);

    const findingsDir = join(home, ".kiln", "findings");
    mkdirSync(findingsDir);
    writeFileSync(join(findingsDir, `${id}.md`), `# Findings\n\n<script>alert(1)</script>\n${TOKEN}\n`);

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const board = await text(`${server.url}/board`);
      assert.equal(board.status, 200);
      assert.match(board.body, new RegExp(`href="/jobs/${id}/findings"`));
      assert.doesNotMatch(board.body, new RegExp(`href="/jobs/${featureId}/findings"`));
      assert.doesNotMatch(board.body, new RegExp(TOKEN));

      const page = await text(`${server.url}/jobs/${id}/findings`);
      assert.equal(page.status, 200);
      assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(page.body, /<script>alert/);
      assert.match(page.body, /\[redacted\]/);
      assert.doesNotMatch(page.body, new RegExp(TOKEN));

      const missing = await text(`${server.url}/jobs/${featureId}/findings`);
      assert.equal(missing.status, 404);
      assert.doesNotMatch(missing.body, new RegExp(TOKEN));
    } finally {
      await stop(server.child);
    }
  });

  it(
    "runs kiln tick on an interval while serve is open",
    { timeout: 90_000 },
    async () => {
      const { cwd, home } = workDir("kiln-serve-tick-");
      const web = join(cwd, "repos", "web");
      initCheckout(web);
      assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
      useMock(home);
      const id = addJob(cwd, home, "web", "Show the weekly summary");
      const queued = runCli(["status", id], { cwd, home });
      assert.match(queued.stdout, new RegExp(`${id}\\s+web\\s+feature\\s+queued`));

      const server = await startServe(["--port", "0", "--tick", "1"], { cwd, home });
      try {
        const start = Date.now();
        let state = "";
        let last = "";
        while (Date.now() - start < 45_000) {
          const job = await text(`${server.url}/api/jobs/${id}`);
          last = job.body;
          if (job.status === 200) {
            state = (JSON.parse(job.body) as { state: string }).state;
            if (state === "running" || state === "needs-human" || state === "approved" || state === "done") break;
          }
          await delay(200);
        }
        assert.match(state, /running|needs-human|approved|done/, last);
        assert.doesNotMatch(server.output.stderr, /tick: .*Error/);
      } finally {
        await stop(server.child);
      }
    },
  );
});
