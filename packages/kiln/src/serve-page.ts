import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.js";
import type { AttentionView } from "./attention.js";
import {
  buildBoard,
  type BoardDocument,
  type BoardJob,
  type DayReport,
  type JobDetail,
  type StatsDocument,
} from "./board-view.js";
import {
  COLUMN_LABEL,
  PIPELINE_COLUMNS,
  QUIET_AFTER_MS,
  activityLiveness,
  formatCost,
  formatDuration,
  formatClock,
  formatDay,
  formatLocal,
  formatRelative,
  phaseLabel,
  shortSha,
  stateTone,
  type ActivityRead,
  type FindingView,
  type JobView,
  type PhaseView,
  type PipelineColumn,
  type ReviewDeliverable,
  type StepMark,
} from "./job-view.js";
import type { ActivityEvent, ActivityFeed } from "./activity.js";
import { icon, type IconName } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { kilnVersion } from "./project.js";
import type { StatusJobView } from "./report.js";
import { formatSpend, type SpendSnapshot } from "./rails.js";
import { DEFAULT_STALL_TIMEOUT_MS } from "./schemas.js";
import { SECRET_PLACEHOLDER } from "./schemas.js";
import { BOARD_THEME_CHOICES, DEFAULT_BOARD_THEME, type BoardThemeId } from "./theme.js";
import type { TriggerRow } from "./triggers.js";
import { listWorkflowNames } from "./workflow.js";

export interface ServeRepoOption {
  name: string;
  path: string;
  /** False when `repos.<name>.test` is missing or blank. Omit when the page does not know. */
  hasTest?: boolean;
}

export type AppSection = "pipeline" | "inbox" | "hand" | "repos" | "history" | "stats" | "report" | "settings" | "job" | "triggers";

export interface ServePageOptions {
  csrf: string;
  repos: ServeRepoOption[];
  workflows: string[];
  /** Workflows whose verify step runs the repo test command. */
  workflowsNeedingTest?: string[];
  configError?: string;
  paused?: boolean;
  spend?: SpendSnapshot;
  /** Which list `renderConsole` draws. The serve shell passes this through `renderApp`. */
  section?: "pipeline" | "inbox" | "hand" | "repos" | "history" | "settings";
  repo?: string;
  /** Board palette. Missing uses Kiln. */
  theme?: BoardThemeId;
  /** Stall clock. Missing uses the config default. Screenshots and tests pass a fixed `now`. */
  stallTimeoutMs?: number;
  now?: number;
}

interface BoardClock {
  stallTimeoutMs: number;
  now?: number;
}

export interface AppModel {
  css: string;
  section: AppSection;
  board: BoardDocument;
  attention: AttentionView;
  page?: ServePageOptions;
  repo?: string;
  stats?: StatsDocument;
  report?: DayReport;
  detail?: JobDetail;
  tab?: "overview" | "live" | "changes" | "timeline";
  activity?: ActivityFeed;
  triggers?: TriggerRow[];
}

const LIVE_SCRIPT = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

/** Sidebar `.logo` tile: `--logo` 28px, `--radius-md` 4px, glyph `--icon` 16px. */
const FAVICON_BADGE = 28;
const FAVICON_RADIUS = 4;
const FAVICON_GLYPH = 16;

/** Kiln mark in the sidebar brand. `place` positions that same SVG inside the favicon badge. */
function kilnMark(stroke: string, place = ""): string {
  return `<svg ${place}xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V6l5-3 5 3v6l-5 3-5-3z"/><path d="M3 6l5 3 5-3M8 9v6"/></svg>`;
}

function boardStylesheet(): string {
  return readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");
}

function themeBlock(css: string, theme: string): string {
  const start = css.indexOf(`/* theme:${theme} */`);
  if (start === -1) return "";
  const end = css.indexOf("/* theme:end */", start);
  return end === -1 ? "" : css.slice(start, end);
}

function declaredColor(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  return match?.[1];
}

/** Accent and glyph colors from the theme block in `serve.css`. No palette of our own. */
function themeAccent(css: string, theme: BoardThemeId): { fill: string; stroke: string } {
  const source = css.includes("/* theme:") ? css : boardStylesheet();
  const block =
    themeBlock(source, theme) ||
    themeBlock(source, DEFAULT_BOARD_THEME) ||
    themeBlock(boardStylesheet(), DEFAULT_BOARD_THEME);
  const fill = declaredColor(block, "--primary");
  const stroke = declaredColor(block, "--on-primary");
  if (!fill || !stroke) throw new Error(`Board theme ${theme} has no accent color.`);
  return { fill, stroke };
}

function faviconSvg(fill: string, stroke: string): string {
  const offset = (FAVICON_BADGE - FAVICON_GLYPH) / 2;
  const glyph = kilnMark(stroke, `x="${offset}" y="${offset}" width="${FAVICON_GLYPH}" height="${FAVICON_GLYPH}" `);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_BADGE} ${FAVICON_BADGE}"><rect width="${FAVICON_BADGE}" height="${FAVICON_BADGE}" rx="${FAVICON_RADIUS}" fill="${fill}"/>${glyph}</svg>`;
}

function faviconLink(css: string, theme: BoardThemeId): string {
  const accent = themeAccent(css, theme);
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(faviconSvg(accent.fill, accent.stroke))}">`;
}

export function renderConsole(css: string, attention: AttentionView, page?: ServePageOptions): string {
  const jobs = [...attention.needsYou, ...attention.inFlight, ...attention.doneRecently].map((item) => item.job);
  const board = buildBoard(jobs, []);
  const section = page?.section ?? "inbox";
  return renderApp({ css, section, board, attention, ...(page ? { page, ...(page.repo ? { repo: page.repo } : {}) } : {}) });
}

export function renderApp(model: AppModel): string {
  const page = model.page ?? { csrf: "", repos: [], workflows: listWorkflowNames() };
  const paused = page.paused === true;
  const versionText = kilnVersion();
  const version = versionText && versionText !== "unknown" ? `<span class="ver">v${escapeHtml(versionText)}</span>` : "";
  const spend = page.spend ? `<span class="spend" id="spend">${escapeHtml(formatSpend(page.spend))}</span>` : `<span class="spend" id="spend"></span>`;
  const capNote = page.spend?.blocked ? `<span class="cap" id="cap-note">cap hit</span>` : `<span class="cap" id="cap-note" hidden>cap hit</span>`;
  const body = `<div class="shell">
<aside class="nav" aria-label="Kiln">
<div class="brand"><span class="logo" aria-hidden="true">${kilnMark("currentColor")}</span><div><h1>Kiln</h1>${version}</div></div>
<div class="nav-scroll">
${navHtml(model)}
<button class="add" type="button" id="add-job">Add job</button>
</div>
<footer class="side-foot">
<div class="runstate" id="runstate">
<span class="live-dot${paused ? " paused" : ""}" id="run-dot" aria-hidden="true"></span>
<span id="run-label">${paused ? "Paused" : "Running"}</span>
<form method="post" action="${paused ? "/api/resume" : "/api/pause"}" class="pause" id="pause-form"><input type="hidden" name="csrf" value="${escapeHtml(page.csrf)}"><button type="submit" id="pause-toggle" aria-pressed="${paused ? "true" : "false"}">${icon("pause", "icon icon-pause")}${icon("play", "icon icon-play")}<span id="pause-label">${paused ? "Resume" : "Pause"}</span></button></form>
</div>
<p class="spend-row">${spend}${capNote}</p>
<div class="notify">
<button class="tool-link" type="button" id="notify" data-state="ask" aria-pressed="false">${icon("bell", "icon icon-bell")}${icon("bell-off", "icon icon-bell-off")}<span id="notify-label">Notify me</span></button>
<p class="notify-note" id="notify-note" hidden></p>
</div>
</footer>
</aside>
<div class="workspace${model.section === "job" ? " with-rail" : ""}">
${mainHtml(model, page)}
</div>
</div>
<div class="scrim" data-close></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Add job">
${intakeSheet(page, model.attention)}
</aside>`;
  const job = model.detail?.job;
  return document({
    css: model.css,
    title: `(${model.board.inboxCount}) Kiln`,
    needsYou: model.attention.needsYouCount,
    revision: model.attention.revision,
    csrf: page.csrf,
    section: model.section,
    theme: page.theme ?? DEFAULT_BOARD_THEME,
    stallTimeoutMs: page.stallTimeoutMs,
    ...(job ? { jobId: job.jobId, latest: job.latestEventAt } : {}),
    live: true,
    body,
  });
}

export function renderTextPage(css: string, title: string, text: string, theme: BoardThemeId = DEFAULT_BOARD_THEME): string {
  return document({
    css,
    title,
    needsYou: 0,
    revision: "",
    section: "job",
    theme,
    live: false,
    body: `<a class="back" href="/">Pipeline</a>
<div class="page"><h1>${escapeHtml(title)}</h1>
<pre class="text">${escapeHtml(text)}</pre></div>`,
  });
}

export function renderMessagePage(
  css: string,
  title: string,
  message: string,
  theme: BoardThemeId = DEFAULT_BOARD_THEME,
): string {
  return document({
    css,
    title,
    needsYou: 0,
    revision: "",
    section: "job",
    theme,
    live: false,
    body: `<a class="back" href="/">Pipeline</a>
<div class="page"><h1>${escapeHtml(title)}</h1>
<p class="empty">${escapeHtml(message)}</p></div>`,
  });
}

