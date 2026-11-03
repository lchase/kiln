import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { loadKilnConfig } from "../src/config.js";
import { pullRequestBody } from "../src/delivery.js";
import { evidenceSection } from "../src/evidence.js";
import { appendEvent, eventsPath, readEvents, type KilnEvent } from "../src/events.js";
import { ledgerRows, parseSince, renderLedger } from "../src/ledger.js";
import { packageRoot } from "../src/paths.js";
import { projectRunJournal, promptsHash } from "../src/project.js";
import { redact } from "../src/redact.js";
import type { KilnHost } from "../src/host.js";
import type { Job } from "../src/schemas.js";
import { writeJob } from "../src/jobs.js";
import { reapLaunches } from "./reap.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const FAKE_GITHUB = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const FAKE_SLACK = "xoxb-1234567890-abcdefghij";
const FAKE_AWS = "AKIAFAKEFAKEFAKEFAKE";
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.signatureX";
const FAKE_NPM = "npm_FAKEFAKEFAKEFAKEFAKEFAKE";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  keep.push(dir);
  return dir;
}

function kilnHome(dir: string): string {
  const home = join(dir, "home");
  const kiln = join(home, ".kiln");
  mkdirSync(join(kiln, "jobs"), { recursive: true });
  const checkout = join(dir, "repo");
  mkdirSync(checkout);
  writeFileSync(
    join(kiln, "kiln.config.json"),
    `${JSON.stringify({ adapter: "mock", repos: { web: { path: checkout, test: "node --test test.mjs" } } }, null, 2)}\n`,
  );
  return kiln;
}

