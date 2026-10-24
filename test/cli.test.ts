import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const isolatedHome = mkdtempSync(join(tmpdir(), "kiln-home-"));

function runCli(
  args: string[],
  options: { cwd?: string; home?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, HOME: options.home ?? isolatedHome },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function splitOutput(stdout: string): { json: Record<string, unknown>; markdown: string } {
  const at = stdout.indexOf("\n\n#");
  assert.ok(at > 0, `expected JSON followed by markdown, got:\n${stdout}`);
  return {
    json: JSON.parse(stdout.slice(0, at)) as Record<string, unknown>,
    markdown: stdout.slice(at + 2),
  };
}

after(() => {
  rmSync(join(root, ".kiln"), { recursive: true, force: true });
  rmSync(isolatedHome, { recursive: true, force: true });
});

describe("kiln refine", () => {
  it("prints usage and exits 2 without a requirement file", () => {
    const result = runCli([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: kiln refine/);
  });

  it("prints questions for the thin example and does not write a plan", () => {
    const result = runCli(["refine", "examples/requirements/thin-jira.md"]);
    assert.equal(result.status, 0, result.stderr);
    const { json, markdown } = splitOutput(result.stdout);
    assert.equal(json.kind, "questions");
    assert.match(markdown, /^# Not ready: Search is weird/);
    assert.match(markdown, /acceptance criteria/);
    assert.match(markdown, /## Questions/);
    assert.match(result.stderr, /fictional example data/);
    assert.equal(existsSync(join(root, ".kiln", "plans", "EX-201.json")), false);
  });

  it("prints a cross-repo plan and writes it under .kiln/plans", () => {
    const result = runCli(["refine", "examples/requirements/weekly-reflection.md"]);
    assert.equal(result.status, 0, result.stderr);
    const { json, markdown } = splitOutput(result.stdout);
    assert.equal(json.kind, "plan");
    const plan = json.plan as { contracts: { id: string }[]; tasks: { dependsOn: string[] }[] };
    assert.equal(plan.contracts.length, 1);
    const contractId = plan.contracts[0]?.id;
    assert.ok(contractId);
    for (const task of plan.tasks) {
      assert.equal(task.dependsOn[0], contractId);
    }
    assert.ok(markdown.indexOf("## Contracts") < markdown.indexOf("## Tasks"));
    assert.match(markdown, /frontend/);
    assert.match(markdown, /ai-core/);

    const jsonPath = join(root, ".kiln", "plans", "EX-202.json");
    const markdownPath = join(root, ".kiln", "plans", "EX-202.md");
    assert.equal(existsSync(join(root, "examples", "plans")), false);
    assert.match(readFileSync(jsonPath, "utf8"), /EX-202-api-frontend-ai-core/);
    assert.match(readFileSync(markdownPath, "utf8"), /^# Plan: Weekly reflection summary/);
    assert.match(result.stderr, new RegExp(jsonPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("prints a single-repo bug plan with no contracts", () => {
    const result = runCli(["refine", "examples/requirements/duplicate-habit.md"]);
    assert.equal(result.status, 0, result.stderr);
    const { json, markdown } = splitOutput(result.stdout);
    assert.equal(json.kind, "plan");
    const plan = json.plan as { contracts: unknown[]; tasks: { repo: string; workflow: string }[] };
    assert.deepEqual(plan.contracts, []);
    assert.equal(plan.tasks[0]?.repo, "frontend");
    assert.equal(plan.tasks[0]?.workflow, "bug");
    assert.match(markdown, /None\. This plan stays inside one repo/);
    assert.match(readFileSync(join(root, ".kiln", "plans", "EX-203.json"), "utf8"), /"contracts": \[\]/);
  });

  it("refuses a requirement outside the examples when no local config exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-no-config-"));
    const requirement = join(dir, "real-requirement.md");
    writeFileSync(requirement, "---\nid: EX-SECRET\nsource: jira\ntitle: Internal ticket\n---\n\nDo not commit this.\n");
    try {
      const result = runCli(["refine", requirement], { cwd: dir, home: dir });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No local kiln config found/);
      assert.match(result.stderr, /\.kiln/);
      assert.equal(existsSync(join(dir, ".kiln")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a plan next to a local config and does not use the example plans directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-local-"));
    const kilnDir = join(dir, ".kiln");
    mkdirSync(kilnDir);
    writeFileSync(
      join(kilnDir, "kiln.config.json"),
      JSON.stringify({
        note: "Local test config. Not a real company.",
        repos: {
          frontend: {
            checkout: join(root, "examples", "checkouts", "frontend"),
            ownership: join(root, "examples", "ownership", "frontend.json"),
          },
          "ai-core": {
            checkout: join(root, "examples", "checkouts", "ai-core"),
            ownership: join(root, "examples", "ownership", "ai-core.json"),
          },
          "evals-obs": {
            checkout: join(root, "examples", "checkouts", "evals-obs"),
            ownership: join(root, "examples", "ownership", "evals-obs.json"),
          },
        },
      }),
    );
    const requirement = join(kilnDir, "requirements.md");
    writeFileSync(requirement, readFileSync(join(root, "examples", "requirements", "duplicate-habit.md")));
    try {
      const result = runCli(["refine", requirement], { cwd: dir, home: isolatedHome });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /fictional example data/);
      const written = join(kilnDir, "plans", "EX-203.json");
      assert.match(readFileSync(written, "utf8"), /"repo": "frontend"/);
      assert.equal(existsSync(join(root, "examples", "plans")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