function navHtml(model: AppModel): string {
  const board = model.board;
  const item = (href: string, id: string, label: string, section: AppSection, glyph: IconName, badge?: number) => {
    const current = model.section === section ? ` aria-current="page"` : "";
    const count = badge !== undefined && badge > 0 ? `<span class="badge">${badge}</span>` : "";
    const extra = id === "open-settings" ? ` id="open-settings"` : "";
    return `<a class="nav-link" href="${href}"${current}${extra}><span class="nav-label">${icon(glyph)}${escapeHtml(label)}</span>${count}</a>`;
  };
  const repos = board.repos
    .map((group) => {
      const current = model.section === "repos" && model.repo === group.repo ? ` aria-current="page"` : "";
      return `<a class="nav-sub" href="/repos/${encodeURIComponent(group.repo)}"${current}>${escapeHtml(group.repo)}<span class="badge">${group.jobs.length}</span></a>`;
    })
    .join("");
  return `<nav class="side" aria-label="Sections">
${item("/", "pipeline", "Pipeline", "pipeline", "pipeline")}
${item("/inbox", "inbox", "Inbox", "inbox", "inbox", board.inboxCount)}
<p class="unseen" id="inbox-unseen" hidden></p>
${item("/hand", "hand", "Needs a hand", "hand", "hand", board.handCount)}
${item("/repos", "repos", "Repos", "repos", "repos")}
${repos}
${item("/history", "history", "History", "history", "history", board.history.length)}
${item("/stats", "stats", "Stats", "stats", "stats")}
${item("/report", "report", "Today", "report", "today")}
${item("/triggers", "triggers", "Triggers", "triggers", "triggers")}
${item("/settings", "open-settings", "Settings", "settings", "settings")}
</nav>`;
}

function mainHtml(model: AppModel, page: ServePageOptions): string {
  const error = `<p class="meta config-error" id="config-error" role="status"${page.configError ? "" : " hidden"}>${escapeHtml(page.configError ?? "")}</p>`;
  if (model.section === "settings") {
    return `${error}<main class="main"><h2>Settings</h2><section id="settings" aria-label="Settings">${settingsForm(page.theme ?? DEFAULT_BOARD_THEME)}</section></main>`;
  }
  if (model.section === "stats" && model.stats) {
    return `${error}<main class="main">${statsHtml(model.stats)}</main>`;
  }
  if (model.section === "report" && model.report) {
    return `${error}<main class="main">${reportHtml(model.report)}</main>`;
  }
  if (model.section === "job" && model.detail) {
    return `${error}<main class="main detail">${detailHtml(model.detail, model.tab ?? "overview", page.csrf, clockOf(page), model.activity)}</main>`;
  }
  if (model.section === "triggers") {
    return `${error}<main class="main">${triggersHtml(model.triggers ?? [])}</main>`;
  }
  if (model.section === "pipeline") {
    return `${error}<main class="main">${pipelineHtml(allJobs(model.board), clockOf(page))}</main>`;
  }
  return `${error}<main class="main">${listHtml(model, page.csrf, clockOf(page))}</main>`;
}

function clockOf(page: ServePageOptions): BoardClock {
  return {
    stallTimeoutMs: page.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    ...(page.now !== undefined ? { now: page.now } : {}),
  };
}

function triggersHtml(rows: readonly TriggerRow[]): string {
  const body =
    rows.length === 0
      ? `<p class="empty">No triggers.</p>`
      : rows.map((row) => triggerCard(row)).join("\n");
  return `<header class="list-head"><h2>Triggers</h2><p class="meta">The clock, Jira, and pull request activity can start work. A review is posted only after you approve it. Kiln does not approve or merge. <a href="/settings">Edit triggers in Settings.</a></p></header>${body}`;
}

function triggerCard(row: TriggerRow): string {
  const on = row.enabled;
  const bits = [row.kind, row.schedule, on ? "enabled" : "disabled"];
  if (row.label) bits.push(`label ${row.label}`);
  if (row.maxNew !== undefined) bits.push(`${row.maxNew} new/fire`);
  if (row.maxQueued !== undefined) bits.push(`${row.maxQueued} queued or running`);
  if (row.repoLabels && row.repoLabels.length > 0) {
    bits.push(row.repoLabels.map((item) => `${item.repo} label ${item.label}`).join(", "));
  }
  const next = row.nextFire ? `<p class="meta">next <time datetime="${escapeHtml(row.nextFire)}" data-time>${escapeHtml(row.nextFire)}</time></p>` : "";
  const last = row.lastFire ? `<p class="meta">last fire <time datetime="${escapeHtml(row.lastFire)}" data-time>${escapeHtml(row.lastFire)}</time></p>` : `<p class="meta">last fire none</p>`;
  const error = row.lastError
    ? `<p class="err">last error${row.lastErrorAt ? ` <time datetime="${escapeHtml(row.lastErrorAt)}" data-time>${escapeHtml(row.lastErrorAt)}</time>` : ""}: ${escapeHtml(row.lastError)}</p>`
    : "";
  const recent =
    row.recent.length === 0
      ? `<p class="empty">No routed events yet.</p>`
      : `<ul class="recent">${row.recent
          .map(
            (item) =>
              `<li><time datetime="${escapeHtml(item.ts)}" data-time>${escapeHtml(item.ts)}</time> <span class="ev">${escapeHtml(item.event)}</span> ${escapeHtml(item.summary)}</li>`,
          )
          .join("")}</ul>`;
  return `<article class="trigger" id="trigger-${escapeHtml(row.id)}">
<h3>${escapeHtml(row.id)}</h3>
<p class="meta">${escapeHtml(bits.join(" · "))}</p>
${next}${last}${error}
${recent}
</article>`;
}

function allJobs(board: BoardDocument): JobView[] {
  return board.repos.flatMap((group) => group.jobs);
}

function listHtml(model: AppModel, csrf: string, clock: BoardClock): string {
  const board = model.board;
  if (model.section === "inbox") {
    return `<header class="list-head"><h2>Inbox</h2><p class="meta">Approve, reject, or revise. Approving a review posts the draft as a comment. Kiln does not approve or merge.</p></header>${jobList(board.inbox, "inbox", "Nothing is waiting on a gate.", csrf, clock)}`;
  }
  if (model.section === "hand") {
    return `<header class="list-head"><h2>Needs a hand</h2><p class="meta">A breaker tripped, a cap was hit, a review could not be posted, a launch is blocked on a repo setting, or a run failed with no retry left.</p></header>${jobList(board.hand, "hand", "Nothing needs a person.", csrf, clock)}`;
  }
  if (model.section === "history") {
    return `<header class="list-head"><h2>History</h2></header>${jobList(board.history, "history", "No finished jobs.", csrf, clock)}`;
  }
  const groups = model.repo ? board.repos.filter((group) => group.repo === model.repo) : board.repos;
  if (groups.length === 0) return `<header class="list-head"><h2>Repos</h2></header><p class="empty">No jobs.</p>`;
  const heading = model.repo ? escapeHtml(model.repo) : "Repos";
  return `<header class="list-head"><h2>${heading}</h2></header>${groups
    .map((group) => {
      const label = model.repo ? "" : `<h3>${escapeHtml(group.repo)}</h3>`;
      return `<section class="repo-block">${label}${groupedJobs(group.jobs, "repos", csrf, clock)}</section>`;
    })
    .join("")}`;
}

/** Jobs in one column. Queued cards follow launch order, the same order `kiln queue` prints. */
function inColumn<T extends JobView>(jobs: readonly T[], column: PipelineColumn): T[] {
  const rows = jobs.filter((job) => job.column === column);
  if (column !== "queued") return rows;
  return rows.sort((left, right) => (left.queuePosition ?? Infinity) - (right.queuePosition ?? Infinity));
}

function heldChip(job: JobView): string {
  return job.held ? `<span class="chip">Held</span>` : "";
}

function pipelineHtml(jobs: readonly JobView[], clock: BoardClock): string {
  const columns = PIPELINE_COLUMNS.map((column) => {
    const cards = inColumn(jobs, column).map((job) => pipeCard(job, clock)).join("");
    return `<section class="col" data-column="${column}">
<header class="full"><h2>${escapeHtml(COLUMN_LABEL[column])}</h2><span class="count"></span></header>
<div class="slim-face"><span>${escapeHtml(COLUMN_LABEL[column])}</span><span class="count"></span></div>
${cards}<p class="empty">${escapeHtml(emptyColumn(column))}</p>
</section>`;
  }).join("");
  return `<header class="list-head"><div class="head-row"><h2>Pipeline</h2><button type="button" id="compact" aria-pressed="true" aria-label="collapse empty columns"></button></div><p class="meta">Jobs moving through queued, running, needs you, needs a hand, and done.</p></header>${filtersHtml(jobs)}<div class="board-scroll"><div class="board" id="board">${columns}</div></div>`;
}

function emptyColumn(column: PipelineColumn): string {
  switch (column) {
    case "queued":
      return "Nothing queued.";
    case "running":
      return "Nothing running.";
    case "needs-you":
      return "Nothing needs you.";
    case "needs-hand":
      return "Nothing needs a hand.";
    case "done":
      return "Nothing finished.";
  }
}

