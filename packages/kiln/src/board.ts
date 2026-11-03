import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ObservedGate } from "./reconcile.js";

/**
 * Review rounds and the artifact texts `kiln status` attaches to a job.
 * The serve shell reads phases from the event log; these readers stay for
 * that status payload.
 */

export interface BoardReviewRound {
  n: number;
  security?: string;
  ux?: string;
  ui?: string;
  code?: string;
}

export interface BoardFile {
  id: string;
  group: string;
  label: string;
  text: string;
  tone?: "good" | "warn" | "stop";
}

const REVIEW_FILE = /^(security|ux|ui|code)(?:\.(\d+))?\.json$/;
const TEXT_LIMIT = 8_000;

export function readReviewRounds(runDir: string | undefined): BoardReviewRound[] {
  if (!runDir) return [];
  const dir = join(runDir, "artifacts");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rounds = new Map<number, BoardReviewRound>();
  for (const name of names) {
    const match = REVIEW_FILE.exec(name);
    if (!match?.[1]) continue;
    const n = match[2] ? Number(match[2]) : 1;
    const round = rounds.get(n) ?? { n };
    const verdict = verdictOf(readJson(join(dir, name)));
    if (verdict) {
      if (match[1] === "security") round.security = verdict;
      else if (match[1] === "ux") round.ux = verdict;
      else if (match[1] === "ui") round.ui = verdict;
      else if (match[1] === "code") round.code = verdict;
    }
    rounds.set(n, round);
  }
  return [...rounds.values()].sort((left, right) => left.n - right.n);
}

export function readBoardFiles(input: {
  runDir?: string;
  specPath?: string;
  findingsPath?: string;
  diffSummary?: string;
  logTail?: string;
  workflow?: string;
  gates?: ObservedGate[];
}): BoardFile[] {
  const files: BoardFile[] = [];
  const spec = readText(input.specPath);
  if (spec) files.push({ id: "spec", group: "Job", label: "spec.md", text: spec });

  const build = latestArtifact(input.runDir, "build");
  if (build) {
    const doc = artifactDoc(build);
    files.push({ id: "build", group: "Job", label: "build.md", text: doc.text, ...(doc.tone ? { tone: doc.tone } : {}) });
  } else if (input.diffSummary?.trim()) {
    files.push({ id: "build", group: "Job", label: "build.md", text: input.diffSummary.trim() });
  }

  const decision = latestArtifact(input.runDir, "decision");
  if (decision) {
    const doc = artifactDoc(decision);
    files.push({ id: "decision", group: "Job", label: "decision.md", text: doc.text, ...(doc.tone ? { tone: doc.tone } : {}) });
  }

  const findingsFile = readText(input.findingsPath);
  const findingsArtifact = latestArtifact(input.runDir, "findings");
  const findingsMarkdown = findingsFile
    || (isRecord(findingsArtifact) && typeof findingsArtifact.markdown === "string" ? findingsArtifact.markdown : "");
  if (input.workflow === "investigation" && findingsMarkdown.trim()) {
    files.push({ id: "findings", group: "Job", label: "findings.md", text: clip(findingsMarkdown) });
  }

  for (const gate of input.gates ?? []) {
    const body = gate.rendered?.trim() || gate.prompt?.trim();
    if (body) {
      const label = input.workflow === "investigation" ? "findings.md" : "gate.md";
      if (!files.some((file) => file.label === label && file.text.includes(body.slice(0, 40)))) {
        files.push({ id: `gate-${gate.stepId}`, group: "Job", label, text: clip(body) });
      }
    }
    for (const artifact of gate.artifacts ?? []) {
      if (!artifact.summary?.trim()) continue;
      const label = artifact.name.endsWith(".md") ? artifact.name : `${artifact.name}.md`;
      if (files.some((file) => file.label === label || file.label === artifact.name)) continue;
      const tone = toneFromSummary(artifact.summary);
      files.push({
        id: `artifact-${gate.stepId}-${artifact.name}`,
        group: "Job",
        label,
        text: clip(artifact.summary),
        ...(tone ? { tone } : {}),
      });
    }
  }

  if (input.runDir) addReviewFiles(files, input.runDir);
  addGateReviews(files, input.gates ?? []);

  if (input.logTail?.trim()) {
    files.push({ id: "log", group: "Job", label: "log", text: clip(input.logTail) });
  }
  return files;
}

