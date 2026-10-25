import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { LoadedKilnConfig } from "../config.js";
import { listValidJobs, newJobId, writeJob } from "../jobs.js";
import type { Job } from "../schemas.js";
import { assertWorkflowName } from "../workflow.js";
import { packageRoot } from "../paths.js";

/** Context files larger than this are named in the spec instead of copied in. */
export const CONTEXT_INLINE_LIMIT = 40 * 1024;

const TICKET_FILE = /^(\d+)-.+\.md$/;

export interface ImportTicketsInput {
  dir: string;
  repo: string;
  workflow?: string;
  contextPath?: string;
  dryRun: boolean;
  cwd: string;
  now?: Date;
}

interface TicketRef {
  raw: string;
  number: number;
}

interface ParsedTicket {
  file: string;
  path: string;
  label: string;
  number: number;
  title: string;
  text: string;
  blockedBy: TicketRef[];
  spike: boolean;
}

interface ImportRow {
  status: "new" | "unchanged";
  label: string;
  title: string;
  workflow: string;
  depLabels: string[];
  jobId?: string;
}

export interface ImportTicketsResult {
  report: string;
  warnings: string[];
}

/**
 * `kiln import <dir> --repo R`. One job per `NN-slug.md` file.
 * Re-running keys on the ticket directory plus the filename (`source.ref`).
 */
export function importTickets(config: LoadedKilnConfig, input: ImportTicketsInput): ImportTicketsResult {
  const dirAbs = resolveTicketDir(input.cwd, input.dir);
  if (!config.repos[input.repo]) {
    const known = Object.keys(config.repos).sort();
    const suffix = known.length > 0 ? ` Known repos: ${known.join(", ")}.` : " No repos are registered.";
    throw new Error(`Unknown repo ${input.repo}.${suffix} Run kiln repo add ${input.repo} <path>.`);
  }

  const requested = input.workflow ?? "feature";
  assertWorkflowName(requested);
  const investigation = existsSync(join(packageRoot(), "workflows", "investigation.yaml"));
  const context = resolveContext(dirAbs, input.contextPath, input.cwd);
  const tickets = readTickets(dirAbs);
  const warnings: string[] = [];
  const workflows = new Map<string, string>();
  for (const ticket of tickets) {
    const workflow = workflowFor(ticket, requested, investigation, warnings);
    if (workflow !== requested) assertWorkflowName(workflow);
    workflows.set(ticket.path, workflow);
  }

  const existing = new Map<string, Job>();
  for (const job of listValidJobs(config)) {
    if (job.source.kind !== "tickets") continue;
    if (!existing.has(job.source.ref)) existing.set(job.source.ref, job);
  }

  const assigned = new Map<string, string>();
  const start = input.now ?? new Date();
  let offset = 0;
  for (const ticket of tickets) {
    const prior = existing.get(ticket.path);
    if (prior) {
      assigned.set(ticket.path, prior.id);
      continue;
    }
    assigned.set(ticket.path, newJobId(new Date(start.getTime() + offset)));
    offset += 1;
  }

  const pendingIds = new Set<string>();
  for (const ticket of tickets) {
    if (!existing.has(ticket.path)) {
      const id = assigned.get(ticket.path);
      if (id) pendingIds.add(id);
    }
  }

  const rows: ImportRow[] = [];
  const writes: { ticket: ParsedTicket; id: string; now: Date; dependsOn: string[] }[] = [];
  let newOffset = 0;
  for (const ticket of tickets) {
    const id = assigned.get(ticket.path);
    if (!id) continue;
    const workflow = workflows.get(ticket.path) ?? requested;
    const dependsOn = ticket.blockedBy.map((dep) => {
      const upstream = tickets.find((candidate) => candidate.number === dep.number);
      const upstreamId = upstream ? assigned.get(upstream.path) : undefined;
      if (!upstream || !upstreamId) {
        throw new Error(`Ticket ${ticket.file} blocks on unknown ticket ${dep.raw}.`);
      }
      return upstreamId;
    });
    const depLabels = ticket.blockedBy.map((dep) => {
      const upstream = tickets.find((candidate) => candidate.number === dep.number);
      return upstream?.label ?? dep.raw;
    });
    const prior = existing.get(ticket.path);
    if (prior) {
      rows.push({
        status: "unchanged",
        label: ticket.label,
        title: prior.title,
        workflow: prior.workflow,
        depLabels,
        jobId: prior.id,
      });
      continue;
    }
    const now = new Date(start.getTime() + newOffset);
    newOffset += 1;
    writes.push({ ticket, id, now, dependsOn });
    rows.push({
      status: "new",
      label: ticket.label,
      title: ticket.title,
      workflow,
      depLabels,
      ...(input.dryRun ? {} : { jobId: id }),
    });
  }

  if (!input.dryRun) {
    for (const write of writes) {
      const workflow = workflows.get(write.ticket.path) ?? requested;
      writeJob(config, {
        id: write.id,
        workflow,
        repo: input.repo,
        specText: composeSpec(write.ticket.text, context),
        title: write.ticket.title,
        dependsOn: write.dependsOn,
        source: { kind: "tickets", ref: write.ticket.path },
        now: write.now,
        pendingIds,
      });
    }
  }

  return {
    report: renderImport(dirAbs, input.repo, rows, input.dryRun),
    warnings,
  };
}

