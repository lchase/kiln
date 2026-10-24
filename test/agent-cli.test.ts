import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PlannerOutputError } from "../src/errors.js";
import { packageRoot } from "../src/paths.js";
import { AgentCliPlanner, defaultClaudeArgs } from "../src/planners/agent-cli.js";
import { extractModelJson } from "../src/planners/extract-json.js";
import { refine } from "../src/refine.js";
import type { Requirement } from "../src/schemas.js";

const fixture = join(packageRoot(), "test", "fixtures", "echo-agent.mjs");

function agentPlanner(): AgentCliPlanner {
  return new AgentCliPlanner({ bin: process.execPath, args: [fixture] });
}

describe("agent CLI planner", () => {
  it("asks Claude for JSON in print mode with tools disabled", () => {
    const args = defaultClaudeArgs({ type: "object" });
    assert.equal(args[0], "-p");
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("json"));
    const toolsAt = args.indexOf("--tools");
    assert.equal(args[toolsAt + 1], "");
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("--permission-prompts"));
  });

  it("reads a non-interactive CLI and returns questions without decomposing", async () => {
    const requirement: Requirement = {
      id: "EX-AGENT-Q",
      source: "jira",
      title: "Agent questions please",
      body: "This example is intentionally thin.",
    };
    const result = await refine(requirement, agentPlanner());
    assert.equal(result.kind, "questions");
    if (result.kind !== "questions") return;
    assert.deepEqual(result.readiness.missing, ["scope"]);
    assert.deepEqual(result.readiness.questions, ["Which repo does this example change?"]);
  });

  it("reads a Codex-style JSONL plan from the same CLI", async () => {
    const requirement: Requirement = {
      id: "EX-AGENT",
      source: "markdown",
      title: "Agent plan please",
      body: "A scripted agent fixture answers this example.",
      acceptanceCriteria: ["The habit list shows each habit once"],
    };
    const result = await refine(requirement, agentPlanner());
    assert.equal(result.kind, "plan");
    if (result.kind !== "plan") return;
    assert.equal(result.plan.requirementId, "EX-AGENT");
    assert.deepEqual(result.plan.contracts, []);
    assert.equal(result.plan.tasks[0]?.repo, "frontend");
  });
});

describe("extractModelJson", () => {
  it("reads a Claude result envelope", () => {
    const value = extractModelJson(
      JSON.stringify({
        type: "result",
        result: "ignored",
        structured_output: { ready: true, missing: [], questions: [] },
      }),
    );
    assert.deepEqual(value, { ready: true, missing: [], questions: [] });
  });

  it("reads JSON embedded in a Claude result string", () => {
    const value = extractModelJson(
      JSON.stringify({
        type: "result",
        result: '```json\n{"ready":false,"missing":["scope"],"questions":["Which repo?"]}\n```',
      }),
    );
    assert.deepEqual(value, {
      ready: false,
      missing: ["scope"],
      questions: ["Which repo?"],
    });
  });

  it("reads the last agent message from a Codex JSONL stream", () => {
    const plan = { requirementId: "EX-1", contracts: [] };
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "example" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: JSON.stringify(plan) },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    assert.deepEqual(extractModelJson(stdout), plan);
  });

  it("rejects empty stdout", () => {
    assert.throws(() => extractModelJson("  \n"), PlannerOutputError);
  });
});