function addReviewFiles(files: BoardFile[], runDir: string): void {
  const dir = join(runDir, "artifacts");
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const rows: { n: number; kind: string; file: string }[] = [];
  for (const name of names) {
    const match = REVIEW_FILE.exec(name);
    if (!match?.[1]) continue;
    rows.push({ n: match[2] ? Number(match[2]) : 1, kind: match[1], file: name });
  }
  const order = ["security", "ux", "ui", "code"];
  rows.sort((left, right) => left.n - right.n || order.indexOf(left.kind) - order.indexOf(right.kind));
  for (const row of rows) {
    const doc = artifactDoc(readJson(join(dir, row.file)));
    files.push({
      id: `r${row.n}-${row.kind}`,
      group: `Round ${row.n}`,
      label: row.kind,
      text: doc.text,
      ...(doc.tone ? { tone: doc.tone } : {}),
    });
  }
}

function latestArtifact(runDir: string | undefined, name: string): unknown {
  if (!runDir) return undefined;
  const dir = join(runDir, "artifacts");
  if (!existsSync(dir)) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { iter: number; file: string } | undefined;
  const pattern = new RegExp(`^${name}(?:\\.(\\d+))?\\.json$`);
  for (const file of names) {
    const match = pattern.exec(file);
    if (!match) continue;
    const iter = match[1] ? Number(match[1]) : 0;
    if (!best || iter >= best.iter) best = { iter, file };
  }
  return best ? readJson(join(dir, best.file)) : undefined;
}

function artifactDoc(value: unknown): { text: string; tone?: "good" | "warn" | "stop" } {
  if (!isRecord(value)) return { text: clip(typeof value === "string" ? value : "") };
  const head = typeof value.verdict === "string" ? value.verdict : typeof value.decision === "string" ? value.decision : typeof value.status === "string" ? value.status : "";
  const body =
    typeof value.findings === "string"
      ? value.findings
      : typeof value.reason === "string"
        ? value.reason
        : typeof value.summary === "string"
          ? value.summary
          : typeof value.markdown === "string"
            ? value.markdown
            : JSON.stringify(value, null, 2);
  const tone = toneOf(head);
  const text = head ? `VERDICT: ${head}\n\n${body}` : body;
  return { text: clip(text), ...(tone ? { tone } : {}) };
}

function toneOf(head: string): "good" | "warn" | "stop" | undefined {
  if (head === "PASS" || head === "APPROVE" || head === "READY") return "good";
  if (head === "CHANGES") return "warn";
  if (head === "ESCALATE" || head === "BLOCKED") return "stop";
  return undefined;
}

function toneFromSummary(summary: string): "good" | "warn" | "stop" | undefined {
  const head = summary.trim().split(/[\s—-]/)[0] ?? "";
  return toneOf(head);
}

function addGateReviews(files: BoardFile[], gates: ObservedGate[]): void {
  const known = new Set(files.filter((file) => file.group.startsWith("Round")).map((file) => file.label));
  for (const gate of gates) {
    for (const review of gate.reviews ?? []) {
      if (!review.summary?.trim() || known.has(review.name)) continue;
      known.add(review.name);
      const tone = toneFromSummary(review.summary);
      files.push({
        id: `review-${review.name}`,
        group: "Round 1",
        label: review.name,
        text: clip(review.summary),
        ...(tone ? { tone } : {}),
      });
    }
  }
}

function verdictOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const verdict = value.verdict;
  return typeof verdict === "string" && verdict.trim() ? verdict.trim() : undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readText(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, "utf8").trim();
    return text ? clip(text) : undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TEXT_LIMIT) return trimmed;
  return `${trimmed.slice(0, TEXT_LIMIT - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