function resolveTicketDir(cwd: string, dir: string): string {
  const resolved = resolve(cwd, dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Ticket directory ${resolved} does not exist or is not a directory.`);
  }
  return realpathSync(resolved);
}

interface ContextFile {
  path: string;
  bytes: number;
  text?: string;
}

function resolveContext(dirAbs: string, contextPath: string | undefined, cwd: string): ContextFile | undefined {
  const explicit = contextPath ? resolve(cwd, contextPath) : undefined;
  const fallback = join(dirname(dirAbs), "spec.md");
  const path = explicit ?? (existsSync(fallback) && statSync(fallback).isFile() ? fallback : undefined);
  if (!path) return undefined;
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Could not read context ${path}.`);
  }
  const bytes = statSync(path).size;
  if (bytes > CONTEXT_INLINE_LIMIT) return { path, bytes };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read context ${path}: ${message}`);
  }
  if (!text.trim()) return undefined;
  return { path, bytes, text };
}

function composeSpec(ticketText: string, context: ContextFile | undefined): string {
  const base = ticketText.endsWith("\n") ? ticketText : `${ticketText}\n`;
  if (!context) return base;
  if (context.text === undefined) {
    return `${base}\n## Background\n\nContext: ${context.path} (${context.bytes} bytes). The file is larger than 40KB and is referenced by path.\n`;
  }
  const body = context.text.endsWith("\n") ? context.text : `${context.text}\n`;
  return `${base}\n## Background\n\n${body}`;
}

function workflowFor(
  ticket: ParsedTicket,
  requested: string,
  investigation: boolean,
  warnings: string[],
): string {
  if (!ticket.spike) return requested;
  if (investigation) return "investigation";
  warnings.push(
    `warning: ${ticket.file} looks like a spike or says no product code; workflows/investigation.yaml is missing, using ${requested}.`,
  );
  return requested;
}

function readTickets(dirAbs: string): ParsedTicket[] {
  const names = readdirSync(dirAbs)
    .filter((name) => TICKET_FILE.test(name))
    .sort((left, right) => ticketNumber(left) - ticketNumber(right) || left.localeCompare(right));
  if (names.length === 0) {
    throw new Error(`No NN-slug.md tickets in ${dirAbs}.`);
  }
  const tickets = names.map((name) => parseTicket(dirAbs, name));
  const byNumber = new Map<number, ParsedTicket>();
  for (const ticket of tickets) {
    const prior = byNumber.get(ticket.number);
    if (prior) {
      throw new Error(`Tickets ${prior.file} and ${ticket.file} share number ${ticket.label}.`);
    }
    byNumber.set(ticket.number, ticket);
  }
  const problems: string[] = [];
  for (const ticket of tickets) {
    if (ticket.blockedBy.some((dep) => dep.number === ticket.number)) {
      problems.push(`${ticket.file} blocks on itself.`);
      continue;
    }
    const unknown = ticket.blockedBy.filter((dep) => !byNumber.has(dep.number));
    if (unknown.length === 0) continue;
    const listed = unknown.map((dep) => dep.raw).join(", ");
    const noun = unknown.length === 1 ? "ticket" : "tickets";
    problems.push(`${ticket.file} blocks on unknown ${noun} ${listed}.`);
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return tickets;
}

function parseTicket(dirAbs: string, file: string): ParsedTicket {
  const path = join(dirAbs, file);
  const label = ticketLabel(file);
  const number = ticketNumber(file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ticket ${file}: ${message}`);
  }
  if (!text.trim()) {
    throw new Error(`Ticket ${file} is empty.`);
  }
  let meta: FrontMatter;
  let body: string;
  try {
    ({ meta, body } = splitFrontMatter(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read front matter in ${file}: ${message}`);
  }
  let bodyDeps: TicketRef[];
  try {
    bodyDeps = blockedByFromBody(body, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
  const heading = headingTitle(body);
  if (heading?.number !== undefined && heading.number !== number) {
    throw new Error(`Ticket ${file} heading is numbered ${heading.rawNumber ?? heading.number}, not ${label}.`);
  }
  const title = heading?.title ?? meta.title;
  if (!title) {
    throw new Error(`Ticket ${file} has no title. Expected a "# NN: Title" heading or front matter title.`);
  }
  return {
    file,
    path,
    label,
    number,
    title,
    text,
    blockedBy: dedupeRefs([...meta.blockedBy, ...bodyDeps]),
    spike: looksLikeSpike(text, meta.type),
  };
}

interface FrontMatter {
  title?: string;
  type?: string;
  blockedBy: TicketRef[];
}

function splitFrontMatter(text: string): { meta: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match?.[1]) return { meta: { blockedBy: [] }, body: text };
  return { meta: parseFrontMatter(match[1]), body: text.slice(match[0].length) };
}

function parseFrontMatter(yaml: string): FrontMatter {
  const lines = yaml.split(/\r?\n/);
  let title: string | undefined;
  let type: string | undefined;
  const blockedBy: TicketRef[] = [];
  let listKey: "blocked-by" | undefined;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item?.[1] && listKey === "blocked-by") {
      blockedBy.push(...refsFromScalar(item[1]));
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!field?.[1]) continue;
    listKey = undefined;
    const key = field[1];
    const value = field[2] ?? "";
    if (key === "title") title = unquote(value);
    else if (key === "type") type = unquote(value);
    else if (key === "blocked-by") {
      if (!value.trim()) listKey = "blocked-by";
      else blockedBy.push(...refsFromScalar(value));
    }
  }
  return { title: title?.trim() || undefined, type: type?.trim() || undefined, blockedBy };
}

