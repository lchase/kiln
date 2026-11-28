import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.js";
import type { AttentionView } from "./attention.js";
import {
  buildBoard,
  type BoardDocument,
  type BoardJob,
  type DayReport,
  type DiffFile,
  type JobDetail,
  type StatsDocument,
} from "./board-view.js";
import {
  COLUMN_LABEL,
  PIPELINE_COLUMNS,
  QUIET_AFTER_MS,
  activityLiveness,
  formatCost,
  formatStepUsage,
  formatDuration,
  formatClock,
  formatDay,
  formatLocal,
  formatRelative,
  isReviewStep,
  progressSegments,
  runningPhaseId,
  startedPhaseIds,
  stepAgent,
  shortSha,
  stateTone,
  stepFocus,
  type ActivityRead,
  type FindingView,
  type JobView,
  type PhaseView,
  type PipelineColumn,
  type ReviewDeliverable,
  type StepFocus,
  type StepMark,
} from "./job-view.js";
import type { ActivityEvent, ActivityFeed } from "./activity.js";
import { EMPTY_ARTIFACTS, type ArtifactEntry, type ArtifactSet } from "./artifacts.js";
import { phaseGroups, type PhaseNode } from "./phase-groups.js";
import { icon, type IconName } from "./icons.js";
import { DEFAULT_SANDBOX_DOMAINS } from "./sandbox.js";
import { renderMarkdown } from "./markdown.js";
import type { StepRead } from "./step-result.js";
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

export type AppSection = "pipeline" | "repos" | "history" | "stats" | "report" | "settings" | "job" | "triggers";

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
  section?: "pipeline" | "repos" | "history" | "settings";
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

