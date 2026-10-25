import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const keep: string[] = [];
const testCommand = "node --test test.mjs && printf '%s\\n' landed > kiln-landed.txt";

interface StoredJob {
  id: string;
  repo: string;
  workflow: string;
  spec: string;
  title: string;
  dependsOn?: string[];
  source: { kind: string; ref: string };
  createdAt: string;
  state?: unknown;
}

function runCli(
  args: string[],
  options: { cwd: string; home: string; input?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, HOME: options.home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempWork(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-intake-"));
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

function useMock(cwd: string): void {
  const path = join(cwd, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = 2;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function register(cwd: string, home: string, checkout: string): void {
  const added = runCli(["repo", "add", "web", checkout, "--test", testCommand], { cwd, home });
  assert.equal(added.status, 0, added.stderr);
}

function readJobs(cwd: string): StoredJob[] {
  const dir = join(cwd, ".kiln", "jobs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as StoredJob);
}

function writeTickets(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function waitForStatus(cwd: string, home: string, jobId: string, pattern: RegExp): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 30000) {
    const status = runCli(["status", jobId], { cwd, home });
    last = `${status.stdout}${status.stderr}`;
    if (status.status === 0 && pattern.test(status.stdout)) return status.stdout;
    sleep(0.1);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${last}`);
}

function runIds(checkout: string): string[] {
  const dir = join(checkout, ".runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "journal.jsonl"))).sort();
}

const fourTickets: Record<string, string> = {
  "01-probe-platform.md": [
    "# 01: Probe the unconfirmed platform facts",
    "",
    "**What to build:** Check which libraries the sample app already uses and write the answers down.",
    "",
    "**Blocked by:**",
    "None — can start immediately",
    "",
  ].join("\n"),
  "02-draft-empty-copy.md": [
    "# 02: Draft the empty-state copy",
    "",
    "**What to build:** Write the sentence the page shows when the list is empty.",
    "",
    "**Blocked by:**",
    "None — can start immediately",
    "",
  ].join("\n"),
  "03-render-empty-state.md": [
    "# 03: Render the empty state",
    "",
    "**What to build:** When the list is empty, show the drafted sentence.",
    "",
    "**Blocked by:**",
    "- 01: Probe the unconfirmed platform facts",
    "",
  ].join("\n"),
  "04-link-summary.md": [
    "# 04: Link the summary to the empty state",
    "",
    "**What to build:** Point the summary page at the empty state when there is nothing to list.",
    "",
    "**Blocked by:**",
    "- 01: Probe the unconfirmed platform facts",
    "- 02: Draft the empty-state copy",
    "",
  ].join("\n"),
  "README.md": "Notes that are not tickets.\n",
};

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("intake", () => {
  it("prints prompt and import in usage", () => {
    const { cwd, home } = tempWork();
    const result = runCli([], { cwd, home });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--prompt/);
    assert.match(result.stderr, /kiln import <dir>/);
  });

  it("records a file spec as source kind file", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const spec = join(cwd, "sunday.md");
    writeFileSync(spec, "# Show the summary\n\nA person can read it.\n");
    const created = runCli(["add", "feature", "--repo", "web", "--spec", spec], { cwd, home });
    assert.equal(created.status, 0, created.stderr);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    assert.equal(job.source.kind, "file");
    assert.equal(job.source.ref, spec);
    assert.equal(job.title, "Show the summary");
    assert.equal(readFileSync(join(cwd, ".kiln", job.spec), "utf8"), readFileSync(spec, "utf8"));
    const status = runCli(["status", job.id], { cwd, home });
    assert.match(status.stdout, new RegExp(`source file ${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("rejects add when spec and prompt are both set or both missing", () => {
    const { cwd, home } = tempWork();
    const both = runCli(["add", "feature", "--repo", "web", "--spec", "a.md", "--prompt", "text"], { cwd, home });
    assert.equal(both.status, 2);
    const neither = runCli(["add", "feature", "--repo", "web"], { cwd, home });
    assert.equal(neither.status, 2);
  });

  it("stores a stdin prompt as the spec and titles it from the first line", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const text = "First line of the prompt\n\nMore detail for the sample page.\n";
    const created = runCli(["add", "feature", "--repo", "web", "--prompt", "-"], { cwd, home, input: text });
    assert.equal(created.status, 0, created.stderr);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    assert.equal(job.title, "First line of the prompt");
    assert.equal(job.source.kind, "prompt");
    assert.equal(job.source.ref, "stdin");
    assert.equal(readFileSync(join(cwd, ".kiln", job.spec), "utf8"), text);
    const status = runCli(["status"], { cwd, home });
    assert.match(status.stdout, /source prompt stdin/);
  });

  it("truncates a long prompt title", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const line = "A".repeat(90);
    const created = runCli(["add", "feature", "--repo", "web", "--prompt", `${line}\nsecond line`], { cwd, home });
    assert.equal(created.status, 0, created.stderr);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    assert.equal(job.title, `${"A".repeat(77)}...`);
    assert.equal(job.title.length, 80);
    assert.equal(job.source.ref, "inline");
  });

  it("imports four tickets with dependencies, and a second import changes nothing", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, fourTickets);

    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stderr, /01-probe-platform\.md/);
    assert.match(imported.stderr, /using feature/);
    assert.doesNotMatch(imported.stderr, /02-draft-empty-copy\.md/);
    assert.doesNotMatch(imported.stderr, /03-render-empty-state\.md/);
    assert.doesNotMatch(imported.stderr, /04-link-summary\.md/);
    assert.match(imported.stdout, /imported 4 new, 0 unchanged/);
    const jobs = readJobs(cwd);
    assert.equal(jobs.length, 4);
    const byFile = new Map(jobs.map((job) => [job.source?.ref.slice(job.source.ref.lastIndexOf("/") + 1), job]));
    const first = byFile.get("01-probe-platform.md");
    const second = byFile.get("02-draft-empty-copy.md");
    const third = byFile.get("03-render-empty-state.md");
    const fourth = byFile.get("04-link-summary.md");
    assert.ok(first && second && third && fourth);
    for (const job of [first, second, third, fourth]) {
      assert.equal(job.workflow, "feature");
      assert.equal(job.repo, "web");
      assert.equal(job.source.kind, "tickets");
      assert.equal(job.state, undefined);
    }
    assert.equal(first.dependsOn, undefined);
    assert.equal(second.dependsOn, undefined);
    assert.deepEqual(third.dependsOn, [first.id]);
    assert.deepEqual(fourth.dependsOn, [first.id, second.id]);
    assert.ok(first.createdAt < second.createdAt);
    assert.ok(second.createdAt < third.createdAt);
    assert.ok(third.createdAt < fourth.createdAt);
    assert.match(imported.stdout, /03\s+03: Render the empty state\s+feature\s+deps 01/);
    assert.match(imported.stdout, /04\s+04: Link the summary to the empty state\s+feature\s+deps 01, 02/);

    const before = snapshotKiln(cwd);
    const again = runCli(["import", "tickets", "--repo", "web"], { cwd, home });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /imported 0 new, 4 unchanged/);
    assert.match(again.stdout, /unchanged/);
    assert.equal(readJobs(cwd).length, 4);
    assert.deepEqual(snapshotKiln(cwd), before);
  });

  it("errors on an unknown blocked-by number and writes no jobs", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "03-render-empty-state.md": [
        "# 03: Render the empty state",
        "",
        "**What to build:** Show the empty sentence.",
        "",
        "**Blocked by:**",
        "- 09: Missing ticket",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 1);
    assert.match(imported.stderr, /03-render-empty-state\.md/);
    assert.match(imported.stderr, /unknown ticket 09/);
    assert.equal(existsSync(join(cwd, ".kiln", "jobs")), false);
    assert.equal(existsSync(join(cwd, ".kiln", "specs")), false);
  });

  it("dry-run prints dependencies and creates nothing", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, fourTickets);
    const dry = runCli(["import", dir, "--repo", "web", "--dry-run"], { cwd, home });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /01\s+01: Probe the unconfirmed platform facts\s+feature\s+deps none\s+new/);
    assert.match(dry.stdout, /03\s+03: Render the empty state\s+feature\s+deps 01\s+new/);
    assert.match(dry.stdout, /04\s+04: Link the summary to the empty state\s+feature\s+deps 01, 02\s+new/);
    assert.match(dry.stdout, /dry-run: 4 new, 0 unchanged, created nothing/);
    assert.equal(existsSync(join(cwd, ".kiln", "jobs")), false);
    assert.equal(existsSync(join(cwd, ".kiln", "specs")), false);
  });

  it("parses a front-matter ticket", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "01-list-facts.md": [
        "# 01: List the platform facts",
        "",
        "**What to build:** Name the two libraries the sample app uses.",
        "",
        "**Blocked by:**",
        "None — can start immediately",
        "",
      ].join("\n"),
      "02-record-answers.md": [
        "---",
        "title: Record the platform answers",
        "type: task",
        "blocked-by:",
        '  - "01"',
        "---",
        "",
        "Write the two answers into the notes file.",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);
    const jobs = readJobs(cwd);
    assert.equal(jobs.length, 2);
    const list = jobs.find((job) => job.source?.ref.endsWith("01-list-facts.md"));
    const record = jobs.find((job) => job.source?.ref.endsWith("02-record-answers.md"));
    assert.ok(list && record);
    assert.equal(record.title, "Record the platform answers");
    assert.equal(record.workflow, "feature");
    assert.deepEqual(record.dependsOn, [list.id]);
    assert.match(imported.stdout, /02\s+Record the platform answers\s+feature\s+deps 01/);
  });

  it("uses feature and warns when a spike ticket has no investigation workflow", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "01-time-the-query.md": [
        "# 01: Time the list query",
        "",
        "**What to build:** This is a spike. No product code. Measure the query and write the number down.",
        "",
        "**Blocked by:**",
        "None — can start immediately",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stderr, /01-time-the-query\.md/);
    assert.match(imported.stderr, /investigation\.yaml is missing, using feature/);
    assert.doesNotMatch(imported.stdout, /warning:/);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    assert.equal(job.workflow, "feature");
  });

  it("keeps a ticket on the requested workflow when the body only mentions an upstream spike", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "01-list-facts.md": [
        "# 01: List the platform facts",
        "",
        "**What to build:** Name the two libraries the sample app uses.",
        "",
        "**Blocked by:**",
        "None — can start immediately",
        "",
      ].join("\n"),
      "02-render-empty-state.md": [
        "# 02: Render the empty state",
        "",
        "**What to build:** Use the findings from the 01 spike. Blocked by: 01 spike.",
        "",
        "**Blocked by:**",
        "- 01: List the platform facts",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web", "--workflow", "feature"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stderr, "");
    const jobs = readJobs(cwd);
    assert.equal(jobs.length, 2);
    for (const job of jobs) assert.equal(job.workflow, "feature");
    const follow = jobs.find((job) => job.source?.ref.endsWith("02-render-empty-state.md"));
    assert.ok(follow);
    assert.equal(follow.workflow, "feature");
    assert.doesNotMatch(imported.stdout, /investigation/);
  });

  it("treats front matter type wayfinder:research as a spike", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "01-measure-the-query.md": [
        "---",
        "title: Measure the list query",
        "type: wayfinder:research",
        "---",
        "",
        "Time the query and write the number down.",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stderr, /01-measure-the-query\.md/);
    assert.match(imported.stderr, /using feature/);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    assert.equal(job.workflow, "feature");
    assert.equal(job.title, "Measure the list query");
  });

  it("attaches parent spec.md as Background, and references a large context by path", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    register(cwd, home, web);
    writeFileSync(join(cwd, "spec.md"), "The sample list has a weekly paragraph.\n");
    const dir = join(cwd, "tickets");
    writeTickets(dir, {
      "01-list-facts.md": [
        "# 01: List the platform facts",
        "",
        "**What to build:** Name the two libraries.",
        "",
        "**Blocked by:**",
        "None — can start immediately",
        "",
      ].join("\n"),
    });
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    const spec = readFileSync(join(cwd, ".kiln", job.spec), "utf8");
    assert.match(spec, /# 01: List the platform facts/);
    assert.match(spec, /## Background\n\nThe sample list has a weekly paragraph\./);

    const other = tempWork();
    const otherWeb = join(other.cwd, "web");
    mkdirSync(otherWeb);
    register(other.cwd, other.home, otherWeb);
    const huge = join(other.cwd, "huge.md");
    writeFileSync(huge, "y".repeat(40 * 1024 + 1));
    const otherDir = join(other.cwd, "tickets");
    writeTickets(otherDir, {
      "01-list-facts.md": [
        "# 01: List the platform facts",
        "",
        "**What to build:** Name the two libraries.",
        "",
        "**Blocked by:**",
        "None — can start immediately",
        "",
      ].join("\n"),
    });
    const large = runCli(["import", otherDir, "--repo", "web", "--context", huge], other);
    assert.equal(large.status, 0, large.stderr);
    const largeJob = readJobs(other.cwd)[0];
    assert.ok(largeJob);
    const largeSpec = readFileSync(join(other.cwd, ".kiln", largeJob.spec), "utf8");
    assert.match(largeSpec, /## Background/);
    assert.match(largeSpec, /referenced by path/);
    assert.ok(largeSpec.includes(huge));
    assert.equal(largeSpec.includes("y".repeat(200)), false);
  });

  it("keeps tick, reconcile, and status off the intake adapters", () => {
    for (const name of ["driver.ts", "reconcile.ts", "report.ts"]) {
      const text = readFileSync(join(root, "src", name), "utf8");
      assert.doesNotMatch(text, /from ["'][^"']*intake\//);
      assert.doesNotMatch(text, /kind === ["'](?:file|prompt|tickets|jira)["']/);
    }
  });
});

describe("intake tick", { concurrency: 1 }, () => {
  it("creates a runnable job from a prompt", { timeout: 60_000 }, () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    register(cwd, home, web);
    useMock(cwd);
    const prompt = "Show a quiet empty state\n\nThe page explains there is nothing to list yet.\n";
    const created = runCli(["add", "feature", "--repo", "web", "--prompt", prompt], { cwd, home });
    assert.equal(created.status, 0, created.stderr);
    const job = readJobs(cwd)[0];
    assert.ok(job);
    assert.equal(job.title, "Show a quiet empty state");
    assert.equal(job.source.kind, "prompt");
    assert.equal(job.source.ref, "inline");
    assert.equal(readFileSync(join(cwd, ".kiln", job.spec), "utf8"), prompt);

    const launched = runCli(["tick"], { cwd, home });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, new RegExp(`launch ${job.id}\\s+web`));
    const status = waitForStatus(cwd, home, job.id, new RegExp(`${job.id}\\s+web\\s+feature\\s+needs-human`));
    assert.match(status, /source prompt inline/);
    assert.equal(runIds(web).length, 1);
  });

  it("ticks a job file that has no source and lets it satisfy a dependency", { timeout: 60_000 }, () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    register(cwd, home, web);
    useMock(cwd);

    const id = "j-old-job";
    const jobsDir = join(cwd, ".kiln", "jobs");
    const specsDir = join(cwd, ".kiln", "specs");
    mkdirSync(jobsDir, { recursive: true });
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, `${id}.md`), "# Show the weekly summary\n\nA person can read it.\n");
    const jobFile = join(jobsDir, `${id}.json`);
    writeFileSync(
      jobFile,
      `${JSON.stringify(
        {
          id,
          repo: "web",
          workflow: "feature",
          spec: `specs/${id}.md`,
          title: "Show the weekly summary",
          createdAt: "2026-10-24T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const spec = join(cwd, "follow.md");
    writeFileSync(spec, "# Link the summary\n\nPoint at the weekly summary.\n");
    const created = runCli(
      ["add", "feature", "--repo", "web", "--spec", spec, "--title", "Link the summary", "--after", id],
      { cwd, home },
    );
    assert.equal(created.status, 0, created.stderr);
    const follow = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(follow);

    const listed = runCli(["status"], { cwd, home });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`${id}\\s+web\\s+feature\\s+queued`));
    assert.match(listed.stdout, new RegExp(`${follow}\\s+web\\s+feature\\s+blocked`));
    assert.doesNotMatch(listed.stdout, /invalid/);
    assert.doesNotMatch(listed.stdout, new RegExp(`blocked on missing job ${id}`));
    const oldStatus = runCli(["status", id], { cwd, home });
    assert.equal(oldStatus.status, 0, oldStatus.stderr);
    assert.doesNotMatch(oldStatus.stdout, /source /);

    const launched = runCli(["tick"], { cwd, home });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, new RegExp(`launch ${id}\\s+web`));
    assert.doesNotMatch(launched.stdout, new RegExp(`launch ${follow}`));
    waitForStatus(cwd, home, id, new RegExp(`${id}\\s+web\\s+feature\\s+needs-human`));

    const answered = runCli(["approve", id], { cwd, home });
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    const ready = runCli(["status", follow], { cwd, home });
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, new RegExp(`${follow}\\s+web\\s+feature\\s+queued`));

    const next = runCli(["tick"], { cwd, home });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`launch ${follow}\\s+web`));
    const stored = JSON.parse(readFileSync(jobFile, "utf8")) as { source?: unknown };
    assert.equal(stored.source, undefined);
  });

  it("tick launches only the tickets that are not blocked", { timeout: 60_000 }, () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    register(cwd, home, web);
    useMock(cwd);
    const dir = join(cwd, "tickets");
    writeTickets(dir, fourTickets);
    const imported = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(imported.status, 0, imported.stderr);

    const jobs = readJobs(cwd);
    const byFile = new Map(jobs.map((job) => [job.source?.ref.slice(job.source.ref.lastIndexOf("/") + 1), job]));
    const first = byFile.get("01-probe-platform.md");
    const second = byFile.get("02-draft-empty-copy.md");
    const third = byFile.get("03-render-empty-state.md");
    const fourth = byFile.get("04-link-summary.md");
    assert.ok(first && second && third && fourth);
    assert.deepEqual(third.dependsOn, [first.id]);
    assert.deepEqual(fourth.dependsOn, [first.id, second.id]);

    const tick1 = runCli(["tick"], { cwd, home });
    assert.equal(tick1.status, 0, tick1.stderr);
    assert.match(tick1.stdout, new RegExp(`launch ${first.id}\\s+web`));
    assert.doesNotMatch(tick1.stdout, new RegExp(`launch ${second.id}`));
    assert.doesNotMatch(tick1.stdout, new RegExp(`launch ${third.id}`));
    assert.doesNotMatch(tick1.stdout, new RegExp(`launch ${fourth.id}`));

    const tick2 = runCli(["tick"], { cwd, home });
    assert.equal(tick2.status, 0, tick2.stderr);
    assert.match(tick2.stdout, new RegExp(`launch ${second.id}\\s+web`));
    assert.doesNotMatch(tick2.stdout, new RegExp(`launch ${third.id}`));
    assert.doesNotMatch(tick2.stdout, new RegExp(`launch ${fourth.id}`));

    const tick3 = runCli(["tick"], { cwd, home });
    assert.equal(tick3.status, 0, tick3.stderr);
    assert.match(tick3.stdout, /nothing to launch/);
    assert.doesNotMatch(tick3.stdout, new RegExp(`launch ${third.id}`));
    assert.doesNotMatch(tick3.stdout, new RegExp(`launch ${fourth.id}`));

    waitForStatus(cwd, home, first.id, new RegExp(`${first.id}\\s+web\\s+feature\\s+needs-human`));
    waitForStatus(cwd, home, second.id, new RegExp(`${second.id}\\s+web\\s+feature\\s+needs-human`));
    const blocked = runCli(["status"], { cwd, home });
    assert.match(blocked.stdout, new RegExp(`${third.id}\\s+web\\s+feature\\s+blocked`));
    assert.match(blocked.stdout, new RegExp(`${fourth.id}\\s+web\\s+feature\\s+blocked`));
    assert.equal(runIds(web).length, 2);

    const before = snapshotKiln(cwd);
    const again = runCli(["import", dir, "--repo", "web"], { cwd, home });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /imported 0 new, 4 unchanged/);
    assert.deepEqual(snapshotKiln(cwd), before);
  });
});

function snapshotKiln(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const folder of ["jobs", "specs"]) {
    const dir = join(cwd, ".kiln", folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      out[`${folder}/${name}`] = readFileSync(path, "utf8");
    }
  }
  return out;
}