function filtersHtml(jobs: readonly JobView[]): string {
  const repos = [...new Set(jobs.map((job) => job.repo))].sort((left, right) => left.localeCompare(right));
  const workflows = [...new Set(jobs.map((job) => job.workflow))].sort((left, right) => left.localeCompare(right));
  const repoButtons = [`<button type="button" class="repo-f" data-repo="" aria-pressed="true">All</button>`]
    .concat(repos.map((repo) => `<button type="button" class="repo-f" data-repo="${escapeHtml(repo)}">${escapeHtml(repo)}</button>`))
    .join("");
  const workflowButtons = [`<button type="button" class="wf-f" data-workflow="" aria-pressed="true">All</button>`]
    .concat(workflows.map((workflow) => `<button type="button" class="wf-f" data-workflow="${escapeHtml(workflow)}">${escapeHtml(workflow)}</button>`))
    .join("");
  return `<div class="filters"><div class="filter"><span class="k">Repo</span>${repoButtons}</div><div class="filter"><span class="k">Workflow</span>${workflowButtons}</div></div>`;
}

function pipeCard(job: JobView, clock: BoardClock): string {
  const id = encodeURIComponent(job.jobId);
  const cost = formatCost(job.costUsd);
  const age = job.since ? timeHtml(job.since, "rel") : "";
  const blocked = job.launchBlock ? `<p class="reason">${escapeHtml(job.reason)}</p>${launchFixHtml(job)}` : "";
  return `<article class="card" id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-state="${escapeHtml(job.state)}" data-repo="${escapeHtml(job.repo)}" data-workflow="${escapeHtml(job.workflow)}"${activityAttrs(job)}${job.latestEventAt ? ` data-latest="${escapeHtml(job.latestEventAt)}"` : ""}>
<a class="job-title" href="/jobs/${id}">${escapeHtml(job.title)}</a>
<div class="job-meta"><span class="meta">${escapeHtml(job.repo)}</span><span class="chip">${escapeHtml(job.workflow)}</span>${heldChip(job)}${age}${cost ? `<span class="meta">${escapeHtml(cost)}</span>` : ""}</div>
${progressHtml(job, clock, false)}${blocked}
</article>`;
}

function groupedJobs(jobs: readonly JobView[], section: "repos" | "history", csrf: string, clock: BoardClock): string {
  const blocks = PIPELINE_COLUMNS.flatMap((column) => {
    const rows = inColumn(jobs, column);
    if (rows.length === 0) return [];
    const cards = rows.map((job) => jobRow(job, section, csrf, clock)).join("\n");
    return [
      `<section class="state-group"><div class="jobs"><h3>${escapeHtml(COLUMN_LABEL[column])}<span class="badge">${rows.length}</span></h3>\n${cards}</div></section>`,
    ];
  });
  return blocks.length === 0 ? `<p class="empty">No jobs.</p>` : blocks.join("");
}