/** The step page: one step of a job, `/jobs/<id>/steps/<step>`. */
/** Settings sections, in nav order. `/settings/<id>` opens one. Server and script share this list. */
export const SETTINGS_SECTIONS = [
  { id: "repos", title: "Repos" },
  { id: "limits", title: "Limits and retries" },
  { id: "sandbox", title: "Sandbox" },
  { id: "triggers", title: "Triggers" },
  { id: "jira", title: "Jira" },
  { id: "workflows", title: "Local workflows and skills" },
  { id: "appearance", title: "Appearance" },
  { id: "file", title: "Edit the file" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** Short facts beside the nav links. Only counts and a word, never a secret. */
export interface SettingsFacts {
  repos?: number;
  triggers?: number;
  jira?: "connected" | "not set up";
}

/** Jira is connected when a base URL, an email, and a token (file or env) are all present. */
export function jiraFact(jira: { baseUrl?: string; email?: string; apiToken?: string } | undefined, envToken?: string): "connected" | "not set up" {
  const present = (value: string | undefined) => Boolean(value && value.trim());
  return present(jira?.baseUrl) && present(jira?.email) && (present(jira?.apiToken) || present(envToken)) ? "connected" : "not set up";
}

export interface StepPage {
  id: string;
  view: "activity" | "result";
  result: StepRead;
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
  /** What the run's steps wrote, for the job page's Artifacts column. */
  artifacts?: ArtifactSet;
  /** The run's step ids grouped by what runs at the same time, for the phase chain. Missing means the old grouping. */
  phasePlan?: string[][];
  /** The Pipeline page's view: columns (the default) or the attention-first list. */
  boardView?: BoardView;
  /** For the list view: each active job's grouped step ids, by job id. A job with none uses the old grouping. */
  phasePlans?: Record<string, string[][]>;
  /** Set on the step page. `section` is still "job". */
  step?: StepPage;
  triggers?: TriggerRow[];
  /** Open Settings section. Missing is `repos`. */
  settingsSection?: SettingsSectionId;
  settingsFacts?: SettingsFacts;
}

export type BoardView = "list" | "columns";

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
  const section = page?.section ?? "pipeline";
  return renderApp({ css, section, board, attention, ...(page ? { page, ...(page.repo ? { repo: page.repo } : {}) } : {}) });
}

/** The keyboard shortcuts `serve.js` handles. Keep the two lists in step. */
const SHORTCUTS_PANEL = `<aside class="shortcuts" id="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" hidden>
<header><h2>Keyboard shortcuts</h2><button type="button" class="btn" id="close-shortcuts">Close</button></header>
<dl>
<div><dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next or previous job</dd></div>
<div><dt><kbd>Enter</kbd></dt><dd>Open the focused job</dd></div>
<div><dt><kbd>/</kbd></dt><dd>Filter jobs on History and By repo</dd></div>
<div><dt><kbd>g</kbd> <kbd>p</kbd></dt><dd>Go to Pipeline</dd></div>
<div><dt><kbd>g</kbd> <kbd>r</kbd></dt><dd>Go to By repo</dd></div>
<div><dt><kbd>g</kbd> <kbd>h</kbd></dt><dd>Go to History</dd></div>
<div><dt><kbd>g</kbd> <kbd>t</kbd></dt><dd>Go to Triggers</dd></div>
<div><dt><kbd>g</kbd> <kbd>s</kbd></dt><dd>Go to Settings</dd></div>
<div><dt><kbd>[</kbd></dt><dd>Collapse or expand the sidebar</dd></div>
<div><dt><kbd>?</kbd></dt><dd>Show or hide this list</dd></div>
<div><dt><kbd>Esc</kbd></dt><dd>Close this list or clear the filter</dd></div>
</dl>
</aside>`;

export function renderApp(model: AppModel): string {
  const page = model.page ?? { csrf: "", repos: [], workflows: listWorkflowNames() };
  const paused = page.paused === true;
  const versionText = kilnVersion();
  const version = versionText && versionText !== "unknown" ? `<span class="ver">v${escapeHtml(versionText)}</span>` : "";
  const spend = page.spend ? `<span class="spend" id="spend">${escapeHtml(formatSpend(page.spend))}</span>` : `<span class="spend" id="spend"></span>`;
  const capNote = page.spend?.blocked ? `<span class="cap" id="cap-note">cap hit</span>` : `<span class="cap" id="cap-note" hidden>cap hit</span>`;
  const body = `<div class="shell">
<aside class="nav" aria-label="Kiln">
<div class="brand"><span class="logo" aria-hidden="true">${kilnMark("currentColor")}</span><div class="brand-text"><h1>Kiln</h1>${version}</div><button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar ([)">${icon("panel-left-close", "icon nav-toggle-close")}${icon("panel-left-open", "icon nav-toggle-open")}</button></div>
<div class="nav-scroll">
${navHtml(model)}
<button class="add" type="button" id="add-job" title="Add job">${icon("plus", "icon add-icon")}<span class="add-text">Add job</span></button>
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
<button class="tool-link" type="button" id="show-shortcuts"><span class="kbd" aria-hidden="true">?</span><span class="tool-text">Shortcuts</span></button>
</footer>
</aside>
<div class="workspace">
${mainHtml(model, page)}
</div>
</div>
<div class="scrim" data-close></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Add job">
${intakeSheet(page, model.attention)}
</aside>
${SHORTCUTS_PANEL}`;
  const job = model.detail?.job;
  return document({
    css: model.css,
    title: tabTitle(model.board.inboxCount),
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
    return `<a class="nav-link" href="${href}" title="${escapeHtml(label)}"${current}${extra}><span class="nav-label">${icon(glyph)}<span class="nav-text">${escapeHtml(label)}</span></span>${count}</a>`;
  };
  const repos = board.repos
    .map((group) => {
      const current = model.section === "repos" && model.repo === group.repo ? ` aria-current="page"` : "";
      return `<a class="nav-sub" href="/repos/${encodeURIComponent(group.repo)}" title="${escapeHtml(group.repo)}"${current}>${escapeHtml(group.repo)}<span class="badge">${group.jobs.length}</span></a>`;
    })
    .join("");
  return `<nav class="side" aria-label="Sections">
${item("/", "pipeline", "Pipeline", "pipeline", "pipeline", board.inboxCount)}
${item("/repos", "repos", "By repo", "repos", "repos")}
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
    const facts = model.settingsFacts ?? { repos: page.repos.length };
    return `${error}<main class="main"><section id="settings" aria-label="Settings"><header class="settings-header"><h2>Settings</h2><p class="meta settings-path" id="settings-path"></p></header>${settingsForm(page.theme ?? DEFAULT_BOARD_THEME, model.settingsSection ?? "repos", facts)}</section></main>`;
  }
  if (model.section === "stats" && model.stats) {
    return `${error}<main class="main">${statsHtml(model.stats)}</main>`;
  }
  if (model.section === "report" && model.report) {
    return `${error}<main class="main">${reportHtml(model.report)}</main>`;
  }
  if (model.section === "job" && model.detail && model.step) {
    return `${error}<main class="main detail">${stepPageHtml(model.detail, model.step, clockOf(page), model.activity)}</main>`;
  }
  if (model.section === "job" && model.detail) {
    return `${error}<main class="main detail">${detailHtml(model.detail, model.tab, page.csrf, clockOf(page), model.activity, model.artifacts, model.phasePlan)}</main>`;
  }
  if (model.section === "triggers") {
    return `${error}<main class="main">${triggersHtml(model.triggers ?? [])}</main>`;
  }
  if (model.section === "pipeline") {
    return `${error}<main class="main">${pipelineHtml(allJobs(model.board), clockOf(page), page.csrf, model.boardView ?? "columns", model.phasePlans ?? {})}</main>`;
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
  return `<header class="list-head"><h2>Triggers</h2><p class="meta">The clock, Jira, and pull request activity can start work. A review is posted only after you approve it. Kiln does not approve or merge. <a href="/settings/triggers">Edit triggers in Settings.</a></p></header>${body}`;
}

/** Plain words for the trigger events on the Triggers page. The raw event name and dedupe key stay in the row's tooltip. */
const TRIGGER_EVENT_LABEL: Record<string, string> = {
  "trigger.fired": "Fired",
  "trigger.routed": "Routed",
  "trigger.failed": "Failed",
  "trigger.skipped": "Skipped",
};

/** "0 * * * *" reads as "every hour"; any cron this does not recognise is shown as written. */
export function cronPhrase(cron: string): string {
  if (/^0 \* \* \* \*$/.test(cron)) return "every hour";
  const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (minutes) return `every ${minutes[1]} minutes`;
  return cron;
}

/** Browser tab title: the count only shows when something needs the user. */
export function tabTitle(count: number): string {
  return count > 0 ? `(${count}) Kiln` : "Kiln";
}

function triggerCard(row: TriggerRow): string {
  const on = row.enabled;
  const bits = [row.kind, row.kind === "schedule" ? cronPhrase(row.schedule) : row.schedule, on ? "enabled" : "disabled"];
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
              `<li title="${escapeHtml(item.summary)}"><time datetime="${escapeHtml(item.ts)}" data-time>${escapeHtml(item.ts)}</time> <span class="ev">${escapeHtml(TRIGGER_EVENT_LABEL[item.event] ?? item.event)}</span>${item.event === "trigger.fired" ? "" : ` ${escapeHtml(item.summary)}`}</li>`,
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

/** The filter box on the job lists. `serve.js` hides rows whose text does not match, and `/` focuses it. */
const JOB_FILTER = `<input type="search" id="job-filter" class="job-filter" placeholder="Filter jobs (press /)" aria-label="Filter jobs" autocomplete="off" spellcheck="false">`;

/** Where the cleanup buttons report. `serve.js` fills it, and fills it again after the page reloads. */
const BULK_STATUS = `<p class="meta bulk-status" id="bulk-status" role="status"></p>`;

/** The filter box and the Remove finished button for the job lists. `serve.js` shows the button when it applies. */
const LIST_TOOLS = `${JOB_FILTER}<div class="bulk"><button type="button" class="btn" id="remove-finished" hidden></button>${BULK_STATUS}</div>`;

function listHtml(model: AppModel, csrf: string, clock: BoardClock): string {
  const board = model.board;
  if (model.section === "history") {
    return `<header class="list-head"><h2>History</h2>${LIST_TOOLS}</header>${jobList(board.history, "history", "No finished jobs.", csrf, clock)}`;
  }
  const groups = model.repo ? board.repos.filter((group) => group.repo === model.repo) : board.repos;
  if (groups.length === 0) return `<header class="list-head"><h2>Jobs by repo</h2></header><p class="empty">No jobs.</p>`;
  const heading = model.repo ? escapeHtml(model.repo) : "Jobs by repo";
  return `<header class="list-head"><h2>${heading}</h2>${LIST_TOOLS}</header>${groups
    .map((group) => {
      const label = model.repo ? "" : `<h3>${escapeHtml(group.repo)}</h3>`;
      return `<section class="repo-block">${label}${groupedJobs(group.jobs, "repos", csrf, clock)}</section>`;
    })
    .join("")}`;
}

function finishedAt(job: JobView): number {
  const at = Date.parse(job.latestEventAt ?? job.since ?? "");
  return Number.isFinite(at) ? at : 0;
}

/** Jobs in one column. Queued cards follow launch order, the same order `kiln queue` prints. */
function inColumn<T extends JobView>(jobs: readonly T[], column: PipelineColumn): T[] {
  const rows = jobs.filter((job) => job.column === column);
  // Finished work reads newest first, so the latest outcome is the top card.
  if (column === "done") return rows.sort((left, right) => finishedAt(right) - finishedAt(left));
  if (column !== "queued") return rows;
  return rows.sort((left, right) => (left.queuePosition ?? Infinity) - (right.queuePosition ?? Infinity));
}

function heldChip(job: JobView): string {
  return job.held ? `<span class="chip">Held</span>` : "";
}

/** One plain sentence per column, shown on hover, so "Needs you" and "Needs a hand" are not left to guesswork. */
const COLUMN_HINT: Record<PipelineColumn, string> = {
  queued: "Waiting for its turn to start.",
  running: "An agent is working on it now.",
  "needs-you": "A decision is waiting for you: approve, reject, or revise.",
  "needs-hand": "It stopped and needs a person to look at it, then retry.",
  done: "Finished: merged, landed, rejected, or cancelled.",
};

const COLUMN_ICON: Record<PipelineColumn, IconName> = {
  queued: "hourglass",
  running: "play",
  "needs-you": "eye",
  "needs-hand": "hand",
  done: "circle-check",
};

/** The List and Columns switch. The choice is a cookie the server reads, so it is saved and shown with no flash. */
function boardViewSwitch(view: BoardView): string {
  const button = (value: BoardView, label: string) => `<button type="button" data-view="${value}" aria-pressed="${view === value ? "true" : "false"}">${label}</button>`;
  return `<div class="seg board-view" id="board-view" role="group" aria-label="Board view">${button("list", "List")}${button("columns", "Columns")}</div>`;
}

function pipelineHtml(jobs: readonly JobView[], clock: BoardClock, csrf: string, view: BoardView = "columns", plans: Record<string, string[][]> = {}): string {
  if (view === "list") return pipelineListHtml(jobs, clock, csrf, plans);
  const titles = new Map(jobs.map((job) => [job.jobId, job.title]));
  const counts = new Map<PipelineColumn, number>();
  const columns = PIPELINE_COLUMNS.map((column) => {
    const rows = inColumn(jobs, column);
    counts.set(column, rows.length);
    const cards = rows.map((job) => pipeCard(job, clock, csrf, titles)).join("");
    const sub = column === "queued" ? `<span class="col-sub">in launch order</span>` : "";
    return `<section class="col" data-column="${column}" aria-label="${escapeHtml(COLUMN_LABEL[column])}" title="${escapeHtml(COLUMN_HINT[column])}">
<header class="full"><h2>${icon(COLUMN_ICON[column], `icon col-icon ${column}`)}${escapeHtml(COLUMN_LABEL[column])}</h2><span class="count">${rows.length || ""}</span>${sub}</header>
<div class="slim-face"><span>${escapeHtml(COLUMN_LABEL[column])}</span><span class="count">${rows.length}</span></div>
${column === "needs-hand" ? `<button type="button" class="btn col-bulk" id="retry-all" hidden></button>` : ""}${cards}<p class="empty">${escapeHtml(emptyColumn(column))}</p>${column === "done" ? `<button type="button" class="btn done-more" id="done-more" hidden></button>` : ""}
</section>`;
  }).join("");
  const status = boardStatusHtml(counts.get("running") ?? 0, counts.get("needs-you") ?? 0, counts.get("needs-hand") ?? 0);
  return `<header class="list-head"><div class="head-row"><h2>Pipeline</h2>${status}<span class="head-tools">${boardViewSwitch("columns")}<button type="button" id="compact" aria-pressed="true" aria-label="collapse empty columns"></button></span></div></header>${filtersHtml(jobs)}${BULK_STATUS}<div class="board-scroll"><div class="board" id="board">${columns}</div></div>`;
}

/** `2 running, 2 need you, 1 needs a hand`. The dot pulses only while something runs. */
export function boardStatusHtml(running: number, needsYou: number, hand: number): string {
  const dot = running > 0 ? `<span class="board-pulse" aria-hidden="true"></span>` : "";
  const text = `${running} running, ${needsYou} ${needsYou === 1 ? "needs" : "need"} you, ${hand} ${hand === 1 ? "needs" : "need"} a hand`;
  return `<p class="board-status" id="board-status" role="status">${dot}<span>${text}</span></p>`;
}

/** One list row: a status icon, the title and state line (with the phase chain for a job in flight), the cost, and the action. */
function plRowHtml(job: JobView, parts: { cls: string; glyph: IconName; state: string; chain?: string; cost?: string; action?: string }): string {
  const cost = parts.cost ? `<span class="pl-cost"><span class="sr-only">Cost </span>${escapeHtml(parts.cost)}</span>` : `<span class="pl-cost"></span>`;
  return `<article class="pl-row ${parts.cls}" ${jobAttrs(job)}>${icon(parts.glyph, `icon pl-icon ${parts.cls}`)}<div class="pl-main"><a class="pl-title" href="/jobs/${encodeURIComponent(job.jobId)}">${escapeHtml(job.title)}</a><span class="pl-state">${parts.state}</span>${parts.chain ?? ""}</div>${cost}<span class="pl-act">${parts.action ?? ""}</span></article>`;
}

/** A job waiting on you: a highlighted band with the reason, the phase chain, and a big Review button. */
function askBandHtml(job: JobView, plan: readonly (readonly string[])[] | undefined): string {
  const cost = formatCost(job.costUsd);
  const line = `${escapeHtml(needsYouSentence(job))}${cost ? `. ${escapeHtml(cost)} so far` : ""}.`;
  return `<section class="pl-row pl-ask needs-you" ${jobAttrs(job)} aria-label="Needs you: ${escapeHtml(job.title)}"><div class="pl-ask-body"><p class="pl-ask-kind">${icon("eye")}Needs you</p><h3><a class="pl-title" href="/jobs/${encodeURIComponent(job.jobId)}">${escapeHtml(job.title)}</a></h3><p class="pl-ask-line">${line}</p>${phaseChainHtml(job, new Set(), plan)}</div><a class="btn primary" href="/jobs/${encodeURIComponent(job.jobId)}">Review</a></section>`;
}

function runningRowHtml(job: JobView, clock: BoardClock, plan: readonly (readonly string[])[] | undefined): string {
  const { step, liveness, fallback } = runningParts(job, clock);
  const live = liveness ? ` ${liveness}` : "";
  const state = step ? `<b>${escapeHtml(step.label)}</b> ${escapeHtml(step.meta)}${live}` : `${fallback}${live}`;
  const note = job.latestNote ? `<span class="pl-note">${escapeHtml(job.latestNote)}</span>` : "";
  const cost = formatCost(job.costUsd);
  return plRowHtml(job, { cls: "running", glyph: "play", state: `${state}${note}`, chain: phaseChainHtml(job, new Set(), plan), ...(cost ? { cost } : {}) });
}

function handRowHtml(job: JobView, csrf: string, plan: readonly (readonly string[])[] | undefined): string {
  const id = encodeURIComponent(job.jobId);
  const forms: string[] = [];
  if (job.retry) forms.push(postForm(`/api/jobs/${id}/retry`, "retry", "Retry", csrf));
  if (job.reviewPostError) forms.push(`<a class="card-btn" href="/jobs/${id}">Review</a>`);
  const cost = formatCost(job.costUsd);
  return plRowHtml(job, {
    cls: "needs-hand",
    glyph: "triangle-alert",
    state: `<span class="pl-bad">${escapeHtml(job.reason)}</span>${launchFixHtml(job)}`,
    chain: phaseChainHtml(job, new Set(), plan),
    ...(cost ? { cost } : {}),
    ...(forms.length ? { action: `<div class="d-actions">${forms.join("")}</div>` } : {}),
  });
}

function queuedRowHtml(job: JobView, titles: ReadonlyMap<string, string>): string {
  const position = job.queuePosition !== undefined ? `<span class="queue-pos"><span class="sr-only">Position </span>${job.queuePosition}</span> ` : "";
  const blocked = job.launchBlock ? `<span class="pl-bad">${escapeHtml(job.reason)}</span>${launchFixHtml(job)}` : "";
  return plRowHtml(job, { cls: "queued", glyph: "hourglass", state: `${position}${queueWhyHtml(job, titles)}${heldChip(job)}${blocked}` });
}

function doneRowHtml(job: JobView): string {
  const outcome = doneOutcome(job);
  const run = job.doneMetrics?.runMs !== undefined ? `, ${escapeHtml(formatDuration(job.doneMetrics.runMs))}` : "";
  const cost = formatCost(job.doneMetrics?.costUsd ?? job.costUsd);
  return plRowHtml(job, { cls: "done", glyph: outcome.glyph, state: `<span class="outcome-word ${escapeHtml(job.state)}">${escapeHtml(outcome.label)}</span>${run}`, ...(cost ? { cost } : {}) });
}

const LANE_TITLE: Record<PipelineColumn, string> = { queued: "Queued", running: "Running", "needs-you": "Needs you", "needs-hand": "Needs a hand", done: "Finished" };

function laneHtml(column: PipelineColumn, rows: string[], extra = ""): string {
  if (rows.length === 0) return "";
  return `<section class="pl-lane ${column}" data-lane="${column}" aria-label="${escapeHtml(LANE_TITLE[column])}"><h3>${icon(COLUMN_ICON[column])}<span>${escapeHtml(LANE_TITLE[column])}</span><span class="pl-count" data-pl-count>${rows.length}</span>${extra}</h3>${rows.join("")}</section>`;
}

/**
 * The Pipeline as one list in order of what needs you: a band for each job waiting on a decision (or one calm line),
 * then what is stuck, running, queued, and recently finished. Every job in flight carries its phase chain. A cap on
 * Finished and the filters are applied by `serve.js`, the same as for the columns.
 */
function pipelineListHtml(jobs: readonly JobView[], clock: BoardClock, csrf: string, plans: Record<string, string[][]>): string {
  const titles = new Map(jobs.map((job) => [job.jobId, job.title]));
  const rows = (column: PipelineColumn) => inColumn(jobs, column);
  const waiting = rows("needs-you");
  const stuck = rows("needs-hand");
  const running = rows("running");
  const status = boardStatusHtml(running.length, waiting.length, stuck.length);
  const band =
    waiting.length > 0
      ? waiting.map((job) => askBandHtml(job, plans[job.jobId])).join("")
      : `<p class="pl-calm">${icon("circle-check")}<span>Nothing needs you right now.</span></p>`;
  const lanes = [
    laneHtml("needs-hand", stuck.map((job) => handRowHtml(job, csrf, plans[job.jobId])), `<span class="pl-lane-act"><button type="button" class="btn" id="retry-all" hidden></button></span>`),
    laneHtml("running", running.map((job) => runningRowHtml(job, clock, plans[job.jobId]))),
    laneHtml("queued", rows("queued").map((job) => queuedRowHtml(job, titles))),
    laneHtml("done", rows("done").map((job) => doneRowHtml(job)), ""),
  ].join("");
  const doneMore = rows("done").length > 0 ? `<button type="button" class="btn done-more" id="done-more" hidden></button>` : "";
  const body = jobs.length === 0 ? `<p class="empty">No jobs.</p>` : `${band}${lanes}${doneMore}`;
  return `<header class="list-head"><div class="head-row"><h2>Pipeline</h2>${status}<span class="head-tools">${boardViewSwitch("list")}</span></div></header>${filtersHtml(jobs)}${BULK_STATUS}<div class="pipeline-list" id="board">${body}</div>`;
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

/** One card per job, drawn the way its column needs. */
function pipeCard(job: JobView, clock: BoardClock, csrf: string, titles: ReadonlyMap<string, string>): string {
  switch (job.column) {
    case "queued":
      return queuedCard(job, titles);
    case "running":
      return runningCard(job, clock);
    case "needs-you":
      return needsYouCard(job);
    case "needs-hand":
      return handCard(job, csrf);
    case "done":
      return doneCard(job);
  }
}

/** The `article.card` wrapper. The filters and `paintLiveness` read its data attributes. */
function jobAttrs(job: JobView): string {
  return `id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-state="${escapeHtml(job.state)}" data-repo="${escapeHtml(job.repo)}" data-workflow="${escapeHtml(job.workflow)}"${activityAttrs(job)}${job.latestEventAt ? ` data-latest="${escapeHtml(job.latestEventAt)}"` : ""}`;
}

function cardShell(job: JobView, cls: string, inner: string): string {
  return `<article class="card ${cls}" ${jobAttrs(job)}>
<a class="job-title" href="/jobs/${encodeURIComponent(job.jobId)}">${escapeHtml(job.title)}</a>
${inner}
</article>`;
}

/** `feature` reads `Feature`. */
export function workflowLabel(workflow: string): string {
  return workflow ? workflow.charAt(0).toUpperCase() + workflow.slice(1) : workflow;
}

export const REPO_TONES = 6;

/** A stable `--repo-N` color slot for a repo name, 1 to 6. */
export function repoTone(repo: string): number {
  let hash = 0;
  for (let index = 0; index < repo.length; index += 1) hash = (hash * 31 + repo.charCodeAt(index)) >>> 0;
  return (hash % REPO_TONES) + 1;
}

function repoHtml(repo: string): string {
  return `<span class="card-repo repo-${repoTone(repo)}">${icon("repos")}<span>${escapeHtml(repo)}</span></span>`;
}

function cardFoot(job: JobView): string {
  return `<div class="card-foot">${repoHtml(job.repo)}<span class="card-flow">${escapeHtml(workflowLabel(job.workflow))}</span></div>`;
}

/** Queued: the launch position and why it is there. No step track. */
function queuedCard(job: JobView, titles: ReadonlyMap<string, string>): string {
  const position = job.queuePosition !== undefined ? `<span class="queue-pos"><span class="sr-only">Position </span>${job.queuePosition}</span>` : "";
  const blocked = job.launchBlock ? `<p class="card-reason">${escapeHtml(job.reason)}</p>${launchFixHtml(job)}` : "";
  return cardShell(job, "queued", `<p class="queue-line">${position}${queueWhyHtml(job, titles)}${heldChip(job)}</p>${blocked}${cardFoot(job)}`);
}

function queueWhyHtml(job: JobView, titles: ReadonlyMap<string, string>): string {
  if (job.held) return "";
  const reason = job.queueReason ?? "";
  const waits = /^waits for (.+)$/.exec(reason)?.[1] ?? (reason ? undefined : job.dependsOn.find((dep) => dep.state !== "done")?.jobId);
  if (waits) {
    return `<span class="queue-why waits">${icon("lock")}<span>Waits for ${escapeHtml(titles.get(waits) ?? waits)}</span></span>`;
  }
  const retry = /^retries at (.+)$/.exec(reason)?.[1];
  if (retry) return `<span class="queue-why">Retries ${timeHtml(retry, "clock")}</span>`;
  return `<span class="queue-why">${job.queuePosition === 1 ? "Next up" : "Ready"}</span>`;
}

/**
 * One segment per `job.steps` entry. Only a running card marks `current`, and
 * that one segment sweeps. A needs-a-hand card marks the failed step.
 */
export function stepTrackHtml(job: Parameters<typeof stepFocus>[0], mode: "running" | "needs-you" | "needs-hand"): string {
  const steps = job.steps;
  if (steps.length === 0) return "";
  const focus = stepFocus(job);
  const marked = mode === "needs-hand" && focus?.kind === "step" && focus.step.status === "failed" ? focus.step : undefined;
  const segs = steps
    .map((step) => {
      let cls = "upcoming";
      if (step === marked) cls = "failed";
      else if (step.status === "done" || step.status === "skipped") cls = "done";
      else if (step.status === "failed") cls = "failed";
      else if (step.status === "running" && mode === "running") cls = "current sweep";
      return `<span class="seg ${cls}" title="${escapeHtml(step.label)}"></span>`;
    })
    .join("");
  return `<div class="track" role="img" aria-label="${escapeHtml(trackLabel(steps, mode, marked, focus))}">${segs}</div>`;
}

function trackLabel(
  steps: readonly StepMark[],
  mode: "running" | "needs-you" | "needs-hand",
  failed: StepMark | undefined,
  focus: StepFocus | undefined,
): string {
  const total = steps.length;
  // With no step to name, the outcome says where the job is.
  const settled = focus?.kind === "outcome" ? focus.label : `All ${total} steps done`;
  if (failed) return `Failed at ${failed.label}`;
  if (steps.every((step) => step.status === "done" || step.status === "skipped")) return settled;
  const at = mode === "running" ? steps.findIndex((step) => step.status === "running") : -1;
  const index = at >= 0 ? at : steps.findIndex((step) => step.status !== "done" && step.status !== "skipped");
  const step = steps[index];
  return step ? `Step ${index + 1} of ${total}: ${step.label}` : settled;
}

/**
 * What a running job is doing: the live step (name, `step N of M`, how long it has run) and the liveness words, or
 * the retry or reason when no step is live. The card and the list row both read it.
 */
function runningParts(job: JobView, clock: BoardClock): { step?: { label: string; meta: string }; liveness: string; fallback: string } {
  const index = job.steps.findIndex((step) => step.status === "running");
  const step = job.steps[index];
  const live = activityLiveness({
    column: job.column,
    ...(job.stallActivityAt ? { lastActivityAt: job.stallActivityAt } : {}),
    ...(clock.now !== undefined ? { now: clock.now } : {}),
    stallTimeoutMs: clock.stallTimeoutMs,
  });
  // The step pulse is the dot, so the liveness reads as words only.
  const liveness = live.liveness === "idle" ? "" : livenessHtml(live, false);
  const fallback = job.scheduledRetry && job.nextRetryAt ? `Retrying ${timeHtml(job.nextRetryAt, "clock")}` : escapeHtml(job.reason);
  if (!step) return { liveness, fallback };
  const phase = [...job.phases].reverse().find((item) => item.id === step.id && item.startedAt);
  const ran = phase?.startedAt ? elapsed(phase.startedAt, clock) : "";
  return { step: { label: step.label, meta: `step ${index + 1} of ${job.steps.length}${ran ? `, ${ran}` : ""}` }, liveness, fallback };
}

/** Running: the track, the live step with `step N of M` and how long it has run, and the newest note. */
function runningCard(job: JobView, clock: BoardClock): string {
  const { step, liveness, fallback } = runningParts(job, clock);
  const line = step
    ? `<p class="run-line"><span class="step-pulse" aria-hidden="true"></span><span class="run-step">${escapeHtml(step.label)}</span><span class="run-meta">${escapeHtml(step.meta)}</span>${liveness}</p>`
    : `<p class="run-line"><span class="run-meta">${fallback}</span>${liveness}</p>`;
  const note = job.latestNote ? `<p class="run-note">${escapeHtml(job.latestNote)}</p>` : "";
  return cardShell(job, "running", `${stepTrackHtml(job, "running")}${line}${note}${cardFoot(job)}`);
}

const DECISION_SKIP: ReadonlySet<string> = new Set(["verify", "approver", "approve", "security", "ux", "ui", "code"]);

/**
 * One sentence for a job that waits on the operator: a pull request that
 * conflicts or is ready to merge, or the step a gate asks about.
 */
export function needsYouSentence(job: Pick<JobView, "state" | "reason" | "prNumber" | "steps">): string {
  const base = /^Conflicts with ([^\s:,]+)/.exec(job.reason)?.[1];
  if (base && job.prNumber) return `Pull request #${job.prNumber} conflicts with ${base}`;
  if (job.state === "in-review") return job.prNumber ? `Pull request #${job.prNumber} is ready to merge` : job.reason;
  const decided = [...job.steps].reverse().find((step) => step.status === "done" && !DECISION_SKIP.has(step.id));
  return decided ? `Waiting for your decision on the ${decided.label.toLowerCase()}` : "Waiting for your decision";
}

function costHtml(job: JobView): string {
  const cost = formatCost(job.costUsd);
  return cost ? `<span class="card-cost"><span class="sr-only">Cost </span>${escapeHtml(cost)}</span>` : "";
}

/** Needs you: the track, the reason, the cost, and Review (the job page holds Approve, Reject, and Revise). */
function needsYouCard(job: JobView): string {
  const sentence = needsYouSentence(job);
  const glyph: IconName = job.prNumber ? "git-pull-request" : "list-checks";
  const review = `<a class="card-btn" href="/jobs/${encodeURIComponent(job.jobId)}">Review</a>`;
  return cardShell(
    job,
    "needs-you",
    `${stepTrackHtml(job, "needs-you")}<p class="card-reason">${icon(glyph)}<span>${escapeHtml(sentence)}</span></p><div class="card-act">${costHtml(job)}${review}</div>${cardFoot(job)}`,
  );
}

/** Needs a hand: the track with the failed step, the reason, the cost, and Retry when allowed. */
function handCard(job: JobView, csrf: string): string {
  const id = encodeURIComponent(job.jobId);
  const actions: string[] = [];
  if (job.retry) actions.push(postForm(`/api/jobs/${id}/retry`, "retry", "Retry", csrf));
  if (job.reviewPostError) actions.push(`<a class="card-btn" href="/jobs/${id}">Review</a>`);
  const act = actions.length ? `<div class="d-actions">${actions.join("")}</div>` : "";
  const cost = costHtml(job);
  return cardShell(
    job,
    "needs-hand",
    `${stepTrackHtml(job, "needs-hand")}<p class="card-reason">${icon("triangle-alert")}<span>${escapeHtml(job.reason)}</span></p>${launchFixHtml(job)}${cost || act ? `<div class="card-act">${cost}${act}</div>` : ""}${cardFoot(job)}`,
  );
}

/** The stepper's outcome (`Merged #88`, `Landed locally`, `Rejected`, `Cancelled`, ...) with its glyph. */
export function doneOutcome(job: Parameters<typeof stepFocus>[0]): { label: string; glyph: IconName } {
  const focus = stepFocus(job);
  const label = focus?.kind === "outcome" ? focus.label : (focus?.step.label ?? "");
  if (job.state === "rejected") return { label, glyph: "circle-x" };
  if (job.state === "cancelled") return { label, glyph: "ban" };
  if (label.startsWith("Merged")) return { label, glyph: "git-merge" };
  return { label, glyph: "circle-check" };
}

function metricHtml(name: string, glyph: IconName, value: string): string {
  return `<span class="metric" title="${escapeHtml(name)}">${icon(glyph)}<span class="sr-only">${escapeHtml(name)} </span>${value}</span>`;
}

function metricsHtml(metrics: JobView["doneMetrics"]): string {
  if (!metrics) return "";
  const items: string[] = [];
  const cost = formatCost(metrics.costUsd);
  if (cost) items.push(metricHtml("Cost", "coins", escapeHtml(cost)));
  if (metrics.runMs !== undefined) items.push(metricHtml("Run time", "clock", escapeHtml(formatDuration(metrics.runMs))));
  if (metrics.added !== undefined && metrics.removed !== undefined) {
    items.push(metricHtml("Lines added and removed", "file-diff", `<span class="added">+${metrics.added}</span> <span class="removed">-${metrics.removed}</span>`));
  }
  if (metrics.files !== undefined) items.push(metricHtml("Files changed", "files", String(metrics.files)));
  if (metrics.fixRounds !== undefined && metrics.fixRounds > 0) items.push(metricHtml("Fix rounds", "wrench", String(metrics.fixRounds)));
  return items.length ? `<p class="metrics">${items.join("")}</p>` : "";
}

/** Done: the title on one line, the outcome with the repo, then the metrics Kiln has. */
function doneCard(job: JobView): string {
  const outcome = doneOutcome(job);
  const line = `<p class="done-line"><span class="outcome-word ${escapeHtml(job.state)}">${icon(outcome.glyph)}<span>${escapeHtml(outcome.label)}</span></span><span class="done-where">${repoHtml(job.repo)}<span class="card-flow">${escapeHtml(workflowLabel(job.workflow))}</span></span></p>`;
  return cardShell(job, "done", `${line}${metricsHtml(job.doneMetrics)}`);
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
  section: "repos" | "history",
  empty: string,
  csrf: string,
  clock: BoardClock,
): string {
  if (jobs.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<div class="jobs">${jobs.map((job) => jobRow(job, section, csrf, clock)).join("\n")}</div>`;
}

function jobRow(job: BoardJob, section: "repos" | "history", csrf: string, clock: BoardClock): string {
  const id = encodeURIComponent(job.jobId);
  const classes = ["job"];
  if (job.scheduledRetry) classes.push("retrying");
  const repo = section === "repos" ? "" : `<span class="meta">${escapeHtml(job.repo)}</span>`;
  const sandbox = job.sandboxed ? `<span class="meta">sandbox · docker</span>` : "";
  const pr = section === "repos" && job.state === "in-review" ? `<span class="meta">PR review</span>` : "";
  const retrying =
    job.scheduledRetry && job.nextRetryAt
      ? `<div class="meta">retrying <time datetime="${escapeHtml(job.nextRetryAt)}" data-time="clock">${escapeHtml(formatRelative(job.nextRetryAt))}</time>${job.attemptLine ? ` · ${escapeHtml(job.attemptLine)}` : ""}</div>`
      : "";
  // The step list already ends in the outcome ("Merged #109"), so a finished row that draws it does not say it again
  // in a reason line, a history line, and an inline log. A local landing keeps its history line: it names the branch.
  const settled = job.finished && job.steps.length > 0 && stepFocus(job)?.kind === "outcome";
  const history = job.historyLine && (!settled || /^landed locally · /.test(job.historyLine)) ? `<div class="meta">${escapeHtml(job.historyLine)}</div>` : "";
  const unsafe = job.prUrl && !safeUrl(job.prUrl) ? `<div class="branch">${escapeHtml(job.prUrl)}</div>` : "";
  const deps = dependsHtml(job);
  const reason = settled ? "" : `<p class="reason">${escapeHtml(job.reason)}</p>`;
  const fix = launchFixHtml(job);
  const feedback = feedbackHtml(job);
  const tail = job.logTail && !job.finished ? logDisclosure(job.logTail) : "";
  const notes = visibleNotes(job);
  const unseen = `<p class="unseen" data-unseen-for="${escapeHtml(job.jobId)}" hidden></p>`;
  const links = fileLinks(job);
  const age = job.since ? timeHtml(job.since, "rel") : "";
  const cost = formatCost(job.costUsd);
  return `<article class="${classes.join(" ")}" id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-state="${escapeHtml(job.state)}" data-repo="${escapeHtml(job.repo)}" data-workflow="${escapeHtml(job.workflow)}" data-deps="${escapeHtml(job.dependsOn.map((dep) => dep.jobId).join(" "))}"${job.canRemove ? ` data-removable="true"` : ""}${activityAttrs(job)}${job.latestEventAt ? ` data-latest="${escapeHtml(job.latestEventAt)}"` : ""}>
<div class="job-main">
<div class="job-top"><a class="job-title" href="/jobs/${id}">${escapeHtml(job.title)}</a></div>
<div class="job-meta"><span class="num">${escapeHtml(job.jobId)}</span>${repo}<span class="chip ${stateTone(job.state)}">${escapeHtml(stateWord(job.state))}</span>${heldChip(job)}<span class="chip">${escapeHtml(job.workflow)}</span>${age}${cost ? `<span class="meta">${escapeHtml(cost)}</span>` : ""}${sandbox}${pr}</div>
${progressHtml(job, clock)}${reason}${fix}${history}${unsafe}${retrying}${deps}${feedback}${notes}${tail}${unseen}${links}
</div>
${actionsHtml(job, section, csrf)}
</article>`;
}

/** The state as a person reads it. Only the one that is jargon changes: the rest already read plainly. */
function stateWord(state: string): string {
  return state === "needs-human" ? "needs you" : state;
}

function showReason(job: JobView): boolean {
  if (!job.ask) return true;
  const norm = (value: string) => value.replace(/^Gate:\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  const ask = norm(job.ask);
  const reason = norm(job.reason);
  return reason !== ask && !reason.endsWith(ask);
}

function visibleNotes(job: JobView): string {
  const lines = job.notes.filter((line) => !looksLikeLog(line));
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

function activityAttrs(job: JobView): string {
  const activity = job.stallActivityAt ? ` data-activity="${escapeHtml(job.stallActivityAt)}"` : "";
  return ` data-column="${escapeHtml(job.column)}"${activity}`;
}

function progressHtml(job: JobView, clock: BoardClock): string {
  if (job.steps.length === 0) return "";
  const live = activityLiveness({
    column: job.column,
    ...(job.stallActivityAt ? { lastActivityAt: job.stallActivityAt } : {}),
    ...(clock.now !== undefined ? { now: clock.now } : {}),
    stallTimeoutMs: clock.stallTimeoutMs,
  });
  const focus = stepFocus(job);
  const items = job.steps
    .map((step) => {
      const cls = stepClass(step.status);
      const mark = step.status === "done" ? icon("check", "icon mark") : "";
      const current = !job.finished && (step.status === "running" || step.status === "failed") ? ` aria-current="step"` : "";
      return `<li class="step ${cls}"${current}>${mark}<span class="name">${escapeHtml(step.label)}</span></li>`;
    })
    .join("");
  // An outcome is read: the step list carries no outcome words.
  let nowName = "";
  if (focus?.kind === "step") nowName = `<span class="step-now ${stepClass(focus.step.status)}" aria-hidden="true">${escapeHtml(focus.step.label)}</span>`;
  else if (focus) nowName = `<span class="step-now outcome">${escapeHtml(focus.label)}</span>`;
  const liveness = live.liveness === "idle" ? "" : livenessHtml(live);
  const meta = nowName || liveness ? `<div class="progress-meta">${nowName}${liveness}</div>` : "";
  return `<div class="progress"><ol class="steps" aria-label="Steps">${items}</ol>${meta}</div>`;
}

function stepClass(status: StepMark["status"]): string {
  if (status === "done") return "done";
  if (status === "skipped") return "skipped";
  if (status === "running") return "current";
  if (status === "failed") return "failed";
  return "upcoming";
}

function livenessHtml(live: ActivityRead, withDot = true): string {
  const dot = !withDot || live.liveness === "stalled" ? "" : `<span class="live-dot" aria-hidden="true"></span>`;
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
  const href = `/settings/repos?${new URLSearchParams({ repo: fix.repo, field: fix.field }).toString()}`;
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

function actionsHtml(
  job: BoardJob,
  section: "repos" | "history" | "job",
  csrf: string,
  parts: { gate?: boolean; retry?: boolean } = {},
): string {
  const showGate = parts.gate !== false && section === "job";
  const showRetry = parts.retry !== false && (section === "repos" || section === "job");
  const id = encodeURIComponent(job.jobId);
  const forms: string[] = showGate ? gateForms(job, id, csrf) : [];
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

/** Approve, Reject, and Revise (with a required note), as allowed. `id` is already URL-encoded. */
function gateForms(job: BoardJob, id: string, csrf: string): string[] {
  const forms: string[] = [];
  if (job.canApprove) forms.push(postForm(`/api/jobs/${id}/approve`, "approve", "Approve", csrf));
  if (job.canReject) forms.push(postForm(`/api/jobs/${id}/reject`, "reject", "Reject", csrf));
  if (job.canRevise) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/revise" class="act revise"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input name="note" type="text" required maxlength="8000" placeholder="Note for the next round" aria-label="Note for the next round" autocomplete="off"><button type="submit">Revise</button></form>`,
    );
  }
  return forms;
}

/** Opening the summary reveals the real submit button, so confirming needs no script. */
function confirmForm(action: string, kind: string, label: string, confirm: string, csrf: string): string {
  return `<details class="act confirm ${kind}"><summary>${label}</summary>${postForm(action, kind, confirm, csrf)}</details>`;
}

function postForm(action: string, kind: string, label: string, csrf: string): string {
  return `<form method="post" action="${action}" class="act ${kind}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">${label}</button></form>`;
}

type JobTarget = "live" | "changes" | "timeline";

function detailHtml(
  detail: JobDetail,
  tab: "overview" | "live" | "changes" | "timeline" | undefined,
  csrf: string,
  clock: BoardClock,
  activity?: ActivityFeed,
  artifacts?: ArtifactSet,
  phasePlan?: readonly (readonly string[])[],
): string {
  const job = detail.job;
  const target: JobTarget | undefined = tab === "live" || tab === "changes" || tab === "timeline" ? tab : undefined;
  const feed = activity ?? { running: job.column === "running", cursor: "", events: [], raw: "" };
  const deciding = job.column === "needs-you" && job.inbox;
  const failing = !deciding && (job.column === "needs-hand" || job.retry);
  const nowing = !deciding && !failing && job.column === "running";
  const middle = deciding ? decisionCardHtml(job, csrf) : failing ? failureCardHtml(job, csrf) : nowing ? nowCardHtml(job, feed, clock) : "";
  const result = !deciding && job.deliverable ? `<details class="job-more" id="result"><summary>Result</summary>${deliverableHtml(job)}</details>` : "";
  const ask = !deciding && job.ask ? `<p class="ask">${escapeHtml(job.ask)}</p>` : "";
  // The Now card names the running step, and the failure card carries the reason.
  const reason = !failing && !nowing && showReason(job) && stepFocus(job)?.kind !== "outcome" ? `<p class="reason">${escapeHtml(job.reason)}</p>` : "";
  const targetAttr = target ? ` data-target="${target}"` : "";
  return `<div class="job-page"${activityAttrs(job)}${targetAttr}>
<header class="job-head">
<a class="back" href="/">Pipeline</a>
<div class="job-top"><h1>${escapeHtml(job.title)}</h1><span class="chip ${stateTone(job.state)}">${escapeHtml(stateWord(job.state))}</span>${heldChip(job)}</div>
${jobMetaHtml(job)}
${ask}${reason}${launchFixHtml(job)}
<p class="unseen" data-unseen-for="${escapeHtml(job.jobId)}" hidden></p>
${actionsHtml(job, "job", csrf, { gate: !deciding, retry: false })}
</header>
${progressRowHtml(job, startedPhaseIds(job, feed), phasePlan)}
<div class="job-body">
<div class="job-main">
${middle}
${stepSectionsHtml(job, feed, clock)}
${result}
<details class="job-more" id="changes"${target === "changes" ? " open" : ""}><summary>Diff</summary>${changesHtml(detail)}</details>
<details class="job-more" id="timeline"${target === "timeline" ? " open" : ""}><summary>Event history</summary>${timelineHtml(detail)}</details>
</div>
${sideHtml(detail, artifacts)}
</div>
</div>`;
}

/** `/jobs/<id>/steps/<step>`: the job header, the step list as navigation, and the selected step. */
function stepPageHtml(detail: JobDetail, step: StepPage, clock: BoardClock, activity?: ActivityFeed): string {
  const job = detail.job;
  const feed = activity ?? { running: job.column === "running", cursor: "", events: [], raw: "" };
  const started = startedPhaseIds(job, feed);
  const runningId = runningPhaseId(job, feed);
  const phase = job.phases.find((item) => item.id === step.id);
  const label = phase?.label ?? job.steps.find((item) => item.id === step.id)?.label ?? step.id;
  const id = encodeURIComponent(job.jobId);
  const events = feed.events.filter((event) => event.phase === step.id);
  const open = step.id === runningId;
  const bits = phase ? stepStateBits(phase, clock, open) : [];
  const agent = stepAgent(step.id) ?? step.result.stepKind;
  // The observed model and the step's cost, once it has run. Before that, the workflow's model.
  const who = [agent, phase && hasUsage(phase) ? formatStepUsage(phase) : step.result.model].filter(Boolean).join(", ");
  const commands = events.filter((event) => event.kind === "command").length;
  const files = editedFiles(events);
  const here = stepHref(job, step.id);
  const viewLink = (href: string, text: string, current: boolean) => `<a href="${href}"${current ? ` aria-current="page"` : ""}>${text}</a>`;
  const views = [
    viewLink(here, "Activity", step.view === "activity"),
    viewLink(`${here}?view=result`, "Result", step.view === "result"),
    ...(job.log ? [`<a href="/jobs/${id}/log">Raw log</a>`] : []),
  ].join("");
  const body =
    step.view === "result"
      ? `<div class="step-result">${stepResultHtml(step.result.result)}</div>`
      : liveRootHtml("step-live", { running: open && feed.running, cursor: feed.cursor, phase: step.id, pin: true }, liveFeedHtml(label, events));
  return `<div class="job-page"${activityAttrs(job)}>
<header class="job-head">
<a class="back" href="/">Pipeline</a>
<div class="job-top"><h1><a class="title-link" href="/jobs/${id}">${escapeHtml(job.title)}</a></h1><span class="chip ${stateTone(job.state)}">${escapeHtml(stateWord(job.state))}</span>${heldChip(job)}</div>
${jobMetaHtml(job)}
</header>
<div class="step-page">
${stepNavHtml(detail, step.id, started, runningId, clock)}
<section class="step-view" aria-labelledby="step-title">
<header class="step-view-head"><h2 id="step-title">${escapeHtml(label)}</h2><span class="meta">${escapeHtml(bits.join(", "))}</span>${who ? `<span class="step-agent">${escapeHtml(who)}</span>` : ""}</header>
<dl class="step-counts"><div><dt>Commands run</dt><dd>${commands}</dd></div><div><dt>Files edited</dt><dd>${files}</dd></div></dl>
<nav class="step-views" aria-label="${escapeHtml(label)} views">${views}</nav>
${body}
</section>
</div>
</div>`;
}

function elapsed(since: string, clock: BoardClock): string {
  const ms = (clock.now ?? Date.now()) - Date.parse(since);
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "";
}

/** Distinct paths the step's Edit and Write events touched. */
function editedFiles(events: readonly ActivityEvent[]): number {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.kind !== "edit") continue;
    paths.add(event.summary.replace(/^\S+\s+/, "").replace(/\s+\+\d+\s+-\d+$/, ""));
  }
  return paths.size;
}

