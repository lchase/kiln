import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { appendInvestigationFindings, writeFindings } from "../src/findings.js";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const keep: string[] = [];
const testCommand = "node --test test.mjs";

/**
 * Scripted mock findings for a public sample checkout. No company names,
 * hosts, or private paths. The behavior test stores this text at
 * `<kilnDir>/findings/<jobId>.md`.
 */
const SAMPLE_FINDINGS = [
  "# Findings: Probe the unconfirmed platform facts",
  "",
  "## Questions",
  "",
  "- Which test runner does the sample app use?",
  "- Is there already a list view in the sample app?",
  "",
  "## Answers",
  "",
  "### Which test runner does the sample app use?",
  "",
  "The sample app uses node:test.",
  "",
  "Evidence:",
  "",
  "File: test.mjs",
  "Command: `node --test test.mjs`",
  "Output: the file registers one test named checkout.",
  "",
  "### Is there already a list view in the sample app?",
  "",
  "No list view is in this checkout.",
  "",
  "Evidence:",
  "",
  "File: test.mjs",
  "Command: `rg -n \"list view\" --glob '!node_modules'`",
  "Output: no matches. The checkout only contains test.mjs.",
  "",
  "## Unconfirmed",
  "",
  "- Whether a later ticket should add a list view or only the empty-state sentence.",
  "",
  "## Implications for dependent tickets",
  "",
  "A ticket that renders an empty state can add that view. It should not assume a list component already exists. It should keep node:test.",
  "",
].join("\n");

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function runCli(
  args: string[],
  options: { cwd: string; home: string; env?: Record<string, string> },
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home, ...options.env };
  delete env.KILN_HOME;
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function waitForStatus(
  cwd: string,
  home: string,
  jobId: string,
  pattern: RegExp,
  env: Record<string, string>,
): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 60_000) {
    const status = runCli(["status", jobId], { cwd, home, env });
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

function writeFeatureFixtures(checkout: string): void {
  writeFileSync(
    join(checkout, "test.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('checkout', () => { assert.equal(true, true); });",
      "",
    ].join("\n"),
  );
  const feature = join(checkout, "test", "fixtures", "kiln-feature");
  mkdirSync(feature, { recursive: true });
  writeFileSync(
    join(feature, "spec.json"),
    `${JSON.stringify([{ output: { goal: "Show the empty state.", design: "Add the sentence.", acceptance: "The job's checks pass." } }])}\n`,
  );
  writeFileSync(
    join(feature, "build.json"),
    `${JSON.stringify([{ output: { summary: "Mock build.", status: "READY" } }])}\n`,
  );
  for (const step of ["security", "ux", "ui", "code"]) {
    writeFileSync(
      join(feature, `${step}.json`),
      `${JSON.stringify([{ output: { verdict: "PASS", findings: "No must-fix findings." } }])}\n`,
    );
  }
  writeFileSync(
    join(feature, "approver.json"),
    `${JSON.stringify([{ output: { decision: "APPROVE", reason: "Reviews passed." } }])}\n`,
  );
  const investigation = join(checkout, "test", "fixtures", "kiln-investigation");
  mkdirSync(investigation, { recursive: true });
  writeFileSync(
    join(investigation, "explore.json"),
    `${JSON.stringify([{ output: { markdown: SAMPLE_FINDINGS } }])}\n`,
  );
}

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
  writeFeatureFixtures(checkout);
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "initial"]);
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-q", "-u", "origin", "main"]);
  git(checkout, ["remote", "set-head", "origin", "main"]);
  return { checkout, origin };
}

