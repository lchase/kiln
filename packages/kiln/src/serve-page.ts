import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionView } from "./attention.js";
import {
  buildBoard,
  type BoardDocument,
  type BoardJob,
  type DayReport,
  type JobDetail,
  type PhaseCard,
  type StatsDocument,
} from "./board-view.js";
import { packageRoot } from "./paths.js";
import type { StatusJobView } from "./report.js";
import { formatSpend, type SpendSnapshot } from "./rails.js";
import { listWorkflowNames } from "./workflow.js";

export interface ServeRepoOption {
  name: string;
  path: string;
}

export type AppSection = "inbox" | "hand" | "repos" | "history" | "stats" | "report" | "settings" | "job";

export interface ServePageOptions {
  csrf: string;
  repos: ServeRepoOption[];
  workflows: string[];
  configError?: string;
  paused?: boolean;
  spend?: SpendSnapshot;
  /** Which list `renderConsole` draws. The serve shell passes this through `renderApp`. */
  section?: "inbox" | "hand" | "repos" | "history";
  repo?: string;
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
  tab?: "overview" | "changes" | "timeline";
}

const LIVE_SCRIPT = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

function kilnVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

const VERSION = kilnVersion();

export function renderConsole(css: string, attention: AttentionView, page?: ServePageOptions): string {
  const jobs = [...attention.needsYou, ...attention.inFlight, ...attention.doneRecently].map((item) => item.job);
  const board = buildBoard(jobs, []);
  const section = page?.section ?? "inbox";
  return renderApp({ css, section, board, attention, ...(page ? { page, ...(page.repo ? { repo: page.repo } : {}) } : {}) });
}

