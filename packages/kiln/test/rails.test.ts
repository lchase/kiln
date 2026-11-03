import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig } from "../src/config.js";
import { readStatus, reviseJob, runTick } from "../src/driver.js";
import { readEvents } from "../src/events.js";
import { decideFailure, failureFingerprint, normalizeFailureText } from "../src/failure.js";
import { FIX_LAND_COMMAND, ensureFixTrailers } from "../src/fix-commit.js";
import { defaultHost, type KilnHost } from "../src/host.js";
import { writeJob } from "../src/jobs.js";
import { renderLedgerFile } from "../src/ledger.js";
import { packageRoot } from "../src/paths.js";
import { projectRunJournal } from "../src/project.js";
import { isPaused, pauseFactory, resumeFactory } from "../src/rails.js";
import { planFeedback } from "../src/feedback.js";

const keep: string[] = [];
const root = packageRoot();

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("failure class and fingerprint", () => {
  it("strips timestamps, temp paths, hex ids, and line numbers", () => {
    const left = normalizeFailureText(
      "error TS2304: Cannot find name Widget at /tmp/kiln-abc/src/widget.ts:12:4 run 2026-01-02T03:04:05.000Z id deadbeefcafebabe",
    );
    const right = normalizeFailureText(
      "error TS2304: Cannot find name Widget at /tmp/other/src/widget.ts:99:1 run 2020-05-05T01:02:03Z id 0123456789abcdef",
    );
    assert.equal(left, right);
    assert.equal(failureFingerprint(left), failureFingerprint(right));
    assert.match(left, /<tmp>/);
    assert.match(left, /<line>/);
    assert.match(left, /<ts>/);
    assert.match(left, /<id>/);
  });

  it("classifies network, rate limit, 5xx, and start flakes as transient, and test errors as deterministic", () => {
    const transient = decideFailure({
      text: "connect ECONNRESET",
      operational: true,
      blocked: false,
      attempt: 1,
      maxAttempts: 5,
      sameFingerprint: 1,
      maxSameFingerprint: 3,
    });
    assert.equal(transient.class, "transient");
    assert.equal(transient.retry, true);
    const limited = decideFailure({
      text: "429 too many requests",
      operational: false,
      blocked: false,
      attempt: 1,
      maxAttempts: 5,
      sameFingerprint: 1,
      maxSameFingerprint: 3,
    });
    assert.equal(limited.class, "transient");
    const server = decideFailure({
      text: "502 bad gateway",
      operational: false,
      blocked: false,
      attempt: 1,
      maxAttempts: 5,
      sameFingerprint: 1,
      maxSameFingerprint: 3,
    });
    assert.equal(server.class, "transient");
    const flake = decideFailure({
      text: "the container never started",
      operational: true,
      blocked: false,
      attempt: 1,
      maxAttempts: 5,
      sameFingerprint: 1,
      maxSameFingerprint: 3,
    });
    assert.equal(flake.class, "transient");
    const typed = decideFailure({
      text: "error TS2304: Cannot find name Widget",
      operational: true,
      blocked: false,
      attempt: 1,
      maxAttempts: 5,
      sameFingerprint: 1,
      maxSameFingerprint: 3,
    });
    assert.equal(typed.class, "deterministic");
    assert.equal(typed.retry, false);
  });
});

