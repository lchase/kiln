import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";
import { truncateCaptured } from "./truncate-output.js";

/**
 * Live activity for one yak run. The claude-code adapter appends SDK messages to
 * `sessions/<step>.jsonl`. A command step writes `artifacts/<step>.json`.
 */

export type ActivityKind = "message" | "tool" | "edit" | "command" | "result" | "error";

/** `note` is the agent speaking (a `message`). Everything else is an `action`. */
export type ActivityRole = "note" | "action";

export interface ActivityEvent {
  at: string;
  phase: string;
  kind: ActivityKind;
  role: ActivityRole;
  summary: string;
  detail?: string;
}

export interface ActivityFeed {
  running: boolean;
  phase?: string;
  cursor: string;
  events: ActivityEvent[];
  raw: string;
  lastActivityAt?: string;
}

interface Sourced extends Omit<ActivityEvent, "role"> {
  source: string;
  line: number;
  command?: string;
  /** `$ <full original command>`, the head of a command event's detail. */
  shell?: string;
}

type ToolView = { kind: ActivityKind; summary: string; command?: string; shell?: string };

interface SourceFile {
  source: string;
  phase: string;
  events: Sourced[];
  raw: string;
  lastLine: number;
}

type ToolInput = Record<string, unknown>;

const CURSOR_PART = /^([A-Za-z0-9][A-Za-z0-9._-]*):(\d+)$/;
const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/;
const ARTIFACT_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.(\d+))?\.json$/;

/**
 * Known tools. Anything else is the tool name, plus a path when the input has one.
 * `root` is the run's worktree, from the session's init `cwd`, when known.
 */
const TOOLS: Record<string, (input: ToolInput, root: string | undefined) => ToolView> = {
  Read: (input, root) => ({ kind: "tool", summary: `Read ${pathOf(input, root)}` }),
  Edit: (input, root) => ({ kind: "edit", summary: `Edit ${pathOf(input, root)}${statOf(str(input, "old_string"), str(input, "new_string"))}` }),
  Write: (input, root) => ({ kind: "edit", summary: `Write ${pathOf(input, root)}${statOf("", str(input, "content"))}` }),
  Bash: (input, root) => {
    const full = str(input, "command");
    const command = clip(full ? tidyCommand(full.split("\n")[0] ?? full, root) : "command");
    return { kind: "command", summary: `Ran ${command}`, command, ...(full ? { shell: `$ ${full.trim()}` } : {}) };
  },
  Grep: (input, root) => ({ kind: "tool", summary: where("Grep", str(input, "pattern"), str(input, "path"), root) }),
  Glob: (input) => ({ kind: "tool", summary: `Glob ${str(input, "pattern") ?? ""}`.trim() }),
  Skill: (input) => ({ kind: "tool", summary: `Skill ${str(input, "skill") ?? ""}`.trim() }),
  StructuredOutput: () => ({ kind: "tool", summary: "Returned its result" }),
};

export function parseActivityCursor(raw: string | null | undefined): Map<string, number> | undefined {
  if (raw == null || raw === "") return new Map();
  const map = new Map<string, number>();
  for (const part of raw.split(",")) {
    const match = CURSOR_PART.exec(part);
    const line = match?.[2] === undefined ? NaN : Number(match[2]);
    if (!match?.[1] || !Number.isInteger(line) || line < 0) return undefined;
    map.set(match[1], line);
  }
  return map;
}

/** One stream-json session. A trailing partial line is not an event yet. */
export function parseActivityStream(text: string, phase: string, fallbackAt: string): ActivityEvent[] {
  return parseSession(text, phase, "session.jsonl", fallbackAt).events.map(publish);
}

export function newestActivityAt(runDir: string): string | undefined {
  return newestActivity(runDir).at;
}