function stepNavHtml(detail: JobDetail, selected: string, started: ReadonlySet<string>, runningId: string | undefined, clock: BoardClock): string {
  const job = detail.job;
  const row = (mark: StepMark): string => {
    const phase = job.phases.find((item) => item.id === mark.id);
    const status = mark.id === runningId ? "running" : mark.status;
    const glyph =
      status === "done"
        ? icon("check", "icon mark")
        : status === "running"
          ? `<span class="step-dot" aria-hidden="true"></span>`
          : `<span class="step-ring" aria-hidden="true"></span>`;
    const note =
      status === "failed"
        ? "failed"
        : status === "skipped"
          ? "skipped"
          : status === "running" && phase?.startedAt
            ? elapsed(phase.startedAt, clock)
            : phase?.durationMs !== undefined
              ? formatDuration(phase.durationMs)
              : "";
    const inner = `${glyph}<span class="step-row-name">${escapeHtml(mark.label)}</span><span class="step-row-note">${escapeHtml(note)}</span>`;
    const cls = `step-row ${stepClass(status)}`;
    if (!started.has(mark.id)) return `<li><span class="${cls}">${inner}</span></li>`;
    const current = mark.id === selected ? ` aria-current="page"` : "";
    return `<li><a class="${cls}" href="${stepHref(job, mark.id)}"${current}>${inner}</a></li>`;
  };
  const items: string[] = [];
  const steps = job.steps;
  for (let index = 0; index < steps.length; ) {
    const mark = steps[index] as StepMark;
    if (!isReviewStep(mark.id)) {
      items.push(row(mark));
      index += 1;
      continue;
    }
    const group: string[] = [];
    while (index < steps.length && isReviewStep(steps[index]?.id ?? "")) {
      group.push(row(steps[index] as StepMark));
      index += 1;
    }
    items.push(`<li class="step-group"><span class="step-group-label" id="step-group-reviews">Reviews</span><ol class="step-list" aria-labelledby="step-group-reviews">${group.join("")}</ol></li>`);
  }
  const id = encodeURIComponent(job.jobId);
  const count = detail.changes.files?.length ?? 0;
  return `<nav class="step-nav" aria-label="Steps">
<ol class="step-list">${items.join("")}</ol>
<p class="step-nav-foot"><a href="/jobs/${id}#changes">Changes so far, ${count === 1 ? "1 file" : `${count} files`}</a><a href="/jobs/${id}#timeline">Event history</a></p>
</nav>`;
}