export function renderApp(model: AppModel): string {
  const page = model.page ?? { csrf: "", repos: [], workflows: listWorkflowNames() };
  const paused = page.paused === true;
  const version = VERSION ? `<span class="ver">v${escapeHtml(VERSION)}</span>` : "";
  const spend = page.spend ? `<span class="spend" id="spend">${escapeHtml(formatSpend(page.spend))}</span>` : `<span class="spend" id="spend"></span>`;
  const capNote = page.spend?.blocked ? `<span class="cap" id="cap-note">cap hit</span>` : `<span class="cap" id="cap-note" hidden>cap hit</span>`;
  const body = `<div class="shell">
<aside class="nav" aria-label="Kiln">
<div class="brand"><span class="logo" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V6l5-3 5 3v6l-5 3-5-3z"/><path d="M3 6l5 3 5-3M8 9v6"/></svg></span><div><h1>Kiln</h1>${version}</div></div>
<div class="runstate" id="runstate">
<span class="live-dot${paused ? " paused" : ""}" id="run-dot" aria-hidden="true"></span>
<span id="run-label">${paused ? "Paused" : "Running"}</span>
<form method="post" action="${paused ? "/api/resume" : "/api/pause"}" class="pause" id="pause-form"><input type="hidden" name="csrf" value="${escapeHtml(page.csrf)}"><button type="submit" id="pause-toggle" aria-pressed="${paused ? "true" : "false"}">${paused ? "Resume" : "Pause"}</button></form>
</div>
${spend}${capNote}
${navHtml(model)}
<button class="add" type="button" id="add-job">Add job</button>
<button class="tool-link" type="button" id="notify">Notify me</button>
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
    ...(job ? { jobId: job.jobId, latest: job.latestEventAt } : {}),
    live: true,
    body,
  });
}

export function renderTextPage(css: string, title: string, text: string): string {
  return document({
    css,
    title,
    needsYou: 0,
    revision: "",
    section: "job",
    live: false,
    body: `<a class="back" href="/">Inbox</a>
<div class="page"><h1>${escapeHtml(title)}</h1>
<pre class="text">${escapeHtml(text)}</pre></div>`,
  });
}

export function renderMessagePage(css: string, title: string, message: string): string {
  return document({
    css,
    title,
    needsYou: 0,
    revision: "",
    section: "job",
    live: false,
    body: `<a class="back" href="/">Inbox</a>
<div class="page"><h1>${escapeHtml(title)}</h1>
<p class="empty">${escapeHtml(message)}</p></div>`,
  });
}

function navHtml(model: AppModel): string {
  const board = model.board;
  const item = (href: string, id: string, label: string, section: AppSection, badge?: number) => {
    const current = model.section === section ? ` aria-current="page"` : "";
    const count = badge !== undefined && badge > 0 ? `<span class="badge">${badge}</span>` : "";
    const extra = id === "open-settings" ? ` id="open-settings"` : "";
    return `<a class="nav-link" href="${href}"${current}${extra}>${escapeHtml(label)}${count}</a>`;
  };
  const repos = board.repos
    .map((group) => {
      const current = model.section === "repos" && model.repo === group.repo ? ` aria-current="page"` : "";
      return `<a class="nav-sub" href="/repos/${encodeURIComponent(group.repo)}"${current}>${escapeHtml(group.repo)}<span class="badge">${group.jobs.length}</span></a>`;
    })
    .join("");
  return `<nav class="side" aria-label="Sections">
${item("/inbox", "inbox", "Inbox", "inbox", board.inboxCount)}
<p class="unseen" id="inbox-unseen" hidden></p>
${item("/hand", "hand", "Needs a hand", "hand", board.handCount)}
${item("/repos", "repos", "Repos", "repos")}
${repos}
${item("/history", "history", "History", "history", board.history.length)}
${item("/stats", "stats", "Stats", "stats")}
${item("/report", "report", "Today", "report")}
${item("/settings", "open-settings", "Settings", "settings")}
</nav>`;
}

function mainHtml(model: AppModel, page: ServePageOptions): string {
  const error = `<p class="meta config-error" id="config-error" role="status"${page.configError ? "" : " hidden"}>${escapeHtml(page.configError ?? "")}</p>`;
  if (model.section === "settings") {
    return `${error}<main class="main"><h2>Settings</h2><section id="settings" aria-label="Settings">${settingsForm()}</section></main>`;
  }
  if (model.section === "stats" && model.stats) {
    return `${error}<main class="main">${statsHtml(model.stats)}</main>`;
  }
  if (model.section === "report" && model.report) {
    return `${error}<main class="main">${reportHtml(model.report)}</main>`;
  }
  if (model.section === "job" && model.detail) {
    return `${error}<main class="main detail">${detailHtml(model.detail, model.tab ?? "overview", page.csrf)}</main>`;
  }
  return `${error}<main class="main">${listHtml(model, page.csrf)}</main>`;
}

function listHtml(model: AppModel, csrf: string): string {
  const board = model.board;
  if (model.section === "inbox") {
    return `<header class="list-head"><h2>Inbox</h2><p class="meta">Approve, reject, or revise. Kiln does not do this on its own.</p></header>${jobList(board.inbox, "inbox", "Nothing is waiting on a gate.", csrf)}`;
  }
  if (model.section === "hand") {
    return `<header class="list-head"><h2>Needs a hand</h2><p class="meta">A breaker tripped, a cap was hit, or a run failed with no retry left.</p></header>${jobList(board.hand, "hand", "Nothing needs a person.", csrf)}`;
  }
  if (model.section === "history") {
    return `<header class="list-head"><h2>History</h2></header>${jobList(board.history, "history", "No finished jobs.", csrf)}`;
  }
  const groups = model.repo ? board.repos.filter((group) => group.repo === model.repo) : board.repos;
  if (groups.length === 0) return `<header class="list-head"><h2>Repos</h2></header><p class="empty">No jobs.</p>`;
  return `<header class="list-head"><h2>${model.repo ? escapeHtml(model.repo) : "Repos"}</h2></header>${groups
    .map(
      (group) =>
        `<section class="repo-block"><h3>${escapeHtml(group.repo)}</h3>${jobList(group.jobs, "repos", "No jobs.", csrf)}</section>`,
    )
    .join("")}`;
}

function jobList(
  jobs: readonly BoardJob[],
  section: "inbox" | "hand" | "repos" | "history",
  empty: string,
  csrf: string,
): string {
  if (jobs.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<div class="jobs">${jobs.map((job) => jobRow(job, section, csrf)).join("\n")}</div>`;
}