function jobList(
  jobs: readonly BoardJob[],
  section: "inbox" | "hand" | "repos" | "history",
  empty: string,
  csrf: string,
  clock: BoardClock,
): string {
  if (jobs.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<div class="jobs">${jobs.map((job) => jobRow(job, section, csrf, clock)).join("\n")}</div>`;
}

function jobRow(job: BoardJob, section: "inbox" | "hand" | "repos" | "history", csrf: string, clock: BoardClock): string {
  const id = encodeURIComponent(job.jobId);
  const classes = ["job"];
  if (section === "inbox") classes.push("decision");
  if (job.scheduledRetry) classes.push("retrying");
  if (section === "inbox" || (section === "hand" && !job.scheduledRetry && !job.launchBlock)) classes.push("human");
  const flag = classes.includes("human") ? `<span class="flag">Needs a decision</span>` : "";
  const repo = section === "repos" ? "" : `<span class="meta">${escapeHtml(job.repo)}</span>`;
  const sandbox = job.sandboxed ? `<span class="meta">sandbox · docker</span>` : "";
  const pr = section === "repos" && job.state === "in-review" ? `<span class="meta">PR review</span>` : "";
  const retrying =
    job.scheduledRetry && job.nextRetryAt
      ? `<div class="meta">retrying <time datetime="${escapeHtml(job.nextRetryAt)}" data-time="clock">${escapeHtml(formatRelative(job.nextRetryAt))}</time>${job.attemptLine ? ` · ${escapeHtml(job.attemptLine)}` : ""}</div>`
      : "";
  const attempt = !retrying && job.attemptLine && (section === "hand" || section === "inbox") ? `<div class="meta">${escapeHtml(job.attemptLine)}</div>` : "";
  const history = job.historyLine ? `<div class="meta">${escapeHtml(job.historyLine)}</div>` : "";
  const unsafe = job.prUrl && !safeUrl(job.prUrl) ? `<div class="branch">${escapeHtml(job.prUrl)}</div>` : "";
  const deps = dependsHtml(job);
  const body = section === "inbox" ? decisionBody(job) : "";
  const reason = section === "inbox" && !showReason(job) ? "" : `<p class="reason">${escapeHtml(job.reason)}</p>`;
  const fix = launchFixHtml(job);
  const feedback = feedbackHtml(job);
  const tail = section !== "inbox" && job.logTail ? logDisclosure(job.logTail) : "";
  const notes = visibleNotes(job, section);
  const unseen = `<p class="unseen" data-unseen-for="${escapeHtml(job.jobId)}" hidden></p>`;
  const links = fileLinks(job);
  const age = job.since ? timeHtml(job.since, "rel") : "";
  const cost = formatCost(job.costUsd);
  return `<article class="${classes.join(" ")}" id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-state="${escapeHtml(job.state)}" data-repo="${escapeHtml(job.repo)}" data-workflow="${escapeHtml(job.workflow)}" data-deps="${escapeHtml(job.dependsOn.map((dep) => dep.jobId).join(" "))}"${activityAttrs(job)}${job.latestEventAt ? ` data-latest="${escapeHtml(job.latestEventAt)}"` : ""}>
<div class="job-main">
<div class="job-top">${flag}<a class="job-title" href="/jobs/${id}">${escapeHtml(job.title)}</a></div>
<div class="job-meta"><span class="num">${escapeHtml(job.jobId)}</span>${repo}<span class="chip ${stateTone(job.state)}">${escapeHtml(job.state)}</span>${heldChip(job)}<span class="chip">${escapeHtml(job.workflow)}</span>${age}${cost ? `<span class="meta">${escapeHtml(cost)}</span>` : ""}${sandbox}${pr}</div>
${progressHtml(job, clock, false)}${reason}${fix}${section === "inbox" ? ranHtml(job) : ""}${history}${unsafe}${retrying}${attempt}${deps}${feedback}${body}${notes}${tail}${unseen}${links}
</div>
${actionsHtml(job, section, csrf)}
</article>`;
}

function showReason(job: JobView): boolean {
  if (!job.ask) return true;
  const norm = (value: string) => value.replace(/^Gate:\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  const ask = norm(job.ask);
  const reason = norm(job.reason);
  return reason !== ask && !reason.endsWith(ask);
}

function visibleNotes(job: JobView, section: "inbox" | "hand" | "repos" | "history"): string {
  const lines = job.notes.filter((line) => section === "inbox" || !looksLikeLog(line));
  if (lines.length === 0) return "";
  return `<div class="note">${lines.map((line) => escapeHtml(line)).join("<br>")}</div>`;
}

function decisionBody(job: JobView): string {
  const ask = job.ask ? `<p class="ask">${escapeHtml(job.ask)}</p>` : "";
  const policy =
    job.workflow === "review" && job.canApprove
      ? `<p class="meta">Approving posts this draft as a pull request comment. Kiln does not approve the pull request or merge it.</p>`
      : "";
  return `${ask}${policy}${deliverableHtml(job)}`;
}

function ranHtml(job: JobView): string {
  if (job.phases.length === 0 && job.costUsd === null) return "";
  const bits = [job.workflow];
  if (job.phases.length > 0) bits.push(job.phases.map((phase) => `${phase.label} ${phase.status}`).join(", "));
  const durations = job.phases.flatMap((phase) => (phase.durationMs === undefined ? [] : [phase.durationMs]));
  if (durations.length > 0) bits.push(formatDuration(durations.reduce((sum, ms) => sum + ms, 0)));
  const cost = formatCost(job.costUsd);
  if (cost) bits.push(cost);
  return `<p class="ran">${escapeHtml(bits.join(" · "))}</p>`;
}

function activityAttrs(job: JobView): string {
  const activity = job.stallActivityAt ? ` data-activity="${escapeHtml(job.stallActivityAt)}"` : "";
  return ` data-column="${escapeHtml(job.column)}"${activity}`;
}

function progressHtml(job: JobView, clock: BoardClock, full: boolean): string {
  if (job.steps.length === 0) return "";
  const live = activityLiveness({
    column: job.column,
    ...(job.stallActivityAt ? { lastActivityAt: job.stallActivityAt } : {}),
    ...(clock.now !== undefined ? { now: clock.now } : {}),
    stallTimeoutMs: clock.stallTimeoutMs,
  });
  const focus = focusStep(job.steps);
  const items = job.steps
    .map((step) => {
      const cls = stepClass(step.status);
      const mark = step.status === "done" ? icon("check", "icon mark") : "";
      const current = step.status === "running" || step.status === "failed" ? ` aria-current="step"` : "";
      return `<li class="step ${cls}"${current}>${mark}<span class="name">${escapeHtml(step.label)}</span></li>`;
    })
    .join("");
  const nowName = focus ? `<span class="step-now ${stepClass(focus.status)}" aria-hidden="true">${escapeHtml(focus.label)}</span>` : "";
  const liveness = live.liveness === "idle" ? "" : livenessHtml(live);
  const meta = nowName || liveness ? `<div class="progress-meta">${nowName}${liveness}</div>` : "";
  const variant = full ? " steps-full" : "";
  return `<div class="progress"><ol class="steps${variant}" aria-label="Steps">${items}</ol>${meta}</div>`;
}

function stepClass(status: StepMark["status"]): string {
  if (status === "done") return "done";
  if (status === "skipped") return "skipped";
  if (status === "running") return "current";
  if (status === "failed") return "failed";
  return "upcoming";
}

function focusStep(steps: readonly StepMark[]): StepMark | undefined {
  return (
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "failed") ??
    [...steps].reverse().find((step) => step.status === "done")
  );
}

function livenessHtml(live: ActivityRead): string {
  const dot = live.liveness === "stalled" ? "" : `<span class="live-dot" aria-hidden="true"></span>`;
  return `<span class="liveness ${live.liveness}">${dot}<span class="liveness-label">${escapeHtml(live.label ?? "")}</span></span>`;
}

function deliverableHtml(job: JobView, skipPr = false): string {
  const deliverable = job.deliverable;
  if (!deliverable) return "";
  if (deliverable.kind === "review") return reviewHtml(job, deliverable, skipPr);
  const prose = deliverable.markdown ? `<div class="prose">${renderMarkdown(deliverable.markdown)}</div>` : "";
  const notes = deliverable.notes.length
    ? `<ul class="notes">${deliverable.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    : "";
  return `${prose}${notes}`;
}

function reviewHtml(job: JobView, review: ReviewDeliverable, skipPr = false): string {
  const link = skipPr ? "" : prLinkHtml(job.repo, review.prNumber ?? job.prNumber, review.prUrl ?? job.prUrl, review.headSha ?? job.headSha);
  const verdict = review.verdict ? `<p class="verdict">${escapeHtml(review.verdict)}</p>` : "";
  const prose = review.markdown ? `<div class="prose">${renderMarkdown(review.markdown)}</div>` : "";
  const raw = review.raw ? `<details class="raw"><summary>Raw output</summary><pre class="text">${escapeHtml(review.raw)}</pre></details>` : "";
  return `${link}${verdict}${prose}${findingsHtml(review.findings)}${raw}`;
}

function findingsHtml(findings: readonly FindingView[]): string {
  if (findings.length === 0) return `<p class="empty">No findings.</p>`;
  const groups: string[] = [];
  let severity = "";
  let items: string[] = [];
  const flush = () => {
    if (!severity) return;
    groups.push(`<section class="finding-group"><h3>${escapeHtml(severity)}</h3><ul>${items.join("")}</ul></section>`);
  };
  for (const finding of findings) {
    if (finding.severity !== severity) {
      flush();
      severity = finding.severity;
      items = [];
    }
    const loc =
      finding.file && finding.line !== undefined
        ? `<code>${escapeHtml(`${finding.file}:${finding.line}`)}</code>`
        : finding.file
          ? `<code>${escapeHtml(finding.file)}</code>`
          : "";
    items.push(`<li>${loc}<span>${escapeHtml(finding.comment)}</span></li>`);
  }
  flush();
  return `<div class="findings">${groups.join("")}</div>`;
}

function prLinkHtml(repo: string, number: number | undefined, url: string | undefined, sha: string | undefined): string {
  if (!number && !url && !sha) return "";
  const label = number ? `${repo}#${number}` : "pull request";
  const safe = url ? safeUrl(url) : undefined;
  const link = safe ? `<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>` : escapeHtml(label);
  const short = sha ? ` <code>${escapeHtml(shortSha(sha))}</code>` : "";
  return `<p class="pr-line">${link}${short}</p>`;
}

function logDisclosure(text: string): string {
  return `<details class="log"><summary>Log</summary><pre class="text">${escapeHtml(clipTail(text))}</pre></details>`;
}

function looksLikeLog(text: string): boolean {
  return /yak resume|worktree branch|suspended —/.test(text) || text.split("\n").length > 8;
}

function timeHtml(iso: string, mode: "rel" | "local" | "clock" | "date"): string {
  const text =
    mode === "rel" ? formatRelative(iso) : mode === "date" ? formatDay(iso) : mode === "clock" ? formatClock(iso) : formatLocal(iso);
  return `<time datetime="${escapeHtml(iso)}" data-time="${mode}">${escapeHtml(text)}</time>`;
}

function clipTail(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-8);
  return tail.join("\n");
}

function launchFixHtml(job: JobView): string {
  const fix = job.launchBlock?.fix;
  if (!fix) return "";
  const href = `/settings?${new URLSearchParams({ repo: fix.repo, field: fix.field }).toString()}`;
  return `<p class="links"><a href="${escapeHtml(href)}">Edit ${escapeHtml(fix.repo)} in Settings</a></p>`;
}

function fileLinks(job: BoardJob): string {
  const id = encodeURIComponent(job.jobId);
  const links: string[] = [];
  if (job.spec) links.push(fileLink(`/jobs/${id}/spec`, "file-text", "Spec"));
  if (job.log) links.push(fileLink(`/jobs/${id}/log`, "scroll-text", "Log"));
  if (job.findings) links.push(fileLink(`/jobs/${id}/findings`, "list-checks", "Findings"));
  if (links.length === 0) return "";
  return `<p class="links">${links.join("")}</p>`;
}

function fileLink(href: string, name: IconName, label: string): string {
  return `<a class="text-btn" href="${href}">${icon(name)}<span>${escapeHtml(label)}</span></a>`;
}

function feedbackHtml(job: BoardJob): string {
  if (job.feedback.length === 0) return "";
  const rows = job.feedback
    .map((line) => {
      const href = line.url ? safeUrl(line.url) : undefined;
      const body = href ? `<a href="${escapeHtml(href)}">${escapeHtml(line.label)}</a>` : escapeHtml(line.label);
      return `<li>${body}</li>`;
    })
    .join("");
  return `<ul class="feedback">${rows}</ul>`;
}

function dependsHtml(job: BoardJob): string {
  if (job.dependsOn.length === 0) return "";
  const links = job.dependsOn
    .map((dep) => `<a href="/jobs/${encodeURIComponent(dep.jobId)}">${escapeHtml(dep.jobId)}</a>`)
    .join(", ");
  const detail = job.dependsOn
    .map((dep) => dep.detail)
    .filter((line): line is string => Boolean(line) && line !== job.reason)
    .join("; ");
  return `<p class="deps">depends on ${links}</p>${detail ? `<p class="meta">${escapeHtml(detail)}</p>` : ""}`;
}

function actionsHtml(job: BoardJob, section: "inbox" | "hand" | "repos" | "history" | "job", csrf: string): string {
  const showGate = section === "inbox" || section === "job" || (section === "hand" && Boolean(job.reviewPostError));
  const showRetry = section === "hand" || section === "repos" || section === "job";
  if (!showGate && !showRetry) return "";
  const id = encodeURIComponent(job.jobId);
  const forms: string[] = [];
  if (showGate && job.canApprove) forms.push(postForm(`/api/jobs/${id}/approve`, "approve", "Approve", csrf));
  if (showGate && job.canReject) forms.push(postForm(`/api/jobs/${id}/reject`, "reject", "Reject", csrf));
  if (showGate && job.canRevise) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/revise" class="act revise"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input name="note" type="text" required maxlength="8000" placeholder="Note for the next round" autocomplete="off"><button type="submit">Revise</button></form>`,
    );
  }
  if (showRetry && job.retry) forms.push(postForm(`/api/jobs/${id}/retry`, "retry", "Retry", csrf));
  const queueable = (section === "repos" || section === "job") && job.queuePosition !== undefined;
  if (queueable && job.held) forms.push(postForm(`/api/jobs/${id}/release`, "release", "Release", csrf));
  if (queueable && !job.held) {
    forms.push(postForm(`/api/jobs/${id}/next`, "next", "Run next", csrf));
    forms.push(postForm(`/api/jobs/${id}/hold`, "hold", "Hold", csrf));
  }
  if (section === "job" && job.canStop) {
    forms.push(confirmForm(`/api/jobs/${id}/cancel`, "stop", "Stop job", "Confirm stop", csrf));
  }
  if (section === "job" && job.canRemove) {
    forms.push(confirmForm(`/api/jobs/${id}/remove`, "remove", "Remove job", "Confirm remove", csrf));
  }
  if (forms.length === 0) return "";
  return `<div class="d-actions">${forms.join("")}</div>`;
}

/** Opening the summary reveals the real submit button, so confirming needs no script. */
function confirmForm(action: string, kind: string, label: string, confirm: string, csrf: string): string {
  return `<details class="act confirm ${kind}"><summary>${label}</summary>${postForm(action, kind, confirm, csrf)}</details>`;
}

function postForm(action: string, kind: string, label: string, csrf: string): string {
  return `<form method="post" action="${action}" class="act ${kind}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">${label}</button></form>`;
}

