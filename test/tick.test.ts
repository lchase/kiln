import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import type { Plan } from "../src/schemas.js";
import { validatePlan } from "../src/validate.js";

const root = packageRoot();
const keep: string[] = [];

function runCli(
  args: string[],
  options: { cwd: string; home: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: options.home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function initCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
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
  for (const step of ["security", "ux", "code"]) {
    writeFileSync(
      join(fixtures, `${step}.json`),
      `${JSON.stringify([{ output: { verdict: "PASS", findings: "No must-fix findings." } }])}\n`,
    );
  }
  writeFileSync(
    join(fixtures, "approver.json"),
    `${JSON.stringify([{ output: { decision: "APPROVE", reason: "Reviews passed." } }])}\n`,
  );
}

function writeConfig(
  kilnDir: string,
  checkouts: { frontend: string; "ai-core": string; "evals-obs": string },
  maxConcurrent: number,
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
            test: "node --test test.mjs",
          },
          "ai-core": {
            checkout: checkouts["ai-core"],
            ownership: join(root, "examples", "ownership", "ai-core.json"),
            test: "node --test test.mjs",
          },
          "evals-obs": {
            checkout: checkouts["evals-obs"],
            ownership: join(root, "examples", "ownership", "evals-obs.json"),
            test: "node --test test.mjs",
          },
        },
      },
      null,
      2,
    ),
  );
}