function jobRow(job: BoardJob, section: "inbox" | "hand" | "repos" | "history", csrf: string): string {
  const id = encodeURIComponent(job.jobId);
  const classes = ["job"];
  if (job.scheduledRetry) classes.push("retrying");
  if (section === "inbox" || (section === "hand" && !job.scheduledRetry)) classes.push("human");
  const flag = classes.includes("human") ? `<span class="flag">your call</span>` : "";
  const repo = section === "repos" ? "" : `<span class="meta">${escapeHtml(job.repo)}</span>`;
  const sandbox = job.sandboxed ? `<span class="meta">sandbox · docker</span>` : "";
  const pr = section === "repos" && job.state === "in-review" ? `<span class="meta">PR review</span>` : "";
  const retrying =
    job.scheduledRetry && job.nextRetryAt
      ? `<div class="meta">retrying <time datetime="${escapeHtml(job.nextRetryAt)}" data-time="clock">${escapeHtml(job.nextRetryAt)}</time>${job.attemptLine ? ` · ${escapeHtml(job.attemptLine)}` : ""}</div>`
      : "";
  const attempt = !retrying && job.attemptLine && (section === "hand" || section === "inbox") ? `<div class="meta">${escapeHtml(job.attemptLine)}</div>` : "";
  const history = job.historyLine ? `<div class="meta">${escapeHtml(job.historyLine)}</div>` : "";
  const unsafe = job.prUrl && !safeUrl(job.prUrl) ? `<div class="branch">${escapeHtml(job.prUrl)}</div>` : "";
  const deps = dependsHtml(job);
  const evidence = section === "inbox" ? evidenceHtml(job) : "";
  const feedback = feedbackHtml(job);
  const tail = section !== "inbox" && job.logTail ? `<div class="note">${escapeHtml(clipTail(job.logTail))}</div>` : "";
  const notes = job.notes.length ? `<div class="note">${job.notes.map((line) => escapeHtml(line)).join("<br>")}</div>` : "";
  const unseen = `<p class="unseen" data-unseen-for="${escapeHtml(job.jobId)}" hidden></p>`;
  const links = fileLinks(job);
  return `<article class="${classes.join(" ")}" id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-state="${escapeHtml(job.state)}" data-repo="${escapeHtml(job.repo)}" data-deps="${escapeHtml(job.dependsOn.map((dep) => dep.jobId).join(" "))}"${job.latestEventAt ? ` data-latest="${escapeHtml(job.latestEventAt)}"` : ""}>
<div class="job-main">
<div class="job-top">${flag}<a class="job-title" href="/jobs/${id}">${escapeHtml(job.title)}</a></div>
<div class="job-meta"><span class="num">${escapeHtml(job.jobId)}</span>${repo}<span class="meta">${escapeHtml(job.state)}</span>${sandbox}${pr}</div>
<p class="reason">${escapeHtml(job.reason)}</p>
${history}${unsafe}${retrying}${attempt}${deps}${feedback}${evidence}${notes}${tail}${unseen}${links}
</div>
${actionsHtml(job, section, csrf)}
</article>`;
}

function clipTail(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-8);
  return tail.join("\n");
}

function fileLinks(job: BoardJob): string {
  const id = encodeURIComponent(job.jobId);
  const links: string[] = [];
  if (job.spec) links.push(`<a href="/jobs/${id}/spec">spec</a>`);
  if (job.log) links.push(`<a href="/jobs/${id}/log">log</a>`);
  if (job.findings) links.push(`<a href="/jobs/${id}/findings">Findings</a>`);
  if (links.length === 0) return "";
  return `<p class="links">${links.join(" ")}</p>`;
}

function evidenceHtml(job: BoardJob): string {
  if (job.evidence.length === 0) return "";
  const texts = job.evidence.map((text) => (text.length > 500 ? `${text.slice(0, 499)}…` : text));
  return `<div class="evidence">${texts.map((text) => `<pre class="text">${escapeHtml(text)}</pre>`).join("")}</div>`;
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
    .filter((line): line is string => Boolean(line))
    .join("; ");
  return `<p class="deps">depends on ${links}</p>${detail ? `<p class="meta">${escapeHtml(detail)}</p>` : ""}`;
}

function actionsHtml(job: BoardJob, section: "inbox" | "hand" | "repos" | "history" | "job", csrf: string): string {
  const showGate = section === "inbox" || section === "job";
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
  if (forms.length === 0) return "";
  return `<div class="d-actions">${forms.join("")}</div>`;
}

function postForm(action: string, kind: string, label: string, csrf: string): string {
  return `<form method="post" action="${action}" class="act ${kind}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">${label}</button></form>`;
}

