import type { LoadedKilnConfig } from "../config.js";
import { assertCanStack, listValidJobs, renderAddedJob, writeJob } from "../jobs.js";
import type { Job } from "../schemas.js";
import { assertWorkflowName } from "../workflow.js";
import { typeLooksLikeSpike, workflowForSpike } from "./tickets.js";

/** Jira issue keys, stored and matched in uppercase (`PROJ-123`). */
const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

const ENV_BASE_URL = "JIRA_BASE_URL";
const ENV_EMAIL = "JIRA_EMAIL";
const ENV_API_TOKEN = "JIRA_API_TOKEN";

interface AdfMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: unknown;
}

interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

interface JiraIssue {
  summary: string;
  description: unknown;
  issueType?: string;
  acceptance: unknown;
  blockedBy: string[];
}

export interface AddJiraInput {
  workflow: string;
  repo: string;
  key: string;
  title?: string;
  dependsOn: string[];
  stack?: boolean;
  dryRun: boolean;
  now?: Date;
  /** Tests pass a stub. The CLI uses the global fetch. */
  fetch?: typeof fetch;
  /** Tests pass a fixed env. The CLI uses `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface AddJiraResult {
  created: boolean;
  job?: Job;
  jsonPath?: string;
  report: string;
  warnings: string[];
}

/**
 * `kiln add <workflow> --repo R --jira PROJ-123`.
 * One issue becomes one job. Re-running the same key prints the existing id.
 */
export async function addFromJira(config: LoadedKilnConfig, input: AddJiraInput): Promise<AddJiraResult> {
  const key = normalizeIssueKey(input.key);
  assertKnownRepo(config, input.repo);
  assertWorkflowName(input.workflow);

  const existing = existingJiraJob(config, key);
  if (existing) {
    return { created: false, job: existing, report: renderExisting(existing), warnings: [] };
  }

  const credentials = resolveJiraCredentials(config, input.env ?? process.env);
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const client = { fetchImpl, credentials };
  const acceptanceField = await findAcceptanceCriteriaField(client);
  const issueUrl = jiraIssueUrl(credentials.baseUrl, key, acceptanceField);
  const issueResponse = await jiraGet(issueUrl, client);
  if (issueResponse.status !== 200) {
    failStatus(key, issueResponse.status, issueResponse.body, credentials);
  }
  const issue = parseIssue(key, parseJson(issueResponse.body, key), acceptanceField);
  const warnings: string[] = [];
  const workflow = workflowForSpike(key, typeLooksLikeSpike(issue.issueType), input.workflow, warnings);
  const dependsOn = mergeDepends(dependencyIds(config, issue.blockedBy, warnings), input.dependsOn);
  assertDependsExist(config, dependsOn);
  const specText = jiraIssueSpec({
    key,
    summary: issue.summary,
    browseUrl: `${credentials.baseUrl}/browse/${encodeURIComponent(key)}`,
    descriptionMarkdown: adfToMarkdown(issue.description),
    acceptanceMarkdown: acceptanceMarkdown(issue.acceptance),
  });
  assertCanStack(input.repo, dependsOn, input.stack, listValidJobs(config));
  const title = input.title?.trim() || `${key}: ${issue.summary}`;
  if (!title) {
    throw new Error("Job title is empty. Pass --title.");
  }
  const safeSpec = redactSecrets(specText, credentials);
  if (input.dryRun) {
    return {
      created: false,
      report: renderDryRun({
        key,
        repo: input.repo,
        workflow,
        title: redactSecrets(title, credentials),
        dependsOn,
        specText: safeSpec,
      }),
      warnings,
    };
  }
  const written = writeJob(config, {
    workflow,
    repo: input.repo,
    specText: safeSpec,
    title: redactSecrets(title, credentials),
    dependsOn,
    ...(input.stack ? { stack: true } : {}),
    source: { kind: "jira", ref: key },
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    created: true,
    job: written.job,
    jsonPath: written.jsonPath,
    report: renderAddedJob(written.job, written.jsonPath),
    warnings,
  };
}

export function normalizeIssueKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) {
    throw new Error(`Jira issue key ${JSON.stringify(raw)} is not a KEY-123 identifier.`);
  }
  return key;
}