function ghStub(dir: string, logPath: string): { bin: string; env: Record<string, string> } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "gh");
  writeFileSync(
    script,
    ["#!/bin/sh", 'printf "%s\\n" "$*" >> "$GH_LOG"', 'echo "gh should not be called" >&2', "exit 1", ""].join("\n"),
  );
  spawnSync("chmod", ["+x", script]);
  return {
    bin,
    env: {
      GH_LOG: logPath,
      KILN_GH: script,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function useMock(home: string): void {
  const path = join(home, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = 2;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

interface Boot {
  cwd: string;
  home: string;
  checkout: string;
  origin: string;
  env: Record<string, string>;
  ghLog: string;
}

function boot(): Boot {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-investigation-"));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  const { checkout, origin } = initOrigin(join(cwd, "repos"));
  const ghLog = join(cwd, "gh.log");
  writeFileSync(ghLog, "");
  const stub = ghStub(cwd, ghLog);
  const added = runCli(
    ["repo", "add", "web", checkout, "--test", testCommand, "--deliver", "pr", "--base", "main"],
    { cwd, home, env: stub.env },
  );
  assert.equal(added.status, 0, added.stderr);
  useMock(home);
  return { cwd, home, checkout, origin, env: stub.env, ghLog };
}

function writeTickets(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const probeAndFollow: Record<string, string> = {
  "01-probe-platform.md": [
    "# 01: Probe the unconfirmed platform facts",
    "",
    "**What to build:** This is a spike. No product code. Which test runner does the sample app use? Is there already a list view?",
    "",
    "**Blocked by:**",
    "None — can start immediately",
    "",
  ].join("\n"),
  "02-render-empty-state.md": [
    "# 02: Render the empty state",
    "",
    "**What to build:** When the list is empty, show a sentence. Use the answers from the probe.",
    "",
    "**Blocked by:**",
    "- 01: Probe the unconfirmed platform facts",
    "",
  ].join("\n"),
};

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("findings file", () => {
  it("writes the markdown once and appends investigation sections for yak", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-findings-"));
    keep.push(dir);
    assert.throws(() => writeFindings(dir, "j1", "# Findings\n\n## Questions\n\n- Q\n"), /Unconfirmed/);
    const path = writeFindings(dir, "j1", SAMPLE_FINDINGS);
    assert.equal(readFileSync(path, "utf8"), SAMPLE_FINDINGS);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, past, past);
    assert.equal(writeFindings(dir, "j1", SAMPLE_FINDINGS), path);
    assert.ok(statSync(path).mtimeMs < Date.parse("2021-01-01T00:00:00Z"));

    const spec = "# 02: Render the empty state\n\nWhen the list is empty, show a sentence.\n";
    const handed = appendInvestigationFindings(spec, [
      { title: "01: Probe the unconfirmed platform facts", markdown: SAMPLE_FINDINGS },
      { title: "Second probe", markdown: "## Questions\n\n- Other?\n\n## Answers\n\nNo.\n\n## Unconfirmed\n\nNone.\n\n## Implications for dependent tickets\n\nStop.\n" },
    ]);
    assert.equal(appendInvestigationFindings(spec, []), spec);
    assert.match(handed, /## Findings from 01: Probe the unconfirmed platform facts\n\n# Findings: Probe/);
    assert.match(handed, /## Findings from Second probe\n\n## Questions/);
    assert.ok(handed.indexOf("01: Probe") < handed.indexOf("Second probe"));
    assert.doesNotMatch(spec, /## Findings from/);
  });
});

describe("investigation run", { concurrency: 1 }, () => {
  it("approves a spike, stores findings, and hands them to the next job without a pull request", { timeout: 120_000 }, () => {
    const { cwd, home, checkout, origin, env, ghLog } = boot();
    const dir = join(cwd, "tickets");
    writeTickets(dir, probeAndFollow);
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home, env });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stderr, "");
    assert.match(imported.stdout, /01: Probe the unconfirmed platform facts\s+investigation/);
    assert.match(imported.stdout, /02: Render the empty state\s+feature/);

    const jobsDir = join(home, ".kiln", "jobs");
    const jobs = readdirSync(jobsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(jobsDir, name), "utf8")) as {
        id: string;
        workflow: string;
        title: string;
        spec: string;
        dependsOn?: string[];
      });
    const probe = jobs.find((job) => job.workflow === "investigation");
    const follow = jobs.find((job) => job.workflow === "feature");
    assert.ok(probe && follow);
    assert.deepEqual(follow.dependsOn, [probe.id]);

    const launched = runCli(["tick"], { cwd, home, env });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, new RegExp(`launch ${probe.id}\\s+web`));
    assert.doesNotMatch(launched.stdout, new RegExp(`launch ${follow.id}`));
    const gated = waitForStatus(cwd, home, probe.id, new RegExp(`${probe.id}\\s+web\\s+investigation\\s+needs-human`), env);
    assert.match(gated, /Approve findings for "01: Probe the unconfirmed platform facts"/);
    const probeRun = runIdOf(gated, probe.id);
    assert.equal(readFileSync(ghLog, "utf8"), "");
    assert.doesNotMatch(git(origin, ["show-ref"]), /yak\//);

    const approved = runCli(["approve", probe.id], { cwd, home, env });
    assert.equal(approved.status, 0, `${approved.stdout}\n${approved.stderr}`);
    assert.match(approved.stdout, /finished: ok/);
    const done = runCli(["status"], { cwd, home, env });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, new RegExp(`${probe.id}\\s+web\\s+investigation\\s+done`));
    assert.match(done.stdout, new RegExp(`${follow.id}\\s+web\\s+feature\\s+queued`));
    assert.doesNotMatch(done.stdout, /in-review/);
    assert.doesNotMatch(done.stdout, /pull\//);
    const findingsPath = join(home, ".kiln", "findings", `${probe.id}.md`);
    assert.match(done.stdout, new RegExp(`findings ${findingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(readFileSync(findingsPath, "utf8"), SAMPLE_FINDINGS);
    const storedFollow = readFileSync(join(home, ".kiln", follow.spec), "utf8");
    assert.match(storedFollow, /When the list is empty/);
    assert.doesNotMatch(storedFollow, /## Findings from/);
    const writtenAt = statSync(findingsPath).mtimeMs;

    const main = git(checkout, ["rev-parse", "main"]).trim();
    assert.equal(git(checkout, ["rev-parse", `yak/${probeRun}`]).trim(), main);
    assert.equal(existsSync(join(home, ".kiln", "deliveries", `${probe.id}.json`)), false);

    const next = runCli(["tick"], { cwd, home, env });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`launch ${follow.id}\\s+web`));
    assert.equal(statSync(findingsPath).mtimeMs, writtenAt);
    assert.equal(readFileSync(findingsPath, "utf8"), SAMPLE_FINDINGS);
    const followStatus = waitForStatus(
      cwd,
      home,
      follow.id,
      new RegExp(`${follow.id}\\s+web\\s+feature\\s+needs-human`),
      env,
    );
    const followRun = runIdOf(followStatus, follow.id);
    const input = JSON.parse(
      readFileSync(join(checkout, ".runs", followRun, "artifacts", "input.json"), "utf8"),
    ) as { description?: string; acceptance?: string };
    assert.match(input.description ?? "", /When the list is empty, show a sentence/);
    assert.match(input.description ?? "", /## Findings from 01: Probe the unconfirmed platform facts/);
    assert.match(input.description ?? "", /The sample app uses node:test/);
    assert.match(input.description ?? "", /File: test\.mjs/);
    assert.match(input.acceptance ?? "", /## Findings from 01: Probe the unconfirmed platform facts/);
    assert.doesNotMatch(readFileSync(join(home, ".kiln", follow.spec), "utf8"), /## Findings from/);

    const idle = runCli(["tick"], { cwd, home, env });
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stdout, /nothing to launch/);
    assert.equal(readFileSync(ghLog, "utf8"), "");
    assert.doesNotMatch(git(origin, ["show-ref"]), /yak\//);
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]).trim(), main);
  });

  it("rejects an investigation without findings and leaves the dependent blocked", { timeout: 90_000 }, () => {
    const { cwd, home, origin, env, ghLog } = boot();
    const dir = join(cwd, "tickets");
    writeTickets(dir, probeAndFollow);
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home, env });
    assert.equal(imported.status, 0, imported.stderr);
    const jobs = readdirSync(join(home, ".kiln", "jobs"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(home, ".kiln", "jobs", name), "utf8")) as {
        id: string;
        workflow: string;
      });
    const probe = jobs.find((job) => job.workflow === "investigation");
    const follow = jobs.find((job) => job.workflow === "feature");
    assert.ok(probe && follow);
    assert.equal(runCli(["tick"], { cwd, home, env }).status, 0);
    waitForStatus(cwd, home, probe.id, /needs-human/, env);
    const rejected = runCli(["reject", probe.id], { cwd, home, env });
    assert.equal(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    const status = runCli(["status"], { cwd, home, env });
    assert.match(status.stdout, new RegExp(`${probe.id}\\s+web\\s+investigation\\s+rejected`));
    assert.match(status.stdout, new RegExp(`${follow.id}\\s+web\\s+feature\\s+blocked`));
    assert.doesNotMatch(status.stdout, /findings /);
    assert.equal(existsSync(join(home, ".kiln", "findings")), false);
    const next = runCli(["tick"], { cwd, home, env });
    assert.match(next.stdout, /nothing to launch/);
    assert.equal(readFileSync(ghLog, "utf8"), "");
    assert.doesNotMatch(git(origin, ["show-ref"]), /yak\//);
  });

  it("refuses to stack onto an investigation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-stack-"));
    keep.push(cwd);
    const home = join(cwd, "home");
    mkdirSync(home);
    const web = join(cwd, "web");
    mkdirSync(web);
    assert.equal(runCli(["repo", "add", "web", web, "--test", "npm test"], { cwd, home }).status, 0);
    const spec = join(cwd, "probe.md");
    writeFileSync(spec, "# Probe the unconfirmed platform facts\n\nNo product code. Which runner is installed?\n");
    const created = runCli(
      ["add", "investigation", "--repo", "web", "--spec", spec, "--title", "Probe the unconfirmed platform facts"],
      { cwd, home },
    );
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(id);
    const follow = join(cwd, "follow.md");
    writeFileSync(follow, "# Render the empty state\n\nShow a sentence.\n");
    const stacked = runCli(
      ["add", "feature", "--repo", "web", "--spec", follow, "--title", "Render the empty state", "--after", id, "--stack"],
      { cwd, home },
    );
    assert.equal(stacked.status, 1);
    assert.match(stacked.stderr, new RegExp(`stack cannot target investigation job ${id}`));
    assert.match(stacked.stderr, /does not land a branch/);
    const names = readdirSync(join(home, ".kiln", "jobs")).filter((name) => name.endsWith(".json"));
    assert.deepEqual(names, [`${id}.json`]);

    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "01-note-the-runner.md": [
        "# 01: Note the runner",
        "",
        "**What to build:** Record the test runner name in the empty-state notes.",
        "",
        "**Blocked by:**",
        "- 02: Probe the unconfirmed platform facts",
        "",
      ].join("\n"),
      "02-probe-platform.md": [
        "# 02: Probe the unconfirmed platform facts",
        "",
        "**What to build:** No product code. Which test runner does the sample app use?",
        "",
        "**Blocked by:**",
        "- 01: Note the runner",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web", "--stack"], { cwd, home });
    assert.equal(imported.status, 1);
    assert.match(imported.stderr, /01-note-the-runner\.md/);
    assert.match(imported.stderr, /02-probe-platform\.md/);
    assert.match(imported.stderr, /does not land a branch/);
    assert.deepEqual(
      readdirSync(join(home, ".kiln", "jobs")).filter((name) => name.endsWith(".json")),
      [`${id}.json`],
    );
  });
});
