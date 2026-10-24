import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const root = packageRoot();
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: root,
    encoding: "utf8",
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

describe("kiln refine", () => {
  it("prints usage and exits 2 without a requirement file", () => {
    const result = runCli([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: kiln refine/);
  });

  it("prints questions for the thin example", () => {
    const result = runCli(["refine", "examples/requirements/thin-jira.md"]);
    assert.equal(result.status, 0, result.stderr);
    const { json, markdown } = splitOutput(result.stdout);
    assert.equal(json.kind, "questions");
    assert.match(markdown, /^# Not ready: Search is weird/);
    assert.match(markdown, /acceptance criteria/);
    assert.match(markdown, /## Questions/);
  });

  it("prints a cross-repo plan with contracts before tasks", () => {
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
  });
});