function refsFromScalar(raw: string): TicketRef[] {
  const value = unquote(raw.trim());
  if (!value || /^(none\b.*|null|~)$/i.test(value)) return [];
  const flow = /^\[([\s\S]*)\]$/.exec(value);
  if (flow?.[1] !== undefined) {
    const inner = flow[1].trim();
    if (!inner) return [];
    return inner.split(",").flatMap((part) => refsFromScalar(part));
  }
  const num = /^(\d+)\b/.exec(value);
  if (!num?.[1]) {
    throw new Error(`could not read blocked-by value ${JSON.stringify(raw)}`);
  }
  return [{ raw: num[1], number: Number(num[1]) }];
}

function blockedByFromBody(body: string, filename: string): TicketRef[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\*\*Blocked by:\*\*/i.test(line.trim()));
  if (start < 0) return [];
  const collected: string[] = [];
  const inline = /^\*\*Blocked by:\*\*\s*(.*)$/i.exec(lines[start]?.trim() ?? "");
  if (inline?.[1]?.trim()) collected.push(inline[1].trim());
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed) || /^\*\*[^*]/.test(trimmed)) break;
    const bullet = /^[-*]\s+/.test(trimmed);
    const none = /^none\b/i.test(trimmed) || /^[-*]\s+none\b/i.test(trimmed);
    if (!bullet && !none) {
      if (collected.length > 0) break;
      throw new Error(`Could not read blocked-by line ${JSON.stringify(trimmed)} in ${filename}.`);
    }
    collected.push(trimmed);
  }
  const refs: TicketRef[] = [];
  for (const line of collected) {
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const text = (bullet?.[1] ?? line).trim();
    if (/^none\b/i.test(text)) continue;
    const num = /^(\d+)\b/.exec(text);
    if (!num?.[1]) {
      throw new Error(`Could not read blocked-by line ${JSON.stringify(line)} in ${filename}.`);
    }
    refs.push({ raw: num[1], number: Number(num[1]) });
  }
  return refs;
}

function headingTitle(body: string): { title: string; number?: number; rawNumber?: string } | undefined {
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (!heading?.[1]) continue;
    const numbered = /^(\d+)\s*:\s+(\S.*?)$/.exec(heading[1]);
    if (numbered?.[1] && numbered[2]) {
      return { title: `${numbered[1]}: ${numbered[2]}`, number: Number(numbered[1]), rawNumber: numbered[1] };
    }
    return { title: heading[1] };
  }
  return undefined;
}

function looksLikeSpike(text: string, type: string | undefined): boolean {
  if (type && /^(spike|investigation)$/i.test(type)) return true;
  return /\bspike\b/i.test(text) || /no product code/i.test(text);
}

function dedupeRefs(refs: TicketRef[]): TicketRef[] {
  const seen = new Set<number>();
  const out: TicketRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.number)) continue;
    seen.add(ref.number);
    out.push(ref);
  }
  return out;
}

function ticketLabel(file: string): string {
  const label = TICKET_FILE.exec(basename(file))?.[1];
  if (!label) throw new Error(`Ticket ${file} does not match NN-slug.md.`);
  return label;
}

function ticketNumber(file: string): number {
  return Number(ticketLabel(file));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

function renderImport(dir: string, repo: string, rows: ImportRow[], dryRun: boolean): string {
  const lines = [`import ${dir}`, `repo ${repo}`];
  for (const row of rows) {
    const deps = row.depLabels.length > 0 ? row.depLabels.join(", ") : "none";
    if (dryRun) {
      lines.push(`${row.label}  ${row.title}  ${row.workflow}  deps ${deps}  ${row.status}`);
    } else {
      lines.push(`${row.status} ${row.jobId}  ${row.label}  ${row.title}  ${row.workflow}  deps ${deps}`);
    }
  }
  const created = rows.filter((row) => row.status === "new").length;
  const unchanged = rows.filter((row) => row.status === "unchanged").length;
  if (dryRun) lines.push(`dry-run: ${created} new, ${unchanged} unchanged, created nothing`);
  else lines.push(`imported ${created} new, ${unchanged} unchanged`);
  return `${lines.join("\n")}\n`;
}
