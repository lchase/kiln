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
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { yakCliPath } from "../src/report.js";
import type { Plan } from "../src/schemas.js";

const root = packageRoot();
const keep: string[] = [];
const testCommand = "node --test test.mjs && printf '%s\\n' landed > kiln-landed.txt";

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
      "test('pebble checkout', () => { assert.equal(true, true); });",
      "",
    ].join("\n"),
  );
  const fixtures = join(dir, "test", "fixtures", "kiln-feature");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(
    join(fixtures, "spec.json"),
    `${JSON.stringify([{ output: { goal: "Show the weekly reflection.", design: "Touch the named module.", acceptance: "The task's checks pass." } }])}\n`,
  );
  writeFileSync(
    join(fixtures, "build.json"),
    `${JSON.stringify([{ output: { summary: "Mock build for the Pebble task.", status: "READY" } }])}\n`,
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

function writeConfig(
  kilnDir: string,
  checkouts: { frontend: string; "ai-core": string; "evals-obs": string },
  maxConcurrent: number,
  test = testCommand,
): void {
  mkdirSync(kilnDir, { recursive: true });
  writeFileSync(
    join(kilnDir, "kiln.config.json"),
    JSON.stringify(
      {
        note: "Local Pebble test config. Not a real company.",
        adapter: "mock",
        maxConcurrent,
        repos: {
          frontend: {
            checkout: checkouts.frontend,
            ownership: join(root, "examples", "ownership", "frontend.json"),
            test,
          },
          "ai-core": {
            checkout: checkouts["ai-core"],
            ownership: join(root, "examples", "ownership", "ai-core.json"),
            test,
          },
          "evals-obs": {
            checkout: checkouts["evals-obs"],
            ownership: join(root, "examples", "ownership", "evals-obs.json"),
            test,
          },
        },
      },
      null,
      2,
    ),
  );
}

function writePlan(plansDir: string, plan: Plan): void {
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, `${plan.requirementId}.json`),
    `${JSON.stringify({ kind: "plan", plan }, null, 2)}\n`,
  );
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
  planId: string,
  pattern: RegExp,
  timeoutMs = 30000,
): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const status = runCli(["status", planId], { cwd, home });
    last = `${status.stdout}${status.stderr}`;
    if (status.status === 0 && pattern.test(status.stdout)) return status.stdout;
    sleep(0.1);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${last}`);
}

function runIdOf(status: string, taskId: string): string {
  const match = status.match(new RegExp(`${taskId}\\s+\\S+\\s+\\S+\\s+run (\\S+)`));
  assert.ok(match?.[1], status);
  return match[1];
}

function answerCommand(status: string, choice: "approve" | "reject"): string {
  const command = status.match(new RegExp(`^    answer ${choice}: (.+)$`, "m"))?.[1];
  assert.ok(command, status);
  return command;
}

function pathWithoutLocalBins(): string {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && !entry.includes("node_modules/.bin"))
    .join(":");
}

function runPrinted(command: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: pathWithoutLocalBins() },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertResolvedYak(command: string): void {
  assert.ok(command.includes(process.execPath), command);
  assert.ok(command.includes(yakCliPath()), command);
  assert.doesNotMatch(command, /node_modules\/\.bin/);
}

function deadPid(): number {
  // High unused pid. A killed child stays visible to kill(pid, 0) until reaped.
  const pid = 2_147_483_646;
  assert.throws(() => process.kill(pid, 0));
  return pid;
}

function task(
  id: string,
  title: string,
  repo: "frontend" | "ai-core",
  dependsOn: string[] = [],
): Plan["tasks"][number] {
  return {
    id,
    repo,
    title,
    description: `${title}.`,
    workflow: "feature",
    dependsOn,
    acceptance: ["The check for this task passes."],
  };
}

const weeklyPlan: Plan = {
  requirementId: "PEBBLE-WEEKLY",
  contracts: [
    {
      id: "weekly-reflection-api",
      between: ["frontend", "ai-core"],
      owner: "ai-core",
      kind: "api",
      spec: "GET /v1/reflection?week=YYYY-MM-DD returns { paragraph: string, empty: boolean }.",
    },
  ],
  tasks: [
    task("publish-reflection-api", "Publish the weekly reflection endpoint", "ai-core"),
    task("render-reflection", "Show the weekly reflection on Sunday", "frontend", ["weekly-reflection-api"]),
  ],
};

function pebbleDir(): { cwd: string; home: string; checkouts: { frontend: string; "ai-core": string; "evals-obs": string } } {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-tick-"));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  const checkouts = {
    frontend: join(cwd, "repos", "frontend"),
    "ai-core": join(cwd, "repos", "ai-core"),
    "evals-obs": join(cwd, "repos", "evals-obs"),
  };
  initCheckout(checkouts.frontend);
  initCheckout(checkouts["ai-core"]);
  initCheckout(checkouts["evals-obs"]);
  return { cwd, home, checkouts };
}

function approve(cwd: string, home: string, planId: string): void {
  const approved = runCli(["approve", planId], { cwd, home });
  assert.equal(approved.status, 0, approved.stderr);
}

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("kiln tick", { concurrency: 1 }, () => {
  it("runs the contract owner first, resumes through approve, and commits on the worktree branch", () => {
    const { cwd, home, checkouts } = pebbleDir();
    const kilnDir = join(cwd, ".kiln");
    writeConfig(kilnDir, checkouts, 2);
    writePlan(join(kilnDir, "plans"), weeklyPlan);

    const unapproved = runCli(["tick"], { cwd, home });
    assert.equal(unapproved.status, 0, unapproved.stderr);
    assert.match(unapproved.stdout, /skip PEBBLE-WEEKLY \(not approved\)/);
    assert.match(unapproved.stdout, /nothing to launch/);
    assert.deepEqual(runIds(checkouts["ai-core"]), []);

    approve(cwd, home, "PEBBLE-WEEKLY");

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /launch publish-reflection-api\s+ai-core/);
    assert.match(first.stdout, /pid \d+/);
    assert.doesNotMatch(first.stdout, /launch render-reflection/);
    const second = runCli(["tick"], { cwd, home });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /inFlight=1/);
    assert.match(second.stdout, /nothing to launch/);
    assert.doesNotMatch(second.stdout, /launch render-reflection/);

    const suspended = waitForStatus(cwd, home, "PEBBLE-WEEKLY", /publish-reflection-api\s+ai-core\s+suspended/);
    const ownerRun = runIds(checkouts["ai-core"])[0];
    assert.ok(ownerRun);
    assert.equal(journalTag(checkouts["ai-core"], ownerRun), "kiln:PEBBLE-WEEKLY/publish-reflection-api");
    assert.deepEqual(runIds(checkouts.frontend), []);
    assert.match(suspended, /render-reflection\s+frontend\s+blocked/);
    assert.match(suspended, new RegExp(`run ${ownerRun}`));
    const approveCmd = answerCommand(suspended, "approve");
    const rejectCmd = answerCommand(suspended, "reject");
    assertResolvedYak(approveCmd);
    assertResolvedYak(rejectCmd);
    assert.match(approveCmd, /\{"decision":"approve"\}/);
    assert.match(rejectCmd, /\{"decision":"reject"\}/);
    assert.match(approveCmd, /KILN_TASK_TITLE=/);
    assert.notEqual(approveCmd, rejectCmd);

    const answered = runPrinted(approveCmd, home);
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    assert.match(answered.stdout, new RegExp(`run ${ownerRun} finished: ok`));

    const resumed = runCli(["status", "PEBBLE-WEEKLY"], { cwd, home });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /publish-reflection-api\s+ai-core\s+ok/);
    assert.match(resumed.stdout, new RegExp(`branch yak/${ownerRun}`));
    assert.doesNotMatch(resumed.stdout, /gate approve:/);
    assert.equal(
      git(checkouts["ai-core"], ["log", "-1", "--format=%s", `yak/${ownerRun}`]).trim(),
      "kiln: Publish the weekly reflection endpoint",
    );
    assert.equal(git(checkouts["ai-core"], ["show", `yak/${ownerRun}:kiln-landed.txt`]), "landed\n");
    assert.equal(existsSync(join(checkouts["ai-core"], "kiln-landed.txt")), false);

    const third = runCli(["tick"], { cwd, home });
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /launch render-reflection\s+frontend/);
    const dependent = waitForStatus(cwd, home, "PEBBLE-WEEKLY", /render-reflection\s+frontend\s+suspended/);
    const dependentRun = runIds(checkouts.frontend)[0];
    assert.ok(dependentRun);
    assert.equal(journalTag(checkouts.frontend, dependentRun), "kiln:PEBBLE-WEEKLY/render-reflection");
    assert.deepEqual(worktrees(checkouts.frontend), [dependentRun]);
  });

  it("keeps a dirty checkout file unchanged and writes the run only in its worktree", () => {
    const { cwd, home, checkouts } = pebbleDir();
    const checkout = checkouts.frontend;
    const tracked = join(checkout, "tracked.txt");
    writeFileSync(tracked, "original\n");
    git(checkout, ["add", "tracked.txt"]);
    git(checkout, ["commit", "-q", "-m", "track"]);
    writeFileSync(tracked, "dirty\n");
    const before = readFileSync(tracked);

    writeConfig(join(cwd, ".kiln"), checkouts, 1);
    const plan: Plan = {
      requirementId: "PEBBLE-ISOLATED",
      contracts: [],
      tasks: [task("touch-worktree", "Touch only the worktree", "frontend")],
    };
    writePlan(join(cwd, ".kiln", "plans"), plan);
    approve(cwd, home, "PEBBLE-ISOLATED");

    const launched = runCli(["tick"], { cwd, home });
    assert.equal(launched.status, 0, launched.stderr);
    const runId = waitForStatus(cwd, home, "PEBBLE-ISOLATED", /touch-worktree\s+frontend\s+suspended/).match(
      /run (\S+)/,
    )?.[1];
    assert.ok(runId);
    const worktree = join(checkout, ".yak", "worktrees", runId);
    assert.equal(readFileSync(join(worktree, "kiln-landed.txt"), "utf8"), "landed\n");
    assert.deepEqual(readFileSync(tracked), before);
    assert.equal(existsSync(join(checkout, "kiln-landed.txt")), false);
    assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf8"), "original\n");

    const exclude = readFileSync(join(checkout, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\.runs\/$/m);
    assert.match(exclude, /^\.yak\/$/m);
    const porcelain = git(checkout, ["status", "--porcelain"]);
    assert.match(porcelain, /tracked\.txt/);
    assert.doesNotMatch(porcelain, /\.runs/);
    assert.doesNotMatch(porcelain, /\.yak/);
    assert.doesNotMatch(porcelain, /kiln-landed/);

    const status = runCli(["status", "PEBBLE-ISOLATED"], { cwd, home });
    const answered = runPrinted(answerCommand(status.stdout, "approve"), home);
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    const done = runCli(["status", "PEBBLE-ISOLATED"], { cwd, home });
    assert.match(done.stdout, new RegExp(`branch yak/${runId}`));
    assert.equal(git(checkout, ["show", `yak/${runId}:kiln-landed.txt`]), "landed\n");
    assert.equal(
      git(checkout, ["log", "-1", "--format=%s", `yak/${runId}`]).trim(),
      "kiln: Touch only the worktree",
    );
    assert.deepEqual(readFileSync(tracked), before);
    assert.equal(existsSync(join(checkout, "kiln-landed.txt")), false);
  });

  it("gives two ready tasks in one repo two distinct worktrees when maxConcurrent is 2", () => {
    const { cwd, home, checkouts } = pebbleDir();
    writeConfig(join(cwd, ".kiln"), checkouts, 2);
    const plan: Plan = {
      requirementId: "PEBBLE-POLISH",
      contracts: [],
      tasks: [
        task("calm-empty", "Calm empty copy", "frontend"),
        task("sunday-heading", "Sunday heading", "frontend"),
      ],
    };
    writePlan(join(cwd, ".kiln", "plans"), plan);
    approve(cwd, home, "PEBBLE-POLISH");

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /launch calm-empty\s+frontend/);
    const second = runCli(["tick"], { cwd, home });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /launch sunday-heading\s+frontend/);
    const suspended = waitForStatus(
      cwd,
      home,
      "PEBBLE-POLISH",
      /calm-empty\s+frontend\s+suspended[\s\S]*sunday-heading\s+frontend\s+suspended/,
    );
    const trees = worktrees(checkouts.frontend);
    const ids = runIds(checkouts.frontend);
    assert.deepEqual(ids, trees);
    assert.equal(trees.length, 2);
    assert.notEqual(trees[0], trees[1]);
    assert.equal(existsSync(join(checkouts.frontend, "kiln-landed.txt")), false);
    for (const id of trees) {
      const tree = join(checkouts.frontend, ".yak", "worktrees", id);
      assert.equal(git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), `yak/${id}`);
    }

    const calm = runIdOf(suspended, "calm-empty");
    const sunday = runIdOf(suspended, "sunday-heading");
    const commands = [...suspended.matchAll(/^    answer approve: (.+)$/gm)].map((match) => match[1] ?? "");
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.ok(command);
      assertResolvedYak(command);
      const answered = runPrinted(command, home);
      assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    }
    const checkout = checkouts.frontend;
    assert.equal(existsSync(join(checkout, ".yak", "worktrees", calm, "kiln-landed.txt")), true);
    assert.equal(existsSync(join(checkout, ".yak", "worktrees", sunday, "kiln-landed.txt")), true);
    assert.equal(git(checkout, ["log", "-1", "--format=%s", `yak/${calm}`]).trim(), "kiln: Calm empty copy");
    assert.equal(git(checkout, ["log", "-1", "--format=%s", `yak/${sunday}`]).trim(), "kiln: Sunday heading");
    for (const id of [calm, sunday]) {
      const names = git(checkout, ["show", "--name-only", "--format=", `yak/${id}`])
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      assert.deepEqual(names, ["kiln-landed.txt"]);
    }
  });

  it("does not launch a second ready task when maxConcurrent is 1 and the first run is in flight", () => {
    const { cwd, home, checkouts } = pebbleDir();
    writeConfig(join(cwd, ".kiln"), checkouts, 1);
    const plan: Plan = {
      requirementId: "PEBBLE-POLISH",
      contracts: [],
      tasks: [
        task("calm-empty", "Calm empty copy", "frontend"),
        task("sunday-heading", "Sunday heading", "frontend"),
      ],
    };
    writePlan(join(cwd, ".kiln", "plans"), plan);
    approve(cwd, home, "PEBBLE-POLISH");

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /maxConcurrent=1/);
    assert.match(first.stdout, /launch calm-empty\s+frontend/);
    assert.doesNotMatch(first.stdout, /launch sunday-heading/);

    const second = runCli(["tick"], { cwd, home });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /inFlight=1/);
    assert.match(second.stdout, /nothing to launch/);

    const status = waitForStatus(cwd, home, "PEBBLE-POLISH", /calm-empty\s+frontend\s+suspended/);
    assert.match(status, /sunday-heading\s+frontend\s+ready/);
    assert.equal(runIds(checkouts.frontend).length, 1);
  });

  it("marks a dead journal dead, prints cancel, and launches the next task under maxConcurrent 1", () => {
    const { cwd, home, checkouts } = pebbleDir();
    writeConfig(join(cwd, ".kiln"), checkouts, 1);
    const plan: Plan = {
      requirementId: "PEBBLE-POLISH",
      contracts: [],
      tasks: [
        task("calm-empty", "Calm empty copy", "frontend"),
        task("sunday-heading", "Sunday heading", "frontend"),
      ],
    };
    writePlan(join(cwd, ".kiln", "plans"), plan);
    approve(cwd, home, "PEBBLE-POLISH");

    const runId = "2026-10-24T00-00-00Z-dead";
    const runDir = join(checkouts.frontend, ".runs", runId);
    mkdirSync(runDir, { recursive: true });
    const gone = deadPid();
    writeFileSync(
      join(runDir, "journal.jsonl"),
      [
        JSON.stringify({
          t: "run.started",
          runId,
          tag: "kiln:PEBBLE-POLISH/calm-empty",
          pid: process.pid,
        }),
        JSON.stringify({ t: "run.resumed", runId, pid: gone }),
        "{\"t\":\"step.started\",\"partial",
        "",
      ].join("\n"),
    );

    const before = runCli(["status", "PEBBLE-POLISH"], { cwd, home });
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /calm-empty\s+frontend\s+dead/);
    assert.match(before.stdout, /sunday-heading\s+frontend\s+ready/);
    assert.ok(before.stdout.includes(`cancel '${runId}'`), before.stdout);
    assert.ok(before.stdout.includes(`cd '${checkouts.frontend}'`), before.stdout);
    assertResolvedYak(before.stdout);

    const tick = runCli(["tick"], { cwd, home });
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, /launch sunday-heading\s+frontend/);
    assert.doesNotMatch(tick.stdout, /launch calm-empty/);
    const again = runCli(["status", "PEBBLE-POLISH"], { cwd, home });
    assert.match(again.stdout, /calm-empty\s+frontend\s+dead/);
  });

  it("does not relaunch a task whose launch pid died before a journal existed", () => {
    const { cwd, home, checkouts } = pebbleDir();
    const kilnDir = join(cwd, ".kiln");
    writeConfig(kilnDir, checkouts, 1);
    const plan: Plan = {
      requirementId: "PEBBLE-POLISH",
      contracts: [],
      tasks: [task("calm-empty", "Calm empty copy", "frontend")],
    };
    writePlan(join(kilnDir, "plans"), plan);
    approve(cwd, home, "PEBBLE-POLISH");

    const logPath = join(kilnDir, "logs", "PEBBLE-POLISH", "calm-empty.log");
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "yak exited before writing a journal\n");
    const crumbDir = join(kilnDir, "launching", "PEBBLE-POLISH");
    mkdirSync(crumbDir, { recursive: true });
    writeFileSync(
      join(crumbDir, "calm-empty.json"),
      `${JSON.stringify({ planId: "PEBBLE-POLISH", taskId: "calm-empty", pid: deadPid(), logPath }, null, 2)}\n`,
    );

    const status = runCli(["status", "PEBBLE-POLISH"], { cwd, home });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /calm-empty\s+frontend\s+launch-failed/);
    assert.ok(status.stdout.includes(`log ${logPath}`), status.stdout);

    const first = runCli(["tick"], { cwd, home });
    const second = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /nothing to launch/);
    assert.match(second.stdout, /nothing to launch/);
    assert.doesNotMatch(first.stdout, /launch calm-empty/);
    assert.deepEqual(runIds(checkouts.frontend), []);
    const still = runCli(["status", "PEBBLE-POLISH"], { cwd, home });
    assert.match(still.stdout, /launch-failed/);
  });

  it("does not satisfy a dependency when the approve gate was rejected", () => {
    const { cwd, home, checkouts } = pebbleDir();
    writeConfig(join(cwd, ".kiln"), checkouts, 2);
    writePlan(join(cwd, ".kiln", "plans"), weeklyPlan);
    approve(cwd, home, "PEBBLE-WEEKLY");

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    const suspended = waitForStatus(cwd, home, "PEBBLE-WEEKLY", /answer reject:/);
    const ownerRun = runIds(checkouts["ai-core"])[0];
    assert.ok(ownerRun);
    const rejectCmd = answerCommand(suspended, "reject");
    assertResolvedYak(rejectCmd);

    const answered = runPrinted(rejectCmd, home);
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    assert.match(answered.stdout, new RegExp(`run ${ownerRun} finished: ok`));
    const rejected = runCli(["status", "PEBBLE-WEEKLY"], { cwd, home });
    assert.match(rejected.stdout, /publish-reflection-api\s+ai-core\s+rejected/);
    assert.match(rejected.stdout, /render-reflection\s+frontend\s+blocked/);
    assert.doesNotMatch(rejected.stdout, /branch yak\//);
    const commits = git(checkouts["ai-core"], ["log", "--format=%s", `yak/${ownerRun}`]);
    assert.doesNotMatch(commits, /^kiln:/m);

    const next = runCli(["tick"], { cwd, home });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /nothing to launch/);
    assert.doesNotMatch(next.stdout, /launch render-reflection/);
    assert.deepEqual(runIds(checkouts.frontend), []);
  });

  it("refuses an empty test command instead of running it", () => {
    const { cwd, home, checkouts } = pebbleDir();
    writeConfig(join(cwd, ".kiln"), checkouts, 1, "   ");
    const plan: Plan = {
      requirementId: "PEBBLE-POLISH",
      contracts: [],
      tasks: [task("calm-empty", "Calm empty copy", "frontend")],
    };
    writePlan(join(cwd, ".kiln", "plans"), plan);
    approve(cwd, home, "PEBBLE-POLISH");

    const tick = runCli(["tick"], { cwd, home });
    assert.equal(tick.status, 1);
    assert.match(tick.stderr, /empty test command/);
    assert.deepEqual(runIds(checkouts.frontend), []);
  });

  it("feeds a failing review back to the builder and still approves", () => {
    const { cwd, home, checkouts } = pebbleDir();
    const kilnDir = join(cwd, ".kiln");
    const promptLog = join(cwd, "prompt-log");
    mkdirSync(promptLog);
    writeConfig(kilnDir, checkouts, 1);
    const checkout = checkouts.frontend;
    const findings = "MUSTFIX pebble-week-id: the Sunday heading drops the week id";
    commitFeatureFixtures(checkout, {
      spec: [{ output: { goal: "Show the weekly reflection.", design: "Touch the named module.", acceptance: "The task's checks pass." } }],
      build: [{ output: { summary: "Mock build for the Pebble task.", status: "READY" } }],
      security: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ux: [{ output: { verdict: "PASS", findings: "No must-fix findings." } }],
      ui: [{ output: { verdict: "PASS", findings: "Checked: no UI changes." } }],
      code: [
        { output: { verdict: "CHANGES", findings } },
        { output: { verdict: "PASS", findings: "The week id is covered." } },
      ],
      approver: [{ output: { decision: "APPROVE", reason: "Round 2 reviews passed." } }],
    });
    const plan: Plan = {
      requirementId: "PEBBLE-REVIEW",
      contracts: [],
      tasks: [task("sunday-heading", "Sunday heading", "frontend")],
    };
    writePlan(join(kilnDir, "plans"), plan);
    approve(cwd, home, "PEBBLE-REVIEW");

    const launched = runCli(["tick"], { cwd, home, env: promptEnv(promptLog) });
    assert.equal(launched.status, 0, launched.stderr);
    const suspended = waitForStatus(cwd, home, "PEBBLE-REVIEW", /sunday-heading\s+frontend\s+suspended/, 60000);
    const runId = runIdOf(suspended, "sunday-heading");
    assert.deepEqual(stepIterations(checkout, runId, "build"), [1, 2]);
    assert.deepEqual(stepIterations(checkout, runId, "ui"), [1, 2]);
    assert.deepEqual(stepIterations(checkout, runId, "code"), [1, 2]);
    assert.equal(readArtifact(checkout, runId, "code.1.json").verdict, "CHANGES");
    assert.equal(readArtifact(checkout, runId, "code.2.json").verdict, "PASS");
    assert.equal(readArtifact(checkout, runId, "verify.1.json").exitCode, 0);
    assert.equal(readArtifact(checkout, runId, "verify.2.json").exitCode, 0);
    assertAbsoluteFactoryPrompts(checkout, runId, kilnDir);

    const prompts = readPrompts(promptLog);
    const build1 = prompts.find((entry) => entry.stepId === "build" && entry.callIndex === 0);
    const build2 = prompts.find((entry) => entry.stepId === "build" && entry.callIndex === 1);
    assert.ok(build1, JSON.stringify(prompts.map((entry) => [entry.stepId, entry.callIndex])));
    assert.ok(build2);
    assert.match(build1.prompt, /\(round 1: no prior review\)/);
    assert.doesNotMatch(build1.prompt, /MUSTFIX pebble-week-id/);
    assert.match(build2.prompt, new RegExp(findings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(build2.prompt, /<job folder>\/build\.md/);
    const codePrompt = prompts.find((entry) => entry.stepId === "code" && entry.callIndex === 0);
    assert.ok(codePrompt);
    assert.match(codePrompt.prompt, /smart-review:smart-review/);

    const answered = runPrinted(answerCommand(suspended, "approve"), home);
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    const done = runCli(["status", "PEBBLE-REVIEW"], { cwd, home });
    assert.match(done.stdout, /sunday-heading\s+frontend\s+ok/);
    assert.equal(git(checkout, ["log", "-1", "--format=%s", `yak/${runId}`]).trim(), "kiln: Sunday heading");
  });

  it("loops a red verify back to the builder instead of failing the run", () => {
    const { cwd, home, checkouts } = pebbleDir();
    const kilnDir = join(cwd, ".kiln");
    const promptLog = join(cwd, "prompt-log");
    mkdirSync(promptLog);
    const checkout = checkouts.frontend;
    writeFileSync(
      join(checkout, "verify-once.mjs"),
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const path = 'verify-attempt.txt';",
        "const n = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;",
        "writeFileSync(path, String(n + 1));",
        "if (n === 0) {",
        "  console.error('verify failed round 1');",
        "  process.exit(1);",
        "}",
        "console.log('verify ok round 2');",
        "",
      ].join("\n"),
    );
    git(checkout, ["add", "verify-once.mjs"]);
    git(checkout, ["commit", "-q", "-m", "red then green verify"]);
    writeConfig(kilnDir, checkouts, 1, "node verify-once.mjs");
    const plan: Plan = {
      requirementId: "PEBBLE-RED",
      contracts: [],
      tasks: [task("calm-empty", "Calm empty copy", "frontend")],
    };
    writePlan(join(kilnDir, "plans"), plan);
    approve(cwd, home, "PEBBLE-RED");

    const launched = runCli(["tick"], { cwd, home, env: promptEnv(promptLog) });
    assert.equal(launched.status, 0, launched.stderr);
    const suspended = waitForStatus(cwd, home, "PEBBLE-RED", /calm-empty\s+frontend\s+suspended/, 60000);
    const runId = runIdOf(suspended, "calm-empty");
    const journal = readFileSync(join(checkout, ".runs", runId, "journal.jsonl"), "utf8");
    assert.doesNotMatch(journal, /"t":"step.failed"/);
    assert.deepEqual(stepIterations(checkout, runId, "build"), [1, 2]);
    assert.deepEqual(stepIterations(checkout, runId, "verify"), [1, 2]);
    assert.deepEqual(stepIterations(checkout, runId, "ui"), [1, 2]);
    const redVerify = readArtifact(checkout, runId, "verify.1.json");
    assert.equal(redVerify.exitCode, 1);
    assert.match(redVerify.stderr ?? "", /verify failed round 1/);
    assert.equal(readArtifact(checkout, runId, "verify.2.json").exitCode, 0);
    assert.equal(readArtifact(checkout, runId, "security.1.json").verdict, "PASS");
    assert.equal(readArtifact(checkout, runId, "ui.2.json").verdict, "PASS");

    const prompts = readPrompts(promptLog);
    const build2 = prompts.find((entry) => entry.stepId === "build" && entry.callIndex === 1);
    assert.ok(build2, JSON.stringify(prompts.map((entry) => [entry.stepId, entry.callIndex])));
    assert.match(build2.prompt, /verify failed round 1/);
    assert.match(build2.prompt, /Previous verify exit code: 1/);
    const approver = prompts.find((entry) => entry.stepId === "approver");
    assert.ok(approver);
    assert.match(approver.prompt, /Latest verify exit code: 0/);

    const answered = runPrinted(answerCommand(suspended, "approve"), home);
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    const done = runCli(["status", "PEBBLE-RED"], { cwd, home });
    assert.match(done.stdout, /calm-empty\s+frontend\s+ok/);
    assert.match(done.stdout, new RegExp(`branch yak/${runId}`));
  });
});

function promptEnv(promptLog: string): Record<string, string> {
  const hook = join(root, "test", "hooks", "register-record-mock-prompts.mjs");
  return {
    NODE_OPTIONS: `--import ${hook}`,
    KILN_PROMPT_LOG: promptLog,
  };
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
): { verdict?: string; exitCode?: number; stderr?: string; stdout?: string } {
  return JSON.parse(readFileSync(join(checkout, ".runs", runId, "artifacts", name), "utf8")) as {
    verdict?: string;
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  };
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

function assertAbsoluteFactoryPrompts(checkout: string, runId: string, kilnDir: string): void {
  const workflow = JSON.parse(readFileSync(join(checkout, ".runs", runId, "workflow.json"), "utf8")) as {
    steps: Array<{ kind?: string; model?: string; prompt?: { file?: string }; body?: unknown[] }>;
  };
  const files: string[] = [];
  const visit = (step: { kind?: string; prompt?: { file?: string }; body?: unknown[] }): void => {
    if (step.prompt?.file) files.push(step.prompt.file);
    if (Array.isArray(step.body)) {
      for (const child of step.body) visit(child as { kind?: string; prompt?: { file?: string }; body?: unknown[] });
    }
  };
  for (const step of workflow.steps) visit(step);
  assert.equal(files.length, 7);
  for (const file of files) {
    assert.equal(file.startsWith("/"), true, file);
    assert.equal(file.startsWith(kilnDir + "/"), true, file);
    assert.equal(existsSync(file), true, file);
    const text = readFileSync(file, "utf8");
    assert.match(text, /Return JSON/);
    assert.match(text, /The factory agent instructions follow/);
    assert.match(text, /MIT License/);
    assert.doesNotMatch(file, /^prompts\//);
  }
}
