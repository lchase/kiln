import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readBoardFiles, readReviewRounds } from "../src/board.js";

const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("board files", () => {
  it("reads every review iteration and the artifact texts status still attaches", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-board-"));
    keep.push(dir);
    const artifacts = join(dir, "artifacts");
    mkdirSync(artifacts);
    writeFileSync(join(artifacts, "security.json"), JSON.stringify({ verdict: "PASS", findings: "No must-fix findings." }));
    writeFileSync(join(artifacts, "ux.2.json"), JSON.stringify({ verdict: "CHANGES", findings: "Rename the button." }));
    writeFileSync(join(artifacts, "build.1.json"), JSON.stringify({ summary: "src/summary.ts | 4 ++++" }));
    const spec = join(dir, "spec.md");
    writeFileSync(spec, "# Weekly summary\n\nShow the week.\n");

    assert.deepEqual(readReviewRounds(dir), [
      { n: 1, security: "PASS" },
      { n: 2, ux: "CHANGES" },
    ]);
    const files = readBoardFiles({
      runDir: dir,
      specPath: spec,
      workflow: "feature",
      gates: [{ stepId: "approve", prompt: "Approve?", choices: ["approve", "reject"], reviews: [{ name: "security", summary: "ignored, file wins" }] }],
    });
    assert.equal(files.find((file) => file.label === "spec.md")?.text.includes("Weekly summary"), true);
    assert.equal(files.find((file) => file.label === "build.md")?.text.includes("src/summary.ts"), true);
    const security = files.find((file) => file.group === "Round 1" && file.label === "security");
    assert.equal(security?.tone, "good");
    assert.match(security?.text ?? "", /No must-fix findings/);
    const ux = files.find((file) => file.group === "Round 2" && file.label === "ux");
    assert.equal(ux?.tone, "warn");
    assert.equal(files.some((file) => file.text === "ignored, file wins"), false);
  });
});
