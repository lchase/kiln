import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduledRetry, type AttentionItem, type AttentionView } from "./attention.js";
import { readBoardFiles, stageOf, stagesFor, type BoardFile, type BoardReviewRound, type BoardStage } from "./board.js";
import { feedbackRoundLabel } from "./feedback.js";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import { packageRoot } from "./paths.js";
import type { StatusJobView } from "./report.js";
import { listWorkflowNames } from "./workflow.js";

export interface ServeRepoOption {
  name: string;
  path: string;
}

export interface ServePageOptions {
  csrf: string;
  repos: ServeRepoOption[];
  workflows: string[];
  configError?: string;
}

const REVIEWERS = [
  ["security", "sec"],
  ["ux", "ux"],
  ["ui", "ui"],
  ["code", "code"],
] as const;

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
  const intake = page ?? { csrf: "", repos: [], workflows: listWorkflowNames() };
  const items = [...attention.needsYou, ...attention.inFlight, ...attention.doneRecently];
  const stages = stagesFor(items.map((item) => item.job));
  const grouped = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const stage = stageOf(item.job);
    const list = grouped.get(stage) ?? [];
    list.push(item);
    grouped.set(stage, list);
  }
  const tracks = stages
    .map((stage) => ((grouped.get(stage.id)?.length ?? 0) === 0 ? "40px" : "minmax(0, 1fr)"))
    .join(" ");
  const columns = stages.map((stage) => column(stage, grouped.get(stage.id) ?? [])).join("\n");
  const repos = [...new Set(items.map((item) => item.job.repo).filter((repo) => repo.length > 0))].sort();
  const chips = [
    chip("", "all", items.length, true),
    ...repos.map((repo) => chip(repo, repo, items.filter((item) => item.job.repo === repo).length, false)),
  ].join("");
  const version = VERSION ? `<span class="ver">v${escapeHtml(VERSION)}</span>` : "";
  const body = `<header>
<div class="brand"><span class="logo" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V6l5-3 5 3v6l-5 3-5-3z"/><path d="M3 6l5 3 5-3M8 9v6"/></svg></span><h1>Kiln</h1>${version}</div>
<div class="status" id="status">${items.length === 1 ? "1 job" : `${items.length} jobs`}</div>
</header>
<p class="meta config-error" id="config-error" role="status"${intake.configError ? "" : " hidden"}>${escapeHtml(intake.configError ?? "")}</p>
<nav class="repos" aria-label="Filter by repo">${chips}</nav>
<main class="board" id="board" style="--cols: ${tracks}">
${columns}
</main>
<nav class="toolbar" aria-label="Kiln commands">
<button class="tool" type="button" id="add-job" data-tip="Add job" aria-label="Add job"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
<button class="tool" type="button" data-act="approve" data-tip="Approve" aria-label="Approve"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
<button class="tool" type="button" data-act="retry" data-tip="Retry" aria-label="Retry"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg></button>
<button class="tool" type="button" data-act="pr" data-tip="Open pull request" aria-label="Open pull request"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-3"/></svg></button>
<button class="tool" type="button" id="notify" data-tip="Notify me" aria-label="Notify me"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 7H3s3 0 3-7"/><path d="M10 19a2 2 0 0 0 4 0"/></svg></button>
<span class="sep" aria-hidden="true"></span>
<button class="tool" type="button" id="compact" aria-pressed="true" data-tip="expand empty columns" aria-label="expand empty columns"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h7m0 0-3-3m3 3-3 3M21 12h-7m0 0 3-3m-3 3 3 3M12 4v16"/></svg></button>
</nav>
<div class="scrim" data-close></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Job">
${intakeSheet(intake, items)}
${items.map((item) => sheet(item, intake.csrf)).join("\n")}
</aside>`;
  return document({
    css,
    title: `(${attention.needsYouCount}) Kiln`,
    needsYou: attention.needsYouCount,
    revision: attention.revision,
    csrf: intake.csrf,
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
    live: false,
    body: `<a class="back" href="/">Console</a>
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
    live: false,
    body: `<a class="back" href="/">Console</a>
<div class="page"><h1>${escapeHtml(title)}</h1>
<p class="empty">${escapeHtml(message)}</p></div>`,
  });
}

function column(stage: BoardStage, items: AttentionItem[]): string {
  const slim = items.length === 0;
  const tone = stage.tone ? ` ${stage.tone}` : "";
  const cards = items.map((item) => card(item, stage.id)).join("\n");
  const count = items.length ? String(items.length) : "";
  return `<section class="col${slim ? " slim" : ""}${tone}" id="col-${escapeHtml(stage.id)}" data-stage="${escapeHtml(stage.id)}" aria-label="${escapeHtml(stage.label)}, ${items.length}">
<div class="slim-face"><span class="count">${items.length}</span><div class="v"><h2>${escapeHtml(stage.label)}</h2><span class="who">${escapeHtml(stage.who)}</span></div></div>
<div class="full"><div class="col-head"><h2>${escapeHtml(stage.label)}</h2><span class="who">${escapeHtml(stage.who)}</span><span class="count">${escapeHtml(count)}</span></div>
${cards || ""}<div class="empty"${items.length > 0 ? " hidden" : ""}>none</div></div>
</section>`;
}

function card(item: AttentionItem, stage: string): string {
  const job = item.job;
  const waiting = scheduledRetry(job);
  const classes = ["card"];
  if (waiting) classes.push("retrying");
  else if (stage === "needs-human") classes.push("human");
  if (stage === "merged") classes.push("merged");
  if (stage === "queued") classes.push("queued");
  const deps = job.dependsOn.map((dep) => dep.jobId).join(" ");
  const pulse = job.state === "running" ? '<span class="pulse" aria-label="running"></span>' : "";
  const flag = stage === "needs-human" && !waiting ? '<span class="flag">your call</span>' : "";
  const branch = branchOf(job);
  return `<div role="button" tabindex="0" class="${classes.join(" ")}" id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-deps="${escapeHtml(deps)}" data-repo="${escapeHtml(job.repo)}" data-stage="${escapeHtml(stage)}">
<div class="card-top">${pulse}<span class="num">${escapeHtml(job.jobId)}</span>${flag}</div>
<div class="branch repo">${escapeHtml(job.repo)}</div>
<p class="title">${escapeHtml(job.title || job.jobId)}</p>
${branch ? `<div class="branch">${escapeHtml(branch)}</div>` : ""}
${sandboxHtml(job)}
${prLink(job)}
${roundsHtml(job, stage)}
${attemptHtml(job, stage)}
${waiting ? "" : noteHtml(item)}
${dependsHtml(job)}
</div>`;
}

function intakeSheet(intake: ServePageOptions, items: AttentionItem[]): string {
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
<label class="field" id="title-field"><span class="k">Title</span><input id="job-title" type="text" autocomplete="off"></label>
<fieldset class="field" id="after-field"><legend class="k">After</legend><div id="after-list">${afterOptions(items)}</div></fieldset>
<pre class="text preview" id="intake-preview" hidden></pre>
<p class="form-error" id="intake-error" role="alert" hidden></p>
<div class="d-actions"><button type="button" id="preview-job" hidden>Preview</button><button type="submit">Add</button></div>
</form>
</section>`;
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

function afterOptions(items: AttentionItem[]): string {
  const open = items.filter((item) => item.job.state !== "done");
  if (open.length === 0) return `<p class="empty">No open jobs.</p>`;
  return open
    .map((item) => {
      const job = item.job;
      return `<label class="after"><input type="checkbox" name="after" value="${escapeHtml(job.jobId)}"><span class="num">${escapeHtml(job.jobId)}</span><span>${escapeHtml(job.title || job.jobId)}</span></label>`;
    })
    .join("");
}

function sheet(item: AttentionItem, csrf: string): string {
  const job = item.job;
  const files = displayFiles(job);
  const round = lastRound(job);
  const pr = safeUrl(job.prUrl);
  const num = `${job.repo}/${job.jobId} · ${job.workflow} · ${job.state}${round ? ` · round ${round}` : ""}`;
  const branch = branchOf(job);
  return `<section class="sheet" data-job="${escapeHtml(job.jobId)}"${pr ? ` data-pr="${escapeHtml(pr)}"` : ""} hidden>
<div class="d-head">
<div class="num">${escapeHtml(num)}</div>
<h3>${escapeHtml(job.title || job.jobId)}</h3>
${branch ? `<div class="branch">${escapeHtml(branch)}</div>` : ""}
${sandboxHtml(job)}
${prLink(job)}
${actionsHtml(item, csrf)}
<button type="button" class="close" data-close aria-label="Close">×</button>
</div>
<div class="d-body">${filesNav(files, job)}</div>
</section>`;
}

function filesNav(files: BoardFile[], job: StatusJobView): string {
  let group = "";
  const buttons = files
    .map((file, index) => {
      const head = file.group !== group ? `<div class="group">${escapeHtml(file.group)}</div>` : "";
      group = file.group;
      const dot = file.tone ? ` ${file.tone}` : "";
      return `${head}<button type="button" class="file${index === 0 ? " on" : ""}" data-file="${escapeHtml(file.id)}"><span class="dot${dot}"></span>${escapeHtml(file.label)}</button>`;
    })
    .join("");
  const sources = files
    .map((file) => `<pre class="src" data-file="${escapeHtml(file.id)}" hidden>${escapeHtml(file.text)}</pre>`)
    .join("");
  const empty = files.length === 0 ? '<div class="empty">Nothing written yet.</div>' : "";
  return `<nav class="files">${buttons}${routeLinks(job)}${empty}</nav><article class="doc"><div class="md" data-view></div>${sources}</article>`;
}

function routeLinks(job: StatusJobView): string {
  const id = encodeURIComponent(job.jobId);
  const links: string[] = [];
  if (job.specPath) links.push(`<a class="file" href="/jobs/${id}/spec">spec</a>`);
  if (job.logPath) links.push(`<a class="file" href="/jobs/${id}/log">log</a>`);
  if (job.findingsPath) links.push(`<a class="file" href="/jobs/${id}/findings">Findings</a>`);
  if (links.length === 0) return "";
  return `<div class="group">Open</div>${links.join("")}`;
}

function actionsHtml(item: AttentionItem, csrf: string): string {
  const id = encodeURIComponent(item.job.jobId);
  const token = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const forms: string[] = [];
  if (item.job.canApprove) {
    forms.push(`<form method="post" action="/api/jobs/${id}/approve" class="act approve">${token}<button type="submit">Approve</button></form>`);
  }
  if (item.job.canReject) {
    forms.push(`<form method="post" action="/api/jobs/${id}/reject" class="act reject">${token}<button type="submit">Reject</button></form>`);
  }
  if (item.retry) {
    forms.push(`<form method="post" action="/api/jobs/${id}/retry" class="act retry">${token}<button type="submit">Retry</button></form>`);
  }
  if (forms.length === 0) return "";
  return `<div class="d-actions">${forms.join("")}</div>`;
}

function sandboxHtml(job: StatusJobView): string {
  if (!job.sandboxed) return "";
  return `<div class="meta">sandbox · docker</div>`;
}

function roundsHtml(job: StatusJobView, stage: string): string {
  const rounds = job.rounds ?? [];
  const last = rounds[rounds.length - 1]?.n;
  const rows = rounds.map((round) => roundRow(round, stage === "review" && job.state === "running" && round.n === last));
  for (const round of job.feedbackRounds ?? []) {
    const tone = round.outcome ? " PASS" : " CHANGES";
    rows.push(
      `<div class="round"><span class="r">R${round.round}</span><span class="chip${tone}" style="grid-column: 2 / -1">${escapeHtml(feedbackRoundLabel(round))}</span></div>`,
    );
  }
  const inReview = job.state === "in-review" || (job.state === "done" && safeUrl(job.prUrl));
  if (inReview && (job.feedbackRounds?.length ?? 0) === 0) {
    const n = (last ?? 0) + 1;
    const tone = job.state === "done" ? " PASS" : "";
    rows.push(
      `<div class="round"><span class="r">R${n}</span><span class="chip${tone}" style="grid-column: 2 / -1">PR review</span></div>`,
    );
  }
  if (rows.length === 0) return "";
  return `<div class="rounds">${rows.join("")}</div>`;
}

function roundRow(round: BoardReviewRound, waiting: boolean): string {
  const cells = REVIEWERS.map(([key, label]) => {
    const verdict = round[key];
    const tone = verdict === "PASS" || verdict === "CHANGES" ? verdict : waiting && !verdict ? "wait" : "";
    return `<span class="chip${tone ? ` ${tone}` : ""}" title="${escapeHtml(`${key}: ${verdict || "pending"}`)}">${label}</span>`;
  }).join("");
  return `<div class="round"><span class="r">R${round.n}</span>${cells}</div>`;
}

/**
 * A scheduled retry is one quiet line in the stage column.
 * A dead or non-retryable failure in Needs human keeps the attempt budget.
 */
function attemptHtml(job: StatusJobView, stage: string): string {
  if (scheduledRetry(job) && job.nextRetryAt) {
    const detail = [`attempt ${job.attemptCount}/${job.maxAttempts}`];
    if (job.lastFailureReason) detail.push(job.lastFailureReason);
    return `<div class="meta">retrying <time datetime="${escapeHtml(job.nextRetryAt)}" data-time="clock">${escapeHtml(job.nextRetryAt)}</time> · ${escapeHtml(detail.join(" · "))}</div>`;
  }
  if (stage !== "needs-human" || (job.state !== "failed" && job.state !== "dead")) return "";
  if (job.attemptCount <= 0 && !job.lastFailureReason && !job.nextRetryAt) return "";
  const parts: string[] = [];
  if (job.attemptCount > 0) parts.push(`attempt ${job.attemptCount}/${job.maxAttempts}`);
  if (job.lastFailureReason) parts.push(job.lastFailureReason);
  const line = parts.length > 0 ? `<div class="meta">${escapeHtml(parts.join(" · "))}</div>` : "";
  const when = job.nextRetryAt
    ? `<div class="meta">next retry <time datetime="${escapeHtml(job.nextRetryAt)}">${escapeHtml(job.nextRetryAt)}</time></div>`
    : "";
  return `${line}${when}`;
}

function noteHtml(item: AttentionItem): string {
  const lines = [noteText(item)];
  if (item.errorTail) {
    for (const line of item.errorTail.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !lines.some((existing) => existing.includes(trimmed))) lines.push(trimmed);
    }
  }
  return `<div class="note">${lines.map((line) => escapeHtml(line)).join("<br>")}</div>`;
}

function noteText(item: AttentionItem): string {
  const job = item.job;
  if (job.state === "done") return safeUrl(job.prUrl) ? "merged via PR" : "landed locally";
  return item.reason;
}

function dependsHtml(job: StatusJobView): string {
  if (job.dependsOn.length === 0) return "";
  const links = job.dependsOn
    .map((dep) => `<a href="#job-${encodeURIComponent(dep.jobId)}">${escapeHtml(dep.jobId)}</a>`)
    .join(", ");
  return `<p class="deps">depends on ${links}</p>`;
}

function prLink(job: StatusJobView): string {
  const safe = safeUrl(job.prUrl);
  if (safe) {
    const text = job.prNumber ? `PR #${job.prNumber}` : safe;
    return `<div class="branch"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(text)}</a></div>`;
  }
  if (job.prUrl) return `<div class="branch">${escapeHtml(job.prUrl)}</div>`;
  return "";
}

function branchOf(job: StatusJobView): string {
  if (job.branch) return job.branch;
  if (job.runId) return `yak/${job.runId}`;
  return "";
}

function lastRound(job: StatusJobView): number | undefined {
  const rounds = job.rounds ?? [];
  return rounds.length > 0 ? rounds[rounds.length - 1]?.n : undefined;
}

function displayFiles(job: StatusJobView): BoardFile[] {
  if (job.files && job.files.length > 0) return job.files;
  return readBoardFiles({
    ...(job.diffSummary && job.workflow !== INVESTIGATION_WORKFLOW ? { diffSummary: job.diffSummary } : {}),
    ...(job.logTail ? { logTail: job.logTail } : {}),
    ...(job.workflow ? { workflow: job.workflow } : {}),
    gates: job.gates.map((gate) => ({
      stepId: gate.stepId,
      prompt: gate.prompt,
      ...(gate.rendered ? { rendered: gate.rendered } : {}),
      choices: gate.choices,
      artifacts: gate.artifacts,
      reviews: gate.reviews,
    })),
  });
}

function chip(id: string, label: string, count: number, pressed: boolean): string {
  return `<button type="button" class="repo-f" aria-pressed="${pressed ? "true" : "false"}" data-repo="${escapeHtml(id)}">${escapeHtml(label)}<span class="n">${count}</span></button>`;
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
  live: boolean;
  body: string;
}): string {
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
<body data-needs-you="${options.needsYou}" data-revision="${escapeHtml(options.revision)}" data-csrf="${escapeHtml(options.csrf ?? "")}">
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