function writePlan(plansDir: string, plan: Plan): void {
  assert.deepEqual(validatePlan(plan), []);
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
    const event = JSON.parse(line) as { t?: string; tag?: string };
    if (event.t === "run.started") return event.tag;
  }
  return undefined;
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
    {
      id: "publish-reflection-api",
      repo: "ai-core",
      title: "Publish the weekly reflection endpoint",
      description: "Add GET /v1/reflection that summarizes the week's habit records in one paragraph.",
      workflow: "feature",
      dependsOn: [],
      acceptance: [
        "GET /v1/reflection returns a paragraph for a week with habits.",
        "A week with no habits returns empty: true and a calm paragraph, not an error.",
      ],
    },
    {
      id: "render-reflection",
      repo: "frontend",
      title: "Show the weekly reflection on Sunday",
      description: "The home screen requests the reflection from ai-core and renders the paragraph.",
      workflow: "feature",
      dependsOn: ["weekly-reflection-api"],
      acceptance: [
        "The Sunday home screen shows the paragraph from the API.",
        "An empty week shows the calm empty state.",
      ],
    },
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

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("kiln tick", () => {
  it("runs the contract owner first, does not double-launch, and resumes through the approve gate", () => {
    const { cwd, home, checkouts } = pebbleDir();
    const kilnDir = join(cwd, ".kiln");
    writeConfig(kilnDir, checkouts, 2);
    writePlan(join(kilnDir, "plans"), weeklyPlan);

    const unapproved = runCli(["tick"], { cwd, home });
    assert.equal(unapproved.status, 0, unapproved.stderr);
    assert.match(unapproved.stdout, /skip PEBBLE-WEEKLY \(not approved\)/);
    assert.match(unapproved.stdout, /nothing to launch/);
    assert.deepEqual(runIds(checkouts["ai-core"]), []);
    assert.deepEqual(runIds(checkouts.frontend), []);

    const approved = runCli(["approve", "PEBBLE-WEEKLY"], { cwd, home });
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /Approved PEBBLE-WEEKLY/);
    assert.equal(existsSync(join(kilnDir, "plans", "PEBBLE-WEEKLY.approved.json")), true);

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /launch publish-reflection-api\s+ai-core/);
    assert.doesNotMatch(first.stdout, /launch render-reflection/);
    const ownerRuns = runIds(checkouts["ai-core"]);
    assert.equal(ownerRuns.length, 1);
    const ownerRun = ownerRuns[0];
    assert.ok(ownerRun);
    assert.equal(journalTag(checkouts["ai-core"], ownerRun), "kiln:PEBBLE-WEEKLY/publish-reflection-api");
    assert.deepEqual(runIds(checkouts.frontend), []);

    const second = runCli(["tick"], { cwd, home });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /nothing to launch/);
    assert.deepEqual(runIds(checkouts["ai-core"]), ownerRuns);
    assert.deepEqual(runIds(checkouts.frontend), []);

    const suspended = runCli(["status", "PEBBLE-WEEKLY"], { cwd, home });
    assert.equal(suspended.status, 0, suspended.stderr);
    assert.match(suspended.stdout, /publish-reflection-api\s+ai-core\s+suspended/);
    assert.match(suspended.stdout, new RegExp(`run ${ownerRun}`));
    assert.match(suspended.stdout, /render-reflection\s+frontend\s+blocked/);
    assert.match(suspended.stdout, /gate approve:/);
    const command = suspended.stdout.match(/^    answer: (.+)$/m)?.[1];
    assert.ok(command, suspended.stdout);
    assert.match(command, /pending\/approve\.answer\.json/);
    assert.match(command, /\{"decision":"approve"\}/);
    assert.match(command, new RegExp(`yak resume '${ownerRun}'`));

    const answered = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(answered.status, 0, `${answered.stdout}\n${answered.stderr}`);
    assert.match(answered.stdout, new RegExp(`run ${ownerRun} finished: ok`));

    const resumed = runCli(["status", "PEBBLE-WEEKLY"], { cwd, home });
    assert.match(resumed.stdout, /publish-reflection-api\s+ai-core\s+ok/);
    assert.doesNotMatch(resumed.stdout, /gate approve:/);

    const third = runCli(["tick"], { cwd, home });
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /launch render-reflection\s+frontend/);
    const dependentRuns = runIds(checkouts.frontend);
    assert.equal(dependentRuns.length, 1);
    const dependentRun = dependentRuns[0];
    assert.ok(dependentRun);
    assert.equal(journalTag(checkouts.frontend, dependentRun), "kiln:PEBBLE-WEEKLY/render-reflection");
    assert.deepEqual(runIds(checkouts["ai-core"]), ownerRuns);

    const later = runCli(["status"], { cwd, home });
    assert.match(later.stdout, /render-reflection\s+frontend\s+suspended/);
    assert.match(later.stdout, /gate approve:/);
  });

  it("does not launch a second ready task when maxConcurrent is 1 and the first run is suspended", () => {
    const { cwd, home, checkouts } = pebbleDir();
    writeConfig(join(cwd, ".kiln"), checkouts, 1);
    const plan: Plan = {
      requirementId: "PEBBLE-POLISH",
      contracts: [],
      tasks: [
        {
          id: "calm-empty",
          repo: "frontend",
          title: "Calm empty copy",
          description: "An empty week uses calm copy instead of an error.",
          workflow: "feature",
          dependsOn: [],
          acceptance: ["The empty week shows the calm sentence."],
        },
        {
          id: "sunday-heading",
          repo: "frontend",
          title: "Sunday heading",
          description: "The home screen heading says Sunday reflection.",
          workflow: "feature",
          dependsOn: [],
          acceptance: ["The heading is Sunday reflection."],
        },
      ],
    };
    writePlan(join(cwd, ".kiln", "plans"), plan);
    assert.equal(runCli(["approve", "PEBBLE-POLISH"], { cwd, home }).status, 0);

    const first = runCli(["tick"], { cwd, home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /maxConcurrent=1/);
    assert.match(first.stdout, /launch calm-empty\s+frontend/);
    assert.doesNotMatch(first.stdout, /launch sunday-heading/);
    assert.equal(runIds(checkouts.frontend).length, 1);

    const second = runCli(["tick"], { cwd, home });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /inFlight=1/);
    assert.match(second.stdout, /nothing to launch/);
    assert.equal(runIds(checkouts.frontend).length, 1);
    const status = runCli(["status", "PEBBLE-POLISH"], { cwd, home });
    assert.match(status.stdout, /calm-empty\s+frontend\s+suspended/);
    assert.match(status.stdout, /sunday-heading\s+frontend\s+ready/);
  });
});
