import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadKilnConfig, type LoadedKilnConfig } from "./config.js";
import { answerJob, readStatus, retryJob, runTick, startupRecovery } from "./driver.js";
import { browse } from "./fs-browse.js";
import { defaultHost } from "./host.js";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import { intakeJobs } from "./intake-http.js";
import { packageRoot } from "./paths.js";
import { SANDBOX_PREFLIGHT_PREFIX } from "./sandbox.js";
import type { StatusJobView } from "./report.js";
import { renderConsole, type ServePageOptions, renderMessagePage, renderTextPage } from "./serve-page.js";
import { listWorkflowNames } from "./workflow.js";

export interface ServeOptions {
  config: LoadedKilnConfig;
  /** TCP port. `0` asks the OS for an ephemeral port. */
  port: number;
  /** Seconds between ticks. Omit to leave the factory where it is. */
  tickSeconds?: number;
}

const BODY_LIMIT = 65_536;
const TEXT_LIMIT = 100_000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface LiveConfig {
  config: LoadedKilnConfig;
  secrets: string[];
  /** Set while the file on disk fails to load. The last good config stays in `config`. */
  configError?: string;
  mtimeMs: number;
  size: number;
}

interface ServeRepo {
  name: string;
  path: string;
}

/**
 * Local UI over the same derived job view as `kiln status`.
 * Listens on 127.0.0.1 only. Resolves when the process is signalled.
 */
export function startServe(options: ServeOptions): Promise<void> {
  startupRecovery(options.config);
  const css = loadServeCss();
  const csrf = randomBytes(32).toString("hex");
  const state = openLiveConfig(options.config);
  let port = options.port;

  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res, state, () => port, css, csrf).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const status = statusCode(error) ?? 500;
        sendJson(res, status, { error: redact(message, state.secrets) }, state.secrets);
      });
    });

    server.on("error", reject);

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let firstTick: NodeJS.Timeout | undefined;

    const shutdown = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (firstTick) clearTimeout(firstTick);
      server.close(() => resolvePromise());
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("kiln serve did not bind a TCP port."));
        return;
      }
      port = address.port;
      process.stdout.write(`listening http://${address.address}:${address.port}\n`);
      if (options.tickSeconds === undefined) return;
      const tick = (): void => {
        if (stopped) return;
        refreshLiveConfig(state);
        safeTick(state.config, state.secrets, false);
      };
      firstTick = setTimeout(tick, 0);
      timer = setInterval(tick, options.tickSeconds * 1000);
    });
  });
}

export function loadServeCss(): string {
  const path = join(packageRoot(), "assets", "serve.css");
  if (!existsSync(path)) {
    throw new Error(`Kiln serve stylesheet is missing at ${path}.`);
  }
  return readFileSync(path, "utf8");
}

