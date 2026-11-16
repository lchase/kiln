import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { redact } from "./redact.js";

/**
 * Live activity for one yak run.
 *
 * The claude-code adapter appends each SDK message to
 * `<checkout>/.runs/<runId>/sessions/<step>.jsonl`. A command step such as
 * verify has no session file; its plain output is the artifact
 * `artifacts/<step>.json` (`stdout`, `stderr`, `exitCode`), or
 * `artifacts/<step>.<iteration>.json` inside a loop.
 *
 * Events are a readable feed. The raw JSON lines stay on disk.
 */

export type ActivityKind = "message" | "tool" | "edit" | "command" | "result" | "error";

export interface ActivityEvent {
  at: string;
  phase: string;
  kind: ActivityKind;
  summary: string;
  detail?: string;
}

export interface ActivityFeed {
  running: boolean;
  /** Phase whose plain text `raw` shows. The open step while the job runs, otherwise the last phase that wrote output. */
  phase?: string;
  /** Pass this back as `after` to receive only newer events. */
  cursor: string;
  events: ActivityEvent[];
  /** Plain text for `phase`, already redacted. Empty when that phase has not written yet. */
  raw: string;
  /** `at` of the newest event in stream order. */
  lastActivityAt?: string;
}

interface SourcedEvent extends ActivityEvent {
  source: string;
  line: number;
  toolId?: string;
  command?: string;
  file?: string;
}

interface ParsedSource {
  source: string;
  phase: string;
  iteration: number;
  events: SourcedEvent[];
  raw: string;
  lastLine: number;
}

const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CURSOR_PART = /^([A-Za-z0-9][A-Za-z0-9._-]*):(\d+)$/;
const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(jsonl|log)$/;
const ARTIFACT_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.(\d+))?\.json$/;
const SUMMARY_MAX = 160;
const COMMAND_MAX = 80;
const DETAIL_MAX = 4_000;
const RAW_LINES = 200;
const RAW_BYTES = 20 * 1024;
const MAX_SESSION_BYTES = 8_000_000;

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "PowerShell"]);

const ASSISTANT_ERROR: Record<string, string> = {
  authentication_failed: "Authentication failed",
  billing_error: "Billing error",
  rate_limit: "Rate limited",
  overloaded: "The model is overloaded",
  invalid_request: "The model rejected the request",
  server_error: "The model request failed",
  max_output_tokens: "The reply hit the output limit",
  unknown: "The model request failed",
};

const RESULT_ERROR: Record<string, string> = {
  error_max_turns: "Stopped after the turn limit",
  error_max_budget_usd: "Stopped: budget exhausted",
  error_max_structured_output_retries: "Stopped: output did not match the schema",
  error_during_execution: "The step failed",
};

/** `after` query value. An empty string reads from the start. Invalid input returns undefined. */
export function parseActivityCursor(raw: string | null | undefined): Map<string, number> | undefined {
  if (raw === null || raw === undefined || raw === "") return new Map();
  const map = new Map<string, number>();
  for (const part of raw.split(",")) {
    const match = CURSOR_PART.exec(part);
    if (!match?.[1] || match[2] === undefined) return undefined;
    const line = Number(match[2]);
    if (!Number.isInteger(line) || line < 0) return undefined;
    map.set(match[1], line);
  }
  return map;
}

export function formatActivityCursor(lines: ReadonlyMap<string, number>): string {
  return [...lines.entries()]
    .filter(([, line]) => line > 0)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([source, line]) => `${source}:${line}`)
    .join(",");
}

/**
 * Parse one stream-json session. Incomplete trailing line is ignored so a
 * poll mid-write does not invent an event. `fallbackAt` is the receive time
 * when a message has no timestamp.
 */
export function parseActivityStream(text: string, phase: string, fallbackAt: string): ActivityEvent[] {
  return parseStream(text, phase, "session.jsonl", fallbackAt).events.map(publish);
}

/** Newest event time under a run directory, or undefined when nothing has been written. */
export function newestActivityAt(runDir: string): string | undefined {
  try {
    if (!existsSync(runDir)) return undefined;
    return readRunActivity(runDir, { running: false }).lastActivityAt;
  } catch {
    return undefined;
  }
}