describe("loop breakers", () => {
  it("trips on the third identical fingerprint and not on three different ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-fp-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { maxAttempts: 10, maxSameFingerprint: 3 });
    const same = add(config, "Same network error");
    const varied = add(config, "Three different errors");
    const now = new Date("2026-04-01T00:00:00.000Z");
    const sameText = "connect ECONNRESET while fetching the index";
    const variedText = ["connect ECONNRESET while fetching the index", "502 bad gateway", "429 too many requests"];
    const started: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      plantFailure(checkout, same, `2000-04-01T00-00-0${n}Z-same`, sameText);
      plantFailure(checkout, varied, `2000-04-01T00-00-0${n}Z-varied`, variedText[n] ?? "429 too many requests");
      runTick(config, capturingHost(started), { startup: false, now: new Date(now.getTime() + n * 1000) });
    }
    assert.equal(started.length, 0);
    const sameJob = readStatus(config, same).jobs[0];
    const variedJob = readStatus(config, varied).jobs[0];
    assert.equal(sameJob?.state, "needs-human");
    assert.equal(sameJob?.stopReason, "fingerprint");
    assert.equal(sameJob?.nextRetryAt, undefined);
    assert.equal(variedJob?.state, "failed");
    assert.equal(variedJob?.stopReason, undefined);
    assert.ok(variedJob?.nextRetryAt);
    const failed = readEvents(config.kilnDir, { warn: () => {} }).filter(
      (event) => event.event === "run.failed" && event.job_id === same,
    );
    assert.equal(failed.length, 3);
    const last = failed[2];
    assert.ok(last && last.event === "run.failed");
    assert.equal(last.properties.class, "transient");
    const prints = failed.map((event) => (event.event === "run.failed" ? event.properties.fingerprint : ""));
    assert.equal(prints[0], prints[1]);
    assert.equal(prints[1], prints[2]);
    assert.equal(new Set(prints).size, 1);
    const stopped = readEvents(config.kilnDir, { warn: () => {} }).some(
      (event) => event.event === "needs-human" && event.job_id === same && event.properties.reason === "fingerprint",
    );
    assert.equal(stopped, true);
    const laterStarted: string[] = [];
    const later = runTick(config, capturingHost(laterStarted), {
      startup: false,
      now: new Date(now.getTime() + 60 * 60 * 1000),
    });
    assert.doesNotMatch(later, new RegExp(`retry ${same}`));
    assert.equal(laterStarted.some((line) => line.includes(same)), false);
  });

  it("treats an attempt cap as a budget failure and moves the job to needs-human", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-cap-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, {
      maxAttempts: 5,
      repos: { web: { path: checkout, test: "node --test test.mjs", maxAttempts: 2 } },
    });
    assert.equal(config.repos.web?.maxAttempts, 2);
    assert.equal(config.maxAttempts, 5);
    const id = add(config, "Cap the attempts");
    const now = new Date("2026-04-02T00:00:00.000Z");
    plantFailure(checkout, id, "2000-04-02T00-00-00Z-a", "connect ECONNRESET");
    runTick(config, capturingHost([]), { startup: false, now });
    assert.equal(readStatus(config, id).jobs[0]?.state, "failed");
    plantFailure(checkout, id, "2000-04-02T00-00-01Z-b", "502 bad gateway");
    const second = runTick(config, capturingHost([]), { startup: false, now: new Date(now.getTime() + 1000) });
    assert.match(second, /needs human/);
    const job = readStatus(config, id).jobs[0];
    assert.equal(job?.state, "needs-human");
    assert.equal(job?.stopReason, "attempt-cap");
    assert.equal(job?.nextRetryAt, undefined);
    const failed = readEvents(config.kilnDir, { warn: () => {} }).filter(
      (event) => event.event === "run.failed" && event.job_id === id,
    );
    const cap = failed[1];
    assert.ok(cap && cap.event === "run.failed");
    assert.equal(cap.properties.class, "budget");
    assert.equal(cap.properties.tokens, null);
    assert.equal(cap.properties.usd, null);
  });

  it("uses the repo fix-round cap", () => {
    const exhausted = planFeedback({
      maxFixRounds: 1,
      ledger: {
        jobId: "job",
        rounds: [
          {
            round: 1,
            headSha: "a".repeat(40),
            trigger: "ci",
            items: [{ kind: "check", source: "check:old", summary: "old" }],
            at: "2026-01-01T00:00:00.000Z",
            outcome: "pushed",
          },
        ],
      },
      snapshot: {
        operatorLogin: "octocat",
        headSha: "b".repeat(40),
        checks: [{ name: "test", status: "completed", conclusion: "failure" }],
        reviews: [],
        comments: [],
      },
    });
    assert.equal(exhausted.action, "exhaust");
  });
});

describe("daily cap and pause", () => {
  it("blocks new runs once today's recorded dollars reach the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-spend-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, { dailyDollarCap: 1 });
    const id = add(config, "Wait for the cap");
    const started: string[] = [];
    appendCost(config.kilnDir, id, 1.5);
    const output = runTick(config, capturingHost(started), { startup: false, now: new Date() });
    assert.equal(started.length, 0);
    assert.doesNotMatch(output, new RegExp(`launch ${id}`));
    assert.match(readStatus(config, id).jobs[0]?.waitReason ?? "", /Daily cap reached/);
    const blocked = readEvents(config.kilnDir, { warn: () => {} }).some((event) => event.event === "budget.blocked");
    assert.equal(blocked, true);
    const ledger = renderLedgerFile(config.kilnDir, { dailyDollarCap: 1 });
    assert.match(ledger, /today \d{4}-\d{2}-\d{2}  \$1\.50 \/ \$1\.00/);
    runTick(config, capturingHost(started), { startup: false, now: new Date() });
    const blocks = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "budget.blocked");
    assert.equal(blocks.length, 1);
  });

  it("pause blocks new runs and is still paused in a fresh process", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-pause-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const home = join(dir, "home");
    mkdirSync(home);
    const config = load(dir, checkout, {});
    const waiting = add(config, "Do not start");
    const running = add(config, "Already going");
    const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    live.unref();
    const pid = live.pid ?? 0;
    assert.ok(pid > 1);
    journal(checkout, "2000-04-04T00-00-00Z-live", [
      { t: "run.started", at: new Date().toISOString(), runId: "2000-04-04T00-00-00Z-live", tag: `kiln:${running}`, pid },
    ]);
    const cli = runCli(["pause", "--config", config.configPath], dir, home);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^paused/);
    assert.equal(isPaused(config.kilnDir), true);
    const again = runCli(["pause", "--config", config.configPath], dir, home);
    assert.match(again.stdout, /already paused/);
    const started: string[] = [];
    const output = runTick(config, capturingHost(started), { startup: false, now: new Date() });
    assert.equal(started.length, 0, output);
    assert.doesNotMatch(output, new RegExp(`launch ${waiting}`));
    assert.equal(readStatus(config, running).jobs[0]?.state, "running");
    assert.match(readStatus(config, waiting).jobs[0]?.waitReason ?? "", /Paused/);
    const resumed = runCli(["resume", "--config", config.configPath], dir, home);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(isPaused(config.kilnDir), false);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The sleep may already be gone.
    }
    assert.equal(pauseFactory(config.kilnDir), true);
    assert.equal(resumeFactory(config.kilnDir), true);
  });
});

