import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { gateAnswerCommand, yakCliPath } from "../src/report.js";

describe("yakCliPath", () => {
  it("points at the installed @lchase/yak bin", () => {
    const bin = yakCliPath();
    assert.equal(existsSync(bin), true);
    let dir = dirname(bin);
    let pkg: { name?: string } | undefined;
    for (let i = 0; i < 5; i += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    assert.equal(pkg?.name, "@lchase/yak");
  });
});

describe("gateAnswerCommand", () => {
  it("answers the gate with the resolved node and yak binaries", () => {
    const command = gateAnswerCommand(
      "/tmp/checkout",
      "run-1",
      { stepId: "approve", prompt: "Approve?", answerField: "decision", choices: ["approve", "reject"] },
      "approve",
      "Show the summary",
    );
    assert.match(command, new RegExp(yakCliPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(command, /\{"decision":"approve"\}/);
    assert.match(command, /KILN_TASK_TITLE=/);
    assert.doesNotMatch(command, /node_modules\/\.bin/);
  });
});
