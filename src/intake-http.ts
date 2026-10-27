import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { LoadedKilnConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { assertInsideHome } from "./fs-browse.js";
import { addFromFile } from "./intake/file.js";
import { addFromJira } from "./intake/jira.js";
import { addFromPrompt } from "./intake/prompt.js";
import { importTickets, type ImportTicketRow } from "./intake/tickets.js";

export interface IntakeHttpResult {
  ids: string[];
  dryRun?: boolean;
  created?: boolean;
  report?: string;
  jobs?: ImportTicketRow[];
  warnings?: string[];
}

type Source =
  | { kind: "prompt"; text: string }
  | { kind: "spec"; path: string }
  | { kind: "tickets"; dir: string; context?: string }
  | { kind: "jira"; key: string };

interface IntakeRequest {
  repo: string;
  workflow: string;
  title?: string;
  after: string[];
  stack?: boolean;
  dryRun: boolean;
  source: Source;
}

/**
 * `POST /api/jobs`. The body is the CLI intake, and the call goes through
 * `addFromPrompt`, `addFromFile`, `importTickets`, or `addFromJira`.
 */
export async function intakeJobs(
  config: LoadedKilnConfig,
  body: unknown,
  home = homedir(),
): Promise<IntakeHttpResult> {
  const request = parseIntake(body);
  try {
    return await runIntake(config, request, home);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, message);
  }
}

async function runIntake(config: LoadedKilnConfig, request: IntakeRequest, home: string): Promise<IntakeHttpResult> {
  const shared = {
    workflow: request.workflow,
    repo: request.repo,
    ...(request.title !== undefined ? { title: request.title } : {}),
    dependsOn: request.after,
    ...(request.stack ? { stack: true } : {}),
  };
  if (request.source.kind === "prompt") {
    if (request.dryRun) throw new HttpError(400, "Dry-run is only supported for a tickets import.");
    if (request.source.text === "-") {
      throw new HttpError(400, "Pass the prompt text in source.text. Serve does not read stdin.");
    }
    const written = addFromPrompt(config, { ...shared, prompt: request.source.text });
    return { ids: [written.job.id] };
  }
  if (request.source.kind === "spec") {
    if (request.dryRun) throw new HttpError(400, "Dry-run is only supported for a tickets import.");
    const specPath = absoluteInside(home, request.source.path, "Spec path");
    const written = addFromFile(config, { ...shared, specPath, cwd: process.cwd() });
    return { ids: [written.job.id] };
  }
  if (request.source.kind === "jira") {
    if (request.dryRun) throw new HttpError(400, "Dry-run is only supported for a tickets import.");
    const result = await addFromJira(config, { ...shared, key: request.source.key, dryRun: false });
    return {
      ids: result.job ? [result.job.id] : [],
      created: result.created,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  }
  const dir = absoluteInside(home, request.source.dir, "Tickets directory");
  const contextPath = request.source.context
    ? absoluteInside(home, request.source.context, "Context path")
    : undefined;
  const result = importTickets(config, {
    dir,
    repo: request.repo,
    workflow: request.workflow,
    ...(contextPath ? { contextPath } : {}),
    dryRun: request.dryRun,
    ...(request.stack ? { stack: true } : {}),
    cwd: process.cwd(),
  });
  return {
    ids: result.ids,
    jobs: result.jobs,
    report: result.report,
    ...(request.dryRun ? { dryRun: true } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

function parseIntake(body: unknown): IntakeRequest {
  const record = object(body, "Request body must be a JSON object.");
  const repo = requiredString(record, "repo", "Name a repo.");
  const workflow = requiredString(record, "workflow", "Name a workflow.");
  const title = optionalString(record, "title", "title must be a string.");
  const after = stringList(record.after, "after must be a list of job ids.");
  const stack = optionalBoolean(record.stack, "stack must be a boolean.");
  const dryRun = optionalBoolean(record.dryRun, "dryRun must be a boolean.") ?? false;
  const source = parseSource(record.source);
  if (source.kind === "tickets" && title !== undefined) {
    throw new HttpError(400, "A tickets import does not take a title. Each file has its own.");
  }
  if (source.kind === "tickets" && after.length > 0) {
    throw new HttpError(400, "A tickets import does not take after. Blocked-by in the files sets dependencies.");
  }
  return {
    repo,
    workflow,
    ...(title !== undefined ? { title } : {}),
    after,
    ...(stack ? { stack: true } : {}),
    dryRun,
    source,
  };
}

function parseSource(value: unknown): Source {
  const source = object(value, "Name a source: prompt, spec, tickets, or jira.");
  const kind = source.kind;
  if (kind === "prompt") {
    if (typeof source.text !== "string") throw new HttpError(400, "Prompt text must be a string.");
    return { kind, text: source.text };
  }
  if (kind === "spec") {
    if (typeof source.path !== "string") throw new HttpError(400, "Spec path must be a string.");
    return { kind, path: source.path };
  }
  if (kind === "tickets") {
    if (typeof source.dir !== "string") throw new HttpError(400, "Tickets directory must be a string.");
    if (source.context !== undefined && typeof source.context !== "string") {
      throw new HttpError(400, "Context path must be a string.");
    }
    return {
      kind,
      dir: source.dir,
      ...(typeof source.context === "string" ? { context: source.context } : {}),
    };
  }
  if (kind === "jira") {
    if (typeof source.key !== "string") throw new HttpError(400, "Jira key must be a string.");
    return { kind, key: source.key };
  }
  throw new HttpError(400, "Source kind must be prompt, spec, tickets, or jira.");
}

function absoluteInside(home: string, path: string, label: string): string {
  if (!path.trim() || !isAbsolute(path)) {
    throw new HttpError(400, `${label} must be an absolute path.`);
  }
  const absolute = resolve(path);
  assertInsideHome(home, absolute);
  return absolute;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, message);
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, message: string): string | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== "string") throw new HttpError(400, message);
  return record[key];
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, message);
  return value;
}

function stringList(value: unknown, message: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpError(400, message);
  }
  return value.map((item) => item.trim());
}
