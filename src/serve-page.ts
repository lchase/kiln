import { INVESTIGATION_WORKFLOW } from "./findings.js";
import { statusDetails, type StatusJobView, type StatusState, type StatusView } from "./report.js";
import { JOB_STATES } from "./schemas.js";

const REFRESH_SECONDS = 3;

export function renderInbox(css: string, view: StatusView): string {
  const waiting = view.jobs.filter((job) => job.state === "needs-human");
  const body = waiting.length === 0 ? emptyInbox() : waiting.map(renderInboxCard).join("\n");
  return document({
    css,
    title: "Kiln inbox",
    refresh: true,
    current: "inbox",
    main: `<h1>Inbox</h1>
<p class="lede">Jobs waiting on a person. Approve and reject use the same gate as the CLI.</p>
${body}`,
  });
}

export function renderBoard(css: string, view: StatusView): string {
  const groups: string[] = [];
  const states: StatusState[] = [...JOB_STATES, "invalid"];
  for (const state of states) {
    const jobs = view.jobs.filter((job) => job.state === state);
    if (jobs.length === 0) continue;
    groups.push(`<section class="group" id="state-${escapeHtml(state)}">
<h2>${escapeHtml(state)} <span class="count">${jobs.length}</span></h2>
${jobs.map(renderBoardJob).join("\n")}
</section>`);
  }
  const main =
    groups.length > 0
      ? groups.join("\n")
      : `<h1>Board</h1><p class="empty">No jobs.</p>`;
  const titled = groups.length > 0 ? `<h1>Board</h1>\n${main}` : main;
  return document({
    css,
    title: "Kiln board",
    refresh: true,
    current: "board",
    main: titled,
  });
}

export function renderTextPage(css: string, title: string, text: string): string {
  return document({
    css,
    title,
    refresh: false,
    current: "inbox",
    main: `<a class="back" href="/">Inbox</a>
<h1>${escapeHtml(title)}</h1>
<pre class="text">${escapeHtml(text)}</pre>`,
  });
}

export function renderMessagePage(css: string, title: string, message: string): string {
  return document({
    css,
    title,
    refresh: false,
    current: "inbox",
    main: `<a class="back" href="/">Inbox</a>
<h1>${escapeHtml(title)}</h1>
<p class="empty">${escapeHtml(message)}</p>`,
  });
}

function emptyInbox(): string {
  return `<p class="empty">Nothing is waiting on a person. The <a href="/board">board</a> lists every job.</p>`;
}

function renderInboxCard(job: StatusJobView): string {
  const gates = job.gates
    .map((gate) => {
      const asking = gate.rendered && gate.rendered !== gate.prompt ? gate.rendered : gate.prompt;
      const artifacts =
        gate.artifacts.length === 0
          ? ""
          : `<ul class="facts">${gate.artifacts
              .map(
                (artifact) =>
                  `<li><span class="name">${escapeHtml(artifact.name)}</span> ${escapeHtml(artifact.summary)}</li>`,
              )
              .join("")}</ul>`;
      const reviews =
        gate.reviews.length === 0
          ? ""
          : `<h4>Reviews</h4><ul class="facts">${gate.reviews
              .map(
                (review) =>
                  `<li><span class="name">${escapeHtml(review.name)}</span> ${escapeHtml(review.summary)}</li>`,
              )
              .join("")}</ul>`;
      return `<p class="prompt">${escapeHtml(asking)}</p>${artifacts}${reviews}`;
    })
    .join("\n");
  return `<article class="card" id="job-${escapeHtml(job.jobId)}">
<h2>${escapeHtml(job.title || job.jobId)}</h2>
<p class="meta">${escapeHtml(job.repo)} · ${escapeHtml(job.workflow)} · <code>${escapeHtml(job.jobId)}</code>${job.stack ? ' · <span class="chip">stacked</span>' : ""}</p>
${gates}
${resourceLinks(job)}
${actionForms(job)}
</article>`;
}