/**
 * Atlassian document format to markdown. Unknown nodes contribute their text.
 * Covered: paragraph, heading, bullet and ordered lists, list items, code
 * blocks, blockquotes, text marks (strong, em, code, link), hard breaks, rules.
 */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  const node = asNode(value);
  if (!node) return "";
  const blocks = node.type === "doc" ? childNodes(node) : [node];
  return renderBlocks(blocks).trim();
}

function jiraIssueSpec(input: {
  key: string;
  summary: string;
  browseUrl: string;
  descriptionMarkdown: string;
  acceptanceMarkdown: string;
}): string {
  const lines = [`# ${input.key}: ${input.summary}`, `Source: ${input.browseUrl}`];
  const description = input.descriptionMarkdown.trim();
  if (description) lines.push("", description);
  const acceptance = input.acceptanceMarkdown.trim();
  if (acceptance) lines.push("", "## Acceptance criteria", "", acceptance);
  return `${lines.join("\n").trimEnd()}\n`;
}

function resolveJiraCredentials(config: LoadedKilnConfig, env: NodeJS.ProcessEnv): JiraCredentials {
  const file = config.jira;
  const baseUrl = firstSet(env[ENV_BASE_URL], file?.baseUrl);
  const email = firstSet(env[ENV_EMAIL], file?.email);
  const apiToken = firstSet(env[ENV_API_TOKEN], file?.apiToken);
  const missing: string[] = [];
  if (!baseUrl) missing.push(ENV_BASE_URL);
  if (!email) missing.push(ENV_EMAIL);
  if (!apiToken) missing.push(ENV_API_TOKEN);
  if (!baseUrl || !email || !apiToken) {
    throw new Error(
      `Jira credentials are missing: ${missing.join(", ")}. Set them in the environment, or add baseUrl, email, and apiToken to the jira block in the kiln config.`,
    );
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), email, apiToken };
}

function firstSet(envValue: string | undefined, fileValue: string | undefined): string | undefined {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = fileValue?.trim();
  return fromFile || undefined;
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ENV_BASE_URL} is not a valid http or https URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${ENV_BASE_URL} must not include a username or password.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${ENV_BASE_URL} is not a valid http or https URL.`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

interface JiraClient {
  fetchImpl: typeof fetch;
  credentials: JiraCredentials;
}

async function findAcceptanceCriteriaField(client: JiraClient): Promise<string | undefined> {
  const result = await jiraGet(`${client.credentials.baseUrl}/rest/api/3/field`, client);
  if (result.status !== 200) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const field of parsed) {
    if (typeof field !== "object" || field === null) continue;
    const record = field as { id?: unknown; name?: unknown };
    if (typeof record.name !== "string" || !/^acceptance criteria$/i.test(record.name.trim())) continue;
    if (typeof record.id !== "string" || !/^customfield_\d+$/.test(record.id)) continue;
    return record.id;
  }
  return undefined;
}

function jiraIssueUrl(baseUrl: string, key: string, acceptanceField: string | undefined): string {
  const fields = ["summary", "description", "issuetype", "issuelinks", "status"];
  if (acceptanceField) fields.push(acceptanceField);
  const query = new URLSearchParams({ fields: fields.join(",") });
  return `${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?${query.toString()}`;
}

async function jiraGet(url: string, client: JiraClient): Promise<{ status: number; body: string }> {
  const { credentials, fetchImpl } = client;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: authorizationHeader(credentials),
        Accept: "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(`Could not reach Jira at ${credentials.baseUrl}: ${message}`, credentials));
  }
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  return { status: response.status, body: redactSecrets(body, credentials) };
}

function authorizationHeader(credentials: JiraCredentials): string {
  const encoded = Buffer.from(`${credentials.email}:${credentials.apiToken}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function failStatus(key: string, status: number, body: string, credentials: JiraCredentials): never {
  const detail = jiraErrorDetail(body);
  const suffix = detail ? `: ${detail}` : "";
  const message =
    status === 401 || status === 403
      ? `Jira authentication failed for ${key} (HTTP ${status}). Check ${ENV_EMAIL} and ${ENV_API_TOKEN}${suffix}.`
      : status === 404
        ? `Jira issue ${key} was not found (HTTP 404)${suffix}.`
        : `Jira request for ${key} failed (HTTP ${status})${suffix}.`;
  throw new Error(redactSecrets(message, credentials));
}

function jiraErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { errorMessages?: unknown; errors?: unknown };
    const messages: string[] = [];
    if (Array.isArray(parsed.errorMessages)) {
      for (const item of parsed.errorMessages) {
        if (typeof item === "string" && item.trim()) messages.push(item.trim());
      }
    }
    if (typeof parsed.errors === "object" && parsed.errors !== null) {
      for (const value of Object.values(parsed.errors)) {
        if (typeof value === "string" && value.trim()) messages.push(value.trim());
      }
    }
    if (messages.length > 0) return messages.join("; ").slice(0, 300);
  } catch {
    // The body is not JSON. A short slice is still more useful than the status alone.
  }
  return trimmed.slice(0, 300).replace(/\s+/g, " ");
}

