import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PhaseView, StepMark } from "../src/job-view.js";
import { groupsFromPlan, phaseGroups } from "../src/phase-groups.js";

/** The shape of the feature workflow's `workflow.json`: needs name artifacts, and the loop body refers back a round. */
const FEATURE = [
  { kind: "agent", id: "spec", needs: ["input"], produces: "spec" },
  {
    kind: "loop",
    id: "revise",
    needs: ["spec"],
    produces: "rounds",
    body: [
      { kind: "agent", id: "build", needs: ["input", "spec", "security", "ux", "ui", "code", "verify"], produces: "build" },
      { kind: "command", id: "verify", needs: ["input", "build"], produces: "verify" },
      { kind: "agent", id: "security", needs: ["spec", "build", "verify"], produces: "security" },
      { kind: "agent", id: "ux", needs: ["spec", "build", "verify"], produces: "ux" },
      { kind: "agent", id: "ui", needs: ["spec", "build", "verify"], produces: "ui" },
      { kind: "agent", id: "code", needs: ["spec", "build", "verify"], produces: "code" },
    ],
  },
  { kind: "agent", id: "approver", needs: ["input", "spec", "rounds"], produces: "decision" },
  { kind: "gate", id: "approve", needs: ["input", "decision"], produces: "approval" },
  { kind: "command", id: "land", needs: ["input", "approval"] },
];

const mark = (id: string, status: StepMark["status"] = "pending", label = id): StepMark => ({ id, label, status });

describe("groupsFromPlan", () => {
  it("runs the four reviewers together and everything else in order, for the feature workflow", () => {
    assert.deepEqual(groupsFromPlan(FEATURE), [["spec"], ["build"], ["verify"], ["security", "ux", "ui", "code"], ["approver"], ["approve"], ["land"]]);
  });

  it("does not group the step after a loop with the loop's body, even when it needs none of it", () => {
    const plan = [
      { kind: "loop", id: "l", body: [{ kind: "agent", id: "a" }, { kind: "agent", id: "b" }] },
      { kind: "agent", id: "after" },
    ];
    assert.deepEqual(groupsFromPlan(plan), [["a", "b"], ["after"]]);
  });

  it("splits at a step that needs an earlier one, by its id or by what it produces", () => {
    assert.deepEqual(groupsFromPlan([{ id: "a", produces: "x" }, { id: "b", needs: ["x"] }, { id: "c", needs: ["a"] }]), [["a"], ["b", "c"]]);
    assert.deepEqual(groupsFromPlan([{ id: "a" }, { id: "b" }, { id: "c", needs: ["b"] }]), [["a", "b"], ["c"]]);
  });

  it("treats a needs that points at a later step as the previous round's output", () => {
    const plan = [{ kind: "loop", body: [{ id: "build", needs: ["review"] }, { id: "review", needs: ["build"], produces: "review" }] }];
    assert.deepEqual(groupsFromPlan(plan), [["build"], ["review"]]);
  });

  it("reads a map's step as one step, and ignores entries it cannot use", () => {
    assert.deepEqual(groupsFromPlan([{ kind: "map", id: "m", step: { id: "each" } }, null, 7, { kind: "agent" }, { id: "tail" }]), [["each"], ["tail"]]);
  });

  it("is empty for anything that is not a step list", () => {
    for (const bad of [undefined, null, "steps", 3, {}, []]) assert.deepEqual(groupsFromPlan(bad), []);
  });
});

describe("phaseGroups", () => {
  const steps = ["spec", "build", "verify", "security", "ux", "ui", "code", "approver", "approve", "land"].map((id) => mark(id));
  const planGroups = groupsFromPlan(FEATURE);

  it("follows the plan when it names exactly the job's steps", () => {
    const groups = phaseGroups({ steps, phases: [] }, planGroups);
    assert.deepEqual(groups.map((group) => group.map((node) => node.id)), planGroups);
  });

  it("falls back to one group of consecutive reviews when there is no plan or it does not match", () => {
    const expected = [["spec"], ["build"], ["verify"], ["security", "ux", "ui", "code"], ["approver"], ["approve"], ["land"]];
    assert.deepEqual(phaseGroups({ steps, phases: [] }).map((group) => group.map((node) => node.id)), expected);
    assert.deepEqual(phaseGroups({ steps, phases: [] }, [["spec"], ["other"]]).map((group) => group.map((node) => node.id)), expected);
    // Reviews that are not next to each other are not one group.
    const split = [mark("security"), mark("build"), mark("ux")];
    assert.deepEqual(phaseGroups({ steps: split, phases: [] }).map((group) => group.length), [1, 1, 1]);
  });

  it("carries each step's own status and label, and sums the rounds of a finished step", () => {
    const withState = steps.map((step) => (step.id === "security" ? mark("security", "done", "Security") : step.id === "ux" ? mark("ux", "running", "UX") : step));
    const phases: PhaseView[] = [
      { id: "security", label: "Security", status: "done", durationMs: 1000 },
      { id: "security", label: "Security", status: "done", durationMs: 2500 },
      { id: "ux", label: "UX", status: "running", durationMs: 9000 },
    ] as PhaseView[];
    const reviews = phaseGroups({ steps: withState, phases }, planGroups)[3] ?? [];
    assert.deepEqual(reviews.map((node) => [node.id, node.label, node.status]), [["security", "Security", "done"], ["ux", "UX", "running"], ["ui", "ui", "pending"], ["code", "code", "pending"]]);
    assert.equal(reviews[0]?.durationMs, 3500);
    assert.equal(reviews[1]?.durationMs, undefined);
  });
});