function safeTick(config: LoadedKilnConfig, secrets: string[], startup: boolean): void {
  try {
    const report = runTick(config, defaultHost(), { startup });
    if (report.startsWith(SANDBOX_PREFLIGHT_PREFIX)) {
      const tickAt = report.indexOf("\ntick ");
      const head = tickAt === -1 ? report : report.slice(0, tickAt);
      process.stderr.write(`${redact(head.trimEnd(), secrets)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tick: ${redact(message, secrets)}\n`);
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  state: LiveConfig,
  boundPort: () => number,
  css: string,
  csrf: string,
): Promise<void> {
  refreshLiveConfig(state);
  const config = state.config;
  const secrets = state.secrets;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (method === "GET" && path === "/favicon.ico") {
    res.writeHead(204, { Connection: "close", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (method === "GET" && path === "/api/fs") {
    if (!originAllowed(req, boundPort())) {
      sendJson(res, 403, { error: "Cross-origin request rejected." }, secrets);
      return;
    }
    try {
      sendJson(res, 200, browse(homedir(), url.searchParams.get("path") ?? undefined), secrets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, statusCode(error) ?? 500, { error: message }, secrets);
    }
    return;
  }

  if (method === "POST") {
    const raw = await readBody(req);
    if (!originAllowed(req, boundPort())) {
      sendJson(res, 403, { error: "Cross-origin request rejected." }, secrets);
      return;
    }
    if (!csrfOk(csrf, req, raw)) {
      sendJson(res, 403, { error: "CSRF token rejected." }, secrets);
      return;
    }
    if (path === "/api/jobs") {
      await createJob(req, res, state, raw);
      return;
    }
    const action = /^\/api\/jobs\/([^/]+)\/(approve|reject|retry)$/.exec(path);
    if (!action?.[1] || (action[2] !== "approve" && action[2] !== "reject" && action[2] !== "retry")) {
      sendJson(res, 404, { error: "Not found." }, secrets);
      return;
    }
    const jobId = parseJobId(action[1]);
    if (!jobId) {
      sendJson(res, 404, { error: "Not found." }, secrets);
      return;
    }
    if (action[2] === "retry") {
      await retry(req, res, config, css, secrets, jobId);
      return;
    }
    await answer(req, res, config, css, secrets, jobId, action[2]);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." }, secrets);
    return;
  }

  if (path === "/" || path === "" || path === "/board") {
    sendHtml(res, 200, renderConsole(css, readStatus(config).attention, pageOptions(state, csrf)), secrets);
    return;
  }
  if (path === "/api/jobs" || path === "/api/status") {
    sendJson(res, 200, statusDocument(state), secrets);
    return;
  }

  const apiJob = /^\/api\/jobs\/([^/]+)$/.exec(path);
  if (apiJob?.[1]) {
    const jobId = parseJobId(apiJob[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendJson(res, 404, { error: jobId ? `No job ${jobId}.` : "Not found." }, secrets);
      return;
    }
    sendJson(res, 200, job, secrets);
    return;
  }

  const page = /^\/jobs\/([^/]+)\/(spec|log|findings)$/.exec(path);
  if (page?.[1] && (page[2] === "spec" || page[2] === "log" || page[2] === "findings")) {
    const jobId = parseJobId(page[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", jobId ? `No job ${jobId}.` : "Not found."), secrets);
      return;
    }
    if (page[2] === "findings") {
      sendFindings(res, config, css, secrets, job);
      return;
    }
    const target = page[2] === "spec" ? job.specPath : job.logPath;
    if (!target) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", page[2] === "log" ? "No log yet." : "No spec."), secrets);
      return;
    }
    const text = readInside(config.kilnDir, target);
    if (text === undefined) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", "That file is not in the kiln directory."), secrets);
      return;
    }
    const title = page[2] === "spec" ? `${job.title} spec` : `${job.title} log`;
    sendHtml(res, 200, renderTextPage(css, title, text), secrets);
    return;
  }

  if (path.startsWith("/api/")) sendJson(res, 404, { error: "Not found." }, secrets);
  else sendHtml(res, 404, renderMessagePage(css, "Not found", "Not found."), secrets);
}

async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  config: LoadedKilnConfig,
  css: string,
  secrets: string[],
  jobId: string,
  choice: "approve" | "reject",
): Promise<void> {
  try {
    answerJob(config, jobId, choice);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, "Could not answer", message), secrets);
    return;
  }
  const job = findJob(config, jobId);
  if (wantsJson(req)) {
    sendJson(res, 200, { ok: true, job }, secrets);
    return;
  }
  redirect(res, redirectTarget(req));
}

async function retry(
  req: IncomingMessage,
  res: ServerResponse,
  config: LoadedKilnConfig,
  css: string,
  secrets: string[],
  jobId: string,
): Promise<void> {
  try {
    retryJob(config, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, "Could not retry", message), secrets);
    return;
  }
  const job = findJob(config, jobId);
  if (wantsJson(req)) {
    sendJson(res, 200, { ok: true, job }, secrets);
    return;
  }
  redirect(res, redirectTarget(req));
}

function sendFindings(
  res: ServerResponse,
  config: LoadedKilnConfig,
  css: string,
  secrets: string[],
  job: StatusJobView,
): void {
  if (job.workflow !== INVESTIGATION_WORKFLOW) {
    sendHtml(res, 404, renderMessagePage(css, "Not found", "Not found."), secrets);
    return;
  }
  if (!job.findingsPath) {
    sendHtml(res, 404, renderMessagePage(css, "Not found", "No findings yet."), secrets);
    return;
  }
  const text = readInside(config.kilnDir, job.findingsPath);
  if (text === undefined) {
    sendHtml(res, 404, renderMessagePage(css, "Not found", "That file is not in the kiln directory."), secrets);
    return;
  }
  sendHtml(res, 200, renderTextPage(css, `${job.title} findings`, text), secrets);
}

function findJob(config: LoadedKilnConfig, jobId: string): StatusJobView | undefined {
  try {
    return readStatus(config, jobId).jobs[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `No job ${jobId}.`) return undefined;
    throw error;
  }
}

/**
 * Host must be localhost or 127.0.0.1 on the bound port.
 * Browsers send Origin on POST. A cross-site page cannot use this server:
 * Origin, when present, has to be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 * Curl and other non-browser clients omit Origin and are allowed.
 * `Sec-Fetch-Site: cross-site` is rejected even when Origin is absent.
 */
export function originAllowed(req: IncomingMessage, port: number): boolean {
  if (!hostAllowed(req, port)) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;
  const origin = req.headers.origin;
  if (Array.isArray(origin)) return false;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  const value = host.trim().toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function redirectTarget(req: IncomingMessage): string {
  const referer = req.headers.referer;
  if (typeof referer !== "string") return "/";
  try {
    const url = new URL(referer);
    if (url.pathname === "/board") return "/board";
  } catch {
    return "/";
  }
  return "/";
}

function wantsJson(req: IncomingMessage): boolean {
  const accept = headerValue(req.headers.accept);
  if (accept.includes("application/json")) return true;
  return headerValue(req.headers["content-type"]).includes("application/json");
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(",");
  return value ?? "";
}

function parseJobId(raw: string): string | undefined {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!JOB_ID.test(id)) return undefined;
  return id;
}

function readInside(kilnDir: string, target: string): string | undefined {
  let root: string;
  try {
    root = realpathSync(resolve(kilnDir));
  } catch {
    return undefined;
  }
  const resolved = resolve(target);
  if (resolved !== root && !resolved.startsWith(root + sep)) return undefined;
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return undefined;
  }
  if (real !== root && !real.startsWith(root + sep)) return undefined;
  const text = readFileSync(real, "utf8");
  if (text.length <= TEXT_LIMIT) return text;
  return `showing the last ${TEXT_LIMIT} characters\n\n${text.slice(text.length - TEXT_LIMIT)}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BODY_LIMIT) {
      const error = new Error("Request body is too large.");
      (error as { statusCode?: number }).statusCode = 413;
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function csrfOk(expected: string, req: IncomingMessage, body: string): boolean {
  const header = req.headers["x-kiln-csrf"];
  const fromHeader = typeof header === "string" ? header : undefined;
  let fromForm: string | undefined;
  if (headerValue(req.headers["content-type"]).includes("application/x-www-form-urlencoded")) {
    fromForm = new URLSearchParams(body).get("csrf") ?? undefined;
  }
  const provided = fromHeader || fromForm;
  if (!provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function createJob(req: IncomingMessage, res: ServerResponse, state: LiveConfig, raw: string): Promise<void> {
  const secrets = state.secrets;
  if (!headerValue(req.headers["content-type"]).includes("application/json")) {
    sendJson(res, 400, { error: "Content-Type must be application/json." }, secrets);
    return;
  }
  let parsed: unknown;
  if (!raw.trim()) {
    sendJson(res, 400, { error: "Request body must be a JSON object." }, secrets);
    return;
  }
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Request body is not JSON." }, secrets);
    return;
  }
  try {
    const result = await intakeJobs(state.config, parsed);
    sendJson(res, 200, result, state.secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, statusCode(error) ?? 400, { error: message }, state.secrets);
  }
}

function openLiveConfig(config: LoadedKilnConfig): LiveConfig {
  const file = fileStamp(config.configPath);
  return {
    config,
    secrets: secretValues(config),
    mtimeMs: file?.mtimeMs ?? 0,
    size: file?.size ?? -1,
  };
}

/**
 * Re-read the kiln config when the file's mtime or size changed.
 * A file that does not parse keeps the last good config and records `configError`.
 * The failed stamp is not stored, so the next request tries again.
 */
function refreshLiveConfig(state: LiveConfig): void {
  const path = state.config.configPath;
  const file = fileStamp(path);
  if (!file) {
    state.configError = redact(
      `Could not read kiln config ${path}: the file is missing.`,
      redactSecrets(state, path),
    );
    return;
  }
  if (file.mtimeMs === state.mtimeMs && file.size === state.size) return;
  try {
    const next = loadKilnConfig(path);
    state.config = next;
    state.secrets = secretValues(next);
    state.configError = undefined;
    state.mtimeMs = file.mtimeMs;
    state.size = file.size;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const named = message.includes(path) ? message : `${path}: ${message}`;
    state.configError = redact(named, redactSecrets(state, path));
  }
}

function fileStamp(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/** Last good secrets, plus a token sitting in a file that failed to load. */
function redactSecrets(state: LiveConfig, configPath: string): string[] {
  const secrets = [...state.secrets];
  const disk = tokenFromDisk(configPath);
  if (disk && !secrets.includes(disk)) secrets.push(disk);
  return secrets;
}

function tokenFromDisk(configPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { jira?: { apiToken?: unknown } };
    const token = parsed.jira?.apiToken;
    if (typeof token !== "string") return undefined;
    const trimmed = token.trim();
    return trimmed.length >= 8 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function repoList(config: LoadedKilnConfig): ServeRepo[] {
  return Object.entries(config.repos)
    .map(([name, repo]) => ({ name, path: repo.path }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function pageOptions(state: LiveConfig, csrf: string): ServePageOptions {
  return {
    csrf,
    repos: repoList(state.config),
    workflows: listWorkflowNames(),
    ...(state.configError ? { configError: state.configError } : {}),
  };
}

function statusDocument(state: LiveConfig): unknown {
  return {
    ...readStatus(state.config),
    repos: repoList(state.config),
    configError: state.configError ?? null,
  };
}

function statusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code = error.statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function sendHtml(res: ServerResponse, status: number, html: string, secrets: string[]): void {
  const body = redact(html, secrets);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "same-origin",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, secrets: string[]): void {
  const body = redact(`${JSON.stringify(value, null, 2)}\n`, secrets);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    Connection: "close",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, Connection: "close", "Cache-Control": "no-store" });
  res.end();
}

function secretValues(config: LoadedKilnConfig): string[] {
  const values = [config.jira?.apiToken, process.env.JIRA_API_TOKEN];
  const found: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 8 && !found.includes(trimmed)) found.push(trimmed);
  }
  return found;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}