function parseJson(body: string, key: string): unknown {
  if (!body.trim()) {
    throw new Error(`Jira returned an unreadable response for ${key} (HTTP 200).`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Jira returned an unreadable response for ${key} (HTTP 200).`);
  }
}

function parseIssue(key: string, payload: unknown, acceptanceField: string | undefined): JiraIssue {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Jira returned an unreadable response for ${key} (HTTP 200).`);
  }
  const fields = (payload as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null) {
    throw new Error(`Jira issue ${key} has no fields.`);
  }
  const record = fields as Record<string, unknown>;
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error(`Jira issue ${key} has no summary.`);
  }
  return {
    summary: record.summary.trim().replace(/\s+/g, " "),
    description: record.description,
    issueType: readIssueType(record.issuetype),
    acceptance: acceptanceField ? record[acceptanceField] : undefined,
    blockedBy: readBlockedBy(record.issuelinks, key),
  };
}

function readIssueType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = (value as { name?: unknown }).name;
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return trimmed || undefined;
}

function readBlockedBy(links: unknown, selfKey: string): string[] {
  if (!Array.isArray(links)) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (typeof link !== "object" || link === null) continue;
    const record = link as { type?: { name?: unknown }; inwardIssue?: { key?: unknown } };
    const name = record.type?.name;
    if (typeof name !== "string" || !/^blocks$/i.test(name.trim())) continue;
    const raw = record.inwardIssue?.key;
    if (typeof raw !== "string") continue;
    const blocker = raw.trim().toUpperCase();
    if (!ISSUE_KEY.test(blocker) || blocker === selfKey || seen.has(blocker)) continue;
    seen.add(blocker);
    keys.push(blocker);
  }
  return keys;
}

function acceptanceMarkdown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return adfToMarkdown(value);
}

function existingJiraJob(config: LoadedKilnConfig, key: string): Job | undefined {
  return jiraJobs(config, key)[0];
}

function dependencyIds(config: LoadedKilnConfig, blockers: string[], warnings: string[]): string[] {
  const ids: string[] = [];
  for (const blocker of blockers) {
    const match = jiraJobs(config, blocker)[0];
    if (!match) {
      warnings.push(`warning: blocked by ${blocker}, which has no kiln job yet.`);
      continue;
    }
    ids.push(match.id);
  }
  return ids;
}