describe("revise with note", () => {
  it("puts the note in the next prompt input and stores it redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-revise-"));
    keep.push(dir);
    const checkout = join(dir, "web");
    initRepo(checkout);
    const config = load(dir, checkout, {});
    const id = add(config, "Rename the helper");
    const runId = "2000-04-05T00-00-00Z-gate";
    const token = "ghp_aaaaaaaaaaaaaaaaaaaa";
    journal(checkout, runId, [
      { t: "run.started", at: "2026-04-05T00:00:00.000Z", runId, tag: `kiln:${id}`, workflow: "kiln-feature" },
      { t: "gate.opened", stepId: "approve" },
      { t: "run.finished", at: "2026-04-05T00:00:01.000Z", status: "suspended" },
    ]);
    mkdirSync(join(checkout, ".runs", runId, "pending"), { recursive: true });
    writeFileSync(
      join(checkout, ".runs", runId, "pending", "approve.request.json"),
      `${JSON.stringify({
        kind: "gate",
        rendered: "Approve Rename the helper?\n",
        answerSchema: {
          type: "object",
          properties: { decision: { type: "string", enum: ["approve", "reject"] } },
          required: ["decision"],
        },
      })}\n`,
    );
    const started: string[] = [];
    const note = `rename the helper and drop ${token}`;
    const output = reviseJob(config, id, note, capturingHost(started));
    assert.match(output, new RegExp(`revised ${id}`));
    assert.equal(started.length, 1);
    assert.match(started[0] ?? "", /rename the helper/);
    assert.doesNotMatch(started[0] ?? "", new RegExp(token));
    assert.match(started[0] ?? "", /## Human note/);
    const specPrompt = readFileSync(join(root, "prompts", "kiln", "spec.md"), "utf8");
    assert.match(specPrompt, /\{\{input\.description\}\}/);
    const resolved = readEvents(config.kilnDir, { warn: () => {} }).find(
      (event) => event.event === "gate.resolved" && event.job_id === id,
    );
    assert.ok(resolved && resolved.event === "gate.resolved");
    assert.equal(resolved.properties.decision, "revise");
    assert.match(resolved.properties.note ?? "", /rename the helper/);
    assert.doesNotMatch(resolved.properties.note ?? "", new RegExp(token));
    assert.match(resolved.properties.note ?? "", /\[redacted\]/);
  });
});