function detailHtml(detail: JobDetail, tab: "overview" | "changes" | "timeline", _csrf: string): string {
  const job = detail.job;
  const id = encodeURIComponent(job.jobId);
  const tabs = (["overview", "changes", "timeline"] as const)
    .map((name) => {
      const href = name === "overview" ? `/jobs/${id}` : `/jobs/${id}?tab=${name}`;
      const current = name === tab ? ` aria-current="page"` : "";
      const label = name[0]?.toUpperCase() + name.slice(1);
      return `<a href="${href}"${current}>${label}</a>`;
    })
    .join("");
  const panel = tab === "changes" ? changesHtml(detail) : tab === "timeline" ? timelineHtml(detail) : overviewHtml(detail);
  return `<div class="detail-main">
<a class="back" href="/inbox">Inbox</a>
<header class="list-head"><h2>${escapeHtml(job.title)}</h2><p class="reason">${escapeHtml(job.reason)}</p><p class="unseen" data-unseen-for="${escapeHtml(job.jobId)}" hidden></p></header>
<nav class="tabs" aria-label="Job">${tabs}</nav>
${actionsHtml(job, "job", _csrf)}
${panel}
</div>
${railHtml(detail)}`;
}

function overviewHtml(detail: JobDetail): string {
  const cards = detail.overview;
  if (cards.length === 0) return `<p class="empty">No phases in the event log yet.</p>`;
  return `<ol class="phases">${cards.map((card) => phaseHtml(card)).join("")}</ol>`;
}

function phaseHtml(card: PhaseCard): string {
  const bits: string[] = [];
  if (card.verdict) bits.push(`<p class="verdict">${escapeHtml(card.verdict)}</p>`);
  if (card.detail) bits.push(`<pre class="text">${escapeHtml(card.detail)}</pre>`);
  if (card.testCommand || card.exitCode !== undefined) {
    const exit = card.exitCode === undefined ? "" : ` · exit ${card.exitCode}`;
    bits.push(`<p class="meta">${escapeHtml(`${card.testCommand ?? "test"}${exit}`)}</p>`);
  }
  if (card.failureClass || card.fingerprint) {
    bits.push(`<p class="meta">${escapeHtml([card.failureClass, card.fingerprint].filter(Boolean).join(" · "))}</p>`);
  }
  if (card.note) bits.push(`<blockquote class="note">${escapeHtml(card.note)}</blockquote>`);
  const iteration = card.iteration !== undefined ? ` <span class="meta">#${card.iteration}</span>` : "";
  return `<li class="phase ${escapeHtml(card.outcome)}"><header><span class="step">${escapeHtml(card.label)}</span>${iteration}<span class="outcome">${escapeHtml(card.outcome)}</span><time datetime="${escapeHtml(card.ts)}">${escapeHtml(card.ts)}</time></header>${bits.join("")}</li>`;
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
  if (detail.timeline.length === 0) return `<p class="empty">No events.</p>`;
  const rows = detail.timeline
    .map((event) => {
      const step = event.step ? `<span class="meta">${escapeHtml(event.step)}</span>` : "";
      return `<li><time datetime="${escapeHtml(event.ts)}">${escapeHtml(event.ts)}</time> <span class="ev">${escapeHtml(event.event)}</span> ${step}<pre class="text">${escapeHtml(JSON.stringify(event.properties))}</pre></li>`;
    })
    .join("");
  return `<ol class="timeline">${rows}</ol>`;
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
  return `<header class="list-head"><h2>Stats</h2><nav class="tabs" aria-label="Window">${windows}</nav></header>
<section class="stat"><h3>Spend</h3><p>Today ${escapeHtml(stats.spend.day)} ${escapeHtml(formatDollars(stats.spend.usd))} / ${escapeHtml(cap)}</p><p class="meta">This window ${escapeHtml(formatDollars(stats.windowUsd))}</p></section>
<section class="stat"><h3>Cost by repo</h3>${repoRows}</section>
<section class="stat"><h3>Cost by phase</h3>${phaseRows}</section>
<section class="stat"><h3>Runs</h3><p>${stats.runs.started} started · ${stats.runs.finished} finished · ${stats.runs.failed} failed</p>${classRows}</section>
<section class="stat"><h3>Interventions</h3>${interventions}</section>`;
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
            return `<li><a href="/jobs/${encodeURIComponent(run.jobId)}">${escapeHtml(run.title)}</a> <span class="meta">${escapeHtml(run.repo)} · ${escapeHtml(run.outcome)}${klass}${cost}</span></li>`;
          })
          .join("")}</ul>`;
  const interventions =
    report.interventions.total === 0
      ? `<p class="empty">0 interventions</p>`
      : `<ul class="ledger">${report.interventions.rows
          .map((row) => `<li><span class="mono">${escapeHtml(row.repo)} / ${escapeHtml(row.jobId)}</span> ${row.total}</li>`)
          .join("")}</ul>`;
  return `<header class="list-head"><h2>Today</h2><p class="meta">${escapeHtml(report.day)}</p></header>