function jiraJobs(config: LoadedKilnConfig, key: string): Job[] {
  return listValidJobs(config)
    .filter((job) => job.source?.kind === "jira" && job.source.ref === key)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function mergeDepends(fromLinks: string[], after: string[]): string[] {
  const repeated = new Set<string>();
  for (const id of after) {
    if (repeated.has(id)) {
      throw new Error(`--after lists ${id} more than once.`);
    }
    repeated.add(id);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...fromLinks, ...after]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function assertDependsExist(config: LoadedKilnConfig, dependsOn: string[]): void {
  const known = new Set(listValidJobs(config).map((job) => job.id));
  for (const id of dependsOn) {
    if (!known.has(id)) {
      throw new Error(`Job ${id} does not exist. --after must name a job already under ${config.jobsDir}.`);
    }
  }
}

function assertKnownRepo(config: LoadedKilnConfig, repo: string): void {
  if (config.repos[repo]) return;
  const known = Object.keys(config.repos).sort();
  const suffix = known.length > 0 ? ` Known repos: ${known.join(", ")}.` : " No repos are registered.";
  throw new Error(`Unknown repo ${repo}.${suffix} Run kiln repo add ${repo} <path>.`);
}

function renderExisting(job: Job): string {
  const ref = job.source?.ref ?? "";
  return [`exists ${job.id}`, `repo ${job.repo}`, `workflow ${job.workflow}`, `source jira ${ref}`, ""].join("\n");
}

function renderDryRun(input: {
  key: string;
  repo: string;
  workflow: string;
  title: string;
  dependsOn: string[];
  specText: string;
}): string {
  const lines = [`dry-run ${input.key}`, `repo ${input.repo}`, `workflow ${input.workflow}`, `title ${input.title}`];
  if (input.dependsOn.length > 0) lines.push(`dependsOn ${input.dependsOn.join(", ")}`);
  lines.push(`source jira ${input.key}`, "spec:", input.specText.trimEnd(), "created nothing", "");
  return lines.join("\n");
}

/** The API token is sent as a Basic header and must not appear in errors or job files. */
function redactSecrets(text: string, credentials: JiraCredentials): string {
  const basic = Buffer.from(`${credentials.email}:${credentials.apiToken}`, "utf8").toString("base64");
  return text.split(credentials.apiToken).join("[redacted]").split(basic).join("[redacted]");
}

function asNode(value: unknown): AdfNode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as AdfNode;
}

function childNodes(node: AdfNode): AdfNode[] {
  if (!Array.isArray(node.content)) return [];
  const nodes: AdfNode[] = [];
  for (const child of node.content) {
    const nodeChild = asNode(child);
    if (nodeChild) nodes.push(nodeChild);
  }
  return nodes;
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes.map((node) => renderBlock(node, 0)).join("");
}

function renderBlock(node: AdfNode, depth: number): string {
  switch (node.type) {
    case "doc":
      return renderBlocks(childNodes(node));
    case "paragraph":
      return `${renderInline(childNodes(node)).trim()}\n\n`;
    case "heading":
      return `${"#".repeat(headingLevel(node.attrs?.level))} ${renderInline(childNodes(node)).trim()}\n\n`;
    case "bulletList":
      return `${renderList(node, "bullet", depth)}\n`;
    case "orderedList":
      return `${renderList(node, "ordered", depth)}\n`;
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
      return renderBlockquote(node);
    case "rule":
      return "---\n\n";
    case "listItem":
      return renderListItem(node, "-", depth);
    default:
      return renderUnknownBlock(node);
  }
}

function renderList(node: AdfNode, kind: "bullet" | "ordered", depth: number): string {
  let index = kind === "ordered" ? listStart(node.attrs?.order) : 1;
  const lines: string[] = [];
  for (const child of childNodes(node)) {
    const marker = kind === "bullet" ? "-" : `${index}.`;
    if (kind === "ordered") index += 1;
    lines.push(renderListItem(child, marker, depth));
  }
  return lines.join("");
}

function renderListItem(node: AdfNode, marker: string, depth: number): string {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];
  const blocks = childNodes(node);
  if (blocks.length === 0) {
    const text = fallbackText(node).trim();
    return `${indent}${marker} ${text}\n`;
  }
  for (const block of blocks) {
    if (block.type === "bulletList" || block.type === "orderedList") {
      const nested = renderList(block, block.type === "bulletList" ? "bullet" : "ordered", depth + 1).replace(/\n$/, "");
      if (nested) parts.push(nested);
      continue;
    }
    if (block.type === "paragraph" || block.type === undefined) {
      const text = renderInline(childNodes(block)).trim() || fallbackText(block).trim();
      if (text) parts.push(text);
      continue;
    }
    const rendered = renderBlock(block, depth + 1).trim();
    if (rendered) parts.push(rendered);
  }
  const body = parts.join("\n\n");
  const [first, ...rest] = body.split("\n");
  const continuation = `${indent}  `;
  const head = `${indent}${marker} ${first ?? ""}`;
  if (rest.length === 0) return `${head}\n`;
  const tail = rest.map((line) => (line.length > 0 ? `${continuation}${line}` : "")).join("\n");
  return `${head}\n${tail}\n`;
}

