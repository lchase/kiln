import type { KilnEvent } from "./events.js";
import { readEvents } from "./events.js";
import { redact } from "./redact.js";

const REVIEW_STEPS = ["security", "ux", "ui", "code"] as const;

/**
 * Short factual Evidence section for a pull request body, built from the
 * job's events. The whole section goes through `redact`.
 */
export function evidenceSection(events: readonly KilnEvent[], jobId: string): string {
  const rows = events.filter((event) => event.job_id === jobId);
  const lines = ["## Evidence", ""];
  const version = versionLine(rows);
  if (version) lines.push(version);
  const phases = phaseLine(rows);
  if (phases) lines.push(phases);
  const test = testLine(rows);
  if (test) lines.push(test);
  const reviews = reviewLine(rows);
  if (reviews) lines.push(reviews);
  const feedback = feedbackLine(rows);
  if (feedback) lines.push(feedback);
  const gates = gateLine(rows);
  if (gates) lines.push(gates);
  if (lines.length === 2) lines.push("- (no events)");
  return redact(`${lines.join("\n")}\n`);
}

export function evidenceSectionFor(kilnDir: string, jobId: string): string {
  return evidenceSection(readEvents(kilnDir), jobId);
}

function versionLine(events: readonly KilnEvent[]): string | undefined {
  const started = [...events].reverse().find((event) => event.event === "run.started");
  if (!started || started.event !== "run.started") return undefined;
  const props = started.properties;
  const hash = props.prompts_hash.length > 12 ? props.prompts_hash.slice(0, 12) : props.prompts_hash;
  return `- versions: kiln ${props.kiln_version}, yak ${props.yak_version}, workflow ${props.workflow}, prompts ${hash}`;
}

function phaseLine(events: readonly KilnEvent[]): string | undefined {
  const order: string[] = [];
  const failed = new Set<string>();
  for (const event of events) {
    if (!event.step) continue;
    if ((event.event === "phase.started" || event.event === "phase.finished") && !order.includes(event.step)) {
      order.push(event.step);
    }
    if (event.event === "phase.finished" && event.properties.outcome === "failed") failed.add(event.step);
  }
  if (order.length === 0) return undefined;
  const shown = order.map((step) => (failed.has(step) ? `${step} failed` : step));
  return `- phases: ${shown.join(", ")}`;
}

function testLine(events: readonly KilnEvent[]): string | undefined {
  const verify = [...events].reverse().find((event) => event.event === "phase.finished" && event.step === "verify");
  if (!verify || verify.event !== "phase.finished") return undefined;
  const command = verify.properties.test_command;
  const exit = verify.properties.exit_code;
  if (!command && exit === undefined) return undefined;
  const commandText = command ? `\`${command}\`` : "(command not recorded)";
  const result = exit === undefined ? "result unknown" : `exit ${exit}`;
  return `- test: ${commandText} ${result}`;
}

function reviewLine(events: readonly KilnEvent[]): string | undefined {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.event !== "phase.finished" || !event.step || !REVIEW_STEPS.includes(event.step as (typeof REVIEW_STEPS)[number])) {
      continue;
    }
    if (event.properties.verdict) latest.set(event.step, event.properties.verdict);
  }
  const parts = REVIEW_STEPS.flatMap((step) => {
    const verdict = latest.get(step);
    return verdict ? [`${step} ${verdict}`] : [];
  });
  if (parts.length === 0) return undefined;
  return `- reviews: ${parts.join(", ")}`;
}

function feedbackLine(events: readonly KilnEvent[]): string | undefined {
  const rounds = new Map<number, { trigger: string; outcome?: string; items?: number }>();
  for (const event of events) {
    if (event.event !== "pr.feedback") continue;
    const previous = rounds.get(event.properties.round);
    rounds.set(event.properties.round, {
      trigger: event.properties.trigger,
      items: event.properties.items ?? previous?.items,
      outcome: event.properties.outcome ?? previous?.outcome,
    });
  }
  if (rounds.size === 0) return undefined;
  const parts = [...rounds.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([round, info]) => {
      const items = info.items === undefined ? "" : ` (${info.items} ${info.items === 1 ? "item" : "items"})`;
      const outcome = info.outcome ? ` ${info.outcome}` : "";
      return `round ${round} ${info.trigger}${items}${outcome}`;
    });
  return `- feedback: ${parts.join("; ")}`;
}

function gateLine(events: readonly KilnEvent[]): string | undefined {
  const opened = events.filter((event) => event.event === "gate.opened");
  const resolved = new Map<string, Extract<KilnEvent, { event: "gate.resolved" }>>();
  for (const event of events) {
    if (event.event === "gate.resolved" && event.step) resolved.set(event.step, event);
  }
  const steps = new Set<string>();
  for (const event of opened) if (event.step) steps.add(event.step);
  for (const step of resolved.keys()) steps.add(step);
  if (steps.size === 0) return undefined;
  const parts: string[] = [];
  for (const step of steps) {
    const answer = resolved.get(step);
    if (!answer) {
      parts.push(`${step} open`);
      continue;
    }
    const edit = answer.properties.edit || answer.properties.note;
    const noted = edit ? ", edit noted" : "";
    parts.push(`${step} by ${answer.properties.by}: ${answer.properties.decision}${noted}`);
  }
  return `- gates: ${parts.join("; ")}`;
}