function stepResultHtml(result: StepRead["result"]): string {
  const fact = (term: string, value: string) => `<dl class="verdicts"><div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div></dl>`;
  const prose = (heading: string, text: string) =>
    `<h3>${escapeHtml(heading)}</h3>${text.trim() ? `<div class="prose">${renderMarkdown(text)}</div>` : `<p class="empty">Empty.</p>`}`;
  switch (result.kind) {
    case "spec":
      return `${prose("Goal", result.goal)}${prose("Design", result.design)}${prose("Acceptance", result.acceptance)}`;
    case "build":
      return `${fact("Status", result.status)}${prose("Summary", result.summary)}`;
    case "verify": {
      const exit = result.exitCode === null ? "killed, no exit code" : result.exitCode === 0 ? "passed, exit 0" : `failed, exit ${result.exitCode}`;
      const tail = result.tail ? `<pre class="text">${escapeHtml(result.tail)}</pre>` : `<p class="empty">No output.</p>`;
      return `${fact("Result", exit)}<h3>Output, last 40 lines</h3>${tail}`;
    }
    case "review":
      return `${fact("Verdict", result.verdict)}${prose("Findings", result.findings)}`;
    case "approver":
      return `${fact("Decision", result.decision)}${prose("Reason", result.reason)}`;
    default:
      return `<p class="empty">This step has no result to show.</p>`;
  }
}

