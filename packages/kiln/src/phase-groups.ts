import { isReviewStep, type JobView, type PhaseStatus, type PhaseView, type StepMark } from "./job-view.js";

/**
 * The job page's phase chain: which steps run in order and which run at the same time. A step joins the group before
 * it when it is side by side with it (the same top level, or the same loop body) and does not need anything that
 * group makes. The plan comes from a run's `workflow.json`, so this works for any workflow, not only the feature one.
 */

export interface PhaseNode {
  id: string;
  label: string;
  status: PhaseStatus;
  /** Set once the step is done or failed. A step that ran in several rounds sums them. */
  durationMs?: number;
}

interface Leaf {
  id: string;
  /** What the step is called in another step's `needs`: its id and what it produces. */
  names: string[];
  needs: string[];
}

function leafOf(record: Record<string, unknown>): Leaf | undefined {
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  const names = [record.id];
  if (typeof record.produces === "string" && record.produces.length > 0) names.push(record.produces);
  const needs = Array.isArray(record.needs) ? record.needs.filter((item): item is string => typeof item === "string") : [];
  return { id: record.id, names, needs };
}

/**
 * Plain steps that sit next to each other at one level, in order. A loop or map body is its own container, so a step
 * after a loop is never grouped with a step inside it.
 */
function containers(steps: unknown): Leaf[][] {
  const out: Leaf[][] = [];
  if (!Array.isArray(steps)) return out;
  let run: Leaf[] = [];
  const flush = () => {
    if (run.length > 0) out.push(run);
    run = [];
  };
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    if (record.kind === "loop") {
      flush();
      out.push(...containers(record.body));
    } else if (record.kind === "map") {
      flush();
      out.push(...containers([record.step]));
    } else {
      const leaf = leafOf(record);
      if (leaf) run.push(leaf);
    }
  }
  flush();
  return out;
}

/**
 * Step ids grouped in run order, from a yak `workflow.json` `steps` array. A group of more than one step runs at the
 * same time. A `needs` that points at a later step is the previous round's output, so it does not split a group.
 */
export function groupsFromPlan(steps: unknown): string[][] {
  const groups: string[][] = [];
  for (const container of containers(steps)) {
    let current: Leaf[] = [];
    for (const leaf of container) {
      const made = new Set(current.flatMap((item) => item.names));
      if (current.length > 0 && !leaf.needs.some((need) => made.has(need))) {
        current.push(leaf);
        continue;
      }
      if (current.length > 0) groups.push(current.map((item) => item.id));
      current = [leaf];
    }
    if (current.length > 0) groups.push(current.map((item) => item.id));
  }
  return groups;
}

function nodeOf(step: StepMark, phases: readonly PhaseView[]): PhaseNode {
  const node: PhaseNode = { id: step.id, label: step.label, status: step.status };
  if (step.status !== "done" && step.status !== "failed") return node;
  const durations = phases.filter((phase) => phase.id === step.id && phase.durationMs !== undefined).map((phase) => phase.durationMs ?? 0);
  if (durations.length > 0) node.durationMs = durations.reduce((sum, ms) => sum + ms, 0);
  return node;
}

/**
 * The job's steps as groups for the chain. With a plan that names exactly the job's steps, the groups follow it.
 * Without one (a queued job has no run folder yet) or when it does not match, consecutive review steps are the one
 * group that runs together, as they did before the chain.
 */
export function phaseGroups(job: Pick<JobView, "steps" | "phases">, plan?: readonly (readonly string[])[]): PhaseNode[][] {
  const nodes = new Map<string, PhaseNode>(job.steps.map((step) => [step.id, nodeOf(step, job.phases)]));
  if (plan && plan.length > 0) {
    const planned = plan.flat();
    if (planned.length === nodes.size && planned.every((id) => nodes.has(id))) {
      return plan.map((ids) => ids.flatMap((id) => nodes.get(id) ?? []));
    }
  }
  const groups: PhaseNode[][] = [];
  for (const step of job.steps) {
    const node = nodes.get(step.id);
    if (!node) continue;
    const last = groups.at(-1);
    if (last && isReviewStep(step.id) && isReviewStep(last[0]?.id ?? "")) last.push(node);
    else groups.push([node]);
  }
  return groups;
}