/** Newest activity time and newest note (published: redacted and clipped), from one read of the run. */
export function newestActivity(runDir: string): { at?: string; note?: { text: string; at: string } } {
  try {
    if (!existsSync(runDir)) return {};
    const feed = readRunActivity(runDir, { running: false });
    const note = feed.events.reduce<ActivityEvent | undefined>(
      (latest, event) => (event.role === "note" && (!latest || event.at >= latest.at) ? event : latest),
      undefined,
    );
    return { ...(feed.lastActivityAt ? { at: feed.lastActivityAt } : {}), ...(note ? { note: { text: note.summary, at: note.at } } : {}) };
  } catch {
    return {};
  }
}

export function readRunActivity(
  runDir: string | undefined,
  options: { running: boolean; after?: string; logText?: string },
): ActivityFeed {
  const after = parseActivityCursor(options.after ?? "") ?? new Map();
  const sources = runDir && existsSync(runDir) ? loadSources(runDir) : [];
  const seen = new Map(after);
  const all: Sourced[] = [];
  for (const source of sources) {
    seen.set(source.source, Math.max(seen.get(source.source) ?? 0, source.lastLine));
    all.push(...source.events);
  }
  const journal = runDir ? phaseState(runDir) : { order: [] as string[], open: undefined as string | undefined };
  const phase = (options.running ? journal.open : undefined) ?? [...sources].reverse().find((source) => source.raw || source.events.length)?.phase;
  const rawText = [...sources].reverse().find((source) => source.phase === phase && source.raw)?.raw ?? (sources.length ? "" : options.logText ?? "");
  const lastActivityAt = all.reduce<string | undefined>((latest, event) => (!latest || event.at > latest ? event.at : latest), undefined);
  return {
    running: options.running,
    ...(phase ? { phase } : {}),
    cursor: [...seen].filter(([, line]) => line > 0).sort((a, b) => a[0].localeCompare(b[0])).map(([name, line]) => `${name}:${line}`).join(","),
    events: all.filter((event) => event.line > (after.get(event.source) ?? 0)).map(publish),
    raw: rawText ? truncateCaptured(redact(rawText), "stdout") : "",
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

function loadSources(runDir: string): SourceFile[] {
  const order = phaseState(runDir).order;
  const sessions = new Set<string>();
  const sources: SourceFile[] = [];
  for (const name of dirNames(join(runDir, "sessions"))) {
    const phase = SESSION_FILE.exec(name)?.[1];
    if (!phase) continue;
    sessions.add(phase);
    const file = join(runDir, "sessions", name);
    sources.push(parseSession(textOf(file), phase, name, mtimeOf(file)));
  }
  for (const name of dirNames(join(runDir, "artifacts"))) {
    const match = ARTIFACT_FILE.exec(name);
    if (!match?.[1] || sessions.has(match[1])) continue;
    const file = join(runDir, "artifacts", name);
    const parsed = parseCommand(textOf(file), match[1], name, mtimeOf(file));
    if (parsed) sources.push(parsed);
  }
  const place = (phase: string) => { const index = order.indexOf(phase); return index === -1 ? order.length + 1 : index; };
  return sources.sort((left, right) => place(left.phase) - place(right.phase) || left.source.localeCompare(right.source));
}

function parseSession(text: string, phase: string, source: string, fallbackAt: string): SourceFile {
  const lines = completeLines(text);
  const events: Sourced[] = [];
  const pending = new Map<string, Sourced>();
  const raw: string[] = [];
  let root: string | undefined;
  const push = (line: number, at: string, event: Omit<Sourced, "source" | "line" | "at" | "phase">): Sourced => {
    const full = { ...event, source, line, at, phase };
    events.push(full);
    return full;
  };
  lines.forEach((line, index) => {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const at = stamp(record, fallbackAt);
    const lineNo = index + 1;
    if (record.type === "system" && record.subtype === "init" && typeof record.cwd === "string" && record.cwd.trim()) {
      // A resumed session appends a second init; the latest cwd wins from here on.
      root = record.cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "") || undefined;
    } else if (record.type === "assistant") {
      for (const block of blocks(record.message)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          push(lineNo, at, { kind: "message", ...said(block.text) });
          raw.push(block.text.trim());
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const view = toolOf(block.name, inputOf(block.input), root);
          const event = push(lineNo, at, {
            kind: view.kind,
            summary: view.summary,
            ...(view.command ? { command: view.command } : {}),
            ...(view.shell ? { shell: view.shell, detail: view.shell } : {}),
          });
          pending.set(typeof block.id === "string" ? block.id : `${lineNo}:${block.name}`, event);
          raw.push(view.summary);
        }
      }
    } else if (record.type === "user") {
      for (const block of blocks(record.message)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const event = pending.get(block.tool_use_id);
        if (!event?.command) continue;
        const output = toolText(block.content);
        const failed = failureOf(output);
        event.summary = failed ? `Ran ${event.command} - ${failed}` : block.is_error === true ? `Ran ${event.command} - failed` : event.summary;
        const tail = output.split("\n").slice(-40).join("\n");
        if (output) event.detail = event.shell ? `${event.shell}\n\n${tail}` : tail;
        event.line = lineNo;
        event.at = at;
        if (output) raw.push(output);
      }
    } else if (record.type === "result") {
      const errors = Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string").join("\n").trim() : "";
      const failed = record.subtype !== "success" || record.is_error === true;
      const body = failed ? errors : typeof record.result === "string" ? record.result.trim() : "";
      const shown = body && !body.startsWith("{") && !body.startsWith("[") ? said(body) : { summary: failed ? "The step failed" : "Step finished" };
      push(lineNo, at, { kind: failed ? "error" : "result", ...shown });
      raw.push(shown.detail ?? shown.summary);
    }
  });
  return { source, phase, events, raw: raw.join("\n"), lastLine: lines.length };
}