export function readRunActivity(
  runDir: string | undefined,
  options: { running: boolean; after?: string; logText?: string },
): ActivityFeed {
  const after = parseActivityCursor(options.after ?? "") ?? new Map();
  const sources = runDir ? readSources(runDir) : [];
  const journal = runDir ? readJournal(runDir) : [];
  const order = phaseOrder(journal);
  sources.sort((left, right) => compareSources(left, right, order));

  const lines = new Map(after);
  const all: SourcedEvent[] = [];
  for (const source of sources) {
    lines.set(source.source, Math.max(lines.get(source.source) ?? 0, source.lastLine));
    all.push(...source.events);
  }
  const fresh = all.filter((event) => event.line > (after.get(event.source) ?? 0));
  const open = options.running ? openPhase(journal) : undefined;
  const lastPhase = [...sources].reverse().find((source) => source.events.length > 0 || source.raw.trim())?.phase;
  const phase = open ?? lastPhase;
  const rawSource = [...sources].reverse().find((source) => source.phase === phase && source.raw.trim());
  const raw = redactText(truncateRaw(rawSource?.raw || (!sources.length ? options.logText ?? "" : "")));
  const lastActivityAt = newestAt(all);
  return {
    running: options.running,
    ...(phase ? { phase } : {}),
    cursor: formatActivityCursor(lines),
    events: fresh.map(publish),
    raw,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

function readSources(runDir: string): ParsedSource[] {
  let root: string;
  try {
    root = realpathSync(runDir);
  } catch {
    return [];
  }
  const sessions = listDir(join(root, "sessions"));
  const sessionPhases = new Set<string>();
  const sources: ParsedSource[] = [];
  for (const name of sessions) {
    const match = SESSION_FILE.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const file = join(root, "sessions", name);
    if (!contained(root, file)) continue;
    sessionPhases.add(match[1]);
    sources.push(readSession(file, name, match[1], match[2] === "jsonl" ? "jsonl" : "log"));
  }
  for (const name of listDir(join(root, "artifacts"))) {
    const match = ARTIFACT_FILE.exec(name);
    if (!match?.[1]) continue;
    if (sessionPhases.has(match[1])) continue;
    const file = join(root, "artifacts", name);
    if (!contained(root, file)) continue;
    const parsed = readCommandArtifact(file, name, match[1], match[2] ? Number(match[2]) : 0);
    if (parsed) sources.push(parsed);
  }
  return sources;
}

function readSession(file: string, source: string, phase: string, kind: "jsonl" | "log"): ParsedSource {
  const fallbackAt = mtimeIso(file);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  if (size > MAX_SESSION_BYTES) {
    return {
      source,
      phase,
      iteration: 0,
      events: [
        {
          at: fallbackAt,
          phase,
          kind: "error",
          summary: "Session log is too large to show.",
          source,
          line: 1,
        },
      ],
      raw: "",
      lastLine: 1,
    };
  }
  const text = readCapped(file);
  if (kind === "log" && !text.trimStart().startsWith("{")) return parsePlainLog(text, phase, source, fallbackAt);
  return { ...parseStream(text, phase, source, fallbackAt), iteration: 0 };
}

function readCommandArtifact(file: string, source: string, phase: string, iteration: number): ParsedSource | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readCapped(file));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  if (!stdout && !stderr && exitCode === undefined) return undefined;
  const output = stripAnsi(`${stdout}${stdout && stderr ? "\n" : ""}${stderr}`).trim();
  const failed = failureCount(output);
  const verb = phase === "verify" ? "Ran tests" : "Ran command";
  let summary = verb;
  if (failed !== undefined) summary = `${verb} - ${failed} failed`;
  else if (exitCode !== undefined && exitCode !== 0) summary = `${verb} - exit ${exitCode}`;
  const at = mtimeIso(file);
  const detail = tailLines(output, 40);
  const event: SourcedEvent = {
    at,
    phase,
    kind: exitCode !== undefined && exitCode !== 0 ? "error" : "command",
    summary,
    ...(detail && detail !== summary ? { detail } : {}),
    source,
    line: 1,
    command: verb,
  };
  return { source, phase, iteration, events: [event], raw: output, lastLine: 1 };
}