function detailHtml(
  detail: JobDetail,
  tab: "overview" | "live" | "changes" | "timeline",
  _csrf: string,
  clock: BoardClock,
  activity?: ActivityFeed,
): string {
  const job = detail.job;
  const id = encodeURIComponent(job.jobId);
  const liveDefault = job.column === "running";
  const tabs = (["overview", "live", "changes", "timeline"] as const)
    .map((name) => {
      const href = name === "overview" && !liveDefault ? `/jobs/${id}` : `/jobs/${id}?tab=${name}`;
      const current = name === tab ? ` aria-current="page"` : "";
      const label = name[0]?.toUpperCase() + name.slice(1);
      return `<a href="${href}"${current}>${label}</a>`;
    })
    .join("");
  const panel =
    tab === "changes" ? changesHtml(detail) : tab === "timeline" ? timelineHtml(detail) : tab === "live" ? liveHtml(job, activity) : overviewHtml(detail);
  const back = job.inbox ? "/inbox" : "/";
  const backLabel = job.inbox ? "Inbox" : "Pipeline";
  return `<div class="detail-main"${activityAttrs(job)}>
<a class="back" href="${back}">${backLabel}</a>
<header class="list-head">
<div class="job-top"><h2>${escapeHtml(job.title)}</h2><span class="chip ${stateTone(job.state)}">${escapeHtml(job.state)}</span></div>
<div class="job-meta"><a href="/repos/${encodeURIComponent(job.repo)}">${escapeHtml(job.repo)}</a><span class="chip">${escapeHtml(job.workflow)}</span>${job.branch ? `<span class="mono">${escapeHtml(job.branch)}</span>` : ""}${prLinkHtml(job.repo, job.prNumber, job.prUrl, job.headSha)}</div>
${progressHtml(job, clock, true)}
${fileLinks(job)}
${job.ask ? `<p class="ask">${escapeHtml(job.ask)}</p>` : ""}
${job.workflow === "review" && job.canApprove ? `<p class="meta">Approving posts this draft as a pull request comment. Kiln does not approve the pull request or merge it.</p>` : ""}
${showReason(job) ? `<p class="reason">${escapeHtml(job.reason)}</p>` : ""}
${launchFixHtml(job)}
<p class="unseen" data-unseen-for="${escapeHtml(job.jobId)}" hidden></p>
</header>
<nav class="tabs" aria-label="Job">${tabs}</nav>
${actionsHtml(job, "job", _csrf)}
${panel}
</div>
${railHtml(detail)}`;
}

function liveHtml(job: BoardJob, activity: ActivityFeed | undefined): string {
  const feed = activity ?? { running: job.column === "running", cursor: "", events: [], raw: "" };
  const note = feed.running ? (feed.phase ? `Watching ${phaseLabel(feed.phase)}` : "Watching this run") : "Last session";
  const phase = feed.phase ? ` data-phase="${escapeHtml(feed.phase)}"` : "";
  return `<section class="live" id="live" data-running="${feed.running ? "true" : "false"}" data-cursor="${escapeHtml(feed.cursor)}"${phase}>
<div class="live-bar"><p class="meta live-note" id="live-note">${escapeHtml(note)}</p><button type="button" class="btn" id="live-raw-toggle" aria-pressed="false" aria-controls="live-raw">Raw log</button></div>
<p class="field-error" id="live-error" role="alert" hidden></p>
<div class="live-feed" id="live-feed">${feedHtml(feed.events)}</div>
<pre class="text live-raw" id="live-raw" hidden>${escapeHtml(feed.raw)}</pre>
</section>`;
}

function feedHtml(events: readonly ActivityEvent[]): string {
  if (events.length === 0) return `<p class="empty">No session output yet.</p>`;
  const blocks: string[] = [];
  let phase = "";
  let started = "";
  let items: string[] = [];
  const flush = (): void => {
    if (!phase) return;
    blocks.push(
      `<section class="live-phase" data-phase="${escapeHtml(phase)}"><h3>${escapeHtml(phaseLabel(phase))} ${timeHtml(started, "date")}</h3><ol class="live-events">${items.join("")}</ol></section>`,
    );
  };
  for (const event of events) {
    if (event.phase !== phase) {
      flush();
      phase = event.phase;
      started = event.at;
      items = [];
    }
    items.push(eventHtml(event));
  }
  flush();
  return blocks.join("");
}

function eventHtml(event: ActivityEvent): string {
  const summary = escapeHtml(event.summary);
  const body = event.detail
    ? `<button type="button" class="live-summary" aria-expanded="false" data-summary="${summary}" data-detail="${escapeHtml(event.detail)}">${summary}</button>`
    : `<span class="live-summary">${summary}</span>`;
  return `<li class="live-event ${escapeHtml(event.kind)}" data-kind="${escapeHtml(event.kind)}" data-summary="${summary}">${timeHtml(event.at, "clock")}${body}</li>`;
}

function overviewHtml(detail: JobDetail): string {
  const phases = detail.job.phases;
  if (phases.length === 0) return `<p class="empty">No phases in the event log yet.</p>`;
  const cost = formatCost(detail.job.costUsd);
  const summary = cost ? `<p class="meta">Cost ${escapeHtml(cost)}</p>` : "";
  return `${summary}${deliverableHtml(detail.job, true)}<ol class="phases">${phases.map((phase) => phaseHtml(phase)).join("")}</ol>`;
}

function phaseHtml(phase: PhaseView): string {
  const bits: string[] = [];
  if (phase.verdict) bits.push(`<p class="verdict">${escapeHtml(phase.verdict)}</p>`);
  if (phase.detail) bits.push(phaseDetailHtml(phase.detail));
  if (phase.testCommand || phase.exitCode !== undefined) {
    const exit = phase.exitCode === undefined ? "" : ` · exit ${phase.exitCode}`;
    bits.push(`<p class="meta">${escapeHtml(`${phase.testCommand ?? "test"}${exit}`)}</p>`);
  }
  if (phase.failureClass || phase.fingerprint) {
    bits.push(`<p class="meta">${escapeHtml([phase.failureClass, phase.fingerprint].filter(Boolean).join(" · "))}</p>`);
  }
  if (phase.note) bits.push(`<blockquote class="note">${escapeHtml(phase.note)}</blockquote>`);
  const iteration = phase.iteration !== undefined ? ` <span class="meta">#${phase.iteration}</span>` : "";
  const duration = phase.durationMs !== undefined ? `<span class="meta">${escapeHtml(formatDuration(phase.durationMs))}</span>` : "";
  const when = phase.finishedAt ?? phase.startedAt;
  const clock = when ? timeHtml(when, "local") + timeHtml(when, "rel") : "";
  return `<li class="phase ${escapeHtml(phase.status)}"><header><span class="mark" aria-hidden="true">${phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : phase.status === "running" ? "●" : "○"}</span><span class="step">${escapeHtml(phase.label)}</span>${iteration}<span class="outcome">${escapeHtml(phase.status)}</span>${duration}${clock}</header>${bits.join("")}</li>`;
}

function phaseDetailHtml(detail: string): string {
  if (looksLikeLog(detail)) return logDisclosure(detail);
  if (detail.includes("\n") || detail.length > 280) return `<div class="prose">${renderMarkdown(detail)}</div>`;
  return `<p>${escapeHtml(detail)}</p>`;
}

function changesHtml(detail: JobDetail): string {
  const changes = detail.changes;
  const branch = changes.branch ? `<p><span class="k">Branch</span> <span class="mono">${escapeHtml(changes.branch)}</span></p>` : `<p class="empty">No branch yet.</p>`;
  const base = changes.base ? `<p><span class="k">Base</span> <span class="mono">${escapeHtml(changes.base)}</span></p>` : "";
  const pr = prHtml(changes.prUrl, changes.prNumber);
  const diff = changes.diffStat ? `<pre class="text">${escapeHtml(changes.diffStat)}</pre>` : "";
  const commits =
    changes.commits.length === 0
      ? `<p class="empty">No commits read for this branch.</p>`
      : `<ul class="commits">${changes.commits
          .map((commit) => {
            const round = commit.round !== undefined ? `<span class="meta">Kiln-Round ${commit.round}</span>` : "";
            return `<li><code>${escapeHtml(commit.sha.slice(0, 12))}</code> ${escapeHtml(commit.subject)} ${round}</li>`;
          })
          .join("")}</ul>`;
  return `<section class="changes">${branch}${base}${pr}${diff}<h3>Commits</h3>${commits}</section>`;
}

function timelineHtml(detail: JobDetail): string {
  const runs = detail.job.timeline;
  if (runs.length === 0) return `<p class="empty">No events.</p>`;
  return runs
    .map((run) => {
      const label = run.runId ? `Run ${run.runId}` : "Job";
      const rows = run.entries
        .map(
          (entry) =>
            `<li>${timeHtml(entry.ts, "local")}${timeHtml(entry.ts, "rel")}<span>${escapeHtml(entry.summary)}</span></li>`,
        )
        .join("");
      return `<section class="run-group"><h3>${escapeHtml(label)}</h3><ol class="timeline">${rows}</ol></section>`;
    })
    .join("");
}

function railHtml(detail: JobDetail): string {
  const rail = detail.rail;
  const rows: string[] = [];
  const row = (label: string, value: string) => {
    rows.push(`<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`);
  };
  row("Repo", escapeHtml(rail.repo));
  if (rail.issue) row("Issue", `<span class="mono">${escapeHtml(rail.issue)}</span>`);
  if (rail.branch) row("Branch", `<span class="mono">${escapeHtml(rail.branch)}</span>`);
  if (rail.prUrl || rail.prNumber) row("Pull request", prHtml(rail.prUrl, rail.prNumber) || escapeHtml(rail.prUrl ?? ""));
  if (rail.ci) row("CI", escapeHtml(rail.ci));
  if (rail.risk) row("Risk", escapeHtml(rail.risk));
  row("Cost", rail.costUsd === null ? "no cost recorded" : escapeHtml(formatDollars(rail.costUsd)));
  row("Attempts", escapeHtml(`${rail.attempts.used} / ${rail.attempts.cap}`));
  row("Fix rounds", escapeHtml(`${rail.fixRounds.used} / ${rail.fixRounds.cap}`));
  if (rail.failureClass || rail.fingerprint) {
    row("Failure", escapeHtml([rail.failureClass, rail.fingerprint].filter(Boolean).join(" · ")));
  }
  return `<aside class="rail" aria-label="Job facts"><h3>${escapeHtml(detail.job.jobId)}</h3><dl>${rows.join("")}</dl></aside>`;
}