function captureError(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  for (const dir of keep) await reapLaunches(dir);
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("redact", () => {
  it("masks token shapes, auth headers, and secret env values", () => {
    const input = [
      `token ${FAKE_GITHUB}`,
      `slack ${FAKE_SLACK}`,
      `aws ${FAKE_AWS}`,
      `jwt ${FAKE_JWT}`,
      `npm ${FAKE_NPM}`,
      "Authorization: Bearer fake.token.value",
      "X-Api-Key: another-fake-key",
      "export KILN_API_TOKEN=fake-token-value",
      'API_KEY="fake-key-value-123"',
      '{"password":"fake-password-value"}',
      "MY_SECRET=fake-secret-value",
      "plain workflow feature",
    ].join("\n");
    const out = redact(input);
    for (const secret of [FAKE_GITHUB, FAKE_SLACK, FAKE_AWS, FAKE_JWT, FAKE_NPM, "fake-token-value", "fake-key-value-123", "fake-password-value", "fake-secret-value", "fake.token.value", "another-fake-key"]) {
      assert.equal(out.includes(secret), false, secret);
    }
    assert.match(out, /plain workflow feature/);
    assert.match(out, /KILN_API_TOKEN=\[redacted\]/);
    assert.match(out, /Authorization: \[redacted\]/i);
    assert.equal(redact(out), out);
  });
});

describe("event log", () => {
  it("a synthetic run emits the expected sequence once", () => {
    const dir = tempDir("kiln-events-seq-");
    const kiln = kilnHome(dir);
    const config = loadKilnConfig(join(kiln, "kiln.config.json"));
    const { job } = writeJob(config, {
      workflow: "feature",
      repo: "web",
      specText: "# Synthetic\n\nDo the work.\n",
      title: "Synthetic",
      dependsOn: [],
      source: { kind: "prompt", ref: "inline" },
    });
    const runId = "2026-01-01T00-00-00Z-synth";
    const runDir = join(dir, "repo", ".runs", runId);
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    mkdirSync(join(runDir, "pending"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "verify.json"), `${JSON.stringify({ exitCode: 0, stdout: "ok" })}\n`);
    writeFileSync(
      join(runDir, "artifacts", "security.json"),
      `${JSON.stringify({ verdict: "PASS", findings: "clean" })}\n`,
    );
    writeFileSync(join(runDir, "artifacts", "approval.json"), `${JSON.stringify({ decision: "approve" })}\n`);
    writeFileSync(
      join(runDir, "pending", "approve.request.json"),
      `${JSON.stringify({ rendered: "Approve Synthetic?\n" })}\n`,
    );
    const journal = [
      { t: "run.started", runId, workflow: "kiln-feature", tag: `kiln:${job.id}` },
      { t: "step.started", stepId: "spec" },
      { t: "step.completed", stepId: "spec", artifact: "spec", cached: false },
      { t: "step.started", stepId: "verify" },
      { t: "step.completed", stepId: "verify", artifact: "verify", cached: false },
      { t: "step.started", stepId: "security" },
      { t: "step.completed", stepId: "security", artifact: "security", cached: false },
      { t: "gate.opened", stepId: "approve" },
      { t: "gate.answered", stepId: "approve" },
      { t: "run.finished", status: "ok" },
    ];
    const input = {
      kilnDir: kiln,
      jobId: job.id,
      runId,
      runDir,
      workflow: "feature",
      repo: "web",
      testCommand: `KILN_API_TOKEN=${FAKE_GITHUB} node --test test.mjs`,
      events: journal,
    };
    projectRunJournal(input);
    projectRunJournal(input);
    const events = readEvents(kiln);
    assert.deepEqual(
      events.map((event) => event.event),
      [
        "job.added",
        "run.started",
        "phase.started",
        "phase.finished",
        "phase.started",
        "phase.finished",
        "phase.started",
        "phase.finished",
        "gate.opened",
        "gate.resolved",
        "run.finished",
      ],
    );
    const started = events.find((event) => event.event === "run.started");
    assert.ok(started && started.event === "run.started");
    assert.equal(started.run_id, runId);
    assert.equal(started.properties.workflow, "feature");
    assert.match(started.properties.kiln_version, /^\d+\.\d+\.\d+/);
    assert.match(started.properties.yak_version, /^\d+\.\d+\.\d+/);
    assert.match(started.properties.prompts_hash, /^[a-f0-9]{64}$/);
    assert.equal(started.properties.prompts_hash, promptsHash("feature", kiln, job.id));
    const verify = events.find((event) => event.event === "phase.finished" && event.step === "verify");
    assert.ok(verify && verify.event === "phase.finished");
    assert.equal(verify.properties.exit_code, 0);
    assert.match(verify.properties.test_command ?? "", /node --test test\.mjs/);
    const security = events.find((event) => event.event === "phase.finished" && event.step === "security");
    assert.ok(security && security.event === "phase.finished");
    assert.equal(security.properties.verdict, "PASS");
    const gate = events.find((event) => event.event === "gate.resolved");
    assert.ok(gate && gate.event === "gate.resolved");
    assert.equal(gate.properties.decision, "approve");
    assert.equal(gate.properties.by, "human");
    const raw = readFileSync(eventsPath(kiln), "utf8");
    assert.equal(raw.includes(FAKE_GITHUB), false);
    assert.match(raw, /\[redacted\]/);
    for (const event of events) {
      assert.match(event.ts, /Z$/);
      assert.equal(event.step === null || event.step.length > 0, true);
    }
  });

  it("concurrent appends do not interleave lines", async () => {
    const dir = tempDir("kiln-events-race-");
    const kiln = kilnHome(dir);
    const workers = 12;
    const href = new URL("../src/events.js", import.meta.url).href;
    const workerPath = join(dir, "append-worker.mjs");
    writeFileSync(
      workerPath,
      [
        "import { parentPort, workerData } from 'node:worker_threads';",
        `import { appendEvent } from ${JSON.stringify(href)};`,
        "appendEvent(workerData.kilnDir, {",
        "  job_id: 'job-' + workerData.n,",
        "  event: 'job.added',",
        "  properties: { repo: 'web', workflow: 'feature', title: 'Worker ' + workerData.n },",
        "});",
        "parentPort?.postMessage('ok');",
        "",
      ].join("\n"),
    );
    await Promise.all(
      Array.from({ length: workers }, (_, n) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(workerPath, { workerData: { kilnDir: kiln, n } });
          worker.once("message", () => resolve());
          worker.once("error", reject);
        }),
      ),
    );
    const raw = readFileSync(eventsPath(kiln), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, workers);
    assert.equal(raw.endsWith("\n"), true);
    const titles = new Set<string>();
    for (const line of lines) {
      assert.equal(line.includes("}{"), false);
      const parsed = JSON.parse(line) as { properties?: { title?: string } };
      titles.add(parsed.properties?.title ?? "");
    }
    assert.equal(titles.size, workers);
  });

  it("skips a corrupt line and keeps the rest", () => {
    const dir = tempDir("kiln-events-bad-");
    const kiln = kilnHome(dir);
    appendEvent(kiln, {
      job_id: "job-a",
      event: "job.added",
      properties: { repo: "web", workflow: "feature", title: "Before" },
    });
    appendEvent(kiln, {
      job_id: "job-b",
      event: "job.added",
      properties: { repo: "web", workflow: "feature", title: "After" },
    });
    const path = eventsPath(kiln);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines.splice(1, 0, "{\"event\":\"nope\"", "   ");
    writeFileSync(path, `${lines.join("\n")}\n`);
    const warnings: string[] = [];
    const events = readEvents(kiln, { warn: (message) => warnings.push(message) });
    assert.deepEqual(
      events.map((event) => (event.event === "job.added" ? event.properties.title : "")),
      ["Before", "After"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /line 2/);
    assert.equal(warnings[0]?.includes("nope"), false);
  });

  it("reports a log failure and does not throw", () => {
    const dir = tempDir("kiln-events-fail-");
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "x");
    const errors = captureError(() => {
      appendEvent(blocked, {
        job_id: "job-a",
        event: "job.added",
        properties: { repo: "web", workflow: "feature", title: "Nope" },
      });
    });
    assert.match(errors.join("\n"), /event log/);
  });
});