function shortJobId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 5)}…${id.slice(-5)}` : id;
}

function jobMetaHtml(job: JobView): string {
  const bits: string[] = [`<a href="/repos/${encodeURIComponent(job.repo)}">${escapeHtml(job.repo)}</a>`, `<span>${escapeHtml(job.workflow)}</span>`];
  if (job.since) bits.push(`<span>started ${timeHtml(job.since, "rel")}</span>`);
  if (job.attemptCount > 0) bits.push(`<span>attempt ${job.attemptCount} of ${job.maxAttempts}</span>`);
  const cost = formatCost(job.costUsd);
  if (cost) bits.push(`<span>${escapeHtml(cost)}</span>`);
  if (cost && job.costPartial) bits.push(`<span class="meta" title="The steps' costs do not add up to this total">partial</span>`);
  bits.push(`<span class="mono" title="${escapeHtml(job.jobId)}">${escapeHtml(shortJobId(job.jobId))}</span>`);
  if (job.branch) bits.push(`<span class="mono">${escapeHtml(job.branch)}</span>`);
  const pr = prHtml(job.prUrl, job.prNumber);
  if (pr) bits.push(`<span>${pr}</span>`);
  return `<div class="job-meta">${bits.join("")}</div>`;
}

/** What a screen reader hears after a step's name, since the icon carries the state for everyone else. */
const PILL_WORD: Record<string, string> = { done: "done", failed: "failed", current: "in progress", human: "waiting for you", upcoming: "not started" };

/** One step as a pill: a check when done, an x when failed, a dot while it runs, dimmed before it starts. */
function phasePillHtml(job: JobView, node: PhaseNode, started: ReadonlySet<string>): string {
  const waiting = job.column === "needs-you" && node.status === "running";
  const active = !job.finished;
  const state =
    node.status === "done" || node.status === "skipped"
      ? "done"
      : node.status === "failed"
        ? "failed"
        : node.status === "running" && active
          ? waiting
            ? "human"
            : "current"
          : "upcoming";
  const mark = state === "done" ? icon("circle-check", "icon ph-mark") : state === "failed" ? icon("circle-x", "icon ph-mark") : `<span class="ph-dot" aria-hidden="true"></span>`;
  const label = started.has(node.id) ? `<a href="${stepHref(job, node.id)}">${escapeHtml(node.label)}</a>` : escapeHtml(node.label);
  const current = active && (state === "current" || state === "human" || state === "failed") ? ` aria-current="step"` : "";
  const title = node.durationMs !== undefined ? `${node.label}, ${formatDuration(node.durationMs)}` : node.label;
  return `<li class="ph-pill ${state}"${current} title="${escapeHtml(title)}">${mark}<span class="ph-name">${label}<span class="sr-only"> (${PILL_WORD[state]})</span></span></li>`;
}

/**
 * The job page's progress row: a named pill for each step, in run order. Steps that run at the same time sit together
 * in one dashed group. A group that has not started is one quiet pill, so the row stays one line until it runs.
 */
function phaseChainHtml(job: JobView, started: ReadonlySet<string>, plan?: readonly (readonly string[])[]): string {
  const groups = phaseGroups(job, plan);
  if (groups.length === 0) return "";
  const items = groups.map((group) => {
    if (group.length === 1) return phasePillHtml(job, group[0] as PhaseNode, started);
    if (group.every((node) => node.status === "pending")) {
      const name = group.every((node) => isReviewStep(node.id)) ? "Reviews" : "In parallel";
      return `<li class="ph-pill upcoming" title="${escapeHtml(group.map((node) => node.label).join(", "))}"><span class="ph-dot" aria-hidden="true"></span><span class="ph-name">${name} <span class="ph-count">${group.length}</span><span class="sr-only"> (not started)</span></span></li>`;
    }
    return `<li class="ph-par" role="group" aria-label="Run at the same time" title="These run at the same time"><ol class="ph-parlist">${group.map((node) => phasePillHtml(job, node, started)).join("")}</ol></li>`;
  });
  return `<ol class="ph-chain">${items.join(`<li class="ph-sep" aria-hidden="true"></li>`)}</ol>`;
}

function progressRowHtml(job: JobView, started: ReadonlySet<string>, plan?: readonly (readonly string[])[]): string {
  const chain = phaseChainHtml(job, started, plan);
  if (!chain) return "";
  const focus = stepFocus(job);
  const outcome = focus?.kind === "outcome" ? `<p class="prog-outcome">${escapeHtml(focus.label)}</p>` : "";
  return `<section class="job-progress" aria-label="Progress">${chain}${outcome}</section>`;
}

function currentStepLabel(job: JobView): string | undefined {
  return job.steps.find((step) => step.status === "running")?.label ?? job.phases.find((phase) => phase.status === "running")?.label ?? job.currentPhase;
}

/** Same strip as showNow in assets/serve.js; change both together. */
function commandText(event: ActivityEvent | undefined): string {
  if (!event) return "";
  return event.summary.replace(/^Ran\s+/, "");
}

function nowCardHtml(job: JobView, feed: ActivityFeed, clock: BoardClock): string {
  const label = currentStepLabel(job);
  const at = job.lastActivityAt ?? job.stallActivityAt;
  const live = activityLiveness({
    column: job.column,
    ...(at ? { lastActivityAt: at } : {}),
    ...(clock.now !== undefined ? { now: clock.now } : {}),
    stallTimeoutMs: clock.stallTimeoutMs,
  });
  const liveness = live.liveness === "idle" ? "" : livenessHtml(live);
  const last = job.lastActivityAt ? `<span class="now-last">last activity ${timeHtml(job.lastActivityAt, "rel")}</span>` : "";
  const phase = feed.phase ?? job.phases.find((item) => item.status === "running")?.id;
  const command = [...feed.events].reverse().find((event) => event.kind === "command" && (!phase || event.phase === phase));
  const text = commandText(command);
  return `<section class="now-card" aria-label="Now" id="now">