function parsePlainLog(text: string, phase: string, source: string, fallbackAt: string): ParsedSource {
  const lines = completeLines(text);
  const events: SourcedEvent[] = [];
  const raw: string[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("{")) return;
    const shown = oneLine(stripAnsi(trimmed));
    events.push({
      at: fallbackAt,
      phase,
      kind: "message",
      summary: shown.summary,
      ...(shown.detail ? { detail: shown.detail } : {}),
      source,
      line: index + 1,
    });
    raw.push(trimmed);
  });
  return { source, phase, iteration: 0, events, raw: raw.join("\n"), lastLine: lines.length };
}

function parseStream(text: string, phase: string, source: string, fallbackAt: string): ParsedSource {
  const lines = completeLines(text);
  const events: SourcedEvent[] = [];
  const pending = new Map<string, SourcedEvent>();
  const raw: string[] = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== "object") return;
    const message = record as { type?: unknown; timestamp?: unknown };
    const at = stamp(message, fallbackAt);
    if (message.type === "assistant") {
      absorbAssistant(message, { phase, source, at, line: lineNo, events, pending, raw });
      return;
    }
    if (message.type === "user") {
      absorbUser(message, { phase, source, at, line: lineNo, events, pending, raw });
      return;
    }
    if (message.type === "result") absorbResult(message, { phase, source, at, line: lineNo, events, raw });
  });
  return { source, phase, iteration: 0, events, raw: raw.join("\n"), lastLine: lines.length };
}

interface ParseCtx {
  phase: string;
  source: string;
  at: string;
  line: number;
  events: SourcedEvent[];
  pending: Map<string, SourcedEvent>;
  raw: string[];
}

function absorbAssistant(record: object, ctx: ParseCtx): void {
  const error = "error" in record && typeof record.error === "string" ? record.error : undefined;
  if (error) {
    const summary = ASSISTANT_ERROR[error] ?? "The model request failed";
    ctx.events.push({ at: ctx.at, phase: ctx.phase, kind: "error", summary, source: ctx.source, line: ctx.line });
    ctx.raw.push(summary);
  }
  const message = "message" in record ? record.message : undefined;
  for (const block of contentBlocks(message)) {
    if (!block || typeof block !== "object") continue;
    const kind = "type" in block ? block.type : undefined;
    if (kind === "text" && "text" in block && typeof block.text === "string") {
      const text = block.text.trim();
      if (!text) continue;
      const shown = oneLine(text);
      ctx.events.push({
        at: ctx.at,
        phase: ctx.phase,
        kind: "message",
        summary: shown.summary,
        ...(shown.detail ? { detail: shown.detail } : {}),
        source: ctx.source,
        line: ctx.line,
      });
      ctx.raw.push(text);
      continue;
    }
    if (kind !== "tool_use") continue;
    const name = "name" in block && typeof block.name === "string" ? block.name : "";
    const id = "id" in block && typeof block.id === "string" ? block.id : `${ctx.line}:${name}`;
    const input = "input" in block && block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
    const event = toolEvent(name, input, ctx);
    event.toolId = id;
    ctx.events.push(event);
    ctx.pending.set(id, event);
    ctx.raw.push(event.summary);
  }
}

function absorbUser(record: object, ctx: ParseCtx): void {
  const message = "message" in record ? record.message : undefined;
  const structured = "tool_use_result" in record ? record.tool_use_result : undefined;
  for (const block of contentBlocks(message)) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "tool_result") continue;
    const id = "tool_use_id" in block && typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    const event = id ? ctx.pending.get(id) : undefined;
    if (!event) continue;
    ctx.pending.delete(id);
    const text = stripAnsi(toolResultText("content" in block ? block.content : undefined));
    const isError = "is_error" in block && block.is_error === true;
    applyToolResult(event, text, isError, structured);
    event.line = ctx.line;
    event.at = ctx.at;
    if (event.kind === "command" || event.kind === "error") {
      const output = commandOutput(text, structured);
      if (output) ctx.raw.push(output);
    }
  }
}