function renderCodeBlock(node: AdfNode): string {
  const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const code = rawText(node).replace(/\n$/, "");
  return `\`\`\`${language}\n${code}\n\`\`\`\n\n`;
}

function renderBlockquote(node: AdfNode): string {
  const inner = renderBlocks(childNodes(node)).trim();
  if (!inner) return "";
  const quoted = inner
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

function renderUnknownBlock(node: AdfNode): string {
  const nested = childNodes(node);
  if (nested.length > 0) {
    const blockTypes = new Set([
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "codeBlock",
      "blockquote",
      "rule",
      "doc",
    ]);
    if (nested.some((child) => child.type !== undefined && blockTypes.has(child.type))) {
      return renderBlocks(nested);
    }
    const inline = renderInline(nested).trim();
    const own = fallbackText(node).trim();
    const text = [own, inline].filter((part) => part.length > 0).join("");
    return text ? `${text}\n\n` : "";
  }
  const text = fallbackText(node).trim();
  return text ? `${text}\n\n` : "";
}

function renderInline(nodes: AdfNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out += "\\\n";
      continue;
    }
    if (node.type === "text") {
      out += applyMarks(node.text ?? "", node.marks ?? []);
      continue;
    }
    const nested = childNodes(node);
    const inner = nested.length > 0 ? renderInline(nested) : fallbackText(node);
    out += applyMarks(inner, node.marks ?? []);
  }
  return out;
}

function applyMarks(text: string, marks: AdfMark[]): string {
  let out = text;
  for (const mark of marks) {
    if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `*${out}*`;
    else if (mark.type === "code") out = `\`${out}\``;
    else if (mark.type === "link") {
      const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
      if (href) out = `[${out}](${href})`;
    }
  }
  return out;
}

function fallbackText(node: AdfNode): string {
  if (typeof node.text === "string") return node.text;
  const attrs = node.attrs;
  if (!attrs) return "";
  if (typeof attrs.text === "string") return attrs.text;
  return "";
}

function rawText(node: AdfNode): string {
  const nested = childNodes(node);
  if (nested.length === 0) return typeof node.text === "string" ? node.text : "";
  return nested.map((child) => rawText(child)).join("");
}

function headingLevel(value: unknown): number {
  const level = typeof value === "number" ? value : 1;
  if (!Number.isInteger(level)) return 1;
  return Math.min(6, Math.max(1, level));
}

function listStart(value: unknown): number {
  const start = typeof value === "number" ? value : 1;
  if (!Number.isInteger(start) || start < 1) return 1;
  return start;
}