<p class="now-head">${liveness}<span>Now, in ${escapeHtml(label ?? "this run")}</span>${last}</p>
<p class="now-note" id="now-note"${job.latestNote ? "" : " hidden"}>${escapeHtml(job.latestNote ?? "")}</p>
<code class="now-command" id="now-command"${text ? "" : " hidden"}>${escapeHtml(text)}</code>
</section>`;
}

const VERDICT_STEPS = ["approver", "security", "ux", "ui", "code"] as const;

function decisionCardHtml(job: BoardJob, csrf: string): string {
  const verdicts = VERDICT_STEPS.flatMap((id) => {
    const phase = job.phases.find((item) => item.id === id && item.verdict);
    return phase?.verdict ? [`<div><dt>${escapeHtml(phase.label)}</dt><dd>${escapeHtml(phase.verdict)}</dd></div>`] : [];
  });
  const list = verdicts.length > 0 ? `<dl class="verdicts">${verdicts.join("")}</dl>` : "";
  const id = encodeURIComponent(job.jobId);
  const forms = gateForms(job, id, csrf);
  const actions = forms.length > 0 ? `<div class="d-actions">${forms.join("")}</div>` : "";
  return `<section class="mid-card decision-card" aria-label="Your decision" id="decision">
<h2>Your decision</h2>
${list}${decisionBody(job)}${actions}
</section>`;
}

function failureCardHtml(job: BoardJob, csrf: string): string {
  const failed = [...job.phases].reverse().find((phase) => phase.status === "failed");
  const reason = `<p class="reason">${escapeHtml(job.reason)}</p>`;
  const tag = [job.failureClass, job.fingerprint].filter(Boolean).join(" · ");
  const klass = tag ? `<p class="meta mono">${escapeHtml(tag)}</p>` : "";
  const where = failed ? `<p class="meta">Failed in ${escapeHtml(failed.label)}</p>` : "";
  const detail = failed?.detail ? phaseDetailHtml(failed.detail) : "";
  const retry = job.retry ? `<div class="d-actions">${postForm(`/api/jobs/${encodeURIComponent(job.jobId)}/retry`, "retry", "Retry", csrf)}</div>` : "";
  return `<section class="mid-card failure-card" aria-label="What went wrong" id="failure">
<h2>What went wrong</h2>
${reason}${klass}${where}${detail}${retry}
</section>`;
}

function stepSectionsHtml(job: JobView, feed: ActivityFeed, clock: BoardClock): string {
  // Open the current step only while a run is live (see runningPhaseId).
  const openId = runningPhaseId(job, feed);
  const startedIds = startedPhaseIds(job, feed);
  const firstOutput = (id: string) => feed.events.find((event) => event.phase === id)?.at;
  const startOf = (phase: PhaseView) => {
    const at = Date.parse(phase.startedAt ?? firstOutput(phase.id) ?? "");
    return Number.isFinite(at) ? at : phase.id === openId ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  };
  const ran = job.phases.filter((phase) => startedIds.has(phase.id));
  // A finished job's cards are for steps that did agent work. The rest (Land, Your decision) stay in the step track.
  const worked = job.finished ? ran.filter((phase) => hasUsage(phase) || phase.verdict) : ran;
  const started = (worked.length > 0 ? worked : ran).sort((left, right) => startOf(right) - startOf(left));
  const sections = started.map((phase) => stepSectionHtml(job, phase, feed, clock, phase.id === openId)).join("");
  const body = sections || `<p class="empty">No step has started yet.</p>`;
  const phase = openId ?? feed.phase;
  return liveRootHtml("step-sections", { running: Boolean(openId) && feed.running, cursor: feed.cursor, ...(phase ? { phase } : {}) }, body);
}

/**
 * The `#live` wrapper `startLive` in assets/serve.js reads. The job page and the step page both use it.
 * `pin` keeps the step page on its step: an event from another phase is dropped instead of reloading.
 */
function liveRootHtml(cls: string, live: { running: boolean; cursor: string; phase?: string; pin?: boolean }, body: string): string {
  const phaseAttr = live.phase ? ` data-phase="${escapeHtml(live.phase)}"` : "";
  const pin = live.pin ? ` data-pin="true"` : "";
  return `<div class="${cls}" id="live" data-running="${live.running ? "true" : "false"}" data-cursor="${escapeHtml(live.cursor)}"${phaseAttr}${pin}>
<p class="field-error" id="live-error" role="alert" hidden></p>
${body}
</div>`;
}

/** One step's scrolling, following activity log and its follow bar. The job page's open step and the step page share it. */
function liveFeedHtml(label: string, events: readonly ActivityEvent[]): string {
  const items = events.length > 0 ? events.map((event) => eventHtml(event)).join("") : `<li class="empty">No session output yet.</li>`;
  return `<ol id="live-feed" class="activity" tabindex="0" aria-label="${escapeHtml(label)} activity, scrolls">${items}</ol>
<div class="follow-bar"><span id="follow-status" role="status">Following the latest line</span><button type="button" class="btn" id="jump-latest">Jump to latest</button><button type="button" class="btn" id="expand-log" aria-pressed="false" aria-controls="live-feed">Expand</button></div>`;
}

function stepHref(job: JobView, stepId: string): string {
  return `/jobs/${encodeURIComponent(job.jobId)}/steps/${encodeURIComponent(stepId)}`;
}

/** Round, then running Nm, done in, failed after, or skipped. */
function stepStateBits(phase: PhaseView, clock: BoardClock, open: boolean): string[] {
  const bits: string[] = [];
  if (phase.iteration !== undefined) bits.push(`round ${phase.iteration}`);
  if (open && phase.startedAt) {
    const ms = (clock.now ?? Date.now()) - Date.parse(phase.startedAt);
    bits.push(Number.isFinite(ms) && ms >= 0 ? `running ${formatDuration(ms)}` : "running");
  } else if (open) {
    bits.push("running");
  } else if (phase.status === "failed") {
    bits.push(phase.durationMs !== undefined ? `failed after ${formatDuration(phase.durationMs)}` : "failed");
  } else if (phase.status === "skipped") {
    bits.push("skipped");
  } else if (phase.durationMs !== undefined) {
    bits.push(`done in ${formatDuration(phase.durationMs)}`);
  }
  return bits;
}

function stepSectionHtml(job: JobView, phase: PhaseView, feed: ActivityFeed, clock: BoardClock, open: boolean): string {
  const events = feed.events.filter((event) => event.phase === phase.id);
  const commands = events.filter((event) => event.kind === "command").length;
  const bits = stepStateBits(phase, clock, open && Boolean(phase.startedAt));
  bits.push(commands === 1 ? "1 command" : `${commands} commands`);
  if (hasUsage(phase)) bits.push(formatStepUsage(phase));
  const headId = `step-${escapeHtml(phase.id)}`;
  // fix-N and other phases outside the workflow's leaf plan have no step page.
  const title = job.steps.some((step) => step.id === phase.id)
    ? `<a href="${stepHref(job, phase.id)}">${escapeHtml(phase.label)}</a>`
    : escapeHtml(phase.label);
  const verdict = phase.verdict ? `<span class="verdict">${escapeHtml(phase.verdict)}</span>` : "";
  const line = `<span class="meta">${escapeHtml(bits.join(", "))}</span>`;
  if (open) {
    return `<section class="step-section open" aria-labelledby="${headId}" data-phase="${escapeHtml(phase.id)}">
<header class="step-head"><h2 id="${headId}">${title}</h2>${line}</header>
${liveFeedHtml(phase.label, events)}
</section>`;
  }
  const output = producedLink(job, phase);
  const shown = events.length > 0
    ? `<details class="step-activity"><summary>Show activity</summary><ol class="activity">${events.map((event) => eventHtml(event)).join("")}</ol></details>`
    : "";
  return `<section class="step-section" aria-labelledby="${headId}" data-phase="${escapeHtml(phase.id)}">
<header class="step-head"><h2 id="${headId}">${title}</h2>${line}${verdict}${output}</header>
${shown}
</section>`;
}

/** The step has a usage entry: it is an agent step that has run. */
function hasUsage(phase: PhaseView): boolean {
  return phase.status !== "pending" && (phase.model !== undefined || phase.costUsd !== undefined || phase.tokens !== undefined);
}

function producedLink(job: JobView, phase: PhaseView): string {
  const id = encodeURIComponent(job.jobId);
  if (phase.id === "spec" && job.spec) return `<a href="/jobs/${id}/spec">Read the spec</a>`;
  if ((REVIEW_IDS as readonly string[]).includes(phase.id) && job.findings) return `<a href="/jobs/${id}/findings">Read the findings</a>`;
  if (phase.id === "build" || phase.id === "fix" || phase.id === "draft") return `<a href="#changes">See the changes</a>`;
  return "";
}

const REVIEW_IDS = ["security", "ux", "ui", "code", "approver"] as const;

function nextSentence(job: JobView): string {
  if (job.finished) return "Nothing. This job is finished.";
  const left = progressSegments(job).filter((segment) => segment.status === "pending").map((segment) => segment.label);
  if (left.length === 0) return "No steps left after this one.";
  return `${left.join(", then ")}.`;
}