function absorbResult(record: object, ctx: Omit<ParseCtx, "pending">): void {
  const subtype = "subtype" in record && typeof record.subtype === "string" ? record.subtype : "";
  const denials = "permission_denials" in record && Array.isArray(record.permission_denials) ? record.permission_denials : [];
  if (denials.length > 0) {
    const names = denials
      .map((denial) => (denial && typeof denial === "object" && "tool_name" in denial && typeof denial.tool_name === "string" ? denial.tool_name : ""))
      .filter(Boolean);
    const summary = names.length > 0 ? `Tool denied: ${names.join(", ")}` : "Tool denied";
    ctx.events.push({ at: ctx.at, phase: ctx.phase, kind: "error", summary, source: ctx.source, line: ctx.line });
    ctx.raw.push(summary);
    return;
  }
  const errors = "errors" in record && Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string") : [];
  const failed = subtype !== "success" || ("is_error" in record && record.is_error === true);
  if (failed) {
    const plain = errors.map((item) => item.trim()).filter((item) => item && !item.startsWith("{") && !item.startsWith("["));
    const shown = plain.length > 0 ? oneLine(plain.join("\n")) : { summary: RESULT_ERROR[subtype] ?? "The step failed" };
    ctx.events.push({
      at: ctx.at,
      phase: ctx.phase,
      kind: "error",
      summary: shown.summary,
      ...(shown.detail ? { detail: shown.detail } : {}),
      source: ctx.source,
      line: ctx.line,
    });
    ctx.raw.push(shown.detail ?? shown.summary);
    return;
  }
  const result = "result" in record && typeof record.result === "string" ? record.result.trim() : "";
  if (!result || result.startsWith("{") || result.startsWith("[")) {
    ctx.events.push({ at: ctx.at, phase: ctx.phase, kind: "result", summary: "Finished", source: ctx.source, line: ctx.line });
    ctx.raw.push("Finished");
    return;
  }
  const shown = oneLine(result);
  ctx.events.push({
    at: ctx.at,
    phase: ctx.phase,
    kind: "result",
    summary: shown.summary,
    ...(shown.detail ? { detail: shown.detail } : {}),
    source: ctx.source,
    line: ctx.line,
  });
  ctx.raw.push(result);
}

function toolEvent(name: string, input: Record<string, unknown>, ctx: ParseCtx): SourcedEvent {
  const file = fileOf(input);
  if (EDIT_TOOLS.has(name)) {
    const stat = name === "Write" ? writeStat(input) : editStat(input);
    const summary = file ? `${name === "Write" ? "Write" : "Edit"} ${file}${formatStat(stat)}` : name;
    return { at: ctx.at, phase: ctx.phase, kind: "edit", summary, source: ctx.source, line: ctx.line, file, command: name };
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = commandOf(input);
    return {
      at: ctx.at,
      phase: ctx.phase,
      kind: "command",
      summary: `Ran ${command}`,
      source: ctx.source,
      line: ctx.line,
      command,
    };
  }
  return { at: ctx.at, phase: ctx.phase, kind: "tool", summary: toolSummary(name, input, file), source: ctx.source, line: ctx.line, file };
}

function applyToolResult(event: SourcedEvent, text: string, isError: boolean, structured: unknown): void {
  if (event.kind === "command" && event.command) {
    const output = commandOutput(text, structured);
    const failed = failureCount(output);
    if (failed !== undefined) event.summary = `Ran ${event.command} - ${failed} failed`;
    else if (isError || interrupted(structured)) event.summary = `Ran ${event.command} - failed`;
    const detail = tailLines(output, 40);
    if (detail && detail !== event.summary) event.detail = clip(detail, DETAIL_MAX, "tail");
    if (isError) event.kind = "error";
    return;
  }
  if (event.kind === "edit" && event.file) {
    const stat = statFromGitDiff(structured);
    if (stat) {
      const verb = event.command === "Write" ? "Write" : "Edit";
      event.summary = `${verb} ${event.file}${formatStat(stat)}`;
    }
  }
  if (isError) {
    event.kind = "error";
    const detail = plainText(text);
    event.summary = event.file ? `${event.summary} failed` : "Tool failed";
    if (detail) event.detail = clip(detail, DETAIL_MAX, "head");
  }
}

function toolSummary(name: string, input: Record<string, unknown>, file: string | undefined): string {
  if (name === "Read" && file) return `Read ${file}`;
  if (name === "Grep" || name === "Glob") {
    const pattern = stringField(input, "pattern") ?? stringField(input, "query");
    const where = file ?? stringField(input, "path");
    if (pattern && where) return `${name} ${clip(pattern, 60, "head")} in ${where}`;
    if (pattern) return `${name} ${clip(pattern, 80, "head")}`;
  }
  if ((name === "LS" || name === "List") && file) return `List ${file}`;
  if (name === "WebFetch" || name === "WebSearch") {
    const target = stringField(input, "url") ?? stringField(input, "query");
    if (target) return `${name === "WebFetch" ? "Fetch" : "Search"} ${clip(target, 80, "head")}`;
  }
  if (file) return `${name} ${file}`;
  return name || "Tool";
}

