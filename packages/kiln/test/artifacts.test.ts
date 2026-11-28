import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EMPTY_ARTIFACTS, previewOf, readRunArtifacts } from "../src/artifacts.js";

const keep: string[] = [];
after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function run(plan: unknown, files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "kiln-artifacts-"));
  keep.push(dir);
  mkdirSync(join(dir, "artifacts"));
  writeFileSync(join(dir, "workflow.json"), JSON.stringify({ steps: plan }));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, "artifacts", name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

const LOOP_PLAN = [
  { id: "spec", kind: "agent" },
  {
    kind: "loop",
    body: [
      { id: "build", kind: "agent" },
      { id: "verify", kind: "command" },
      { id: "security", kind: "agent" },
      { id: "code", kind: "agent" },
    ],
  },
  { id: "approver", kind: "agent", produces: "decision" },
];

const TWO_ROUNDS = {
  "input.json": { title: "T", description: "# T\n\nThe ask in words." },
  "spec.json": { goal: "G", design: "D", acceptance: "## Acceptance\n- [ ] AC1: one\n- [ ] AC2: two" },
  "build.1.json": { status: "READY", summary: "# Build\n\nRound one summary." },
  "build.2.json": { status: "READY", summary: "# Build\n\nRound two summary." },
  "verify.1.json": { stdout: "", stderr: "boom", exitCode: 1 },
  "verify.2.json": { stdout: "\u001b[32m367 passed\u001b[0m (367)", stderr: "", exitCode: 0 },
  "security.1.json": { verdict: "PASS", findings: "## Findings\n- [nit] a.ts: small\n- [nit] b.ts: small" },
  "security.2.json": { verdict: "PASS", findings: "None." },
  "code.1.json": { verdict: "CHANGES", findings: "- [must] Verify failed.\n- [nit] x" },
  "code.2.json": { verdict: "PASS", findings: "- [nit] y" },
  "decision.json": { decision: "APPROVE", reason: "## Reason\nAll passed." },
  "rounds.json": { build: { status: "READY" } },
  "approval.json": { decision: "approve" },
};