/** The label a step shows in the step track, else the artifact's name made readable. */
function artifactLabel(job: JobView, entry: ArtifactEntry): string {
  if (entry.kind === "ask") return "The ask";
  const step = job.steps.find((item) => item.id === entry.stepId) ?? job.phases.find((item) => item.id === entry.stepId);
  if (step?.label) return step.label;
  const name = entry.stepId.replace(/[-_]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function artifactEntryHtml(job: JobView, entry: ArtifactEntry, open: boolean): string {
  const label = escapeHtml(artifactLabel(job, entry));
  const detail = entry.detail ? ` <span class="art-detail">${escapeHtml(entry.detail)}</span>` : "";
  const body = entry.format === "markdown" ? `<div class="art-md">${renderMarkdown(entry.body)}</div>` : `<pre class="art-text">${escapeHtml(entry.body)}</pre>`;
  return `<details class="art"${open ? " open" : ""}><summary><span class="art-head"><span class="art-name">${label}</span><span class="art-chip ${entry.tone}">${escapeHtml(entry.chip)}${detail}</span></span><span class="art-line">${escapeHtml(entry.preview)}</span></summary><div class="art-body">${body}</div></details>`;
}

/** What went wrong in a round, in a few words: `Verify failed and Code asked for changes`, else `All passed`. */
function roundRollup(job: JobView, entries: readonly ArtifactEntry[]): { text: string; tone: string } {
  const bad = entries.filter((entry) => entry.tone === "bad").map((entry) => `${artifactLabel(job, entry)} failed`);
  const warn = entries.filter((entry) => entry.tone === "warn").map((entry) => `${artifactLabel(job, entry)} asked for changes`);
  const issues = [...bad, ...warn];
  if (issues.length > 0) return { text: issues.slice(0, 2).join(" and ") + (issues.length > 2 ? " and more" : ""), tone: bad.length > 0 ? "bad" : "warn" };
  if (entries.some((entry) => entry.tone === "pass")) return { text: "All passed", tone: "pass" };
  return { text: "", tone: "neutral" };
}

/**
 * The Artifacts column: the ask and spec, the net diff, then each round with what its steps produced. It shows
 * only what exists, because the workflow decides which steps and artifacts there are.
 */
function artifactsHtml(job: JobView, set: ArtifactSet, files: readonly DiffFile[]): string {
  const sections: string[] = [];
  if (set.start.length > 0) {
    const head = set.rounds.length > 0 ? `<h3 class="art-group">Start</h3>` : "";
    sections.push(`<section class="art-section">${head}${set.start.map((entry) => artifactEntryHtml(job, entry, false)).join("")}</section>`);
  }
  if (files.length > 0) {
    const added = files.reduce((total, file) => total + file.added, 0);
    const removed = files.reduce((total, file) => total + file.removed, 0);
    const list = `<ul class="file-list">${files
      .map((file) => `<li><span class="mono file-path">${escapeHtml(file.path)}</span><span class="mono file-count">+${file.added} -${file.removed}</span></li>`)
      .join("")}</ul><a href="#changes">Open the diff</a>`;
    const chip = `<span class="art-chip neutral"><span class="added">+${added}</span> <span class="removed">-${removed}</span> <span class="art-detail">in ${files.length} ${files.length === 1 ? "file" : "files"}</span></span>`;
    const preview = files.slice(0, 3).map((file) => file.path).join(", ");
    sections.push(`<section class="art-section"><h3 class="art-group">Changes</h3><details class="art"><summary><span class="art-head"><span class="art-name">Files changed</span>${chip}</span><span class="art-line">${escapeHtml(preview)}</span></summary><div class="art-body">${list}<p class="meta">The net result after every round, compared with the base.</p></div></details></section>`);
  }
  for (const round of set.rounds) {
    const roll = roundRollup(job, round.entries);
    const rollHtml = roll.text ? `<span class="art-chip ${roll.tone}">${escapeHtml(roll.text)}</span>` : "";
    const tag = round.latest ? ` <span class="art-tag">latest</span>` : "";
    const entries = round.entries
      .map((entry) => artifactEntryHtml(job, entry, entry.tone === "bad" || entry.tone === "warn" || (round.latest && entry.kind === "approver")))
      .join("");
    sections.push(`<details class="art-round"${round.latest ? " open" : ""}><summary class="art-group"><span>Round ${round.round}${tag}</span>${rollHtml}</summary>${entries}</details>`);
  }
  if (sections.length === 0) return "";
  return `<section class="artifacts" aria-label="Artifacts"><header><h2>Artifacts</h2><p class="meta">Each step's output, grouped by round. Open one to read it here.</p></header>${sections.join("")}</section>`;
}

function sideHtml(detail: JobDetail, artifacts: ArtifactSet = EMPTY_ARTIFACTS): string {
  const job = detail.job;
  const id = encodeURIComponent(job.jobId);
  const files = detail.changes.files ?? [];
  const links: string[] = [];
  if (job.spec) links.push(fileLink(`/jobs/${id}/spec`, "file-text", "Spec"));
  if (job.log) links.push(fileLink(`/jobs/${id}/log`, "scroll-text", "Raw log"));
  if (job.findings) links.push(fileLink(`/jobs/${id}/findings`, "list-checks", "Findings"));
  links.push(fileLink("#timeline", "history", "Event history"));
  const rail = detail.rail;
  const rows: string[] = [];
  const row = (label: string, value: string) => rows.push(`<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`);
  if (rail.issue) row("Issue", `<span class="mono">${escapeHtml(rail.issue)}</span>`);
  if (rail.ci) row("CI", escapeHtml(rail.ci));
  if (rail.risk) row("Risk", escapeHtml(rail.risk));
  if (rail.fixRounds.used > 0) row("Fix rounds", escapeHtml(`${rail.fixRounds.used} / ${rail.fixRounds.cap}`));
  if (!job.finished && (rail.failureClass || rail.fingerprint)) row("Failure", escapeHtml([rail.failureClass, rail.fingerprint].filter(Boolean).join(" · ")));
  const facts = rows.length > 0 ? `<dl class="side-facts">${rows.join("")}</dl>` : "";
  return `<aside class="job-side" aria-label="Job facts">
${artifactsHtml(job, artifacts, files)}
<section class="side-card"><h2>What happens next</h2><p>${escapeHtml(nextSentence(job))}</p></section>
<p class="links side-links">${links.join("")}</p>
${facts}
</aside>`;
}

function eventHtml(event: ActivityEvent): string {
  const summary = escapeHtml(event.summary);
  const body = event.detail
    ? `<button type="button" class="live-summary" aria-expanded="false" data-summary="${summary}" data-detail="${escapeHtml(event.detail)}">${summary}</button>`
    : `<span class="live-summary">${summary}</span>`;
  return `<li class="live-event ${escapeHtml(event.kind)}" data-kind="${escapeHtml(event.kind)}" data-summary="${summary}">${timeHtml(event.at, "clock")}${body}</li>`;
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
  const unavailable = changes.changesUnavailable ? `<p class="empty">${escapeHtml(changes.changesUnavailable)}</p>` : "";
  const commits =
    changes.commits.length === 0
      ? unavailable || `<p class="empty">No commits read for this branch.</p>`
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
  const workflowRows = tableRows(
    stats.costByWorkflow.map((row) => [row.workflow, formatDollars(row.usd)]),
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
  return `<header class="list-head"><h2>Stats</h2><nav class="range-links" aria-label="Window">${windows}</nav><p class="meta">Since ${timeHtml(stats.since, "local")}</p></header>
<div class="stat-grid">
<section class="stat"><h3>Spend</h3><p class="stat-num">${escapeHtml(formatDollars(stats.spend.usd))}</p><p class="meta">Today ${escapeHtml(stats.spend.day)} / ${escapeHtml(cap)}</p><p class="meta">This window ${escapeHtml(formatDollars(stats.windowUsd))}</p></section>
<section class="stat"><h3>Runs</h3><p class="stat-num">${stats.runs.finished}</p><p class="meta">${stats.runs.started} started · ${stats.runs.finished} finished · ${stats.runs.failed} failed</p>${classRows}</section>
<section class="stat"><h3>Interventions</h3>${interventions}</section>
</div>
<section class="stat"><h3>Cost by repo</h3>${repoRows}</section>
<section class="stat"><h3>Cost by workflow</h3>${workflowRows}</section>`;
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

function settingsNav(active: SettingsSectionId, facts: SettingsFacts): string {
  const links = SETTINGS_SECTIONS.map(({ id, title }) => {
    const current = id === active ? ` aria-current="page"` : "";
    return `<a href="/settings/${id}"${current}><span>${escapeHtml(title)}</span>${settingsFact(id, facts)}</a>`;
  }).join("");
  return `<nav class="settings-nav" id="settings-nav" aria-label="Settings sections">${links}</nav>`;
}

function settingsFact(id: SettingsSectionId, facts: SettingsFacts): string {
  if (id === "repos" || id === "triggers") {
    const value = facts[id];
    return `<span class="settings-fact" data-settings-fact="${id}">${value === undefined ? "" : String(value)}</span>`;
  }
  if (id === "jira") {
    const state = facts.jira === "connected" ? ` data-state="connected"` : "";
    return `<span class="settings-fact" data-settings-fact="jira"${state}>${facts.jira ?? ""}</span>`;
  }
  return "";
}

interface SettingRow {
  /** The control's id. The explanation, error, and warning ids derive from it. */
  id: string;
  label: string;
  /** One line on what the setting does and what blank means. Trusted markup. */
  explain: string;
  /** `data-error` key for server validation errors. */
  error: string;
  /** Add a warning slot the script fills when the saved value is a problem. */
  warn?: boolean;
  /** A second muted line, such as how to fill the control. */
  hint?: string;
  /**
   * The control is a group (a `.seg`), which a `<label for>` cannot name. The
   * label is then a `<p id="<id>-label">` the group names with `aria-labelledby`.
   */
  group?: boolean;
  /** Control markup, given the `aria-describedby` value to put on it. */
  control: (describedBy: string) => string;
}

/** A setting row: label, one line of explanation, warning and error slots, then the control. */
function settingRow(row: SettingRow): string {
  const ids = [`${row.id}-explain`, ...(row.hint ? [`${row.id}-hint`] : []), ...(row.warn ? [`${row.id}-warn`] : []), `${row.id}-error`];
  return `<div class="setting-row">
<div class="setting-text">${row.group ? `<p class="setting-label" id="${row.id}-label">${escapeHtml(row.label)}</p>` : `<label class="setting-label" for="${row.id}">${escapeHtml(row.label)}</label>`}
<p class="setting-explain" id="${row.id}-explain">${row.explain}</p>${row.hint ? `
<p class="setting-explain" id="${row.id}-hint">${escapeHtml(row.hint)}</p>` : ""}${row.warn ? `
<div class="setting-warn" id="${row.id}-warn" hidden></div>` : ""}
<p class="field-error" id="${row.id}-error" data-error="${row.error}" hidden></p></div>
<div class="setting-control">${row.control(ids.join(" "))}</div>
</div>`;
}

/** Section heading and one line on what it holds. */
function settingsPane(id: SettingsSectionId, active: SettingsSectionId, description: string, body: string, extraClass = "", action = ""): string {
  const title = SETTINGS_SECTIONS.find((section) => section.id === id)?.title ?? id;
  const hidden = id === active ? "" : " hidden";
  const cls = extraClass ? `settings-pane ${extraClass}` : "settings-pane";
  const head = `<header class="settings-pane-head"><h2 id="settings-${id}-title">${escapeHtml(title)}</h2><p class="meta">${escapeHtml(description)}</p></header>`;
  const top = action ? `<div class="settings-pane-top">${head}${action}</div>` : head;
  return `<section class="${cls}" id="settings-${id}" aria-labelledby="settings-${id}-title"${hidden}>
${top}
${body}</section>`;
}

function settingsForm(theme: BoardThemeId, active: SettingsSectionId, facts: SettingsFacts): string {
  const panes = [
    settingsPane(
      "repos",
      active,
      "Checkouts Kiln may run jobs in. A job works in its own worktree and leaves your files alone.",
      `<div class="repo-table-wrap">
<table class="repo-table">
<thead><tr><th scope="col">Name</th><th scope="col">Delivers as</th><th scope="col">Test command</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
<tbody id="repo-list"></tbody>
</table>
</div>
<div id="repo-editor" class="repo-editor" hidden>
<div class="repo-editor-head" id="repo-editor-head"><h3 id="repo-editor-title"></h3><span class="repo-editor-path" id="repo-editor-path"></span></div>
<div class="repo-ident" data-repo-ident="name"><label class="field"><span class="k">Name</span><input id="repo-name" type="text" autocomplete="off" spellcheck="false"></label>
<p class="field-error" data-error="name" hidden></p></div>
<div class="repo-ident" data-repo-ident="path"><div class="field"><span class="k">Path</span><div class="path-row"><input id="repo-path" type="text" autocomplete="off" spellcheck="false" placeholder="~/code/web" aria-label="Path"><button type="button" class="pick" id="repo-browse">Browse</button></div></div>
<div class="fs" id="repo-browser" hidden></div>
<p class="field-error" data-error="path" hidden></p></div>
<div class="repo-grid">
<div class="field"><label class="k" for="repo-test">Test command</label><input id="repo-test" type="text" autocomplete="off" spellcheck="false" placeholder="npm test" aria-describedby="hint-repo-test">
<p class="hint" id="hint-repo-test">Runs in the job's worktree after each build.</p>
<p class="field-error" data-error="test" hidden></p></div>
<div class="field" id="repo-base-field"><label class="k" for="repo-base">Base branch</label><input id="repo-base" type="text" autocomplete="off" spellcheck="false" placeholder="main" aria-describedby="hint-repo-base">
<p class="hint" id="hint-repo-base">Pull requests target this branch.</p>
<p class="field-error" data-error="base" hidden></p></div>
</div>
<fieldset id="repo-deliver" class="field repo-deliver"><legend class="k">When a job is approved</legend>
<div class="repo-choices">
<label class="repo-choice"><input type="radio" name="repo-deliver" value="pr"><span><span class="repo-choice-title">Open a draft pull request</span><span class="repo-choice-note">Kiln pushes the branch. You merge.</span></span></label>
<label class="repo-choice"><input type="radio" name="repo-deliver" value="local" checked><span><span class="repo-choice-title">Keep a local branch</span><span class="repo-choice-note">Nothing is pushed.</span></span></label>
</div>
<p class="field-error" data-error="deliver" hidden></p>
</fieldset>
<details class="repo-more" id="repo-more">
<summary>Naming and limits for this repo</summary>
<p class="hint">Pull request title, branch name, attempts, and fix rounds. Each falls back to the global setting.</p>
<div class="repo-grid">
<div class="field"><label class="k" for="repo-pr-title">Pull request title template</label><input id="repo-pr-title" type="text" autocomplete="off" spellcheck="false" aria-describedby="hint-pr-title">
<p class="hint" id="hint-pr-title">Empty uses the default, [{issue}] {title}, which renders as [ABC-123] Title. {type} fills in feat, fix, and so on from the approver, for example {type}: {title}.</p>
<p class="field-error" data-error="prTitle" hidden></p></div>
<div class="field"><label class="k" for="repo-branch">Branch name template</label><input id="repo-branch" type="text" autocomplete="off" spellcheck="false" aria-describedby="hint-branch">
<p class="hint" id="hint-branch">Empty uses the default, {issue}-{slug}, which renders as ABC-123-slug.</p>
<p class="field-error" data-error="branch" hidden></p></div>
<div class="field"><label class="k" for="repo-max-attempts">Max attempts</label><input id="repo-max-attempts" type="number" min="1" step="1" aria-describedby="hint-repo-attempts">
<p class="hint" id="hint-repo-attempts">Empty uses the global setting.</p>
<p class="field-error" data-error="repoAttempts" hidden></p></div>
<div class="field"><label class="k" for="repo-max-fix-rounds">Max fix rounds</label><input id="repo-max-fix-rounds" type="number" min="1" step="1" aria-describedby="hint-repo-rounds">
<p class="hint" id="hint-repo-rounds">Empty uses the global setting.</p>
<p class="field-error" data-error="repoRounds" hidden></p></div>
</div>
</details>
<div class="repo-editor-foot">
<button type="button" class="repo-remove" id="repo-remove">Remove repo</button>
<div class="repo-remove-confirm" id="repo-remove-confirm" role="group" aria-labelledby="repo-remove-text" hidden><span id="repo-remove-text"></span><button type="button" class="repo-remove" id="repo-remove-yes">Remove</button><button type="button" id="repo-remove-keep">Keep</button></div>
<button type="button" id="repo-done">Done</button>
</div>
</div>`,
      "",
      `<button type="button" class="btn" id="repo-add">Add repo</button>`,
    ),
    settingsPane(
      "limits",
      active,
      "How many jobs run, how much they may spend, and when Kiln stops retrying.",
      `<div class="setting-rows">
${settingRow({
  id: "max-concurrent",
  label: "Jobs at once",
  explain: "How many jobs may run at the same time.",
  error: "maxConcurrent",
  control: (describedBy) => `<input id="max-concurrent" type="number" min="1" step="1" aria-describedby="${describedBy}">`,
})}
${settingRow({
  id: "daily-dollar-cap",
  label: "Daily spending cap",
  explain: `No new job starts once today's cost reaches this. Blank means no cap. <span id="daily-dollar-cap-spent"></span>`,
  error: "dailyDollarCap",
  control: (describedBy) =>
    `<div class="setting-unit"><span class="setting-affix">$</span><input id="daily-dollar-cap" type="number" min="0" step="0.01" placeholder="no cap" aria-describedby="${describedBy}"></div>`,
})}
${settingRow({
  id: "stall-timeout",
  label: "Stop a silent run after",
  explain: "A run that prints nothing for this long is stopped and retried. 0 turns this off.",
  error: "stallTimeoutMs",
  warn: true,
  control: (describedBy) =>
    `<div class="setting-unit"><input id="stall-timeout" type="number" min="0" step="any" aria-describedby="${describedBy} stall-timeout-unit"><span class="setting-affix" id="stall-timeout-unit">minutes</span></div>`,
})}
${settingRow({
  id: "max-attempts",
  label: "Attempts per job",
  explain: "A crashed or stalled run is retried up to this many times, then waits for you.",
  error: "maxAttempts",
  control: (describedBy) => `<input id="max-attempts" type="number" min="1" step="1" aria-describedby="${describedBy}">`,
})}
${settingRow({
  id: "max-same-fingerprint",
  label: "Stop after the same failure",
  explain: "A job waits for you after this many times in a row with an identical error.",
  error: "maxSameFingerprint",
  control: (describedBy) =>
    `<div class="setting-unit"><input id="max-same-fingerprint" type="number" min="1" step="1" aria-describedby="${describedBy} max-same-fingerprint-unit"><span class="setting-affix" id="max-same-fingerprint-unit">times</span></div>`,
})}
${settingRow({
  id: "max-fix-rounds",
  label: "Fix rounds on a pull request",
  explain: "How many times Kiln answers failed checks or review comments before it stops.",
  error: "maxFixRounds",
  control: (describedBy) => `<input id="max-fix-rounds" type="number" min="1" step="1" aria-describedby="${describedBy}">`,
})}
${settingRow({
  id: "adapter-mode",
  label: "Agent",
  explain: "What runs each agent step. Mock makes no model calls and is for testing Kiln.",
  error: "adapter",
  group: true,
  control: (describedBy) => `<div class="seg" id="adapter-mode" role="group" aria-labelledby="adapter-mode-label" aria-describedby="${describedBy}">
<button type="button" data-adapter="claude-code" aria-pressed="true">Claude Code</button>
<button type="button" data-adapter="mock" aria-pressed="false">Mock (no model calls, for testing)</button>
</div>`,
})}
${settingRow({
  id: "keep-worktrees",
  label: "Keep finished worktrees",
  explain: "Off: Kiln removes a finished run's worktree. On: only <code>kiln clean --apply</code> removes them.",
  error: "keepWorktrees",
  control: (describedBy) => `<input id="keep-worktrees" type="checkbox" aria-describedby="${describedBy}">`,
})}
</div>`,
    ),
    settingsPane(
      "sandbox",
      active,
      "Whether agent steps run in a container, and which sites they may reach.",
      `<div class="setting-rows">
${settingRow({
  id: "sandbox-mode",
  label: "Run agents in Docker",
  explain: "Each agent step runs in a container that can reach only the sites below.",
  error: "sandbox.mode",
  warn: true,
  control: (describedBy) =>
    `<button type="button" class="switch" id="sandbox-mode" role="switch" aria-checked="false" aria-describedby="${describedBy} sandbox-check"><span class="switch-knob" aria-hidden="true"></span></button>`,
})}
${settingRow({
  id: "sandbox-domains",
  label: "Sites agents may reach",
  explain: "Used only when the sandbox is on. Blank uses the default list: the Anthropic API, npm, and GitHub.",
  error: "sandbox.allowDomains",
  hint: "One host per line.",
  control: (describedBy) =>
    `<textarea id="sandbox-domains" rows="4" spellcheck="false" placeholder="${DEFAULT_SANDBOX_DOMAINS.map(escapeHtml).join("&#10;")}" aria-describedby="${describedBy}"></textarea>
<button type="button" class="btn setting-reset" id="sandbox-domains-reset" data-default-domains="${escapeHtml(DEFAULT_SANDBOX_DOMAINS.join(" "))}">Reset to default list</button>`,
})}
</div>
<div class="setting-warn setting-check" id="sandbox-check" role="status" hidden></div>`,
    ),
    settingsPane(
      "triggers",
      active,
      "What starts work on its own, and where that work goes.",
      `<div id="trigger-editor" hidden>
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
<h3>Routes</h3>
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
<div class="d-actions"><button type="button" data-row-add="routes">Add route</button></div>`,
    ),
    settingsPane(
      "jira",
      active,
      "The Jira site Kiln reads issues from.",
      `<div class="field"><label class="k" for="jira-base">Base URL</label><input id="jira-base" type="text" autocomplete="off" spellcheck="false" placeholder="https://example.atlassian.net">
<p class="field-error" data-error="jira.baseUrl" hidden></p></div>
<div class="field"><label class="k" for="jira-email">Email</label><input id="jira-email" type="text" autocomplete="off" spellcheck="false" placeholder="dev@example.com">
<p class="field-error" data-error="jira.email" hidden></p></div>
<div class="field"><label class="k" for="jira-acceptance">Acceptance field</label><input id="jira-acceptance" type="text" autocomplete="off" spellcheck="false" placeholder="customfield_10001">
<p class="hint">Optional. When set, Kiln reads acceptance criteria from this field. Empty uses the Jira field named Acceptance criteria.</p>
<p class="field-error" data-error="jira.acceptanceField" hidden></p></div>
<div class="field"><span class="k">API token</span><p class="meta" id="jira-token">not set</p>
<p class="hint">Set JIRA_API_TOKEN in the environment. This page does not store a token.</p>
<p class="field-error" data-error="jira.apiToken" hidden></p></div>`,
      "stack",
    ),
    settingsPane(
      "workflows",
      active,
      "Your own workflows, prompts, and skills. Agents get skills only from here.",
      `<div class="setting-rows">
${settingRow({
  id: "overlay-workflows",
  label: "Local workflows",
  explain: "A folder of your own workflow files. Blank uses the Kiln home <code>workflows</code> folder.",
  error: "overlay.workflows",
  control: (describedBy) =>
    `<input id="overlay-workflows" type="text" autocomplete="off" spellcheck="false" placeholder="workflows" aria-describedby="${describedBy}">`,
})}
${settingRow({
  id: "overlay-prompts",
  label: "Prompt overrides",
  explain: "A folder of prompt files that replace the shipped ones. Blank uses the Kiln home <code>prompts</code> folder.",
  error: "overlay.prompts",
  control: (describedBy) =>
    `<input id="overlay-prompts" type="text" autocomplete="off" spellcheck="false" placeholder="prompts" aria-describedby="${describedBy}">`,
})}
${settingRow({
  id: "overlay-skills",
  label: "Skills folder",
  explain: "A folder holding one folder per skill, each with a <code>SKILL.md</code>. Blank uses the Kiln home <code>skills</code> folder.",
  error: "overlay.skills",
  warn: true,
  control: (describedBy) =>
    `<input id="overlay-skills" type="text" autocomplete="off" spellcheck="false" placeholder="skills" aria-describedby="${describedBy}">`,
})}
${settingRow({
  id: "overlay-skill-paths",
  label: "More skill folders",
  explain: "Agents do not see your Claude Code plugins or skills. List a plugin's <code>skills</code> folder here to give agents that skill.",
  error: "overlay.skillPaths",
  warn: true,
  control: (describedBy) =>
    `<textarea id="overlay-skill-paths" rows="3" spellcheck="false" placeholder="~/skills" aria-describedby="${describedBy}"></textarea>`,
  hint: "One folder per line.",
})}
<div class="setting-row">
<div class="setting-text"><p class="setting-label" id="overlay-skill-names-label">Skills agents will see</p>
<p class="setting-explain">From the saved folders. Save to check new ones.</p></div>
<div class="setting-control" id="overlay-skill-names" role="region" aria-labelledby="overlay-skill-names-label" aria-live="polite"></div>
</div>
</div>`,
    ),
    settingsPane("appearance", active, "How this board looks.", `<p class="hint">Color palette for this board. The choice applies immediately and is saved here.</p>
${themePicker(theme)}
<p class="field-error" data-error="board.theme" hidden></p>`),
    settingsPane(
      "file",
      active,
      "The whole config file as JSON.",
      `<label class="field"><span class="k">kiln.config.json</span><textarea id="settings-json" rows="18" spellcheck="false" aria-describedby="advanced-hint advanced-errors"></textarea></label>
<p class="hint" id="advanced-hint">Saving this section writes the JSON below. A secret is shown as ${escapeHtml(SECRET_PLACEHOLDER)}. Saving that placeholder keeps the current value. Set JIRA_API_TOKEN in the environment. Invalid JSON is not written.</p>
<p class="field-error" id="advanced-errors" data-error="file" hidden></p>`,
    ),
  ];
  return `<form id="settings-form" class="intake-form settings-form">
<div class="settings-layout">
${settingsNav(active, facts)}
${panes.join("\n")}
</div>
<div class="settings-foot">
<p class="form-error" id="settings-error" role="alert" hidden></p>
<p class="saved" id="settings-saved" role="status" hidden>Saved</p>
<div class="settings-unsaved" id="settings-unsaved" role="status" hidden>
<p class="settings-unsaved-text"><span class="settings-unsaved-count" id="settings-unsaved-count"></span><span class="settings-unsaved-list" id="settings-unsaved-list"></span></p>
<button type="button" class="btn" id="settings-discard">Discard</button>
<button type="submit" class="btn primary" id="settings-save">Save changes</button>
</div>
</div>
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
${options.live ? `<script>try{if(localStorage.getItem("kiln-nav")==="collapsed")document.documentElement.setAttribute("data-nav","collapsed")}catch(e){}</script>` : ""}
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