function commandOf(input: Record<string, unknown>): string {
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  if (!command) return "command";
  const line = command.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
  if (!line) return "command";
  return line.length <= COMMAND_MAX ? line : `${line.slice(0, COMMAND_MAX - 1).trimEnd()}…`;
}

function commandOutput(text: string, structured: unknown): string {
  if (structured && typeof structured === "object") {
    const record = structured as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const combined = stripAnsi(`${stdout}${stdout && stderr ? "\n" : ""}${stderr}`).trim();
    if (combined) return combined;
  }
  return plainText(text);
}

function failureCount(text: string): number | undefined {
  const node = [...text.matchAll(/#\s+fail\s+(\d+)/g)];
  const nodeCount = numberAt(node[node.length - 1]?.[1]);
  if (nodeCount !== undefined && nodeCount > 0) return nodeCount;
  const failed = [...text.matchAll(/\b(\d+)\s+failed\b/gi)];
  const count = numberAt(failed[failed.length - 1]?.[1]);
  return count !== undefined && count > 0 ? count : undefined;
}

function editStat(input: Record<string, unknown>): { added: number; removed: number } | undefined {
  const oldText = stringField(input, "old_string") ?? stringField(input, "old_str");
  const newText = stringField(input, "new_string") ?? stringField(input, "new_str");
  if (oldText === undefined || newText === undefined) return undefined;
  return lineDiff(oldText, newText);
}

function writeStat(input: Record<string, unknown>): { added: number; removed: number } | undefined {
  const content = stringField(input, "content") ?? stringField(input, "new_source");
  if (content === undefined) return undefined;
  const added = content.length === 0 ? 0 : content.split("\n").length;
  return added > 0 ? { added, removed: 0 } : undefined;
}

function statFromGitDiff(value: unknown): { added: number; removed: number } | undefined {
  if (!value || typeof value !== "object" || !("gitDiff" in value)) return undefined;
  const diff = value.gitDiff;
  if (!diff || typeof diff !== "object") return undefined;
  const added = "additions" in diff && typeof diff.additions === "number" ? diff.additions : undefined;
  const removed = "deletions" in diff && typeof diff.deletions === "number" ? diff.deletions : undefined;
  if (added === undefined || removed === undefined) return undefined;
  return { added, removed };
}

function lineDiff(before: string, after: string): { added: number; removed: number } | undefined {
  const oldCounts = lineCounts(before);
  const newCounts = lineCounts(after);
  let added = 0;
  let removed = 0;
  for (const key of new Set([...oldCounts.keys(), ...newCounts.keys()])) {
    const delta = (newCounts.get(key) ?? 0) - (oldCounts.get(key) ?? 0);
    if (delta > 0) added += delta;
    else if (delta < 0) removed -= delta;
  }
  if (added === 0 && removed === 0) return undefined;
  return { added, removed };
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text) return counts;
  for (const line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function formatStat(stat: { added: number; removed: number } | undefined): string {
  if (!stat) return "";
  if (stat.added > 0 && stat.removed > 0) return ` (+${stat.added} -${stat.removed})`;
  if (stat.added > 0) return ` (+${stat.added})`;
  if (stat.removed > 0) return ` (-${stat.removed})`;
  return "";
}

function fileOf(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "notebook_path", "target_notebook"]) {
    const value = stringField(input, key);
    if (value) return displayPath(value);
  }
  return undefined;
}

function displayPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const workspace = normalized.lastIndexOf("/workspace/");
  if (workspace !== -1) return normalized.slice(workspace + "/workspace/".length);
  const parts = normalized.split("/").filter(Boolean);
  const anchor = parts.findIndex((part) => part === "src" || part === "packages" || part === "test" || part === "tests");
  if (anchor > 0) return parts.slice(anchor).join("/");
  if (normalized.startsWith("/") && parts.length > 3) return parts.slice(-3).join("/");
  return normalized;
}

function contentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object" && "text" in block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function plainText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return trimmed;
}

function interrupted(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "interrupted" in value && value.interrupted === true);
}