function parseCommand(text: string, phase: string, source: string, at: string): SourceFile | undefined {
  let parsed: { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  try {
    parsed = JSON.parse(text) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const stdout = typeof parsed.stdout === "string" ? parsed.stdout : "";
  const stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";
  const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : undefined;
  if (!stdout && !stderr && exitCode === undefined) return undefined;
  const output = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.trim();
  const failed = failureOf(output);
  const verb = phase === "verify" ? "Ran tests" : "Ran command";
  const summary = failed ? `${verb} - ${failed}` : exitCode ? `${verb} - exit ${exitCode}` : verb;
  return {
    source,
    phase,
    raw: output,
    lastLine: 1,
    events: [{ at, phase, source, line: 1, kind: exitCode ? "error" : "command", summary, ...(output && output !== summary ? { detail: output } : {}) }],
  };
}

function toolOf(name: string, input: ToolInput, root: string | undefined): ToolView {
  return TOOLS[name]?.(input, root) ?? { kind: "tool", summary: str(input, "file_path") ? `${name} ${shortPath(str(input, "file_path") ?? "", root)}` : name || "Tool" };
}

/**
 * Drops a leading `cd` into the worktree and shows worktree paths relative to it.
 * `cd <root>/<sub> && rest` reads `in <sub>: rest`. Only `<root>` on a path boundary
 * matches, so `<root>-other` and paths outside the worktree stay as written.
 */
function tidyCommand(command: string, root: string | undefined): string {
  if (!root) return command;
  const at = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = new RegExp(`^\\s*cd\\s+(["']?)${at}(/[^"'\\s;&|]*)?\\1\\s*(?:&&|;)\\s*`).exec(command);
  const sub = lead?.[2]?.replace(/^\/+|\/+$/g, "");
  const rest = (lead ? command.slice(lead[0].length) : command).replace(
    new RegExp(`${at}(?:/|(?=[\\s"';&)]|$))`, "g"),
    (match) => (match.endsWith("/") ? "" : "."),
  );
  return sub ? `in ${sub}: ${rest}` : rest;
}

function pathOf(input: ToolInput, root: string | undefined): string {
  const file = str(input, "file_path");
  return file ? shortPath(file, root) : "file";
}

function where(verb: string, pattern: string | undefined, path: string | undefined, root: string | undefined): string {
  if (pattern && path) return `${verb} ${pattern} in ${shortPath(path, root)}`;
  return `${verb} ${pattern ?? ""}`.trim();
}

function statOf(before: string | undefined, after: string | undefined): string {
  if (before === undefined || after === undefined) return "";
  const delta = (lines: string) => {
    const map = new Map<string, number>();
    if (lines) for (const line of lines.split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = delta(before);
  const newLines = delta(after);
  let added = 0;
  let removed = 0;
  for (const key of new Set([...oldLines.keys(), ...newLines.keys()])) {
    const change = (newLines.get(key) ?? 0) - (oldLines.get(key) ?? 0);
    if (change > 0) added += change;
    else if (change < 0) removed -= change;
  }
  if (added > 0 && removed > 0) return ` (+${added} -${removed})`;
  if (added > 0) return ` (+${added})`;
  return removed > 0 ? ` (-${removed})` : "";
}

function failureOf(text: string): string | undefined {
  const node = /#\s+fail\s+(\d+)/.exec(text);
  if (node?.[1] && node[1] !== "0") return `${node[1]} failed`;
  const failed = [...text.matchAll(/\b(\d+)\s+failed\b/gi)].at(-1)?.[1];
  return failed && failed !== "0" ? `${failed} failed` : undefined;
}

/** First line is the collapsed summary. The full text is the expand, so it replaces that line. */
function said(text: string): { summary: string; detail?: string } {
  const trimmed = text.trim();
  const summary = clip(trimmed.split("\n")[0] ?? trimmed);
  return trimmed === summary ? { summary } : { summary, detail: trimmed };
}

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`;
}

function shortPath(file: string, root?: string): string {
  const normalized = file.replaceAll("\\", "/");
  if (root && normalized === root) return ".";
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  const workspace = normalized.lastIndexOf("/workspace/");
  if (workspace !== -1) return normalized.slice(workspace + "/workspace/".length);
  const src = normalized.lastIndexOf("/src/");
  return src !== -1 ? normalized.slice(src + 1) : normalized;
}

function blocks(message: unknown): Record<string, unknown>[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object") : [];
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function inputOf(value: unknown): ToolInput {
  return value && typeof value === "object" ? (value as ToolInput) : {};
}

function publish(event: Sourced): ActivityEvent {
  const summary = redact(event.summary).trim() || "Activity";
  const detail = event.detail ? redact(event.detail).trim() : "";
  const role: ActivityRole = event.kind === "message" ? "note" : "action";
  return { at: event.at, phase: event.phase, kind: event.kind, role, summary, ...(detail && detail !== summary ? { detail } : {}) };
}

function completeLines(text: string): string[] {
  if (!text) return [];
  const end = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1;
  if (end <= 0) return [];
  const parts = text.slice(0, end).split("\n");
  parts.pop();
  return parts;
}

function stamp(record: Record<string, unknown>, fallback: string): string {
  const ms = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function str(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function phaseState(runDir: string): { order: string[]; open?: string } {
  const order: string[] = [];
  const open = new Map<string, boolean>();
  let last: string | undefined;
  let finished = false;
  for (const line of completeLines(textOf(join(runDir, "journal.jsonl")))) {
    let event: { t?: string; stepId?: string };
    try {
      event = JSON.parse(line) as { t?: string; stepId?: string };
    } catch {
      continue;
    }
    if (event.t === "run.finished") finished = true;
    if (!event.stepId) continue;
    if (event.t === "step.started") {
      if (!order.includes(event.stepId)) order.push(event.stepId);
      open.set(event.stepId, true);
      last = event.stepId;
    } else if (event.t === "step.completed" || event.t === "step.failed") open.set(event.stepId, false);
  }
  const current = finished ? undefined : last && open.get(last) ? last : [...open].find(([, on]) => on)?.[0];
  return { order, ...(current ? { open: current } : {}) };
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function textOf(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function mtimeOf(file: string): string {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
