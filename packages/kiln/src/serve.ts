import { parseActivityCursor, readRunActivity, type ActivityFeed } from "./activity.js";
import { readRunArtifacts, type ArtifactSet } from "./artifacts.js";
import { groupsFromPlan } from "./phase-groups.js";
import { fork } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_PREFLIGHT_PREFIX } from "./auth.js";
import { loadKilnConfig, type LoadedKilnConfig } from "./config.js";
import {
  answerJob,
  cancelJob,
  cancelQueuedJobs,
  holdJob,
  prioritizeJob,
  readStatus,
  releaseJob,
  removeJob,
  retryJob,
  reviseJob,
  startupRecovery,
} from "./driver.js";
import { browse } from "./fs-browse.js";
import {
  branchOf,
  buildBoard,
  dayReport,
  jobDetail,
  parseSeenQuery,
  parseStatsWindow,
  localBranchExists,
  readBranchCommits,
  readDiffFiles,
  readDiffStat,
  statsFor,
  unseenChanges,
  type DiffFile,
  type StatWindow,
} from "./board-view.js";
import { appendEvent, eventsForJob, readEvents } from "./events.js";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import { cachedGitHub, defaultHost, type KilnHost, type PullRequestViewCache } from "./host.js";
import { intakeJobs } from "./intake-http.js";
import { isJobId, jobBasename, packageRoot } from "./paths.js";
import { SANDBOX_PREFLIGHT_PREFIX, sandboxIsEnabled } from "./sandbox.js";
import type { StatusJobView } from "./report.js";
import {
  isSettingsSection,
  jiraFact,
  renderApp,
  type AppSection,
  type ServePageOptions,
  type SettingsFacts,
  type SettingsSectionId,
  type StepPage,
  renderMessagePage,
  renderTextPage,
} from "./serve-page.js";
import { startedPhaseIds } from "./job-view.js";
import { STEP_NAME, planOf, readStepResult } from "./step-result.js";
import { isPaused, pauseFactory, resumeFactory, spendFor } from "./rails.js";
import { readSettings, saveSettings, settingsStatus } from "./settings.js";
import type { TickReply, TickRequest } from "./tick-worker.js";
import { effectiveTriggers, triggerRows } from "./triggers.js";
import { formatServeStartup } from "./version.js";
import { listWorkflowNames, overlayLoadCounts, workflowNamesNeedingTest } from "./workflow.js";

export interface ServeOptions {
  config: LoadedKilnConfig;
  /** TCP port. `0` asks the OS for an ephemeral port. */
  port: number;
  /** Seconds between ticks. Omit to leave the factory where it is. */
  tickSeconds?: number;
}