function oneLine(text: string): { summary: string; detail?: string } {
  const trimmed = text.trim();
  const flat = trimmed.replace(/\s+/g, " ");
  if (!flat) return { summary: "" };
  const multiline = trimmed.includes("\n");
  if (!multiline && flat.length <= SUMMARY_MAX) return { summary: flat };
  const summary = flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  return { summary, detail: clip(trimmed, DETAIL_MAX, "head") };
}

function publish(event: SourcedEvent): ActivityEvent {
  const summary = redact(event.summary).trim() || "Activity";
  const detail = event.detail ? redact(event.detail).trim() : "";
  return {
    at: event.at,
    phase: event.phase,
    kind: event.kind,
    summary,
    ...(detail && detail !== summary ? { detail } : {}),
  };
}

function redactText(text: string): string {
  return text ? redact(text) : "";
}

function completeLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  parts.pop();
  return parts;
}

function newestAt(events: readonly SourcedEvent[]): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (!latest || event.at > latest) latest = event.at;
  }
  return latest;
}

function stamp(record: { timestamp?: unknown; at?: unknown }, fallback: string): string {
  const value = record.timestamp ?? record.at;
  if (typeof value !== "string") return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function clip(text: string, max: number, edge: "head" | "tail"): string {
  if (text.length <= max) return text;
  return edge === "head" ? `${text.slice(0, max - 1).trimEnd()}…` : `…${text.slice(text.length - (max - 1)).trimStart()}`;
}

function tailLines(text: string, maxLines: number): string {
  if (!text) return "";
  const parts = text.split("\n");
  return parts.slice(-maxLines).join("\n").trim();
}

function truncateRaw(text: string): string {
  if (!text) return "";
  const lined = text.split("\n");
  const cutLines = lined.length > RAW_LINES;
  const kept = cutLines ? lined.slice(-RAW_LINES).join("\n") : text;
  const bytes = Buffer.byteLength(kept);
  if (!cutLines && bytes <= RAW_BYTES) return kept;
  const body = bytes <= RAW_BYTES ? kept : Buffer.from(kept).subarray(bytes - RAW_BYTES).toString("utf8");
  return `[truncated: showing the last ${RAW_LINES} lines or ${RAW_BYTES} bytes]\n${body}`;
}

function mtimeIso(file: string): string {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function readCapped(file: string): string {
  try {
    const size = statSync(file).size;
    if (size > MAX_SESSION_BYTES) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => SOURCE_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

function contained(root: string, file: string): boolean {
  try {
    const real = realpathSync(file);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

interface JournalLine {
  t?: string;
  stepId?: string;
}

function readJournal(runDir: string): JournalLine[] {
  const file = join(runDir, "journal.jsonl");
  if (!existsSync(file)) return [];
  const events: JournalLine[] = [];
  for (const line of completeLines(readCapped(file))) {
    try {
      const parsed = JSON.parse(line) as JournalLine;
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // A torn or foreign line is not a phase boundary.
    }
  }
  return events;
}

function phaseOrder(journal: readonly JournalLine[]): string[] {
  const order: string[] = [];
  for (const event of journal) {
    if (event.t === "step.started" && event.stepId && !order.includes(event.stepId)) order.push(event.stepId);
  }
  return order;
}

function openPhase(journal: readonly JournalLine[]): string | undefined {
  if (journal.some((event) => event.t === "run.finished")) return undefined;
  const open = new Map<string, boolean>();
  let last: string | undefined;
  for (const event of journal) {
    if (!event.stepId) continue;
    if (event.t === "step.started") {
      open.set(event.stepId, true);
      last = event.stepId;
    } else if (event.t === "step.completed" || event.t === "step.failed") {
      open.set(event.stepId, false);
    }
  }
  if (last && open.get(last)) return last;
  for (const [id, isOpen] of open) if (isOpen) return id;
  return undefined;
}

function compareSources(left: ParsedSource, right: ParsedSource, order: readonly string[]): number {
  const rank = rankOf(left.phase, order) - rankOf(right.phase, order);
  if (rank !== 0) return rank;
  if (left.iteration !== right.iteration) return left.iteration - right.iteration;
  return left.source.localeCompare(right.source);
}

function rankOf(phase: string, order: readonly string[]): number {
  const index = order.indexOf(phase);
  return index === -1 ? order.length + 1 : index;
}
