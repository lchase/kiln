import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import type { StatusJobView } from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";
import { reapLaunches } from "./reap.js";

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
    attemptCount: 0,
    maxAttempts: 3,
    prPending: false,
    prClosedUnmerged: false,
    noReadableApproval: false,
    gates: [],
    canApprove: false,
    canReject: false,
    steps: [],
    ...overrides,
  };
}

function page(jobs: StatusJobView[]): string {
  return renderConsole("/* kiln-serve */", buildAttention(jobs));
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => exited(child)));
  for (const dir of keep) await reapLaunches(dir);
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("serve pages", () => {
  it("escapes job text and does not link a javascript pull request url", () => {
    const html = page([
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
    ]);
    assert.match(html, /\/\* kiln-serve \*\//);
    assert.match(html, /\(1\) Kiln/);
    assert.match(html, /Needs human/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b&gt;Approve\?&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /action="\/api\/jobs\/job-1\/approve"/);

    const settled = page([viewJob({ jobId: "job-1", state: "done", title: "Done", prUrl: "javascript:alert(1)" })]);
    assert.match(settled, /javascript:alert\(1\)/);
    assert.doesNotMatch(settled, /href="javascript:/);
    assert.match(settled, /id="col-merged"/);
    assert.match(settled, /landed locally/);
    assert.doesNotMatch(settled, /Show more/);
  });

  it("shows attempt, reason, and next retry on a Needs human card for a dead job", () => {
    const html = page([
      viewJob({
        jobId: "dead-1",
        state: "dead",
        title: "Stalled build",
        attemptCount: 3,
        maxAttempts: 3,
        lastFailureReason: "stalled",
      }),
      viewJob({
        jobId: "fail-1",
        state: "failed",
        title: "Crashed build",
        attemptCount: 1,
        maxAttempts: 3,
        lastFailureReason: "orphaned",
        nextRetryAt: "2026-10-26T03:00:00.000Z",
        steps: [
          { id: "spec", phase: "done" },
          { id: "build", phase: "current" },
        ],
      }),
      viewJob({
        jobId: "gate-1",
        state: "needs-human",
        title: "Waiting",
        canApprove: true,
      }),
    ]);
    const column = (id: string) => {
      const start = html.indexOf(`id="col-${id}"`);
      assert.ok(start >= 0, id);
      const next = html.indexOf('<section class="col', start + 1);
      return html.slice(start, next === -1 ? html.indexOf("</main>") : next);
    };
    const human = column("needs-human");
    const build = column("build");
    assert.match(html, /\(2\) Kiln/);
    assert.match(human, /id="job-dead-1"/);
    assert.match(human, /your call/);
    assert.match(human, /attempt 3\/3 · stalled/);
    assert.doesNotMatch(human, /id="job-fail-1"/);
    assert.match(build, /id="job-fail-1"/);
    assert.match(build, /class="card retrying"/);
    assert.match(build, /retrying <time datetime="2026-10-26T03:00:00.000Z" data-time="clock">/);
    assert.match(build, /attempt 1\/3 · orphaned/);
    assert.doesNotMatch(build, /your call/);
    assert.doesNotMatch(build, /next retry /);
    const gateStart = html.indexOf('id="job-gate-1"');
    const gateEnd = html.indexOf('id="job-', gateStart + 1);
    const gate = html.slice(gateStart, gateEnd === -1 ? undefined : gateEnd);
    assert.doesNotMatch(gate, /attempt /);
    assert.match(gate, /your call/);
    assert.match(html, /action="\/api\/jobs\/dead-1\/retry"/);
  });

  it("puts queued and blocked jobs in Queued, and does not format the clock as UTC", () => {
    const html = page([
      viewJob({ jobId: "q", state: "queued", title: "Wait", logTail: "started 2026-10-26T05:01:22.000Z" }),
      viewJob({
        jobId: "b",
        state: "blocked",
        title: "Hold",
        dependsOn: [{ jobId: "q", state: "queued" }],
      }),
      viewJob({
        jobId: "spec-run",
        state: "running",
        title: "Writing the spec",
        steps: [{ id: "spec", phase: "current" }],
      }),
    ]);
    const between = (id: string, next: string) => html.slice(html.indexOf(`id="col-${id}"`), html.indexOf(`id="col-${next}"`));
    const queued = between("queued", "spec");
    assert.match(queued, /id="job-q"/);
    assert.match(queued, /id="job-b"/);
    assert.match(queued, /depends on/);
    assert.match(queued, /href="#job-q"/);
    assert.match(queued, /waiting · deps/);
    const spec = between("spec", "build");
    assert.match(spec, /id="job-spec-run"/);
    assert.doesNotMatch(spec, /id="job-q"/);
    assert.doesNotMatch(spec, /id="job-b"/);
    assert.match(html, /2026-10-26T05:01:22\.000Z/);
    assert.match(html, /toLocaleTimeString\(\)/);
    assert.match(html, /toLocaleString\(\)/);
    assert.doesNotMatch(html, /timeZone/);
    assert.doesNotMatch(html, /toUTCString/);
    assert.doesNotMatch(html, /toISOString\(/);
  });

  it("keeps every settled job on the board and does not render a graph", () => {
    const jobs = Array.from({ length: 5 }, (_, index) =>
      viewJob({
        jobId: `done-${index}`,
        state: "done",
        title: `Settled ${index}`,
        finishedAt: `2026-10-2${index}T00:00:00.000Z`,
      }),
    );
    const html = page(jobs);
    assert.doesNotMatch(html, /id="graph-panel"/);
    assert.doesNotMatch(html, /Show more/);
    for (const index of jobs.keys()) assert.match(html, new RegExp(`id="job-done-${index}"`));
    assert.match(html, /id="col-done"/);
    assert.doesNotMatch(html, /id="col-merged"/);
  });

  it("links findings for an investigation and keeps a failed job's retry", () => {
    const probe = viewJob({
      jobId: "probe-1",
      workflow: "investigation",
      state: "needs-human",
      title: "Probe the unconfirmed platform facts",
      findingsPath: "/tmp/kiln/findings/probe-1.md",
      gates: [
        {
          stepId: "approve",
          prompt: 'Approve findings for "Probe"?',
          rendered: 'Approve findings for "Probe"?\n\n## Questions\n\nWhich runner?',
          choices: ["approve", "reject"],
          artifacts: [],
          reviews: [],
        },
      ],
    });
    const feature = viewJob({
      jobId: "feat-1",
      state: "failed",
      title: "Render the empty state",
      launchError: "builder exploded",
      logTail: "verify: expected 1 received 0",
    });
    const html = page([probe, feature]);
    assert.match(html, /href="\/jobs\/probe-1\/findings"/);
    assert.match(html, />Findings</);
    assert.match(html, /Which runner\?/);
    assert.doesNotMatch(html, /href="\/jobs\/feat-1\/findings"/);
    assert.match(html, /action="\/api\/jobs\/feat-1\/retry"/);
    assert.match(html, /builder exploded/);
    assert.match(html, /Failed: builder exploded/);
    assert.match(html, /\(2\) Kiln/);
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

    const retry = runCli(["retry"], { cwd, home });
    assert.equal(retry.status, 2);
    assert.match(retry.stderr, /kiln retry/);
  });

  it("binds 127.0.0.1, serves the console, and rejects a cross-origin POST", async () => {
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
      assert.match(homePage.body, /Needs human/);
      assert.match(homePage.body, /\(0\) Kiln/);
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

      const retryDenied = await text(`${server.url}/api/jobs/job-1/retry`, {
        method: "POST",
        headers: { Origin: "http://evil.example", Accept: "application/json" },
      });
      assert.equal(retryDenied.status, 403);
      assert.match(retryDenied.body, /Cross-origin request rejected/);

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
      assert.match(board.body, /Needs human/);
      assert.match(board.body, /Queued/);
      assert.match(board.body, /id="drawer"/);
      const queuedCol = board.body.slice(board.body.indexOf('id="col-queued"'), board.body.indexOf('id="col-spec"'));
      assert.match(queuedCol, new RegExp(`id="job-${downstream}"`));
      const specCol = board.body.slice(board.body.indexOf('id="col-spec"'), board.body.indexOf('id="col-build"'));
      assert.doesNotMatch(specCol, new RegExp(`id="job-${downstream}"`));
      assert.doesNotMatch(board.body, /id="graph-panel"/);
      assert.match(board.body, new RegExp(`id="job-${downstream}"`));
      assert.match(board.body, new RegExp(`href="#job-${upstream}"`));
      assert.match(board.body, /List the weekly summary/);
      assert.match(board.body, /depends on/);
      assert.match(board.body, new RegExp(`Waiting on ${upstream} \\(needs-human\\)`));

      const listed = JSON.parse((await text(`${server.url}/api/jobs`)).body) as {
        jobs: { jobId: string; state: string; dependsOn: { jobId: string; state: string }[]; stack: boolean }[];
        attention: { needsYouCount: number; needsYou: { job: { jobId: string } }[] };
      };
      assert.equal(listed.attention.needsYouCount, 1);
      assert.equal(listed.attention.needsYou[0]?.job.jobId, upstream);
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
      await reapLaunches(cwd);
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
    "retries a failed job through the same launch as the CLI and rejects a cross-origin retry",
    { timeout: 120_000 },
    async () => {
      const { cwd, home } = workDir("kiln-serve-retry-");
      const web = join(cwd, "repos", "web");
      initCheckout(web);
      assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
      useMock(home);
      const id = addJob(cwd, home, "web", "Show the weekly summary");
      const runId = "2020-01-01T00-00-00Z-old";
      const runDir = join(web, ".runs", runId);
      mkdirSync(runDir, { recursive: true });
      const gone = 2_147_483_646;
      assert.throws(() => process.kill(gone, 0));
      writeFileSync(
        join(runDir, "journal.jsonl"),
        [
          JSON.stringify({
            t: "run.started",
            at: "2020-01-01T00:00:00.000Z",
            runId,
            tag: `kiln:${id}`,
            pid: gone,
          }),
          JSON.stringify({ t: "step.started", at: "2020-01-01T00:00:01.000Z", stepId: "spec" }),
          JSON.stringify({
            t: "step.failed",
            at: "2020-01-01T00:00:02.000Z",
            stepId: "spec",
            failure: { reason: "command-failed", detail: "builder exploded" },
          }),
          JSON.stringify({ t: "run.finished", at: "2020-01-01T00:00:03.000Z", status: "failed" }),
          "",
        ].join("\n"),
      );
      const logDir = join(home, ".kiln", "logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `${id}.log`), "builder exploded\nverify: expected 1 received 0\n");

      const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
      try {
        const html = await text(`${server.url}/`);
        assert.equal(html.status, 200);
        assert.match(html.body, /\(0\) Kiln/);
        assert.match(html.body, /verify: expected 1 received 0/);
        assert.match(html.body, new RegExp(`action="/api/jobs/${id}/retry"`));
        const specStart = html.body.indexOf('id="col-spec"');
        const specEnd = html.body.indexOf('<section class="col', specStart + 1);
        const spec = html.body.slice(specStart, specEnd === -1 ? undefined : specEnd);
        assert.match(spec, new RegExp(`id="job-${id}"`));
        assert.match(spec, /class="card retrying"/);
        assert.match(spec, /retrying <time /);
        assert.match(spec, /attempt 1\/3 · failed/);
        assert.doesNotMatch(spec, /your call/);
        const humanStart = html.body.indexOf('id="col-needs-human"');
        const humanEnd = html.body.indexOf("</main>");
        const human = html.body.slice(humanStart, humanEnd === -1 ? undefined : humanEnd);
        assert.doesNotMatch(human, new RegExp(`id="job-${id}"`));

        const denied = await text(`${server.url}/api/jobs/${id}/retry`, {
          method: "POST",
          headers: { Origin: "https://evil.example", Accept: "application/json" },
        });
        assert.equal(denied.status, 403);
        assert.match(denied.body, /Cross-origin request rejected/);
        const still = JSON.parse((await text(`${server.url}/api/jobs/${id}`)).body) as { state: string };
        assert.equal(still.state, "failed");

        const retried = await text(`${server.url}/api/jobs/${id}/retry`, {
          method: "POST",
          headers: { Origin: server.url, Accept: "application/json" },
        });
        assert.equal(retried.status, 200, retried.body);
        const start = Date.now();
        let state = "";
        let last = "";
        while (Date.now() - start < 60_000) {
          const job = await text(`${server.url}/api/jobs/${id}`);
          last = job.body;
          state = (JSON.parse(job.body) as { state: string }).state;
          if (state === "running" || state === "needs-human" || state === "approved" || state === "done") break;
          await delay(200);
        }
        assert.match(state, /running|needs-human|approved|done/, last);
        const cli = runCli(["retry", id], { cwd, home });
        assert.notEqual(cli.status, 0);
        assert.match(cli.stderr, /not failed or dead/);
      } finally {
        await stop(server.child);
        await reapLaunches(cwd);
      }
    },
  );

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
        await reapLaunches(cwd);
      }
    },
  );
});

describe("reap launches", () => {
  it("kills a detached writer before the temp dir is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-reap-"));
    keep.push(dir);
    const runDir = join(dir, ".runs", "2026-10-27T00-00-00Z-reap");
    mkdirSync(runDir, { recursive: true });
    const child = spawn("bash", ["-c", "while true; do mkdir -p .yak/nested; echo x > .yak/nested/note; done"], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid;
    assert.ok(pid && pid > 1);
    writeFileSync(join(runDir, "journal.jsonl"), `${JSON.stringify({ t: "run.started", pid })}\n`);
    await delay(30);
    await reapLaunches(dir);
    await exited(child);
    assert.throws(() => process.kill(pid, 0));
    rmSync(dir, { recursive: true, force: true });
  });
});