function prHtml(url: string | undefined, number: number | undefined): string {
  const safe = url ? safeUrl(url) : undefined;
  const text = number ? `PR #${number}` : (safe ?? url ?? "");
  if (!text) return "";
  if (safe) return `<a href="${escapeHtml(safe)}">${escapeHtml(text)}</a>`;
  return escapeHtml(url ?? text);
}

function statsHtml(stats: StatsDocument): string {
  const windows = (["today", "7d", "30d"] as const)
    .map((window) => {
      const current = stats.window === window ? ` aria-current="page"` : "";
      const label = window === "today" ? "Today" : window;
      return `<a href="/stats?window=${window}"${current}>${label}</a>`;
    })
    .join("");
  const cap = stats.spend.cap === null ? "no cap" : formatDollars(stats.spend.cap);
  const repoRows = tableRows(
    stats.costByRepo.map((row) => [row.repo, formatDollars(row.usd)]),
    "No recorded cost in this window.",
  );
  const phaseRows = tableRows(
    stats.costByPhase.map((row) => [row.phase, formatDollars(row.usd)]),
    "No recorded cost in this window.",
  );
  const classRows = tableRows(
    stats.failuresByClass.map((row) => [row.class, String(row.count)]),
    "No failures in this window.",
  );
  const interventions =
    stats.interventions.total === 0
      ? `<p class="empty">0 interventions</p>`
      : `<ul class="ledger">${stats.interventions.rows
          .map((row) => {
            const reasons = row.reasons.map((reason) => `<li>${escapeHtml(reason.reason)} ${reason.count}</li>`).join("");
            return `<li><span class="mono">${escapeHtml(row.repo)} / ${escapeHtml(row.jobId)}</span> ${row.total}<ul>${reasons}</ul></li>`;
          })
          .join("")}</ul><p class="meta">${stats.interventions.total} ${stats.interventions.total === 1 ? "intervention" : "interventions"}</p>`;
  return `<header class="list-head"><h2>Stats</h2><nav class="tabs" aria-label="Window">${windows}</nav><p class="meta">Since ${timeHtml(stats.since, "local")}</p></header>
<div class="stat-grid">
<section class="stat"><h3>Spend</h3><p class="stat-num">${escapeHtml(formatDollars(stats.spend.usd))}</p><p class="meta">Today ${escapeHtml(stats.spend.day)} / ${escapeHtml(cap)}</p><p class="meta">This window ${escapeHtml(formatDollars(stats.windowUsd))}</p></section>
<section class="stat"><h3>Runs</h3><p class="stat-num">${stats.runs.finished}</p><p class="meta">${stats.runs.started} started · ${stats.runs.finished} finished · ${stats.runs.failed} failed</p>${classRows}</section>
<section class="stat"><h3>Interventions</h3>${interventions}</section>
</div>
<section class="stat"><h3>Cost by repo</h3>${repoRows}</section>
<section class="stat"><h3>Cost by phase</h3>${phaseRows}</section>`;
}

function reportHtml(report: DayReport): string {
  const cap = report.spend.cap === null ? "no cap" : formatDollars(report.spend.cap);
  const runs =
    report.runs.length === 0
      ? `<p class="empty">Nothing ran today.</p>`
      : `<ul class="runs">${report.runs
          .map((run) => {
            const cost = run.usd === null ? "" : ` · ${escapeHtml(formatDollars(run.usd))}`;
            const klass = run.failureClass ? ` · ${escapeHtml(run.failureClass)}` : "";
            return `<li><a href="/jobs/${encodeURIComponent(run.jobId)}">${escapeHtml(run.title)}</a> <span class="chip ${escapeHtml(run.outcome)}">${escapeHtml(run.outcome)}</span> <span class="meta">${escapeHtml(run.repo)}${klass}${cost}</span> ${timeHtml(run.at, "rel")}</li>`;
          })
          .join("")}</ul>`;
  const interventions =
    report.interventions.total === 0
      ? `<p class="empty">0 interventions</p>`
      : `<ul class="ledger">${report.interventions.rows
          .map((row) => `<li><span class="mono">${escapeHtml(row.repo)} / ${escapeHtml(row.jobId)}</span> ${row.total}</li>`)
          .join("")}</ul>`;
  return `<header class="list-head"><h2>Today</h2><p class="meta">${escapeHtml(report.day)}</p></header>
<div class="stat-grid">
<section class="stat"><h3>Spend</h3><p class="stat-num">${escapeHtml(formatDollars(report.spend.usd))}</p><p class="meta">of ${escapeHtml(cap)}</p></section>
<section class="stat"><h3>Runs</h3><p class="stat-num">${report.runs.length}</p></section>
<section class="stat"><h3>Interventions</h3>${interventions}</section>
</div>
<section class="stat"><h3>What ran</h3>${runs}</section>`;
}

/** Chips wrap up to this many choices. Past it, use a select or combobox. */
const PICK_CHIP_MAX = 5;

function tableRows(rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<table><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row[0] ?? "")}</td><td class="num">${escapeHtml(row[1] ?? "")}</td></tr>`).join("")}</tbody></table>`;
}

function formatDollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function intakeSheet(intake: ServePageOptions, attention: AttentionView): string {
  const items = [...attention.needsYou, ...attention.inFlight, ...attention.doneRecently];
  return `<section class="sheet intake" id="intake" aria-label="Add job" hidden>
<div class="d-head">
<div class="num">kiln add</div>
<h3>Add job</h3>
<button type="button" class="close" data-close aria-label="Close">×</button>
</div>
<form id="add-form" class="intake-form">
<div class="intake-body">
<div class="field" id="repo-field"><span class="k" id="repo-label">Repo</span>${repoPicker(intake.repos)}
<p class="field-error" id="repo-error" role="alert" hidden></p></div>
<div class="field" id="workflow-field"><span class="k" id="workflow-label">Workflow</span>${workflowPicker(intake.workflows, new Set(intake.workflowsNeedingTest ?? []))}
<p class="field-error" id="workflow-error" role="alert" hidden></p>
<p class="form-warn" id="intake-warn" role="status" hidden></p></div>
<div class="field"><span class="k" id="source-label">Source</span>
<div class="seg" role="group" aria-labelledby="source-label">
<button type="button" data-source="prompt" aria-pressed="true">Prompt</button>
<button type="button" data-source="spec" aria-pressed="false">Spec file</button>
<button type="button" data-source="tickets" aria-pressed="false">Tickets folder</button>
<button type="button" data-source="jira" aria-pressed="false">Jira</button>
</div></div>
<div data-pane="prompt"><label class="field"><span class="k">Prompt</span><textarea id="prompt-text" rows="4" placeholder="What should this job do?" aria-describedby="prompt-error"></textarea>
<p class="field-error" id="prompt-error" role="alert" hidden></p></label></div>
<div class="field" id="browser-field" hidden>
<div class="k" id="browser-label">Spec file</div>
<div class="fs" id="browser"></div>
<p class="meta" id="picked"></p>
<p class="field-error" id="source-error" role="alert" hidden></p>
</div>
<div data-pane="jira" hidden><label class="field"><span class="k">Jira issue</span><input id="jira-key" type="text" placeholder="PROJ-123 or issue URL" autocomplete="off" spellcheck="false" aria-describedby="jira-error">
<p class="field-error" id="jira-error" role="alert" hidden></p></label></div>
<label class="field" id="issue-field"><span class="k">Issue</span><input id="job-issue" type="text" placeholder="ABC-123" autocomplete="off" spellcheck="false"></label>
<label class="field" id="title-field"><span class="k">Title</span><input id="job-title" type="text" autocomplete="off"></label>
<fieldset class="field" id="after-field"><legend class="k">After</legend><div id="after-list">${afterOptions(items.map((item) => item.job))}</div></fieldset>
<pre class="text preview" id="intake-preview" hidden></pre>
<p class="form-error" id="intake-error" role="alert" hidden></p>
</div>
<div class="form-footer">
<button type="button" class="btn" id="preview-job" hidden>Preview</button>
<button type="button" class="btn" data-close>Cancel</button>
<button type="submit" class="btn primary" id="add-submit" disabled>Add</button>
</div>
</form>
</section>`;
}

function themePicker(selected: BoardThemeId): string {
  const buttons = BOARD_THEME_CHOICES.map((theme) => {
    const on = theme.id === selected;
    return `<button type="button" class="theme" data-theme-choice="${theme.id}" aria-pressed="${on ? "true" : "false"}"><span class="theme-swatch" data-theme="${theme.id}" aria-hidden="true"><span class="swatch bg"></span><span class="swatch panel"></span><span class="swatch card"></span><span class="swatch accent"></span></span><span class="theme-label">${escapeHtml(theme.label)}</span></button>`;
  }).join("");
  return `<div class="themes" id="theme-pick" role="group" aria-label="Theme">${buttons}</div>`;
}

function settingsTabs(): string {
  const sections = [
    ["repos", "Repos"],
    ["global", "Global"],
    ["triggers", "Triggers"],
    ["routes", "Routes"],
    ["jira", "Jira"],
    ["overlay", "Overlay"],
    ["appearance", "Appearance"],
    ["advanced", "Advanced"],
  ];
  const buttons = sections
    .map(
      ([id, label], index) =>
        `<button type="button" data-settings-tab="${id}" aria-pressed="${index === 0 ? "true" : "false"}">${label}</button>`,
    )
    .join("");
  return `<div class="seg" role="tablist" aria-label="Settings sections">${buttons}</div>`;
}