function renderBoardJob(job: StatusJobView): string {
  const deps =
    job.dependsOn.length === 0
      ? ""
      : `<p class="deps">depends on ${job.dependsOn
          .map((dep) => {
            const why = dep.blockedDetail ? ` <span class="why">${escapeHtml(dep.blockedDetail)}</span>` : "";
            return `<a href="/board#job-${encodeURIComponent(dep.jobId)}">${escapeHtml(dep.jobId)}</a> <span class="chip">${escapeHtml(dep.state)}</span>${why}`;
          })
          .join(", ")}</p>`;
  const pr =
    job.prUrl && (job.state === "in-review" || job.state === "done" || job.state === "failed")
      ? renderPr(job.prUrl)
      : "";
  const details = statusDetails(job);
  const detailList =
    details.length === 0
      ? ""
      : `<ul class="details">${details
          .map((line) => `<li class="${detailClass(job.state, line)}">${escapeHtml(line)}</li>`)
          .join("")}</ul>`;
  return `<article class="job" id="job-${escapeHtml(job.jobId)}">
<h3>${escapeHtml(job.title || job.jobId)}</h3>
<p class="meta">${escapeHtml(job.repo)} · ${escapeHtml(job.workflow)} · <code>${escapeHtml(job.jobId)}</code></p>
<p class="chips"><span class="chip state-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span>${job.stack ? '<span class="chip">stacked</span>' : ""}</p>
${deps}
${pr}
${detailList}
${resourceLinks(job)}
</article>`;
}

function detailClass(state: StatusState, line: string): string {
  if (
    line.startsWith("source ") ||
    line.startsWith("gate ") ||
    line.startsWith("approve:") ||
    line.startsWith("reject:") ||
    line.startsWith("waiting ") ||
    line.startsWith("blocked on ") ||
    line.startsWith("fix:")
  ) {
    return "";
  }
  if (state === "failed" || state === "dead") return "bad";
  return "";
}

function renderPr(url: string): string {
  const safe = httpUrl(url);
  if (!safe) return `<p class="links">${escapeHtml(url)}</p>`;
  return `<p class="links"><a href="${escapeHtml(safe)}">Pull request</a></p>`;
}

function resourceLinks(job: StatusJobView): string {
  const links: string[] = [];
  const id = encodeURIComponent(job.jobId);
  if (job.specPath) links.push(`<a href="/jobs/${id}/spec">Spec</a>`);
  if (job.logPath) links.push(`<a href="/jobs/${id}/log">Log</a>`);
  if (job.workflow === INVESTIGATION_WORKFLOW) links.push(`<a href="/jobs/${id}/findings">Findings</a>`);
  if (links.length === 0) return "";
  return `<p class="links">${links.join(" ")}</p>`;
}

function actionForms(job: StatusJobView): string {
  const forms: string[] = [];
  const id = encodeURIComponent(job.jobId);
  if (job.canApprove) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/approve"><button class="approve" type="submit">Approve</button></form>`,
    );
  }
  if (job.canReject) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/reject"><button class="reject" type="submit">Reject</button></form>`,
    );
  }
  if (forms.length === 0) return "";
  return `<div class="actions">${forms.join("")}</div>`;
}

function document(options: {
  css: string;
  title: string;
  refresh: boolean;
  current: "inbox" | "board";
  main: string;
}): string {
  const refresh = options.refresh
    ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
${refresh}
<title>${escapeHtml(options.title)}</title>
<style>
${options.css}
</style>
</head>
<body>
<header class="top">
  <a class="kiln-mark" href="/">Kiln</a>
  <nav>
    <a href="/" ${options.current === "inbox" ? 'aria-current="page"' : ""}>Inbox</a>
    <a href="/board" ${options.current === "board" ? 'aria-current="page"' : ""}>Board</a>
  </nav>
  ${options.refresh ? `<p class="refresh">Refreshes every ${REFRESH_SECONDS}s</p>` : ""}
</header>
<main>
${options.main}
</main>
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

function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}