describe("readRunArtifacts", () => {
  it("is empty without a run folder, an artifacts folder, or any artifact", () => {
    assert.deepEqual(readRunArtifacts(undefined), EMPTY_ARTIFACTS);
    assert.deepEqual(readRunArtifacts(join(tmpdir(), "kiln-no-such-run")), EMPTY_ARTIFACTS);
    assert.deepEqual(readRunArtifacts(run(LOOP_PLAN, {})), EMPTY_ARTIFACTS);
  });

  it("groups into Start and rounds, newest first, with the post-loop artifact in the latest round", () => {
    const set = readRunArtifacts(run(LOOP_PLAN, TWO_ROUNDS));
    assert.deepEqual(set.start.map((entry) => entry.name), ["input", "spec"]);
    assert.deepEqual(set.rounds.map((round) => [round.round, round.latest]), [[2, true], [1, false]]);
    assert.deepEqual(set.rounds[0]?.entries.map((entry) => entry.name), ["build", "verify", "security", "code", "decision"]);
    assert.deepEqual(set.rounds[1]?.entries.map((entry) => entry.name), ["build", "verify", "security", "code"]);
    assert.equal(set.rounds[0]?.entries.at(-1)?.stepId, "approver");
  });

  it("skips the aggregate and the person's own click", () => {
    const set = readRunArtifacts(run(LOOP_PLAN, TWO_ROUNDS));
    const names = [...set.start, ...set.rounds.flatMap((round) => round.entries)].map((entry) => entry.name);
    assert.equal(names.includes("rounds"), false);
    assert.equal(names.includes("approval"), false);
  });

  it("words each shape: verdicts, notes, must fixes, exit codes, decisions", () => {
    const set = readRunArtifacts(run(LOOP_PLAN, TWO_ROUNDS));
    const find = (round: number, name: string) => set.rounds.find((item) => item.round === round)?.entries.find((entry) => entry.name === name);
    assert.deepEqual([find(1, "verify")?.chip, find(1, "verify")?.tone, find(1, "verify")?.detail], ["FAIL", "bad", "exit 1"]);
    assert.deepEqual([find(2, "verify")?.chip, find(2, "verify")?.tone, find(2, "verify")?.detail], ["PASS", "pass", "367 passed"]);
    assert.equal(find(2, "verify")?.body.includes("\u001b"), false);
    assert.deepEqual([find(1, "code")?.chip, find(1, "code")?.tone, find(1, "code")?.detail], ["CHANGES", "warn", "1 must fix"]);
    assert.deepEqual([find(1, "security")?.chip, find(1, "security")?.detail], ["PASS", "2 notes"]);
    assert.deepEqual([find(2, "decision")?.chip, find(2, "decision")?.tone], ["APPROVE", "pass"]);
    assert.equal(set.start.find((entry) => entry.name === "spec")?.chip, "Design and 2 criteria");
    assert.equal(set.start.find((entry) => entry.name === "input")?.kind, "ask");
  });

  it("with no rounds, lists everything in plan order as Start and makes no round", () => {
    const plan = [{ id: "a", kind: "agent" }, { id: "b", kind: "agent", produces: "report" }];
    const set = readRunArtifacts(run(plan, { "report.json": { goal: "x", design: "y", acceptance: "z" }, "a.json": { status: "OK", summary: "did a" } }));
    assert.deepEqual(set.rounds, []);
    assert.deepEqual(set.start.map((entry) => entry.name), ["a", "report"]);
  });

  it("shows any text field of a shape it does not know, and ignores files it cannot read", () => {
    const dir = run([{ id: "custom", kind: "agent" }], {
      "custom.json": { notes: "hello there", count: 3, empty: "  " },
      "broken.json": "{ not json",
      "list.json": [1, 2],
      "bad name.json": { notes: "no" },
      "..hidden.json": { notes: "no" },
    });
    writeFileSync(join(dir, "outside.json"), JSON.stringify({ notes: "outside" }));
    symlinkSync(join(dir, "outside.json"), join(dir, "artifacts", "linked.json"));
    const set = readRunArtifacts(dir);
    assert.deepEqual(set.start.map((entry) => entry.name), ["custom"]);
    assert.equal(set.start[0]?.kind, "other");
    assert.match(set.start[0]?.body ?? "", /## notes\n\nhello there/);
    assert.doesNotMatch(set.start[0]?.body ?? "", /count|empty/);
  });

  it("reads nothing when the artifacts folder, or the run folder, is a symlink to somewhere else", () => {
    const real = run([{ id: "build", kind: "agent" }], { "build.json": { status: "READY", summary: "outside" } });
    // The artifacts folder is a symlink to a real folder full of valid artifacts.
    const viaFolder = mkdtempSync(join(tmpdir(), "kiln-artifacts-"));
    keep.push(viaFolder);
    symlinkSync(join(real, "artifacts"), join(viaFolder, "artifacts"));
    assert.deepEqual(readRunArtifacts(viaFolder), EMPTY_ARTIFACTS);
    // The run folder itself is a symlink: its real path is elsewhere, so it still reads the real run's own artifacts.
    const viaRun = join(mkdtempSync(join(tmpdir(), "kiln-artifacts-")), "linked-run");
    keep.push(join(viaRun, ".."));
    symlinkSync(real, viaRun);
    assert.equal(readRunArtifacts(viaRun).start[0]?.name, "build");
  });

  it("clips a very large body", () => {
    const set = readRunArtifacts(run([{ id: "build", kind: "agent" }], { "build.json": { status: "READY", summary: "x".repeat(60_000) } }));
    assert.ok((set.start[0]?.body.length ?? 0) < 20_100);
  });
});

describe("previewOf", () => {
  it("makes one plain line without headings, list markers, tags, or ticks", () => {
    assert.equal(previewOf("## Findings\n- [must] `a.ts`: **broken** thing\n- [nit] other"), "a.ts: broken thing other");
  });

  it("cuts a long line and marks the cut", () => {
    const out = previewOf("word ".repeat(100));
    assert.ok(out.length <= 175 && out.endsWith("..."));
  });
});