function settingsForm(theme: BoardThemeId): string {
  return `<form id="settings-form" class="intake-form">
<p class="meta" id="settings-path"></p>
<p class="saved" id="settings-saved" role="status" hidden>Saved</p>
<p class="form-error" id="settings-error" role="alert" hidden></p>
${settingsTabs()}
<div id="settings-repos">
<div id="repo-editor" hidden>
<label class="field"><span class="k">Name</span><input id="repo-name" type="text" autocomplete="off" spellcheck="false"></label>
<p class="field-error" data-error="name" hidden></p>
<div class="field"><span class="k">Path</span><div class="path-row"><input id="repo-path" type="text" autocomplete="off" spellcheck="false" placeholder="~/code/web"><button type="button" class="pick" id="repo-browse">Browse</button></div></div>
<div class="fs" id="repo-browser" hidden></div>
<p class="field-error" data-error="path" hidden></p>
<label class="field"><span class="k">Test command</span><input id="repo-test" type="text" autocomplete="off" spellcheck="false" placeholder="npm test"></label>
<p class="field-error" data-error="test" hidden></p>
<div class="field"><span class="k">Deliver</span><div class="seg" id="repo-deliver" role="group" aria-label="Deliver mode">
<button type="button" data-deliver="local" aria-pressed="true">local</button>
<button type="button" data-deliver="pr" aria-pressed="false">pr</button>
</div></div>
<p class="field-error" data-error="deliver" hidden></p>
<label class="field"><span class="k">Base branch</span><input id="repo-base" type="text" autocomplete="off" spellcheck="false" placeholder="main"></label>
<p class="field-error" data-error="base" hidden></p>
<label class="field"><span class="k">PR title template</span><input id="repo-pr-title" type="text" autocomplete="off" spellcheck="false"></label>
<p class="hint" id="hint-pr-title">Default [{issue}] {title}, which renders as [ABC-123] Title.</p>
<p class="field-error" data-error="prTitle" hidden></p>
<label class="field"><span class="k">Branch template</span><input id="repo-branch" type="text" autocomplete="off" spellcheck="false"></label>
<p class="hint" id="hint-branch">Default {issue}-{slug}, which renders as ABC-123-slug.</p>
<p class="field-error" data-error="branch" hidden></p>
<label class="field"><span class="k">Max attempts</span><input id="repo-max-attempts" type="number" min="1" step="1" placeholder="inherit"></label>
<p class="hint">Overrides the global attempt cap for this repo. Empty inherits.</p>
<p class="field-error" data-error="repoAttempts" hidden></p>
<label class="field"><span class="k">Max fix rounds</span><input id="repo-max-fix-rounds" type="number" min="1" step="1" placeholder="inherit"></label>
<p class="hint">Overrides the global fix-round cap for this repo. Empty inherits.</p>
<p class="field-error" data-error="repoRounds" hidden></p>
<div class="d-actions"><button type="button" id="repo-done">Done</button></div>
</div>
<div id="repo-list"></div>
<div class="d-actions"><button type="button" id="repo-add">Add repo</button></div>
</div>
<div id="settings-global" hidden>
<div class="field"><span class="k">Sandbox</span><div class="seg" id="sandbox-mode" role="group" aria-label="Sandbox mode">
<button type="button" data-sandbox="off" aria-pressed="true">Off</button>
<button type="button" data-sandbox="docker" aria-pressed="false">Docker</button>
</div>
<p class="hint">Off leaves the agent unsandboxed. Docker runs agent steps in the sandbox.</p>
<p class="field-error" data-error="sandbox.mode" hidden></p></div>
<label class="field"><span class="k">Allow domains</span><textarea id="sandbox-domains" rows="3" placeholder="example.com" spellcheck="false"></textarea></label>
<p class="hint">One hostname per line. When set, this replaces the built-in host list.</p>
<p class="field-error" data-error="sandbox.allowDomains" hidden></p>
<label class="field"><span class="k">Max attempts</span><input id="max-attempts" type="number" min="1" step="1"></label>
<p class="hint" id="hint-attempts"></p>
<p class="field-error" data-error="maxAttempts" hidden></p>
<label class="field"><span class="k">Stall timeout (ms)</span><input id="stall-timeout" type="number" step="1"></label>
<p class="hint" id="hint-stall"></p>
<p class="field-error" data-error="stallTimeoutMs" hidden></p>
<label class="field"><span class="k">Max fix rounds</span><input id="max-fix-rounds" type="number" min="1" step="1"></label>
<p class="hint" id="hint-fix"></p>
<p class="field-error" data-error="maxFixRounds" hidden></p>
<label class="field"><span class="k">Same fingerprint limit</span><input id="max-same-fingerprint" type="number" min="1" step="1"></label>
<p class="hint" id="hint-fingerprint"></p>
<p class="field-error" data-error="maxSameFingerprint" hidden></p>
<label class="field"><span class="k">Daily dollar cap</span><input id="daily-dollar-cap" type="number" min="0" step="0.01"></label>
<p class="hint" id="hint-cap"></p>
<p class="field-error" data-error="dailyDollarCap" hidden></p>
<label class="field"><span class="k">Max concurrent</span><input id="max-concurrent" type="number" min="1" step="1"></label>
<p class="hint" id="hint-concurrent"></p>
<p class="field-error" data-error="maxConcurrent" hidden></p>
<div class="field"><span class="k">Adapter</span><div class="seg" id="adapter-mode" role="group" aria-label="Adapter">
<button type="button" data-adapter="claude-code" aria-pressed="true">claude-code</button>
<button type="button" data-adapter="mock" aria-pressed="false">mock</button>
</div>
<p class="hint" id="hint-adapter"></p>
<p class="field-error" data-error="adapter" hidden></p></div>
</div>
<div id="settings-triggers" hidden>
<div id="trigger-editor" hidden>
<label class="field"><span class="k">Id</span><input id="trigger-id" type="text" autocomplete="off" spellcheck="false"></label>
<p class="field-error" data-error="trigger.id" hidden></p>
<div class="field"><span class="k">Enabled</span><div class="seg" id="trigger-enabled" role="group" aria-label="Enabled">
<button type="button" data-enabled="true" aria-pressed="true">On</button>
<button type="button" data-enabled="false" aria-pressed="false">Off</button>
</div></div>
<div class="field"><span class="k">Kind</span><div class="seg" id="trigger-kind" role="group" aria-label="Trigger kind">
<button type="button" data-kind="schedule" aria-pressed="true">schedule</button>
<button type="button" data-kind="jira" aria-pressed="false">jira</button>
<button type="button" data-kind="pr" aria-pressed="false">pr</button>
</div></div>
<div data-for-kind="schedule">
<label class="field"><span class="k">Cron</span><input id="trigger-cron" type="text" autocomplete="off" spellcheck="false" placeholder="0 * * * *"></label>
<p class="hint">Five fields, local time. review-requests defaults to 0 * * * *.</p>
<label class="field"><span class="k">Label</span><input id="trigger-label" type="text" autocomplete="off" spellcheck="false" placeholder="kiln-review"></label>
<label class="field"><span class="k">Max new</span><input id="trigger-max-new" type="number" min="1" step="1" placeholder="3"></label>
<p class="hint">New review jobs one fire may create.</p>
<label class="field"><span class="k">Max queued</span><input id="trigger-max-queued" type="number" min="1" step="1" placeholder="5"></label>
<p class="hint">Queued or running review jobs at once.</p>
</div>
<div data-for-kind="jira" hidden>
<label class="field"><span class="k">Every</span><input id="trigger-every" type="text" autocomplete="off" spellcheck="false" placeholder="5m"></label>
<p class="hint">30s, 5m, or 1h. Default 5m.</p>
<label class="field"><span class="k">JQL</span><input id="trigger-jql" type="text" autocomplete="off" spellcheck="false"></label>
<p class="hint">When set, this replaces label and status.</p>
<label class="field"><span class="k">Label</span><input id="trigger-jira-label" type="text" autocomplete="off" spellcheck="false"></label>
<label class="field"><span class="k">Status</span><input id="trigger-status" type="text" autocomplete="off" spellcheck="false"></label>
<div class="field"><span class="k">Repo</span><div id="trigger-repo"></div></div>
</div>
<div data-for-kind="pr" hidden>
<p class="hint">Pull request activity on Kiln-owned pull requests. No extra fields.</p>
</div>
<p class="field-error" data-error="trigger.form" hidden></p>
<div class="d-actions"><button type="button" data-row-done="triggers">Done</button></div>
</div>
<div id="trigger-list"></div>
<div class="d-actions"><button type="button" data-row-add="triggers">Add trigger</button></div>
</div>
<div id="settings-routes" hidden>
<div id="route-editor" hidden>
<label class="field"><span class="k">Id</span><input id="route-id" type="text" autocomplete="off" spellcheck="false"></label>
<p class="field-error" data-error="route.id" hidden></p>
<div class="field"><span class="k">Trigger</span><div id="route-trigger"></div></div>
<div class="field"><span class="k">Action</span><div class="seg" id="route-action" role="group" aria-label="Route action">
<button type="button" data-action="create" aria-pressed="true">create</button>
<button type="button" data-action="attach" aria-pressed="false">attach</button>
</div></div>
<div class="field"><span class="k">Workflow</span><div id="route-workflow"></div></div>
<p class="hint">Used when the action is create.</p>
<div class="field"><span class="k">Repo</span><div id="route-repo"></div></div>
<p class="field-error" data-error="route.form" hidden></p>
<div class="d-actions"><button type="button" data-row-done="routes">Done</button></div>
</div>
<div id="route-list"></div>
<div class="d-actions"><button type="button" data-row-add="routes">Add route</button></div>
</div>
<div id="settings-jira" class="stack" hidden>
<div class="field"><label class="k" for="jira-base">Base URL</label><input id="jira-base" type="text" autocomplete="off" spellcheck="false" placeholder="https://example.atlassian.net">
<p class="field-error" data-error="jira.baseUrl" hidden></p></div>
<div class="field"><label class="k" for="jira-email">Email</label><input id="jira-email" type="text" autocomplete="off" spellcheck="false" placeholder="dev@example.com">
<p class="field-error" data-error="jira.email" hidden></p></div>
<div class="field"><label class="k" for="jira-acceptance">Acceptance field</label><input id="jira-acceptance" type="text" autocomplete="off" spellcheck="false" placeholder="customfield_10001">
<p class="hint">Optional. When set, Kiln reads acceptance criteria from this field. Empty uses the Jira field named Acceptance criteria.</p>
<p class="field-error" data-error="jira.acceptanceField" hidden></p></div>
<div class="field"><span class="k">API token</span><p class="meta" id="jira-token">not set</p>
<p class="hint">Set JIRA_API_TOKEN in the environment. This page does not store a token.</p>
<p class="field-error" data-error="jira.apiToken" hidden></p></div>
</div>
<div id="settings-overlay" hidden>
<label class="field"><span class="k">Workflows</span><input id="overlay-workflows" type="text" autocomplete="off" spellcheck="false" placeholder="workflows"></label>
<p class="hint">Directory of local workflow files. Empty uses the kiln home workflows directory.</p>
<p class="field-error" data-error="overlay.workflows" hidden></p>
<label class="field"><span class="k">Prompts</span><input id="overlay-prompts" type="text" autocomplete="off" spellcheck="false" placeholder="prompts"></label>
<p class="hint">Directory of prompt overrides. Empty uses the kiln home prompts directory.</p>
<p class="field-error" data-error="overlay.prompts" hidden></p>
<label class="field"><span class="k">Skills</span><input id="overlay-skills" type="text" autocomplete="off" spellcheck="false" placeholder="skills"></label>
<p class="hint">Directory of skills. Empty uses the kiln home skills directory.</p>
<p class="field-error" data-error="overlay.skills" hidden></p>
<label class="field"><span class="k">Skill paths</span><textarea id="overlay-skill-paths" rows="3" spellcheck="false" placeholder="/home/dev/skills"></textarea></label>
<p class="hint">One extra skill directory per line.</p>
<p class="field-error" data-error="overlay.skillPaths" hidden></p>
</div>
<div id="settings-appearance" hidden>
<p class="hint">Color palette for this board. The choice applies immediately and is saved here.</p>
${themePicker(theme)}
<p class="field-error" data-error="board.theme" hidden></p>
</div>
<div id="settings-advanced" hidden>
<label class="field"><span class="k">kiln.config.json</span><textarea id="settings-json" rows="18" spellcheck="false" aria-describedby="advanced-hint advanced-errors"></textarea></label>
<p class="hint" id="advanced-hint">Saving this section writes the JSON below. A secret is shown as ${escapeHtml(SECRET_PLACEHOLDER)}. Saving that placeholder keeps the current value. Set JIRA_API_TOKEN in the environment. Invalid JSON is not written.</p>
<p class="field-error" id="advanced-errors" data-error="file" hidden></p>
</div>
<div class="form-footer"><button type="submit" class="btn primary">Save</button></div>
</form>`;
}