const BODY_LIMIT = 65_536;
const TEXT_LIMIT = 100_000;

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
  hasTest: boolean;
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
    let triggerStartup = true;
    let ticking = false;

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
      process.stdout.write(
        redact(
          formatServeStartup({
            node: process.version,
            home: state.config.kilnDir,
            url: `http://${address.address}:${address.port}`,
            ...(options.tickSeconds !== undefined ? { tickSeconds: options.tickSeconds } : {}),
            paused: isPaused(state.config.kilnDir),
            sandbox: sandboxIsEnabled(state.config) ? "docker" : "off",
            overlay: overlayLoadCounts(state.config.overlay, state.config.reviewPrompt),
          }),
          state.secrets,
        ),
      );
      if (options.tickSeconds === undefined) return;
      const tick = (): void => {
        if (stopped) return;
        const startup = triggerStartup;
        triggerStartup = false;
        refreshLiveConfig(state);
        // A tick still running is not joined by a second one. The next interval tries again.
        if (ticking) {
          triggerStartup = startup;
          return;
        }
        ticking = true;
        startTick(state, startup, () => {
          ticking = false;
        });
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

/**
 * Pull request state for this serve process. Deriving a job's state runs
 * `gh pr view`, about a second each, and a page derives it several times.
 * The tick refreshes this cache. Page requests read it.
 */
const pullRequestViews: PullRequestViewCache = new Map();

function pageHost(): KilnHost {
  const host = defaultHost();
  return { ...host, github: cachedGitHub(host.github, { cache: pullRequestViews, mode: "read" }) };
}

/**
 * Run one tick in a child process, so its synchronous `gh` and `git` calls
 * do not hold page requests. The child's pull request reads land in the
 * cache that pages read from.
 */
function startTick(state: LiveConfig, triggerStartup: boolean, done: () => void): void {
  const secrets = state.secrets;
  const fail = (message: string): void => {
    process.stderr.write(`tick: ${redact(message, secrets)}\n`);
  };
  let child: ReturnType<typeof fork>;
  try {
    child = fork(fileURLToPath(new URL("./tick-worker.js", import.meta.url)), [], { serialization: "advanced" });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    done();
    return;
  }
  child.once("message", (reply: TickReply) => {
    for (const [key, entry] of reply.views) pullRequestViews.set(key, entry);
    if (reply.error !== undefined) fail(reply.error);
    const report = reply.report ?? "";
    if (report.startsWith(SANDBOX_PREFLIGHT_PREFIX) || report.startsWith(AUTH_PREFLIGHT_PREFIX)) {
      const tickAt = report.indexOf("\ntick ");
      const head = tickAt === -1 ? report : report.slice(0, tickAt);
      process.stderr.write(`${redact(head.trimEnd(), secrets)}\n`);
    }
  });
  child.once("error", (error) => fail(error.message));
  child.once("exit", done);
  const request: TickRequest = { config: state.config, triggerStartup };
  child.send(request);
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

  const font = method === "GET" ? /^\/assets\/fonts\/(roboto(?:-mono)?-latin\.woff2)$/.exec(path)?.[1] : undefined;
  if (font) {
    const file = join(packageRoot(), "assets", "fonts", font);
    if (!existsSync(file)) {
      res.writeHead(404, { Connection: "close" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "font/woff2",
      Connection: "close",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(readFileSync(file));
    return;
  }

  if (method === "GET" && path === "/favicon.ico") {
    res.writeHead(204, { Connection: "close", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (method === "GET" && path === "/api/settings") {
    if (!originAllowed(req, boundPort())) {
      sendJson(res, 403, { error: "Cross-origin request rejected." }, secrets);
      return;
    }
    const result = readSettings(config.configPath);
    if (!result.ok) {
      sendJson(res, result.status, result.body, secrets);
      return;
    }
    sendJson(res, 200, { ...result.document, ...settingsStatus(config) }, secrets);
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

  if (method === "PUT" && path === "/api/settings") {
    const raw = await readBody(req);
    if (!originAllowed(req, boundPort())) {
      sendJson(res, 403, { error: "Cross-origin request rejected." }, secrets);
      return;
    }
    if (!csrfOk(csrf, req, raw)) {
      sendJson(res, 403, { error: "CSRF token rejected." }, secrets);
      return;
    }
    await putSettings(req, res, state, raw);
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
    if (path === "/api/jobs/cancel") {
      await cancelQueued(res, config, secrets, raw);
      return;
    }
    if (path === "/api/pause" || path === "/api/resume") {
      const pausing = path === "/api/pause";
      const changed = pausing ? pauseFactory(config.kilnDir) : resumeFactory(config.kilnDir);
      if (wantsJson(req)) {
        sendJson(res, 200, { ok: true, paused: pausing, changed }, secrets);
        return;
      }
      redirect(res, redirectTarget(req));
      return;
    }
    const action = /^\/api\/jobs\/([^/]+)\/(approve|reject|retry|revise|cancel|remove|next|hold|release)$/.exec(path);
    if (!action?.[1] || !action[2]) {
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
    if (action[2] === "cancel" || action[2] === "remove") {
      stopOrRemove(req, res, config, css, secrets, jobId, action[2]);
      return;
    }
    if (action[2] === "next" || action[2] === "hold" || action[2] === "release") {
      queueAction(req, res, config, css, secrets, jobId, action[2]);
      return;
    }
    if (action[2] === "revise") {
      await revise(req, res, config, css, secrets, jobId, raw);
      return;
    }
    if (action[2] !== "approve" && action[2] !== "reject") {
      sendJson(res, 404, { error: "Not found." }, secrets);
      return;
    }
    await answer(req, res, config, css, secrets, jobId, action[2]);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." }, secrets);
    return;
  }

  if (path === "/api/jobs" || path === "/api/status") {
    sendJson(res, 200, statusDocument(state), secrets);
    return;
  }
  if (path === "/api/board") {
    sendJson(res, 200, boardPayload(state), secrets);
    return;
  }
  if (path === "/api/stats") {
    const window = parseStatsWindow(url.searchParams.get("window"));
    if (!window) {
      sendJson(res, 400, { error: "window must be today, 7d, or 30d." }, secrets);
      return;
    }
    sendJson(res, 200, statsDocument(state, window), secrets);
    return;
  }
  if (path === "/api/report") {
    sendJson(res, 200, reportDocument(state), secrets);
    return;
  }
  if (path === "/api/unseen") {
    sendJson(res, 200, unseenDocument(state, url.searchParams.getAll("seen")), secrets);
    return;
  }
  if (path === "/api/events") {
    const jobId = url.searchParams.get("job_id");
    if (!jobId || !isJobId(jobId)) {
      sendJson(res, 400, { error: "job_id is required." }, secrets);
      return;
    }
    sendJson(res, 200, { job_id: jobId, events: eventsForJob(config.kilnDir, jobId) }, secrets);
    return;
  }

  const apiActivity = /^\/api\/jobs\/([^/]+)\/activity$/.exec(path);
  if (apiActivity?.[1]) {
    if (!originAllowed(req, boundPort())) {
      sendJson(res, 403, { error: "Cross-origin request rejected." }, secrets);
      return;
    }
    const jobId = parseJobId(apiActivity[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendJson(res, 404, { error: jobId ? `No job ${jobId}.` : "Not found." }, secrets);
      return;
    }
    const after = url.searchParams.get("after");
    if (parseActivityCursor(after) === undefined) {
      sendJson(res, 400, { error: "after must be a phase cursor." }, secrets);
      return;
    }
    const feed = readRunActivity(runDirOf(config, job), {
      running: job.state === "running" || job.state === "approved",
      after: after ?? "",
      ...(job.logTail ? { logText: job.logTail } : {}),
    });
    sendJson(res, 200, { jobId: job.jobId, ...feed }, secrets);
    return;
  }

  const apiDetail = /^\/api\/jobs\/([^/]+)\/detail$/.exec(path);
  if (apiDetail?.[1]) {
    const jobId = parseJobId(apiDetail[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendJson(res, 404, { error: jobId ? `No job ${jobId}.` : "Not found." }, secrets);
      return;
    }
    sendJson(res, 200, detailDocument(state, job), secrets);
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

  // The board has Needs you and Needs a hand as columns. Old links land there.
  if (path === "/inbox" || path === "/hand") {
    redirect(res, "/");
    return;
  }

  const listed = listSection(path);
  if (listed) {
    if (listed === "stats") {
      const window = parseStatsWindow(url.searchParams.get("window"));
      if (!window) {
        sendHtml(res, 400, renderMessagePage(css, "Stats", "window must be today, 7d, or 30d.", config.boardTheme), secrets);
        return;
      }
      sendHtml(res, 200, renderShell(state, css, csrf, "stats", { window }), secrets);
      return;
    }
    sendHtml(res, 200, renderShell(state, css, csrf, listed), secrets);
    return;
  }

  const settingsPage = /^\/settings\/([^/]+)$/.exec(path);
  if (settingsPage?.[1] && isSettingsSection(settingsPage[1])) {
    sendHtml(res, 200, renderShell(state, css, csrf, "settings", { settingsSection: settingsPage[1] }), secrets);
    return;
  }

  const repoPage = /^\/repos\/([^/]+)$/.exec(path);
  if (repoPage?.[1]) {
    let name: string;
    try {
      name = decodeURIComponent(repoPage[1]);
    } catch {
      sendHtml(res, 404, renderMessagePage(css, "Not found", "Not found.", config.boardTheme), secrets);
      return;
    }
    if (!state.config.repos[name]) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", `No repo ${name}.`, config.boardTheme), secrets);
      return;
    }
    sendHtml(res, 200, renderShell(state, css, csrf, "repos", { repo: name }), secrets);
    return;
  }

  const jobPage = /^\/jobs\/([^/]+)$/.exec(path);
  if (jobPage?.[1]) {
    const jobId = parseJobId(jobPage[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", jobId ? `No job ${jobId}.` : "Not found.", config.boardTheme), secrets);
      return;
    }
    const detail = detailDocument(state, job);
    const tabRaw = url.searchParams.get("tab");
    if (tabRaw && tabRaw !== "overview" && tabRaw !== "live" && tabRaw !== "changes" && tabRaw !== "timeline") {
      sendHtml(res, 400, renderMessagePage(css, "Job", "tab must be overview, live, changes, or timeline.", config.boardTheme), secrets);
      return;
    }
    const running = detail.job.state === "running" || detail.job.state === "approved";
    const tab = tabRaw === "overview" || tabRaw === "live" || tabRaw === "changes" || tabRaw === "timeline" ? tabRaw : undefined;
    const activity = readRunActivity(runDirOf(config, job), {
      running,
      ...(job.logTail ? { logText: job.logTail } : {}),
    });
    const runDir = runDirOf(config, job);
    const artifacts = readRunArtifacts(runDir);
    const phasePlan = runDir ? groupsFromPlan(planOf(runDir)) : [];
    sendHtml(res, 200, renderShell(state, css, csrf, "job", { detail, ...(tab ? { tab } : {}), activity, artifacts, phasePlan }), secrets);
    return;
  }

  const stepPage = /^\/jobs\/([^/]+)\/steps\/([^/]+)$/.exec(path);
  if (stepPage?.[1] && stepPage[2]) {
    const jobId = parseJobId(stepPage[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", jobId ? `No job ${jobId}.` : "Not found.", config.boardTheme), secrets);
      return;
    }
    // The step id reaches a file path (the run's artifacts), so check it before anything else uses it.
    let stepId: string;
    try {
      stepId = decodeURIComponent(stepPage[2]);
    } catch {
      sendHtml(res, 404, renderMessagePage(css, "Not found", "Not found.", config.boardTheme), secrets);
      return;
    }
    const noStep = () => sendHtml(res, 404, renderMessagePage(css, "Not found", `No step ${stepId}.`, config.boardTheme), secrets);
    if (!STEP_NAME.test(stepId) || !job.steps.some((step) => step.id === stepId)) {
      noStep();
      return;
    }
    const viewRaw = url.searchParams.get("view");
    if (viewRaw !== null && viewRaw !== "activity" && viewRaw !== "result") {
      sendHtml(res, 400, renderMessagePage(css, "Step", "view must be activity or result.", config.boardTheme), secrets);
      return;
    }
    const detail = detailDocument(state, job);
    const runDir = runDirOf(config, job);
    const activity = readRunActivity(runDir, {
      running: detail.job.state === "running" || detail.job.state === "approved",
      ...(job.logTail ? { logText: job.logTail } : {}),
    });
    if (!startedPhaseIds(detail.job, activity).has(stepId)) {
      noStep();
      return;
    }
    const step = { id: stepId, view: viewRaw === "result" ? ("result" as const) : ("activity" as const), result: readStepResult(runDir, stepId) };
    sendHtml(res, 200, renderShell(state, css, csrf, "job", { detail, activity, step }), secrets);
    return;
  }

  const page = /^\/jobs\/([^/]+)\/(spec|log|findings)$/.exec(path);
  if (page?.[1] && (page[2] === "spec" || page[2] === "log" || page[2] === "findings")) {
    const jobId = parseJobId(page[1]);
    const job = jobId ? findJob(config, jobId) : undefined;
    if (!job) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", jobId ? `No job ${jobId}.` : "Not found.", config.boardTheme), secrets);
      return;
    }
    if (page[2] === "findings") {
      sendFindings(res, config, css, secrets, job);
      return;
    }
    const target = page[2] === "spec" ? job.specPath : job.logPath;
    if (!target) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", page[2] === "log" ? "No log yet." : "No spec.", config.boardTheme), secrets);
      return;
    }
    const text = readInside(config.kilnDir, target);
    if (text === undefined) {
      sendHtml(res, 404, renderMessagePage(css, "Not found", "That file is not in the kiln directory.", config.boardTheme), secrets);
      return;
    }
    const title = page[2] === "spec" ? `${job.title} spec` : `${job.title} log`;
    sendHtml(res, 200, renderTextPage(css, title, text, config.boardTheme), secrets);
    return;
  }

  if (path.startsWith("/api/")) sendJson(res, 404, { error: "Not found." }, secrets);
  else sendHtml(res, 404, renderMessagePage(css, "Not found", "Not found.", config.boardTheme), secrets);
}

async function cancelQueued(
  res: ServerResponse,
  config: LoadedKilnConfig,
  secrets: string[],
  raw: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: "Request body is not JSON." }, secrets);
    return;
  }
  if (!isRecord(parsed) || parsed.queued !== true) {
    sendJson(res, 400, { error: "Cancel requires queued: true." }, secrets);
    return;
  }
  const repo = parsed.repo;
  const workflow = parsed.workflow;
  if (repo !== undefined && typeof repo !== "string") {
    sendJson(res, 400, { error: "repo must be a string." }, secrets);
    return;
  }
  if (workflow !== undefined && typeof workflow !== "string") {
    sendJson(res, 400, { error: "workflow must be a string." }, secrets);
    return;
  }
  try {
    const result = cancelQueuedJobs(config, {
      ...(typeof repo === "string" && repo.length > 0 ? { repo } : {}),
      ...(typeof workflow === "string" && workflow.length > 0 ? { workflow } : {}),
    });
    sendJson(res, 200, { ok: true, cancelled: result.cancelled }, secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message }, secrets);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    answerJob(config, jobId, choice, pageHost());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, "Could not answer", message, config.boardTheme), secrets);
    return;
  }
  const job = findJob(config, jobId);
  if (wantsJson(req)) {
    sendJson(res, 200, { ok: true, job }, secrets);
    return;
  }
  redirect(res, redirectTarget(req));
}

async function revise(
  req: IncomingMessage,
  res: ServerResponse,
  config: LoadedKilnConfig,
  css: string,
  secrets: string[],
  jobId: string,
  raw: string,
): Promise<void> {
  const note = noteFromBody(req, raw);
  if (!note) {
    const message = "A revise note is required.";
    if (wantsJson(req)) sendJson(res, 400, { error: message }, secrets);
    else sendHtml(res, 400, renderMessagePage(css, "Could not revise", message, config.boardTheme), secrets);
    return;
  }
  try {
    reviseJob(config, jobId, note, pageHost());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, "Could not revise", message, config.boardTheme), secrets);
    return;
  }
  const job = findJob(config, jobId);
  if (wantsJson(req)) {
    sendJson(res, 200, { ok: true, job }, secrets);
    return;
  }
  redirect(res, redirectTarget(req));
}

function noteFromBody(req: IncomingMessage, raw: string): string | undefined {
  const type = headerValue(req.headers["content-type"]);
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as { note?: unknown };
      return typeof parsed.note === "string" ? parsed.note : undefined;
    } catch {
      return undefined;
    }
  }
  return new URLSearchParams(raw).get("note") ?? undefined;
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
    retryJob(config, jobId, pageHost());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, "Could not retry", message, config.boardTheme), secrets);
    return;
  }
  const job = findJob(config, jobId);
  if (wantsJson(req)) {
    sendJson(res, 200, { ok: true, job }, secrets);
    return;
  }
  redirect(res, redirectTarget(req));
}

