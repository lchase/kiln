import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadKilnConfig } from "../src/config.js";
import { PlannerOutputError } from "../src/errors.js";
import { packageRoot } from "../src/paths.js";
import { AgentCliPlanner } from "../src/planners/agent-cli.js";
import { extractModelJson } from "../src/planners/extract-json.js";
import { refine } from "../src/refine.js";
import type { Requirement } from "../src/schemas.js";

const fixture = join(packageRoot(), "test", "fixtures", "echo-agent.mjs");
const exampleConfig = loadKilnConfig(join(packageRoot(), "examples", "kiln.config.json"), {
  cwd: packageRoot(),
});

function agentPlanner(): AgentCliPlanner {
  return new AgentCliPlanner({ bin: process.execPath, args: [fixture] });
}

const readyFields = {
  acceptanceCriteria: ["The habit list shows each habit once"],
  scope: "frontend only.",
  outcome: "A person sees each habit once.",
};

describe("agent CLI planner", () => {
  it("reads a non-interactive CLI and returns questions without decomposing", async () => {
    const requirement: Requirement = {
      id: "EX-AGENT-Q",
      source: "jira",
      title: "Agent questions please",
      body: "This example is intentionally thin.",
      ...readyFields,
    };
    const result = await refine(requirement, agentPlanner(), { config: exampleConfig });
    assert.equal(result.kind, "questions");
    if (result.kind !== "questions") return;
    assert.deepEqual(result.readiness.missing, ["scope"]);
    assert.deepEqual(result.readiness.questions, ["Which repo does this example change?"]);
  });

  it("reads a Claude JSON envelope and returns a plan", async () => {
    const requirement: Requirement = {
      id: "EX-AGENT",
      source: "markdown",
      title: "Agent plan please",
      body: "A scripted agent fixture answers this example.",
      ...readyFields,
    };
    const result = await refine(requirement, agentPlanner(), { config: exampleConfig });
    assert.equal(result.kind, "plan");
    if (result.kind !== "plan") return;
    assert.equal(result.plan.requirementId, "EX-AGENT");
    assert.deepEqual(result.plan.contracts, []);
    assert.equal(result.plan.tasks[0]?.repo, "frontend");
    assert.ok(result.plan.tasks[0]?.title);
    assert.ok(result.plan.tasks[0]?.description);
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

  it("reads a Claude event array that contains a result", () => {
    const value = extractModelJson(
      JSON.stringify([
        { type: "system" },
        { type: "result", result: "ignored", structured_output: { ready: true, missing: [], questions: [] } },
      ]),
    );
    assert.deepEqual(value, { ready: true, missing: [], questions: [] });
  });

  it("rejects empty stdout", () => {
    assert.throws(() => extractModelJson("  \n"), PlannerOutputError);
  });
});