describe("fix-round commit trailers", () => {
  it("writes Kiln-Job, Kiln-Round, and Kiln-Prompts-Hash on the land commit and on an amended agent commit", () => {
    const yaml = readFileSync(join(root, "workflows", "fix.yaml"), "utf8");
    assert.ok(yaml.includes(FIX_LAND_COMMAND));
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-commit-"));
    keep.push(dir);
    const landed = join(dir, "landed");
    initRepo(landed);
    writeFileSync(join(landed, "changed.txt"), "changed\n");
    const hash = "a".repeat(64);
    const result = spawnSync("sh", ["-c", FIX_LAND_COMMAND], {
      cwd: landed,
      encoding: "utf8",
      env: {
        ...process.env,
        KILN_TASK_TITLE: "Sample widget",
        KILN_JOB: "j20260101000000abcd",
        KILN_ROUND: "2",
        KILN_PROMPTS_HASH: hash,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const message = git(landed, ["log", "-1", "--format=%B"]);
    assert.match(message, /Kiln-Job: j20260101000000abcd/);
    assert.match(message, /Kiln-Round: 2/);
    assert.match(message, new RegExp(`Kiln-Prompts-Hash: ${hash}`));

    const amended = join(dir, "amended");
    initRepo(amended);
    const base = git(amended, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(amended, "agent.txt"), "from the agent\n");
    git(amended, ["add", "-A"]);
    git(amended, ["commit", "-q", "-m", "agent: sample"]);
    const outcome = ensureFixTrailers(
      amended,
      { jobId: "j20260101000000abcd", round: 1, promptsHash: hash, title: "Sample widget" },
      base,
    );
    assert.equal(outcome, "amended");
    const amendedMessage = git(amended, ["log", "-1", "--format=%B"]);
    assert.match(amendedMessage, /Kiln-Job: j20260101000000abcd/);
    assert.match(amendedMessage, /Kiln-Round: 1/);
    assert.match(amendedMessage, new RegExp(`Kiln-Prompts-Hash: ${hash}`));
  });
});

describe("run cost", () => {
  it("records reported tokens and dollars and leaves missing numbers null", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rails-cost-"));
    keep.push(dir);
    const kiln = join(dir, "kiln");
    mkdirSync(kiln, { recursive: true });
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    projectRunJournal({
      kilnDir: kiln,
      jobId: "job-cost",
      runId: "run-cost",
      runDir,
      workflow: "feature",
      repo: "web",
      events: [
        { t: "run.started", workflow: "kiln-feature" },
        { t: "budget.consumed", stepId: "spec", tokens: 10, usd: 0.2 },
        { t: "budget.consumed", stepId: "build", tokens: 5 },
        { t: "run.finished", status: "ok" },
      ],
    });
    const finished = readEvents(kiln, { warn: () => {} }).find((event) => event.event === "run.finished");
    assert.ok(finished && finished.event === "run.finished");
    assert.equal(finished.properties.tokens, 15);
    assert.equal(finished.properties.usd, 0.2);
    projectRunJournal({
      kilnDir: kiln,
      jobId: "job-empty",
      runId: "run-empty",
      runDir,
      workflow: "feature",
      repo: "web",
      events: [
        { t: "run.started", workflow: "kiln-feature" },
        { t: "run.finished", status: "ok" },
      ],
    });
    const empty = readEvents(kiln, { warn: () => {} }).find(
      (event) => event.event === "run.finished" && event.job_id === "job-empty",
    );
    assert.ok(empty && empty.event === "run.finished");
    assert.equal(empty.properties.tokens, null);
    assert.equal(empty.properties.usd, null);
  });
});

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function load(dir: string, checkout: string, extra: Record<string, unknown>) {
  const configDir = join(dir, "kiln");
  mkdirSync(configDir, { recursive: true });
  const repos = (extra.repos as Record<string, unknown> | undefined) ?? {
    web: { path: checkout, test: "node --test test.mjs" },
  };
  const { repos: _repos, ...rest } = extra;
  writeFileSync(
    join(configDir, "kiln.config.json"),
    `${JSON.stringify({ adapter: "mock", maxConcurrent: 4, repos, ...rest }, null, 2)}\n`,
  );
  return loadKilnConfig(join(configDir, "kiln.config.json"));
}

function add(config: ReturnType<typeof load>, title: string): string {
  return writeJob(config, {
    workflow: "feature",
    repo: "web",
    specText: `# ${title}\n\nDo the work.\n`,
    title,
    dependsOn: [],
    source: { kind: "prompt", ref: "inline" },
  }).job.id;
}

function journal(checkout: string, runId: string, lines: unknown[]): void {
  const runDir = join(checkout, ".runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function plantFailure(checkout: string, jobId: string, runId: string, detail: string): void {
  journal(checkout, runId, [
    { t: "run.started", at: "2026-04-01T00:00:00.000Z", runId, tag: `kiln:${jobId}`, pid: 2_147_483_646 },
    {
      t: "step.failed",
      at: "2026-04-01T00:00:01.000Z",
      stepId: "verify",
      failure: { reason: "command-failed", detail, recoverable: false },
    },
    { t: "run.finished", at: "2026-04-01T00:00:02.000Z", status: "failed", runId },
  ]);
}

function capturingHost(started: string[]): KilnHost {
  const host = defaultHost();
  return {
    ...host,
    startAgent(spec) {
      started.push(spec.args.join(" "));
      return { pid: 0 };
    },
  };
}

function appendCost(kilnDir: string, jobId: string, usd: number): void {
  const line = {
    id: "cost-1",
    ts: new Date().toISOString(),
    job_id: jobId,
    run_id: "run-cost",
    event: "run.finished",
    step: null,
    properties: { status: "ok", tokens: 3, usd, once: "run.finished" },
  };
  writeFileSync(join(kilnDir, "events.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
}

function runCli(args: string[], cwd: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}
