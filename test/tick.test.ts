import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const keep: string[] = [];
const testCommand = "node --test test.mjs && printf '%s\\n' landed > kiln-landed.txt";

function runCliAsync(
  args: string[],
  options: { cwd: string; home: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist", "cli.js"), ...args], {
      cwd: options.cwd,
      env: { ...process.env, HOME: options.home },
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

function runCli(
  args: string[],
  options: { cwd: string; home: string; env?: Record<string, string> },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: options.home, ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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

function workDir(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-tick-"));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home };
}

function register(cwd: string, home: string, name: string, checkout: string, test = testCommand): void {
  const added = runCli(["repo", "add", name, checkout, "--test", test], { cwd, home });
  assert.equal(added.status, 0, added.stderr);
}

function useMock(cwd: string, maxConcurrent = 2): void {
  const path = join(cwd, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = maxConcurrent;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

let lastAddedAt = 0;

function addJob(
  cwd: string,
  home: string,
  workflow: string,
  repo: string,
  title: string,
  after: string[] = [],
): string {
  while (Date.now() <= lastAddedAt) {
    // createdAt is millisecond precision. A later job must sort after this one.
  }
  const spec = join(cwd, `${title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.md`);
  writeFileSync(spec, `# ${title}\n\nDo the work for ${title}.\n`);
  const args = ["add", workflow, "--repo", repo, "--spec", spec, "--title", title];
  for (const id of after) args.push("--after", id);
  const created = runCli(args, { cwd, home });
  assert.equal(created.status, 0, created.stderr);
  lastAddedAt = Date.now();
  const id = created.stdout.match(/^added (\S+)/m)?.[1];
  assert.ok(id, created.stdout);
  return id;
}

function runIds(checkout: string): string[] {
  const dir = join(checkout, ".runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "journal.jsonl"))).sort();
}

function journalTag(checkout: string, runId: string): string | undefined {
  const lines = readFileSync(join(checkout, ".runs", runId, "journal.jsonl"), "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { t?: string; tag?: string };
      if (event.t === "run.started") return event.tag;
    } catch {
      // A torn last line is ignored, same as the driver.
    }
  }
  return undefined;
}

function worktrees(checkout: string): string[] {
  const dir = join(checkout, ".yak", "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name))).sort();
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function waitForStatus(
  cwd: string,
  home: string,
  jobId: string,
  pattern: RegExp,
  timeoutMs = 30000,
): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const status = runCli(["status", jobId], { cwd, home });
    last = `${status.stdout}${status.stderr}`;
    if (status.status === 0 && pattern.test(status.stdout)) return status.stdout;
    sleep(0.1);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${last}`);
}

function runIdOf(status: string, jobId: string): string {
  const match = status.match(new RegExp(`${jobId}\\s+\\S+\\s+\\S+\\s+\\S+\\s+run (\\S+)`));
  assert.ok(match?.[1], status);
  return match[1];
}

function deadPid(): number {
  const pid = 2_147_483_646;
  assert.throws(() => process.kill(pid, 0));
  return pid;
}

function checkoutPair(): { cwd: string; home: string; web: string; api: string } {
  const { cwd, home } = workDir();
  const web = join(cwd, "repos", "web");
  const api = join(cwd, "repos", "api");
  initCheckout(web);
  initCheckout(api);
  register(cwd, home, "web", web);
  register(cwd, home, "api", api);
  useMock(cwd, 2);
  return { cwd, home, web, api };
}

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("kiln tick", { concurrency: 1 }, () => {
  it("keeps a job in another repo blocked until the upstream gate is approved", () => {
    const { cwd, home, web, api } = checkoutPair();
    const upstream = addJob(cwd, home, "feature", "api", "Publish the summary");
    const downstream = addJob(cwd, home, "feature", "web", "Show the summary", [upstream]);

    const stored = JSON.parse(readFileSync(join(cwd, ".kiln", "jobs", `${downstream}.json`), "utf8")) as {
      dependsOn?: string[];
      state?: unknown;
    };
    assert.deepEqual(stored.dependsOn, [upstream]);
    assert.equal(stored.state, undefined);

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`launch ${upstream}\\s+api`));
    assert.doesNotMatch(first.stdout, new RegExp(`launch ${downstream}`));

    const blocked = waitForStatus(cwd, home, upstream, new RegExp(`${upstream}\\s+api\\s+feature\\s+needs-human`));
    assert.match(blocked, new RegExp(`approve: kiln approve ${upstream}`));
    assert.match(blocked, new RegExp(`reject: kiln reject ${upstream}`));
    const both = runCli(["status"], { cwd, home });
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, new RegExp(`${upstream}\\s+api\\s+feature\\s+needs-human`));
    assert.match(both.stdout, new RegExp(`${downstream}\\s+web\\s+feature\\s+blocked`));
    const ownerRun = runIds(api)[0];
    assert.ok(ownerRun);
    assert.equal(journalTag(api, ownerRun), `kiln:${upstream}`);
    assert.deepEqual(runIds(web), []);

    const answered = runCli(["approve", upstream], { cwd, home });
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    assert.match(answered.stdout, new RegExp(`run ${ownerRun} finished: ok`));
    const done = runCli(["status"], { cwd, home });
    assert.match(done.stdout, new RegExp(`${upstream}\\s+api\\s+feature\\s+done\\s+run ${ownerRun}\\s+branch yak/${ownerRun}`));
    assert.match(done.stdout, new RegExp(`${downstream}\\s+web\\s+feature\\s+queued`));
    assert.equal(git(api, ["log", "-1", "--format=%s", `yak/${ownerRun}`]).trim(), "kiln: Publish the summary");

    const next = runCli(["tick"], { cwd, home });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`launch ${downstream}\\s+web`));
    const started = waitForStatus(cwd, home, downstream, new RegExp(`${downstream}\\s+web\\s+feature\\s+needs-human`));
    const downstreamRun = runIdOf(started, downstream);
    assert.equal(journalTag(web, downstreamRun), `kiln:${downstream}`);
    assert.equal("state" in JSON.parse(readFileSync(join(cwd, ".kiln", "jobs", `${upstream}.json`), "utf8")), false);
  });

  it("keeps the downstream job blocked when the upstream gate is rejected", () => {
    const { cwd, home, web, api } = checkoutPair();
    const upstream = addJob(cwd, home, "feature", "api", "Publish the summary");
    const downstream = addJob(cwd, home, "feature", "web", "Show the summary", [upstream]);
    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    waitForStatus(cwd, home, upstream, /needs-human/);
    const ownerRun = runIds(api)[0];
    assert.ok(ownerRun);
    const answered = runCli(["reject", upstream], { cwd, home });
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    const rejected = runCli(["status"], { cwd, home });
    assert.match(rejected.stdout, new RegExp(`${upstream}\\s+api\\s+feature\\s+rejected`));
    assert.match(rejected.stdout, new RegExp(`${downstream}\\s+web\\s+feature\\s+blocked`));
    assert.doesNotMatch(rejected.stdout, /branch yak\//);
    assert.doesNotMatch(git(api, ["log", "--format=%s", `yak/${ownerRun}`]), /^kiln:/m);
    const next = runCli(["tick"], { cwd, home });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /nothing to launch/);
    assert.deepEqual(runIds(web), []);
  });

  it("keeps a dirty checkout file unchanged and writes the run only in its worktree", () => {
    const { cwd, home, web } = checkoutPair();
    const tracked = join(web, "tracked.txt");
    writeFileSync(tracked, "original\n");
    git(web, ["add", "tracked.txt"]);
    git(web, ["commit", "-q", "-m", "track"]);
    writeFileSync(tracked, "dirty\n");
    const before = readFileSync(tracked);
    const id = addJob(cwd, home, "feature", "web", "Touch only the worktree");
    const launched = runCli(["tick"], { cwd, home });
    assert.equal(launched.status, 0, launched.stderr);
    const status = waitForStatus(cwd, home, id, new RegExp(`${id}\\s+web\\s+feature\\s+needs-human`));
    const runId = runIdOf(status, id);
    const worktree = join(web, ".yak", "worktrees", runId);
    assert.equal(readFileSync(join(worktree, "kiln-landed.txt"), "utf8"), "landed\n");
    assert.deepEqual(readFileSync(tracked), before);
    assert.equal(existsSync(join(web, "kiln-landed.txt")), false);
    const exclude = readFileSync(join(web, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\.runs\/$/m);
    assert.match(exclude, /^\.yak\/$/m);
    const porcelain = git(web, ["status", "--porcelain"]);
    assert.match(porcelain, /tracked\.txt/);
    assert.doesNotMatch(porcelain, /\.runs/);
    assert.doesNotMatch(porcelain, /\.yak/);

    const answered = runCli(["approve", id], { cwd, home });
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    const done = runCli(["status", id], { cwd, home });
    assert.match(done.stdout, new RegExp(`branch yak/${runId}`));
    assert.equal(git(web, ["show", `yak/${runId}:kiln-landed.txt`]), "landed\n");
    assert.equal(git(web, ["log", "-1", "--format=%s", `yak/${runId}`]).trim(), "kiln: Touch only the worktree");
    assert.deepEqual(readFileSync(tracked), before);
  });

  it("does not launch a second ready job when maxConcurrent is 1 and the first run is in flight", () => {
    const { cwd, home, web } = checkoutPair();
    useMock(cwd, 1);
    const firstId = addJob(cwd, home, "feature", "web", "Calm empty copy");
    const secondId = addJob(cwd, home, "feature", "web", "Sunday heading");
    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /maxConcurrent=1/);
    assert.match(first.stdout, new RegExp(`launch ${firstId}\\s+web`));
    assert.doesNotMatch(first.stdout, new RegExp(`launch ${secondId}`));
    const second = runCli(["tick"], { cwd, home });
    assert.match(second.stdout, /inFlight=1/);
    assert.match(second.stdout, /nothing to launch/);
    const status = waitForStatus(cwd, home, firstId, /needs-human/);
    assert.match(status, new RegExp(`${firstId}\\s+web\\s+feature\\s+needs-human`));
    const other = runCli(["status", secondId], { cwd, home });
    assert.match(other.stdout, new RegExp(`${secondId}\\s+web\\s+feature\\s+queued`));
    assert.equal(runIds(web).length, 1);
  });

  it("gives two ready jobs in one repo two distinct worktrees when maxConcurrent is 2", () => {
    const { cwd, home, web } = checkoutPair();
    const calm = addJob(cwd, home, "feature", "web", "Calm empty copy");
    const sunday = addJob(cwd, home, "feature", "web", "Sunday heading");
    assert.match(runCli(["tick"], { cwd, home }).stdout, new RegExp(`launch ${calm}\\s+web`));
    assert.match(runCli(["tick"], { cwd, home }).stdout, new RegExp(`launch ${sunday}\\s+web`));
    const calmStatus = waitForStatus(cwd, home, calm, /needs-human/);
    const sundayStatus = waitForStatus(cwd, home, sunday, /needs-human/);
    const calmRun = runIdOf(calmStatus, calm);
    const sundayRun = runIdOf(sundayStatus, sunday);
    assert.notEqual(calmRun, sundayRun);
    assert.deepEqual(worktrees(web).sort(), [calmRun, sundayRun].sort());
    for (const id of [calmRun, sundayRun]) {
      const tree = join(web, ".yak", "worktrees", id);
      assert.equal(git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), `yak/${id}`);
    }
    assert.equal(runCli(["approve", calm], { cwd, home }).status, 0);
    assert.equal(runCli(["approve", sunday], { cwd, home }).status, 0);
    assert.equal(git(web, ["log", "-1", "--format=%s", `yak/${calmRun}`]).trim(), "kiln: Calm empty copy");
    assert.equal(git(web, ["log", "-1", "--format=%s", `yak/${sundayRun}`]).trim(), "kiln: Sunday heading");
  });

  it("marks a dead journal dead, prints cancel, and launches the next job under maxConcurrent 1", () => {
    const { cwd, home, web } = checkoutPair();
    useMock(cwd, 1);
    const calm = addJob(cwd, home, "feature", "web", "Calm empty copy");
    const sunday = addJob(cwd, home, "feature", "web", "Sunday heading");
    const runId = "2026-10-24T00-00-00Z-dead";
    const runDir = join(web, ".runs", runId);
    mkdirSync(runDir, { recursive: true });
    const gone = deadPid();
    writeFileSync(
      join(runDir, "journal.jsonl"),
      [
        JSON.stringify({ t: "run.started", runId, tag: `kiln:${calm}`, pid: process.pid }),
        JSON.stringify({ t: "run.resumed", runId, pid: gone }),
        "{\"t\":\"step.started\",\"partial",
        "",
      ].join("\n"),
    );
    const before = runCli(["status", calm], { cwd, home });
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, new RegExp(`${calm}\\s+web\\s+feature\\s+dead`));
    assert.ok(before.stdout.includes(`cancel '${runId}'`), before.stdout);
    assert.ok(before.stdout.includes(`cd '${web}'`), before.stdout);
    assert.match(runCli(["status", sunday], { cwd, home }).stdout, /queued/);
    const tick = runCli(["tick"], { cwd, home });
    assert.match(tick.stdout, new RegExp(`launch ${sunday}\\s+web`));
    assert.doesNotMatch(tick.stdout, new RegExp(`launch ${calm}`));
    assert.match(runCli(["status", calm], { cwd, home }).stdout, /dead/);
  });

  it("does not relaunch a job whose launch pid died before a journal existed", () => {
    const { cwd, home, web } = checkoutPair();
    const id = addJob(cwd, home, "feature", "web", "Calm empty copy");
    const logPath = join(cwd, ".kiln", "logs", `${id}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "yak exited before writing a journal\n");
    const crumbDir = join(cwd, ".kiln", "launching");
    mkdirSync(crumbDir, { recursive: true });
    writeFileSync(
      join(crumbDir, `${id}.json`),
      `${JSON.stringify({ jobId: id, pid: deadPid(), logPath }, null, 2)}\n`,
    );
    const status = runCli(["status", id], { cwd, home });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`${id}\\s+web\\s+feature\\s+failed`));
    assert.ok(status.stdout.includes(`log ${logPath}`), status.stdout);
    const first = runCli(["tick"], { cwd, home });
    const second = runCli(["tick"], { cwd, home });
    assert.match(first.stdout, /nothing to launch/);
    assert.match(second.stdout, /nothing to launch/);
    assert.deepEqual(runIds(web), []);
  });

  it("refuses an empty test command instead of running it", () => {
    const { cwd, home, web } = checkoutPair();
    const path = join(cwd, ".kiln", "kiln.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { repos: { web: { test: string } } };
    raw.repos.web.test = "   ";
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    addJob(cwd, home, "feature", "web", "Calm empty copy");
    const tick = runCli(["tick"], { cwd, home });
    assert.equal(tick.status, 1);
    assert.match(tick.stderr, /no test command|empty/);
    assert.deepEqual(runIds(web), []);
  });

  it("feeds a failing review back to the builder and still reaches the gate", () => {
    const { cwd, home, web } = checkoutPair();
    const promptLog = join(cwd, "prompt-log");
    mkdirSync(promptLog);
    const findings = "MUSTFIX week-id: the Sunday heading drops the week id";
    commitFeatureFixtures(web, {
      spec: [{ output: { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." } }],
      build: [{ output: { summary: "Mock build.", status: "READY" } }],
      security: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ux: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ui: [{ output: { verdict: "PASS", findings: "Checked: no UI changes." } }],
      code: [
        { output: { verdict: "CHANGES", findings } },
        { output: { verdict: "PASS", findings: "The week id is covered." } },
      ],
      approver: [{ output: { decision: "APPROVE", reason: "Round 2 reviews passed." } }],
    });
    const id = addJob(cwd, home, "feature", "web", "Sunday heading");
    const launched = runCli(["tick"], { cwd, home, env: promptEnv(promptLog, 200) });
    assert.equal(launched.status, 0, launched.stderr);
    const suspended = waitForStatus(cwd, home, id, /needs-human/, 60000);
    const runId = runIdOf(suspended, id);
    assert.deepEqual(stepIterations(web, runId, "build"), [1, 2]);
    assert.deepEqual(stepIterations(web, runId, "code"), [1, 2]);
    assertReviewersOverlap(web, runId, 1);
    assert.equal(readArtifact(web, runId, "code.1.json").verdict, "CHANGES");
    assert.equal(readArtifact(web, runId, "code.2.json").verdict, "PASS");
    const prompts = readPrompts(promptLog);
    const build2 = prompts.find((entry) => entry.stepId === "build" && entry.callIndex === 1);
    assert.ok(build2, JSON.stringify(prompts.map((entry) => [entry.stepId, entry.callIndex])));
    assert.match(build2.prompt, new RegExp(findings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const base = headSha(web);
    assert.equal(readInput(web, runId).baseRef, base);
    assertBranchPreamble(build2.prompt, base);
  });

  it("stops after two rounds when CHANGES are still open", () => {
    const { cwd, home, web } = checkoutPair();
    const promptLog = join(cwd, "prompt-log");
    mkdirSync(promptLog);
    const findings = "MUSTFIX week-id: the Sunday heading drops the week id";
    commitFeatureFixtures(web, {
      spec: [{ output: { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." } }],
      build: [{ output: { summary: "Mock build.", status: "READY" } }],
      security: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ux: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ui: [{ output: { verdict: "PASS", findings: "Checked: no UI changes." } }],
      code: [{ output: { verdict: "CHANGES", findings } }],
      approver: [{ output: { decision: "ESCALATE", reason: "Code review still wants changes." } }],
    });
    const id = addJob(cwd, home, "feature", "web", "Sunday heading");
    const launched = runCli(["tick"], { cwd, home, env: promptEnv(promptLog) });
    assert.equal(launched.status, 0, launched.stderr);
    const suspended = waitForStatus(cwd, home, id, /needs-human/, 60000);
    const runId = runIdOf(suspended, id);
    assert.deepEqual(stepIterations(web, runId, "build"), [1, 2]);
    assert.deepEqual(stepIterations(web, runId, "code"), [1, 2]);
    assert.equal(readArtifact(web, runId, "code.1.json").verdict, "CHANGES");
    assert.equal(readArtifact(web, runId, "code.2.json").verdict, "CHANGES");
    assert.equal(readArtifact(web, runId, "decision.json").decision, "ESCALATE");
    assert.match(suspended, /Agent decision: ESCALATE/);
    assert.deepEqual(
      journalEvents(web, runId).filter((event) => event.stepId === "land"),
      [],
    );
    const approverPrompt = readPrompts(promptLog).find((entry) => entry.stepId === "approver");
    assert.ok(approverPrompt);
    assert.match(approverPrompt.prompt, new RegExp(findings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(approverPrompt.prompt, /Only the final round is provided/);
  });

  it("launches a job once when two ticks run together", async () => {
    const { cwd, home, web } = checkoutPair();
    addJob(cwd, home, "feature", "web", "Sunday heading");
    const [first, second] = await Promise.all([
      runCliAsync(["tick"], { cwd, home }),
      runCliAsync(["tick"], { cwd, home }),
    ]);
    const results = [first, second];
    const launched = results.filter((result) => result.status === 0 && /^launch \S+/m.test(result.stdout));
    assert.equal(
      launched.length,
      1,
      results.map((result) => `${result.status}\n${result.stdout}\n${result.stderr}`).join("\n---\n"),
    );
    const other = results.find((result) => result !== launched[0]);
    assert.ok(other);
    const tolerated =
      (other.status === 0 && /nothing to launch/.test(other.stdout)) ||
      (other.status === 1 && /Another kiln tick is running/.test(other.stderr));
    assert.equal(tolerated, true, `${other.status}\n${other.stdout}\n${other.stderr}`);
    const ids = waitForRunCount(web, 1, 30000);
    assert.deepEqual(ids, runIds(web));
    assert.equal(ids.length, 1, ids.join("\n"));
    assert.equal(worktrees(web).length, 1);
  });

  it("loops a red verify back to the builder instead of failing the run", () => {
    const { cwd, home, web } = checkoutPair();
    const promptLog = join(cwd, "prompt-log");
    mkdirSync(promptLog);
    writeFileSync(
      join(web, "verify-once.mjs"),
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const path = 'verify-attempt.txt';",
        "const n = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;",
        "writeFileSync(path, String(n + 1));",
        "if (n === 0) {",
        "  for (let i = 0; i < 250; i += 1) console.error('verify-line-' + i);",
        "  console.error('verify failed round 1');",
        "  process.exit(1);",
        "}",
        "console.log('verify ok round 2');",
        "",
      ].join("\n"),
    );
    git(web, ["add", "verify-once.mjs"]);
    git(web, ["commit", "-q", "-m", "red then green verify"]);
    const path = join(cwd, ".kiln", "kiln.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { repos: { web: { test: string } } };
    raw.repos.web.test = "node verify-once.mjs";
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    const id = addJob(cwd, home, "feature", "web", "Calm empty copy");
    assert.equal(runCli(["tick"], { cwd, home, env: promptEnv(promptLog) }).status, 0);
    const suspended = waitForStatus(cwd, home, id, /needs-human/, 60000);
    const runId = runIdOf(suspended, id);
    const redVerify = readArtifact(web, runId, "verify.1.json");
    assert.equal(redVerify.exitCode, 1);
    assert.match(redVerify.stderr ?? "", /\[truncated: showing the last 200 lines or 20480 bytes of stderr\]/);
    assert.equal(readArtifact(web, runId, "verify.2.json").exitCode, 0);
    const build2 = readPrompts(promptLog).find((entry) => entry.stepId === "build" && entry.callIndex === 1);
    assert.ok(build2);
    assert.match(build2.prompt, /verify failed round 1/);
    assert.equal(runCli(["approve", id], { cwd, home }).status, 0);
    assert.match(runCli(["status", id], { cwd, home }).stdout, new RegExp(`branch yak/${runId}`));
  });

  it("retries a BLOCKED build and reaches the gate instead of committing", () => {
    const { cwd, home, web } = checkoutPair();
    commitFeatureFixtures(web, {
      spec: [{ output: { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." } }],
      build: [{ output: { summary: "Branch check failed.", status: "BLOCKED" } }],
      security: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ux: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ui: [{ output: { verdict: "PASS", findings: "Checked: no UI changes." } }],
      code: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      approver: [{ output: { decision: "ESCALATE", reason: "Build stayed BLOCKED." } }],
    });
    const id = addJob(cwd, home, "feature", "web", "Sunday heading");
    assert.equal(runCli(["tick"], { cwd, home }).status, 0);
    const suspended = waitForStatus(cwd, home, id, /needs-human/, 60000);
    const runId = runIdOf(suspended, id);
    assert.equal(readArtifact(web, runId, "decision.json").decision, "ESCALATE");
    assert.match(suspended, /Agent decision: ESCALATE/);
    assert.doesNotMatch(git(web, ["log", "--format=%s", `yak/${runId}`]), /^kiln:/m);
  });

  it("lands when a human approves an ESCALATE decision and skips land on reject", () => {
    const { cwd, home, web } = checkoutPair();
    const approveId = addJob(cwd, home, "feature", "web", "Calm empty copy");
    assert.equal(runCli(["tick"], { cwd, home }).status, 0);
    const approveStatus = waitForStatus(cwd, home, approveId, /needs-human/, 60000);
    const approveRun = runIdOf(approveStatus, approveId);
    assert.equal(runCli(["approve", approveId], { cwd, home }).status, 0);
    assert.equal(git(web, ["log", "-1", "--format=%s", `yak/${approveRun}`]).trim(), "kiln: Calm empty copy");

    const rejectId = addJob(cwd, home, "feature", "web", "Leave the tree");
    assert.equal(runCli(["tick"], { cwd, home }).status, 0);
    const rejectStatus = waitForStatus(cwd, home, rejectId, /needs-human/, 60000);
    const rejectRun = runIdOf(rejectStatus, rejectId);
    assert.equal(runCli(["reject", rejectId], { cwd, home }).status, 0);
    assert.match(runCli(["status", rejectId], { cwd, home }).stdout, /rejected/);
    assert.doesNotMatch(git(web, ["log", "--format=%s", `yak/${rejectRun}`]), /^kiln:/m);
  });
});

function promptEnv(promptLog: string, delayMs?: number): Record<string, string> {
  const hook = join(root, "test", "hooks", "register-record-mock-prompts.mjs");
  return {
    NODE_OPTIONS: `--import ${hook}`,
    KILN_PROMPT_LOG: promptLog,
    ...(delayMs === undefined ? {} : { KILN_MOCK_DELAY_MS: String(delayMs) }),
  };
}

/** The four reviewers' step.started events all land before any of them finishes. */
function assertReviewersOverlap(checkout: string, runId: string, iteration: number): void {
  const reviewers = new Set(["security", "ux", "ui", "code"]);
  const lines = readFileSync(join(checkout, ".runs", runId, "journal.jsonl"), "utf8").split("\n");
  const starts: number[] = [];
  const finishes: number[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as { t?: string; stepId?: string; iteration?: number };
      if (!event.stepId || !reviewers.has(event.stepId) || event.iteration !== iteration) return;
      if (event.t === "step.started") starts.push(index);
      if (event.t === "step.completed") finishes.push(index);
    } catch {
      // A torn last line is ignored, same as the driver.
    }
  });
  assert.deepEqual(starts.length, 4, lines.filter((line) => line.includes("security") || line.includes("\"ux\"")).join("\n"));
  assert.equal(finishes.length, 4);
  assert.ok(Math.max(...starts) < Math.min(...finishes), lines.join("\n"));
}

function commitFeatureFixtures(checkout: string, fixtures: Record<string, unknown[]>): void {
  const dir = join(checkout, "test", "fixtures", "kiln-feature");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(fixtures)) {
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(body)}\n`);
  }
  git(checkout, ["add", "test/fixtures"]);
  git(checkout, ["commit", "-q", "-m", "fixtures"]);
}

function waitForRunCount(checkout: string, count: number, timeoutMs: number): string[] {
  const start = Date.now();
  let ids = runIds(checkout);
  while (Date.now() - start < timeoutMs) {
    ids = runIds(checkout);
    if (ids.length > count) return ids;
    if (ids.length === count) {
      sleep(1);
      return runIds(checkout);
    }
    sleep(0.1);
  }
  return ids;
}

function journalEvents(checkout: string, runId: string): { t?: string; stepId?: string }[] {
  const lines = readFileSync(join(checkout, ".runs", runId, "journal.jsonl"), "utf8").split("\n");
  const events: { t?: string; stepId?: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as { t?: string; stepId?: string });
    } catch {
      // A torn last line is ignored, same as the driver.
    }
  }
  return events;
}

function stepIterations(checkout: string, runId: string, stepId: string): number[] {
  const lines = readFileSync(join(checkout, ".runs", runId, "journal.jsonl"), "utf8").split("\n");
  const found: number[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { t?: string; stepId?: string; iteration?: number };
      if (event.t === "step.started" && event.stepId === stepId && typeof event.iteration === "number") {
        found.push(event.iteration);
      }
    } catch {
      // A torn last line is ignored, same as the driver.
    }
  }
  return found;
}

function readArtifact(
  checkout: string,
  runId: string,
  name: string,
): { verdict?: string; exitCode?: number; stderr?: string; status?: string; decision?: string } {
  return JSON.parse(readFileSync(join(checkout, ".runs", runId, "artifacts", name), "utf8")) as {
    verdict?: string;
    exitCode?: number;
    stderr?: string;
    status?: string;
    decision?: string;
  };
}

function headSha(checkout: string): string {
  return git(checkout, ["rev-parse", "HEAD"]).trim();
}

function readInput(checkout: string, runId: string): { baseRef?: string } {
  return JSON.parse(readFileSync(join(checkout, ".runs", runId, "artifacts", "input.json"), "utf8")) as {
    baseRef?: string;
  };
}

function assertBranchPreamble(prompt: string, base: string): void {
  assert.ok(prompt.includes(base), "prompt is missing the base SHA");
  assert.match(prompt, /git branch --show-current/);
  assert.match(prompt, /yak\/<run-id>/);
}

interface PromptRecord {
  stepId: string;
  callIndex: number;
  prompt: string;
}

function readPrompts(promptLog: string): PromptRecord[] {
  return readFileSync(join(promptLog, "prompts.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PromptRecord);
}
