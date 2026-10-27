import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readBoardFiles, readReviewRounds, stageOf, stagesFor, type StageJob } from "../src/board.js";

const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function stage(overrides: Partial<StageJob> & Pick<StageJob, "state">): StageJob {
  return { workflow: "feature", steps: [], ...overrides };
}

describe("board stages", () => {
  it("maps kiln states and the current yak step onto factory columns", () => {
    assert.equal(stageOf(stage({ state: "needs-human" })), "needs-human");
    assert.equal(stageOf(stage({ state: "failed" })), "needs-human");
    assert.equal(
      stageOf(
        stage({
          state: "failed",
          steps: [
            { id: "spec", phase: "done" },
            { id: "build", phase: "current" },
          ],
          attemptCount: 1,
          maxAttempts: 3,
          lastFailureReason: "stalled",
          nextRetryAt: "2026-10-26T23:35:46.000Z",
        }),
      ),
      "build",
    );
    assert.equal(
      stageOf(
        stage({
          state: "failed",
          steps: [{ id: "security", phase: "failed" }],
          attemptCount: 2,
          maxAttempts: 3,
          lastFailureReason: "crashed",
          nextRetryAt: "2026-10-26T23:35:46.000Z",
        }),
      ),
      "review",
    );
    assert.equal(
      stageOf(
        stage({
          state: "failed",
          steps: [{ id: "build", phase: "current" }],
          attemptCount: 3,
          maxAttempts: 3,
          lastFailureReason: "stalled",
          nextRetryAt: "2026-10-26T23:35:46.000Z",
        }),
      ),
      "needs-human",
    );
    assert.equal(stageOf(stage({ state: "dead" })), "needs-human");
    assert.equal(stageOf(stage({ state: "invalid" })), "needs-human");
    assert.equal(stageOf(stage({ state: "rejected" })), "needs-human");
    assert.equal(stageOf(stage({ state: "in-review" })), "pr-review");
    assert.equal(stageOf(stage({ state: "done" })), "merged");
    assert.equal(stageOf(stage({ state: "queued" })), "queued");
    assert.equal(stageOf(stage({ state: "blocked" })), "queued");
    assert.equal(stageOf(stage({ state: "queued", workflow: "investigation" })), "queued");
    assert.equal(stageOf(stage({ state: "blocked", workflow: "investigation" })), "queued");
    assert.equal(stageOf(stage({ state: "running", steps: [{ id: "spec", phase: "current" }] })), "spec");
    assert.equal(
      stageOf(stage({ state: "running", workflow: "investigation", steps: [{ id: "explore", phase: "current" }] })),
      "explore",
    );
    assert.equal(
      stageOf(stage({ state: "running", steps: [{ id: "spec", phase: "done" }, { id: "build", phase: "current" }] })),
      "build",
    );
    assert.equal(
      stageOf(stage({ state: "running", steps: [{ id: "security", phase: "current" }] })),
      "review",
    );
    assert.equal(stageOf(stage({ state: "running", steps: [{ id: "approve", phase: "current" }] })), "needs-human");
    assert.equal(stageOf(stage({ state: "approved" })), "land");
    assert.equal(
      stageOf(stage({ state: "approved", steps: [{ id: "build", phase: "current" }] })),
      "build",
    );

    const empty = stagesFor([]).map((item) => item.id);
    assert.deepEqual(empty, ["queued", "spec", "build", "review", "approve", "land", "pr-review", "merged", "needs-human"]);
    const probe = stagesFor([stage({ state: "queued", workflow: "investigation" })]).map((item) => item.id);
    assert.equal(probe[0], "queued");
    assert.ok(probe.includes("explore"));
    assert.ok(!probe.includes("spec"));
    assert.equal(probe.at(-1), "needs-human");
    const mixed = stagesFor([
      stage({ state: "queued", workflow: "feature" }),
      stage({ state: "queued", workflow: "investigation" }),
    ]).map((item) => item.id);
    assert.ok(mixed.includes("spec"));
    assert.ok(mixed.includes("explore"));
    assert.ok(mixed.indexOf("needs-human") > mixed.indexOf("merged"));
  });

  it("reads every review iteration and the drawer files", () => {
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