function stopOrRemove(
  req: IncomingMessage,
  res: ServerResponse,
  config: LoadedKilnConfig,
  css: string,
  secrets: string[],
  jobId: string,
  kind: "cancel" | "remove",
): void {
  let body: Record<string, unknown>;
  try {
    if (kind === "cancel") {
      const result = cancelJob(config, jobId);
      body = { ok: true, outcome: result.outcome, ...(result.was ? { was: result.was } : {}), message: result.message };
    } else {
      const result = removeJob(config, jobId);
      body = { ok: true, removed: result.removed, ...(result.branch ? { branch: result.branch } : {}) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    const title = kind === "cancel" ? "Could not stop" : "Could not remove";
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, title, message, config.boardTheme), secrets);
    return;
  }
  if (wantsJson(req)) {
    sendJson(res, 200, kind === "cancel" ? { ...body, job: findJob(config, jobId) } : body, secrets);
    return;
  }
  redirect(res, kind === "remove" ? "/" : redirectTarget(req));
}

/** Run next, Hold, and Release. A refusal is `changed: false` with a message, not an error. */
function queueAction(
  req: IncomingMessage,
  res: ServerResponse,
  config: LoadedKilnConfig,
  css: string,
  secrets: string[],
  jobId: string,
  kind: "next" | "hold" | "release",
): void {
  let result: { changed: boolean; message: string };
  try {
    const run = kind === "next" ? prioritizeJob : kind === "hold" ? holdJob : releaseJob;
    result = run(config, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("No job ") ? 404 : 409;
    if (wantsJson(req)) sendJson(res, status, { error: message }, secrets);
    else sendHtml(res, status, renderMessagePage(css, "Could not change the queue", message, config.boardTheme), secrets);
    return;
  }
  if (wantsJson(req)) {
    sendJson(res, 200, { ok: true, changed: result.changed, message: result.message, job: findJob(config, jobId) }, secrets);
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
    sendHtml(res, 404, renderMessagePage(css, "Not found", "Not found.", config.boardTheme), secrets);
    return;
  }
  if (!job.findingsPath) {
    sendHtml(res, 404, renderMessagePage(css, "Not found", "No findings yet.", config.boardTheme), secrets);
    return;
  }
  const text = readInside(config.kilnDir, job.findingsPath);
  if (text === undefined) {
    sendHtml(res, 404, renderMessagePage(css, "Not found", "That file is not in the kiln directory.", config.boardTheme), secrets);
    return;
  }
  sendHtml(res, 200, renderTextPage(css, `${job.title} findings`, text, config.boardTheme), secrets);
}

function findJob(config: LoadedKilnConfig, jobId: string): StatusJobView | undefined {
  try {
    return readStatus(config, jobId, pageHost()).jobs[0];
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
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
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
  if (!isJobId(id)) return undefined;
  return id;
}

function readInside(kilnDir: string, target: string): string | undefined {
  let root: string;
  try {
    root = realpathSync(resolve(kilnDir));
  } catch {
    return undefined;
  }
  // Compare the lexical path with the lexical kiln dir: realpath can add a prefix
  // (macOS tmp dirs live under /private/var), so checking it against `root` would reject every file.
  const lexicalRoot = resolve(kilnDir);
  const resolved = resolve(target);
  if (resolved !== lexicalRoot && !resolved.startsWith(lexicalRoot + sep)) return undefined;
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

async function putSettings(req: IncomingMessage, res: ServerResponse, state: LiveConfig, raw: string): Promise<void> {
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
  const result = saveSettings(state.config.configPath, parsed, homedir());
  if (!result.ok) {
    sendJson(res, result.status, result.body, secrets);
    return;
  }
  state.mtimeMs = -1;
  state.size = -1;
  refreshLiveConfig(state);
  sendJson(res, 200, { ...result.document, ...settingsStatus(state.config) }, state.secrets);
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
    appendEvent(next.kilnDir, {
      job_id: null,
      event: "config.reloaded",
      properties: {},
    });
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
    .map(([name, repo]) => ({ name, path: repo.path, hasTest: Boolean(repo.test?.trim()) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function pageOptions(state: LiveConfig, csrf: string): ServePageOptions {
  const spend = spendFor(state.config.kilnDir, state.config.dailyDollarCap);
  return {
    csrf,
    repos: repoList(state.config),
    workflows: listWorkflowNames(state.config.overlay.workflowsDir),
    workflowsNeedingTest: workflowNamesNeedingTest(state.config.overlay.workflowsDir),
    paused: isPaused(state.config.kilnDir),
    spend,
    ...(state.configError ? { configError: state.configError } : {}),
    theme: state.config.boardTheme,
    stallTimeoutMs: state.config.stallTimeoutMs,
  };
}

function statusDocument(state: LiveConfig): unknown {
  const spend = spendFor(state.config.kilnDir, state.config.dailyDollarCap);
  return {
    ...readStatus(state.config, undefined, pageHost()),
    repos: repoList(state.config),
    configError: state.configError ?? null,
    paused: isPaused(state.config.kilnDir),
    spend: { day: spend.day, usd: spend.usd, cap: spend.cap, blocked: spend.blocked },
  };
}

function listSection(path: string): AppSection | undefined {
  if (path === "/" || path === "" || path === "/board" || path === "/pipeline") return "pipeline";
  if (path === "/repos") return "repos";
  if (path === "/history") return "history";
  if (path === "/stats") return "stats";
  if (path === "/report") return "report";
  if (path === "/settings") return "settings";
  if (path === "/triggers") return "triggers";
  return undefined;
}

function runDirOf(config: LoadedKilnConfig, job: StatusJobView): string | undefined {
  const runId = job.runId;
  const checkout = config.repos[job.repo]?.path;
  if (!runId || !checkout || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return undefined;
  return join(checkout, ".runs", runId);
}

function renderShell(
  state: LiveConfig,
  css: string,
  csrf: string,
  section: AppSection,
  extra: {
    window?: StatWindow;
    repo?: string;
    detail?: ReturnType<typeof detailDocument>;
    tab?: "overview" | "live" | "changes" | "timeline";
    activity?: ActivityFeed;
    artifacts?: ArtifactSet;
    phasePlan?: string[][];
    step?: StepPage;
    settingsSection?: SettingsSectionId;
  } = {},
): string {
  const status = readStatus(state.config, undefined, pageHost());
  const events = readEvents(state.config.kilnDir, { warn: () => {} });
  const board = buildBoard(status.jobs, events, section === "pipeline" ? (job) => doneDiffFiles(state, job, events) : undefined);
  const page = pageOptions(state, csrf);
  return renderApp({
    css,
    section,
    board,
    attention: status.attention,
    page: extra.repo ? { ...page, repo: extra.repo } : page,
    ...(extra.repo ? { repo: extra.repo } : {}),
    ...(section === "stats" && extra.window ? { stats: statsDocument(state, extra.window) } : {}),
    ...(section === "report" ? { report: reportDocument(state) } : {}),
    ...(extra.detail ? { detail: extra.detail, ...(extra.tab ? { tab: extra.tab } : {}), ...(extra.activity ? { activity: extra.activity } : {}), ...(extra.artifacts ? { artifacts: extra.artifacts } : {}), ...(extra.phasePlan ? { phasePlan: extra.phasePlan } : {}), ...(extra.step ? { step: extra.step } : {}) } : {}),
    ...(section === "settings"
      ? { settingsSection: extra.settingsSection ?? "repos", settingsFacts: settingsFacts(state.config) }
      : {}),
    ...(section === "triggers"
      ? { triggers: triggerRows(state.config, readEvents(state.config.kilnDir, { warn: () => {} })) }
      : {}),
  });
}

/** Nav facts for Settings: counts and a word. The Jira token is only checked for presence. */
function settingsFacts(config: LoadedKilnConfig): SettingsFacts {
  return {
    repos: Object.keys(config.repos).length,
    triggers: effectiveTriggers(config.triggers).length,
    jira: jiraFact(config.jira, process.env.JIRA_API_TOKEN),
  };
}

function boardPayload(state: LiveConfig): unknown {
  const status = readStatus(state.config, undefined, pageHost());
  const events = readEvents(state.config.kilnDir, { warn: () => {} });
  const spend = spendFor(state.config.kilnDir, state.config.dailyDollarCap);
  return {
    ...buildBoard(status.jobs, events),
    paused: isPaused(state.config.kilnDir),
    spend,
    configError: state.configError ?? null,
  };
}

function statsDocument(state: LiveConfig, window: StatWindow) {
  const events = readEvents(state.config.kilnDir, { warn: () => {} });
  return statsFor(events, {
    window,
    ...(state.config.dailyDollarCap !== undefined ? { cap: state.config.dailyDollarCap } : {}),
  });
}

function reportDocument(state: LiveConfig) {
  const events = readEvents(state.config.kilnDir, { warn: () => {} });
  return dayReport(events, state.config.dailyDollarCap !== undefined ? { cap: state.config.dailyDollarCap } : {});
}

function unseenDocument(state: LiveConfig, seenValues: string[]) {
  const events = readEvents(state.config.kilnDir, { warn: () => {} });
  const board = buildBoard(readStatus(state.config, undefined, pageHost()).jobs, events);
  return unseenChanges(events, parseSeenQuery(seenValues), new Set(board.inbox.map((job) => job.jobId)));
}

/**
 * A finished job's branch diff does not change, so the Done card reads it once
 * per job id in this process. A failed read is remembered too and leaves the
 * diff and file count off the card.
 */
const doneDiffMemo = new Map<string, DiffFile[] | null>();

function doneDiffFiles(state: LiveConfig, job: StatusJobView, events: ReturnType<typeof readEvents>): DiffFile[] | undefined {
  const key = `${job.repo}\u0000${job.jobId}`;
  const cached = doneDiffMemo.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const repo = state.config.repos[job.repo];
  const branch = branchOf(job, events);
  const base = prBase(events, job.jobId);
  let files: DiffFile[] | undefined;
  try {
    files = repo && branch && base ? readDiffFiles(repo.path, base, branch) : undefined;
  } catch {
    files = undefined;
  }
  doneDiffMemo.set(key, files ?? null);
  return files;
}

function detailDocument(state: LiveConfig, job: StatusJobView) {
  const events = readEvents(state.config.kilnDir, { warn: () => {} });
  const repo = state.config.repos[job.repo];
  const branch = branchOf(job, events);
  const base = prBase(events, job.jobId);
  const commits = repo && branch ? readBranchCommits(repo.path, branch) : [];
  const diff = repo && branch && base ? readDiffStat(repo.path, base, branch) : undefined;
  const files = repo && branch && base ? readDiffFiles(repo.path, base, branch) : undefined;
  const issue = jobIssue(state.config, job.jobId);
  const localBranch = job.runId && branch ? `yak/${job.runId}` : undefined;
  const removedBranch = repo && localBranch && !localBranchExists(repo.path, localBranch) ? localBranch : undefined;
  return jobDetail({
    job,
    events,
    maxFixRounds: repo?.maxFixRounds ?? state.config.maxFixRounds,
    commits,
    ...(issue ? { issue } : {}),
    ...(diff ? { diffStat: diff } : {}),
    ...(files ? { diffFiles: files } : {}),
    ...(removedBranch ? { removedBranch } : {}),
  });
}

function prBase(events: ReturnType<typeof readEvents>, jobId: string): string | undefined {
  let base: string | undefined;
  for (const event of events) {
    if (event.job_id === jobId && event.event === "pr.opened") base = event.properties.base;
  }
  return base;
}

function jobIssue(config: LoadedKilnConfig, jobId: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(config.jobsDir, `${jobBasename(jobId)}.json`), "utf8")) as { issue?: unknown };
    return typeof raw.issue === "string" ? raw.issue : undefined;
  } catch {
    return undefined;
  }
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
    // data: is the inlined SVG favicon. default-src 'none' would block it.
    "Content-Security-Policy":
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  const values = [
    config.jira?.apiToken,
    process.env.JIRA_API_TOKEN,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
  ];
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