function repoListKey(repos: readonly ServeRepoOption[]): string {
  return repos.map((repo) => `${repo.name}\t${repo.path}\t${testFlag(repo)}`).join("\n");
}

/** Matches the flag `serve.js` rebuilds the picker from. Blank when unknown. */
function testFlag(repo: ServeRepoOption): string {
  if (repo.hasTest === undefined) return "";
  return repo.hasTest ? "1" : "0";
}

function hasTestAttr(repo: ServeRepoOption): string {
  if (repo.hasTest === undefined) return "";
  return ` data-has-test="${repo.hasTest ? "true" : "false"}"`;
}

function repoPicker(repos: ServeRepoOption[]): string {
  const list = escapeHtml(repoListKey(repos));
  if (repos.length === 0) {
    return `<div class="picks" id="repo-pick" data-mode="empty" data-value="" data-path="" data-list="${list}" role="group" aria-labelledby="repo-label"><p class="empty">No repos are registered.</p></div>`;
  }
  const selected = repos[0];
  if (!selected) {
    return `<div class="picks" id="repo-pick" data-mode="empty" data-value="" data-path="" data-list="" role="group" aria-labelledby="repo-label"><p class="empty">No repos are registered.</p></div>`;
  }
  if (repos.length > PICK_CHIP_MAX) {
    const options = repos
      .map((repo, index) => {
        const on = repo.name === selected.name;
        return `<li role="option" id="repo-opt-${index}" data-value="${escapeHtml(repo.name)}" data-path="${escapeHtml(repo.path)}"${hasTestAttr(repo)} aria-selected="${on ? "true" : "false"}">${escapeHtml(repo.name)}</li>`;
      })
      .join("");
    return `<div class="combo" id="repo-pick" data-mode="select" data-value="${escapeHtml(selected.name)}" data-path="${escapeHtml(selected.path)}"${hasTestAttr(selected)} data-list="${list}"><input id="repo-pick-query" class="combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="repo-pick-list" aria-labelledby="repo-label" placeholder="Search repos" value="${escapeHtml(selected.name)}" autocomplete="off" spellcheck="false"><ul class="combo-list" id="repo-pick-list" role="listbox" hidden>${options}<li class="empty" role="presentation" hidden>No matching repos.</li></ul></div>`;
  }
  const buttons = repos
    .map((repo, index) => {
      const on = index === 0;
      return `<button type="button" class="pick" data-repo="${escapeHtml(repo.name)}" data-path="${escapeHtml(repo.path)}"${hasTestAttr(repo)} aria-pressed="${on ? "true" : "false"}">${escapeHtml(repo.name)}</button>`;
    })
    .join("");
  return `<div class="picks" id="repo-pick" data-mode="chips" data-value="${escapeHtml(selected.name)}" data-path="${escapeHtml(selected.path)}"${hasTestAttr(selected)} data-list="${list}" role="group" aria-labelledby="repo-label">${buttons}</div>`;
}

function workflowPicker(names: string[], needsTest: ReadonlySet<string>): string {
  const selected = names.includes("feature") ? "feature" : (names[0] ?? "");
  if (names.length === 0 || names.length > PICK_CHIP_MAX) {
    const options =
      names.length === 0
        ? `<option value="">none</option>`
        : names
            .map((name) => `<option value="${escapeHtml(name)}" data-needs-test="${needsTest.has(name) ? "true" : "false"}"${name === selected ? " selected" : ""}>${escapeHtml(name)}</option>`)
            .join("");
    return `<select id="workflow" name="workflow" aria-labelledby="workflow-label">${options}</select>`;
  }
  const buttons = names
    .map(
      (name) =>
        `<button type="button" data-workflow="${escapeHtml(name)}" aria-pressed="${name === selected ? "true" : "false"}" data-needs-test="${needsTest.has(name) ? "true" : "false"}">${escapeHtml(name)}</button>`,
    )
    .join("");
  return `<div class="seg" id="workflow-pick" data-mode="chips" data-workflow="${escapeHtml(selected)}" role="group" aria-labelledby="workflow-label">${buttons}</div>`;
}

function afterLabel(job: StatusJobView): string {
  const title = job.title.trim();
  if (!title || title === job.jobId) return job.jobId;
  return `${job.jobId} — ${title}`;
}

function afterOptions(jobs: StatusJobView[]): string {
  const open = jobs.filter((job) => job.state !== "done");
  if (open.length === 0) return `<p class="empty">No open jobs.</p>`;
  return open
    .map(
      (job) =>
        `<label class="after"><input type="checkbox" name="after" value="${escapeHtml(job.jobId)}"><span>${escapeHtml(afterLabel(job))}</span></label>`,
    )
    .join("");
}

function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function document(options: {
  css: string;
  title: string;
  needsYou: number;
  revision: string;
  csrf?: string;
  section: string;
  theme?: BoardThemeId;
  jobId?: string;
  latest?: string;
  stallTimeoutMs?: number;
  live: boolean;
  body: string;
}): string {
  const job = options.jobId ? ` data-job="${escapeHtml(options.jobId)}"` : "";
  const latest = options.latest ? ` data-latest="${escapeHtml(options.latest)}"` : "";
  const theme = options.theme ?? DEFAULT_BOARD_THEME;
  const stall = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${faviconLink(options.css, theme)}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&family=Roboto+Mono:wght@400;500&display=swap">
<style>
${options.css}
</style>
</head>
<body data-section="${escapeHtml(options.section)}" data-needs-you="${options.needsYou}" data-revision="${escapeHtml(options.revision)}" data-csrf="${escapeHtml(options.csrf ?? "")}" data-pick-limit="${PICK_CHIP_MAX}" data-stall="${stall}" data-quiet="${QUIET_AFTER_MS}"${job}${latest}>
${options.body}
${options.live ? `<script>\n${LIVE_SCRIPT}\n</script>` : ""}
</body>
</html>
`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