describe("intervention ledger", () => {
  it("counts interventions from a fixture log", () => {
    const dir = tempDir("kiln-events-ledger-");
    const kiln = kilnHome(dir);
    const now = new Date("2026-04-10T00:00:00.000Z");
    const old = "2026-03-01T00:00:00.000Z";
    const recent = "2026-04-09T00:00:00.000Z";
    const stamp = (iso: string): string => iso;
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(old),
      job_id: "job-a",
      event: "job.added",
      properties: { repo: "alpha", workflow: "feature", title: "A", once: "job.added" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(recent),
      job_id: "job-a",
      event: "gate.resolved",
      step: "approve",
      properties: { decision: "reject", by: "human", repo: "alpha", once: "gate.resolved:approve" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(recent),
      job_id: "job-a",
      event: "gate.resolved",
      step: "note",
      properties: { decision: "approve", by: "human", note: "adjusted the copy", once: "gate.resolved:note" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(recent),
      job_id: "job-a",
      event: "job.retried",
      properties: { by: "human", repo: "alpha" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(recent),
      job_id: "job-a",
      event: "needs-human",
      properties: { reason: "feedback-exhausted", once: "needs-human:feedback-exhausted" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(old),
      job_id: "job-b",
      event: "job.added",
      properties: { repo: "beta", workflow: "feature", title: "B", once: "job.added" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(old),
      job_id: "job-b",
      event: "gate.resolved",
      step: "approve",
      properties: { decision: "reject", by: "human", once: "gate.resolved:approve" },
    });
    appendEvent(kiln, {
      id: randomUUID(),
      ts: stamp(recent),
      job_id: "job-b",
      event: "job.retried",
      properties: { by: "human", repo: "beta" },
    });
    const path = eventsPath(kiln);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"not":"an event"\n`);
    const warnings: string[] = [];
    const events = readEvents(kiln, { warn: (message) => warnings.push(message) });
    assert.equal(warnings.length, 1);
    const all = renderLedger(events);
    assert.match(all, /^alpha  4\n {2}job-a  4\n {4}gate rejected  1\n {4}manual edit  1\n {4}re-queued or retried by hand  1\n {4}needs-human \(feedback-exhausted\)  1\nbeta  2\n {2}job-b  2\n {4}gate rejected  1\n {4}re-queued or retried by hand  1\n\n6 interventions\n$/);
    const since = parseSince("7d", now);
    const recentOnly = renderLedger(events, { since });
    assert.match(recentOnly, /alpha  4/);
    assert.match(recentOnly, /beta  1/);
    assert.match(recentOnly, /5 interventions/);
    assert.match(recentOnly, /beta  1\n {2}job-b  1\n {4}re-queued or retried by hand  1/);
    assert.doesNotMatch(recentOnly, /beta[\s\S]*gate rejected/);
    assert.equal(renderLedger(events, { repo: "beta" }).includes("alpha"), false);
    assert.equal(ledgerRows(events, { repo: "missing" }).length, 0);
    assert.equal(renderLedger([]), "0 interventions\n");
  });
});

describe("pull request evidence", () => {
  it("builds a short redacted evidence section", () => {
    const dir = tempDir("kiln-events-evidence-");
    const kiln = kilnHome(dir);
    const events: KilnEvent[] = [];
    const remember = (draft: Parameters<typeof appendEvent>[1]): void => {
      appendEvent(kiln, draft);
    };
    remember({
      job_id: "job-e",
      event: "run.started",
      run_id: "run-e",
      properties: {
        kiln_version: "0.7.0",
        yak_version: "0.8.0",
        workflow: "feature",
        prompts_hash: "a".repeat(64),
        repo: "web",
        once: "run.started",
      },
    });
    remember({
      job_id: "job-e",
      run_id: "run-e",
      event: "phase.started",
      step: "verify",
      properties: { once: "phase.started:1" },
    });
    remember({
      job_id: "job-e",
      run_id: "run-e",
      event: "phase.finished",
      step: "verify",
      properties: {
        outcome: "completed",
        test_command: `KILN_API_TOKEN=${FAKE_GITHUB} node --test`,
        exit_code: 0,
        once: "phase.finished:2",
      },
    });
    remember({
      job_id: "job-e",
      run_id: "run-e",
      event: "phase.finished",
      step: "security",
      properties: { outcome: "completed", verdict: "PASS", once: "phase.finished:3" },
    });
    remember({
      job_id: "job-e",
      run_id: "run-e",
      event: "pr.feedback",
      properties: { round: 1, trigger: "ci", items: 2, outcome: "pushed", once: "pr.feedback:1:pushed" },
    });
    remember({
      job_id: "job-e",
      run_id: "run-e",
      event: "gate.resolved",
      step: "approve",
      properties: { decision: "approve", by: "human", once: "gate.resolved:approve" },
    });
    events.push(...readEvents(kiln));
    const section = evidenceSection(events, "job-e");
    assert.match(section, /^## Evidence\n/);
    assert.match(section, /kiln 0\.7\.0, yak 0\.8\.0, workflow feature, prompts aaaaaaaaaaaa/);
    assert.match(section, /phases: verify, security/);
    assert.match(section, /test: `KILN_API_TOKEN=\[redacted\] node --test` exit 0/);
    assert.match(section, /reviews: security PASS/);
    assert.match(section, /feedback: round 1 ci \(2 items\) pushed/);
    assert.match(section, /gates: approve by human: approve/);
    assert.equal(section.includes(FAKE_GITHUB), false);

    const config = loadKilnConfig(join(kiln, "kiln.config.json"));
    const job = {
      id: "job-e",
      repo: "web",
      workflow: "feature",
      spec: "specs/job-e.md",
      title: "Synthetic",
      source: { kind: "prompt", ref: "inline" },
      createdAt: "2026-04-10T00:00:00.000Z",
    } satisfies Job;
    mkdirSync(join(kiln, "specs"), { recursive: true });
    writeFileSync(join(kiln, "specs", "job-e.md"), "# Synthetic\n\nShip the summary.\n");
    const body = pullRequestBody({
      config,
      job,
      checkout: join(dir, "repo"),
      runId: "run-e",
      baseBranch: "main",
      host: {} as KilnHost,
    });
    assert.match(body, /## Evidence/);
    assert.equal(body.includes(FAKE_GITHUB), false);
  });
});

describe("kiln job events", { concurrency: 1 }, () => {
  it("records a real mock run and the ledger counts a rejected gate", { timeout: 120_000 }, () => {
    const cwd = tempDir("kiln-events-e2e-");
    const home = join(cwd, "home");
    mkdirSync(home);
    const checkout = join(cwd, "repo");
    initCheckout(checkout);
    const added = runCli(["repo", "add", "web", checkout, "--test", "node --test test.mjs"], { cwd, home });
    assert.equal(added.status, 0, added.stderr);
    useMock(home);
    const spec = join(cwd, "spec.md");
    writeFileSync(spec, "# Reject the summary\n\nLeave the checkout as it is.\n");
    const created = runCli(["add", "feature", "--repo", "web", "--spec", spec, "--title", "Reject the summary"], { cwd, home });
    assert.equal(created.status, 0, created.stderr);
    const jobId = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(jobId);
    const launched = runCli(["tick"], { cwd, home });
    assert.equal(launched.status, 0, launched.stderr);
    waitForStatus(cwd, home, jobId, /needs-human/);
    const rejected = runCli(["reject", jobId], { cwd, home });
    assert.equal(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    const status = runCli(["status", jobId], { cwd, home });
    assert.match(status.stdout, new RegExp(`${jobId}\\s+web\\s+feature\\s+rejected`));
    const events = readEvents(join(home, ".kiln"));
    const names = events.map((event) => event.event);
    assert.ok(names.includes("job.added"));
    assert.ok(names.includes("run.started"));
    assert.ok(names.includes("phase.started"));
    assert.ok(names.includes("phase.finished"));
    assert.ok(names.includes("gate.opened"));
    assert.ok(names.includes("gate.resolved"));
    assert.ok(names.includes("run.finished"));
    const started = events.find((event) => event.event === "run.started");
    assert.ok(started && started.event === "run.started");
    assert.equal(started.properties.workflow, "feature");
    assert.match(started.properties.prompts_hash, /^[a-f0-9]{64}$/);
    const verify = events.find((event) => event.event === "phase.finished" && event.step === "verify");
    assert.ok(verify && verify.event === "phase.finished");
    assert.equal(verify.properties.exit_code, 0);
    const gate = events.find((event) => event.event === "gate.resolved");
    assert.ok(gate && gate.event === "gate.resolved");
    assert.equal(gate.properties.decision, "reject");
    const ledger = runCli(["ledger", "--since", "7d", "--repo", "web"], { cwd, home });
    assert.equal(ledger.status, 0, ledger.stderr);
    assert.match(ledger.stdout, /web  1/);
    assert.match(ledger.stdout, new RegExp(jobId));
    assert.match(ledger.stdout, /gate rejected  1/);
    assert.match(ledger.stdout, /1 intervention/);
    const raw = readFileSync(join(home, ".kiln", "events.jsonl"), "utf8");
    assert.equal(/\/home\/|\/agent\/|ghp_|sk-ant-/.test(raw), false);
  });
});

describe("events api", () => {
  it("returns one job and records a config reload", async () => {
    const cwd = tempDir("kiln-events-api-");
    const home = join(cwd, "home");
    mkdirSync(home);
    const checkout = join(cwd, "repo");
    mkdirSync(checkout);
    const added = runCli(["repo", "add", "web", checkout, "--test", "node --test"], { cwd, home });
    assert.equal(added.status, 0, added.stderr);
    const kiln = join(home, ".kiln");
    appendEvent(kiln, {
      job_id: "job-api",
      event: "job.added",
      properties: { repo: "web", workflow: "feature", title: "API" },
    });
    const server = await startServe(cwd, home);
    try {
      const missing = await fetch(`${server.url}/api/events`);
      assert.equal(missing.status, 400);
      const listed = await fetch(`${server.url}/api/events?job_id=job-api`);
      assert.equal(listed.status, 200);
      const body = (await listed.json()) as { job_id: string; events: { event: string }[] };
      assert.equal(body.job_id, "job-api");
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0]?.event, "job.added");
      const configPath = join(kiln, "kiln.config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { maxConcurrent?: number };
      config.maxConcurrent = 4;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const again = await fetch(`${server.url}/api/events?job_id=job-api`);
      assert.equal(again.status, 200);
      const events = readEvents(kiln);
      assert.equal(events.some((event) => event.event === "config.reloaded" && event.job_id === null), true);
    } finally {
      server.child.kill("SIGTERM");
    }
  });
});

function initCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(
    join(dir, "test.mjs"),
    ["import assert from 'node:assert/strict';", "import test from 'node:test';", "test('checkout', () => { assert.equal(true, true); });", ""].join("\n"),
  );
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
  writeFileSync(join(fixtures, "approver.json"), `${JSON.stringify([{ output: { decision: "APPROVE", reason: "Reviews passed." } }])}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function runCli(args: string[], options: { cwd: string; home: string }): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home };
  delete env.KILN_HOME;
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function useMock(home: string): void {
  const path = join(home, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
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

function startServe(cwd: string, home: string): Promise<{ url: string; child: ChildProcess }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", "--port", "0", "--no-tick"], {
    cwd,
    env,
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve did not listen\n${stdout}\n${stderr}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolve({ url: match[1], child });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