<section class="stat"><h3>Spend</h3><p>${escapeHtml(formatDollars(report.spend.usd))} / ${escapeHtml(cap)}</p></section>
<section class="stat"><h3>Runs</h3>${runs}</section>
<section class="stat"><h3>Interventions</h3>${interventions}</section>`;
}

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
<div class="field"><span class="k">Repo</span><div class="picks" id="repo-pick">${repoButtons(intake.repos)}</div></div>
<label class="field"><span class="k">Workflow</span><select id="workflow" name="workflow">${workflowOptions(intake.workflows)}</select></label>
<div class="seg" role="tablist" aria-label="Source">
<button type="button" data-source="prompt" aria-pressed="true">Prompt</button>
<button type="button" data-source="spec" aria-pressed="false">Spec file</button>
<button type="button" data-source="tickets" aria-pressed="false">Tickets folder</button>
<button type="button" data-source="jira" aria-pressed="false">Jira</button>
</div>
<div data-pane="prompt"><label class="field"><span class="k">Prompt</span><textarea id="prompt-text" rows="4" placeholder="What should this job do?"></textarea></label></div>
<div id="browser-field" hidden>
<div class="k" id="browser-label">Spec file</div>
<div class="fs" id="browser"></div>
<p class="meta" id="picked"></p>
</div>
<div data-pane="jira" hidden><label class="field"><span class="k">Jira key</span><input id="jira-key" type="text" placeholder="PROJ-123" autocomplete="off" spellcheck="false"></label></div>
<label class="field" id="issue-field"><span class="k">Issue</span><input id="job-issue" type="text" placeholder="ABC-123" autocomplete="off" spellcheck="false"></label>
<label class="field" id="title-field"><span class="k">Title</span><input id="job-title" type="text" autocomplete="off"></label>
<fieldset class="field" id="after-field"><legend class="k">After</legend><div id="after-list">${afterOptions(items.map((item) => item.job))}</div></fieldset>
<pre class="text preview" id="intake-preview" hidden></pre>
<p class="form-error" id="intake-error" role="alert" hidden></p>
<div class="d-actions"><button type="button" id="preview-job" hidden>Preview</button><button type="submit">Add</button></div>
</form>
</section>`;
}

function settingsForm(): string {
  return `<form id="settings-form" class="intake-form">
<p class="meta" id="settings-path"></p>
<p class="saved" id="settings-saved" role="status" hidden>Saved</p>
<p class="form-error" id="settings-error" role="alert" hidden></p>
<div class="seg" role="tablist" aria-label="Settings sections">
<button type="button" data-settings-tab="repos" aria-pressed="true">Repos</button>
<button type="button" data-settings-tab="global" aria-pressed="false">Global</button>
</div>
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
</div>
<div class="d-actions"><button type="submit">Save</button></div>
</form>`;
}

function repoButtons(repos: ServeRepoOption[]): string {
  if (repos.length === 0) return `<p class="empty">No repos are registered.</p>`;
  return repos
    .map(
      (repo, index) =>
        `<button type="button" class="pick" data-repo="${escapeHtml(repo.name)}" data-path="${escapeHtml(repo.path)}" aria-pressed="${index === 0 ? "true" : "false"}">${escapeHtml(repo.name)}</button>`,
    )
    .join("");
}

function workflowOptions(names: string[]): string {
  if (names.length === 0) return `<option value="">none</option>`;
  return names
    .map((name) => `<option value="${escapeHtml(name)}"${name === "feature" ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
}

function afterOptions(jobs: StatusJobView[]): string {
  const open = jobs.filter((job) => job.state !== "done");
  if (open.length === 0) return `<p class="empty">No open jobs.</p>`;
  return open
    .map((job) => `<label class="after"><input type="checkbox" name="after" value="${escapeHtml(job.jobId)}"><span class="num">${escapeHtml(job.jobId)}</span><span>${escapeHtml(job.title || job.jobId)}</span></label>`)
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
  jobId?: string;
  latest?: string;
  live: boolean;
  body: string;
}): string {
  const job = options.jobId ? ` data-job="${escapeHtml(options.jobId)}"` : "";
  const latest = options.latest ? ` data-latest="${escapeHtml(options.latest)}"` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&family=Roboto+Mono:wght@400;500&display=swap">
<style>
${options.css}
</style>
</head>
<body data-section="${escapeHtml(options.section)}" data-needs-you="${options.needsYou}" data-revision="${escapeHtml(options.revision)}" data-csrf="${escapeHtml(options.csrf ?? "")}"${job}${latest}>
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
