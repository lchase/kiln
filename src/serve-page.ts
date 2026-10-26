import type { AttentionItem, AttentionView, GraphEdge, GraphNode } from "./attention.js";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import type { StatusJobView, StepProgress } from "./report.js";

const NODE_W = 184;
const NODE_H = 58;
const GAP_X = 72;
const GAP_Y = 18;
const PAD = 20;

const STATE_COLOR: Record<string, string> = {
  queued: "#8d8175",
  blocked: "#a16207",
  running: "#1d4e89",
  "needs-human": "#c2410c",
  approved: "#1f6b45",
  rejected: "#7c6f64",
  failed: "#9b2c2c",
  dead: "#7f1d1d",
  "in-review": "#6d28d9",
  done: "#1f6b45",
  invalid: "#9b2c2c",
  missing: "#a8a29e",
};

const LIVE_SCRIPT = `
(function () {
  var KEY = "kiln-needs-you";
  var body = document.body;
  var count = Number(body.getAttribute("data-needs-you") || "0");
  document.title = "(" + count + ") Kiln";

  function note(n) {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (err) { raw = null; }
    try { localStorage.setItem(KEY, String(n)); } catch (err) { /* private mode */ }
    if (raw === null) return;
    var prev = Number(raw);
    if (!isFinite(prev) || n <= prev) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    var added = n - prev;
    try {
      new Notification("Kiln", { body: added === 1 ? "1 job needs you" : added + " jobs need you" });
    } catch (err) { /* the browser refused the notification */ }
  }
  note(count);

  var button = document.getElementById("notify");
  function label() {
    if (!button || typeof Notification === "undefined") return;
    button.hidden = false;
    if (Notification.permission === "granted") {
      button.textContent = "Notifications on";
      button.disabled = true;
    } else if (Notification.permission === "denied") {
      button.textContent = "Notifications blocked";
      button.disabled = true;
    } else {
      button.textContent = "Notify me";
      button.disabled = false;
    }
  }
  label();
  if (button) {
    button.addEventListener("click", function () {
      if (typeof Notification === "undefined" || Notification.permission !== "default") return;
      Notification.requestPermission().then(label);
    });
  }

  function elapsed(iso) {
    var start = Date.parse(iso);
    if (isNaN(start)) return "";
    var seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    if (hours > 0) return hours + "h " + String(minutes).padStart(2, "0") + "m";
    if (minutes > 0) return minutes + "m " + String(secs).padStart(2, "0") + "s";
    return secs + "s";
  }
  function tickTimes() {
    var nodes = document.querySelectorAll("time.elapsed");
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute("datetime");
      if (iso) nodes[i].textContent = elapsed(iso);
    }
  }
  tickTimes();
  setInterval(tickTimes, 1000);

  function applyTails(items) {
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = item && item.job && item.job.jobId;
      var tail = item && item.job && item.job.logTail;
      if (!id || typeof tail !== "string") continue;
      var el = document.getElementById("log-" + id);
      if (el && el.textContent !== tail) el.textContent = tail;
    }
  }

  function poll() {
    fetch("/api/jobs", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (view) {
        if (!view || !view.attention) return;
        var attention = view.attention;
        var n = Number(attention.needsYouCount || 0);
        document.title = "(" + n + ") Kiln";
        var badge = document.getElementById("needs-count");
        if (badge) badge.textContent = n === 1 ? "1 job needs you" : n + " jobs need you";
        if (attention.revision && attention.revision !== body.getAttribute("data-revision")) {
          location.reload();
          return;
        }
        applyTails(attention.inFlight);
      })
      .catch(function () { /* the next poll retries */ });
  }
  setInterval(poll, 3000);
})();
`;

export function renderConsole(css: string, attention: AttentionView): string {
  const n = attention.needsYouCount;
  const countLabel = n === 1 ? "1 job needs you" : `${n} jobs need you`;
  const needs =
    attention.needsYou.length === 0
      ? `<p class="empty">Nothing needs you.</p>`
      : attention.needsYou.map(renderNeeds).join("\n");
  const flight =
    attention.inFlight.length === 0
      ? `<p class="empty">Nothing is in flight.</p>`
      : attention.inFlight.map(renderFlight).join("\n");
  const doneCount = attention.doneRecently.length;
  const done =
    doneCount === 0
      ? ""
      : `<details class="done-recent">
<summary>Done recently <span class="count">${doneCount}</span></summary>
<div class="done-list">
${attention.doneRecently.map(renderDone).join("\n")}
</div>
</details>`;
  return document({
    css,
    title: `(${n}) Kiln`,
    live: true,
    needsYou: n,
    revision: attention.revision,
    main: `<section id="needs-you">
<h1>Needs you <span class="count">${n}</span></h1>
${needs}
</section>
<section id="in-flight">
<h1>In flight <span class="count">${attention.inFlight.length}</span></h1>
${flight}
</section>
<section id="graph">
<h1>Dependencies</h1>
${renderGraph(attention)}
</section>
${done}`,
    headerExtra: `<p class="needs-count" id="needs-count">${escapeHtml(countLabel)}</p>
<button type="button" id="notify" hidden>Notify me</button>`,
  });
}

export function renderTextPage(css: string, title: string, text: string): string {
  return document({
    css,
    title,
    live: false,
    needsYou: 0,
    revision: "",
    main: `<a class="back" href="/">Console</a>
<h1>${escapeHtml(title)}</h1>
<pre class="text">${escapeHtml(text)}</pre>`,
  });
}

export function renderMessagePage(css: string, title: string, message: string): string {
  return document({
    css,
    title,
    live: false,
    needsYou: 0,
    revision: "",
    main: `<a class="back" href="/">Console</a>
<h1>${escapeHtml(title)}</h1>
<p class="empty">${escapeHtml(message)}</p>`,
  });
}

export function formatElapsed(iso: string, now = Date.now()): string {
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return "";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function renderNeeds(item: AttentionItem): string {
  const job = item.job;
  const question = gateBody(job);
  const findings = item.findings
    ? `<h3>Findings</h3><pre class="excerpt">${escapeHtml(item.findings)}</pre>`
    : "";
  const diff = !item.findings && job.diffSummary
    ? `<h3>Diff</h3><pre class="excerpt">${escapeHtml(job.diffSummary)}</pre>`
    : "";
  const tail = item.errorTail ? `<pre class="tail">${escapeHtml(item.errorTail)}</pre>` : "";
  const pr = job.prUrl && (job.state === "in-review" || job.state === "failed") ? renderPr(job.prUrl) : "";
  return `<article class="card tone-${escapeHtml(job.state)}" id="job-${escapeHtml(job.jobId)}">
<p class="reason">${escapeHtml(item.reason)}</p>
${heading(job)}
${stepStrip(job.steps)}
${question}
${findings}
${diff}
${reviews(job)}
${artifacts(job)}
${tail}
${pr}
${depends(job)}
${resourceLinks(job)}
${actionForms(item)}
</article>`;
}

function renderFlight(item: AttentionItem): string {
  const job = item.job;
  const reasonClass = job.state === "blocked" ? "reason waiting" : "reason";
  return `<article class="row" id="job-${escapeHtml(job.jobId)}">
<div class="row-main">
${heading(job)}
<p class="${reasonClass}">${escapeHtml(item.reason)}</p>
${depends(job)}
${stepStrip(job.steps)}
${resourceLinks(job)}
</div>
${elapsedHtml(item.since)}
${logDetails(job)}
</article>`;
}

function renderDone(item: AttentionItem): string {
  const job = item.job;
  const pr = job.prUrl ? renderPr(job.prUrl) : "";
  return `<article class="row settled" id="job-${escapeHtml(job.jobId)}">
<div class="row-main">
${heading(job)}
<p class="reason">${escapeHtml(item.reason)}</p>
${pr}
${resourceLinks(job)}
</div>
</article>`;
}

function heading(job: StatusJobView): string {
  const stack = job.stack ? `<span class="chip">stacked</span>` : "";
  return `<h2>${escapeHtml(job.title || job.jobId)}</h2>
<p class="meta">${escapeHtml(job.repo)} · ${escapeHtml(job.workflow)} · <code>${escapeHtml(job.jobId)}</code></p>
<p class="chips"><span class="chip state-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span>${stack}</p>`;
}

function gateBody(job: StatusJobView): string {
  return job.gates
    .map((gate) => {
      const asking = gate.rendered?.split("\n")[0]?.trim() || gate.prompt;
      return `<p class="prompt">${escapeHtml(asking)}</p>`;
    })
    .join("\n");
}

function reviews(job: StatusJobView): string {
  const rows = job.gates.flatMap((gate) => gate.reviews);
  if (rows.length === 0) return "";
  return `<h3>Reviews</h3><ul class="facts">${rows
    .map((review) => `<li><span class="name">${escapeHtml(review.name)}</span> ${escapeHtml(review.summary)}</li>`)
    .join("")}</ul>`;
}

function artifacts(job: StatusJobView): string {
  const rows = job.gates.flatMap((gate) => gate.artifacts);
  if (rows.length === 0) return "";
  return `<ul class="facts">${rows
    .map((artifact) => `<li><span class="name">${escapeHtml(artifact.name)}</span> ${escapeHtml(artifact.summary)}</li>`)
    .join("")}</ul>`;
}

function depends(job: StatusJobView): string {
  if (job.dependsOn.length === 0) return "";
  const links = job.dependsOn
    .map((dep) => {
      const why = dep.blockedDetail ? ` <span class="why">${escapeHtml(dep.blockedDetail)}</span>` : "";
      return `<a href="#job-${encodeURIComponent(dep.jobId)}">${escapeHtml(dep.jobId)}</a> <span class="chip">${escapeHtml(dep.state)}</span>${why}`;
    })
    .join(", ");
  return `<p class="deps">depends on ${links}</p>`;
}

function stepStrip(steps: StepProgress[]): string {
  if (steps.length === 0) return "";
  const items = steps
    .map((step) => `<li class="${escapeHtml(step.phase)}">${escapeHtml(step.id)}</li>`)
    .join("");
  return `<ol class="steps" aria-label="Steps">${items}</ol>`;
}

function elapsedHtml(since: string | undefined): string {
  if (!since) return "";
  return `<time class="elapsed" datetime="${escapeHtml(since)}">${escapeHtml(formatElapsed(since))}</time>`;
}

function logDetails(job: StatusJobView): string {
  if (!job.logTail && !job.logPath) return "";
  const body = job.logTail ? escapeHtml(job.logTail) : "No log yet.";
  return `<details class="log"><summary>Log</summary><pre id="log-${escapeHtml(job.jobId)}">${body}</pre></details>`;
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

function actionForms(item: AttentionItem): string {
  const forms: string[] = [];
  const id = encodeURIComponent(item.job.jobId);
  if (item.job.canApprove) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/approve"><button class="approve" type="submit">Approve</button></form>`,
    );
  }
  if (item.job.canReject) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/reject"><button class="reject" type="submit">Reject</button></form>`,
    );
  }
  if (item.retry) {
    forms.push(`<form method="post" action="/api/jobs/${id}/retry"><button class="retry" type="submit">Retry</button></form>`);
  }
  if (forms.length === 0) return "";
  return `<div class="actions">${forms.join("")}</div>`;
}

function renderGraph(attention: AttentionView): string {
  const graph = attention.graph;
  if (graph.nodes.length === 0) return `<p class="empty">No jobs.</p>`;
  const placed = placeGraph(graph.nodes, graph.edges);
  const edges = graph.edges
    .map((edge) => {
      const from = placed.pos.get(edge.from);
      const to = placed.pos.get(edge.to);
      if (!from || !to) return "";
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const sameColumn = from.x === to.x;
      const d = sameColumn
        ? `M ${x1} ${y1} C ${x1 + 36} ${y1 + 28}, ${x2 + NODE_W + 36} ${y2 + 28}, ${x2 + NODE_W} ${y2}`
        : `M ${x1} ${y1} C ${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`;
      const marker = edge.stack ? "url(#arrow-stack)" : "url(#arrow)";
      const cls = edge.stack ? "edge stack" : "edge";
      return `<path class="${cls}" d="${d}" marker-end="${marker}"/>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node) => {
      const at = placed.pos.get(node.jobId);
      if (!at) return "";
      const color = STATE_COLOR[node.state] ?? "#8d8175";
      const title = clip(node.title || node.jobId, 22);
      const sub = clip(node.repo ? `${node.repo} · ${node.state}` : node.state, 26);
      return `<a href="#job-${encodeURIComponent(node.jobId)}">
<g class="node">
<rect x="${at.x}" y="${at.y}" width="${NODE_W}" height="${NODE_H}" rx="8"/>
<rect x="${at.x}" y="${at.y}" width="6" height="${NODE_H}" rx="3" fill="${color}"/>
<text class="node-title" x="${at.x + 16}" y="${at.y + 24}">${escapeHtml(title)}</text>
<text class="node-sub" x="${at.x + 16}" y="${at.y + 42}">${escapeHtml(sub)}</text>
</g>
</a>`;
    })
    .join("");
  const states = [...new Set(graph.nodes.map((node) => node.state))];
  const legend = states
    .map(
      (state) =>
        `<li><span class="swatch" style="background:${STATE_COLOR[state] ?? "#8d8175"}"></span>${escapeHtml(state)}</li>`,
    )
    .join("");
  const stackNote = graph.edges.some((edge) => edge.stack)
    ? `<li class="stack-key"><span class="swatch dash"></span>stacked</li>`
    : "";
  return `<div class="graph">
<svg viewBox="0 0 ${placed.width} ${placed.height}" width="${placed.width}" height="${placed.height}" role="img" aria-label="Job dependencies">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M 0 1 L 9 5 L 0 9 z" fill="#8a7968"/>
</marker>
<marker id="arrow-stack" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M 0 1 L 9 5 L 0 9 z" fill="#c2410c"/>
</marker>
</defs>
${edges}
${nodes}
</svg>
<ul class="legend">${legend}${stackNote}</ul>
</div>`;
}

function placeGraph(nodes: GraphNode[], edges: GraphEdge[]): {
  width: number;
  height: number;
  pos: Map<string, { x: number; y: number }>;
} {
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.jobId, []);
  for (const edge of edges) incoming.get(edge.to)?.push(edge.from);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (incoming.get(id) ?? []).filter((dep) => incoming.has(dep));
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(rankOf));
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  for (const node of nodes) rankOf(node.jobId);
  const columns = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const rank = memo.get(node.jobId) ?? 0;
    const column = columns.get(rank) ?? [];
    column.push(node);
    columns.set(rank, column);
  }
  for (const column of columns.values()) column.sort((left, right) => left.jobId.localeCompare(right.jobId));
  const ranks = [...columns.keys()].sort((left, right) => left - right);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [column, rank] of ranks.entries()) {
    const list = columns.get(rank) ?? [];
    for (const [row, node] of list.entries()) {
      pos.set(node.jobId, {
        x: PAD + column * (NODE_W + GAP_X),
        y: PAD + row * (NODE_H + GAP_Y),
      });
    }
  }
  const tallest = Math.max(1, ...[...columns.values()].map((list) => list.length));
  const width = PAD * 2 + Math.max(1, ranks.length) * NODE_W + Math.max(0, ranks.length - 1) * GAP_X;
  const height = PAD * 2 + tallest * NODE_H + Math.max(0, tallest - 1) * GAP_Y;
  return { width, height, pos };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function document(options: {
  css: string;
  title: string;
  live: boolean;
  needsYou: number;
  revision: string;
  main: string;
  headerExtra?: string;
}): string {
  const script = options.live ? `<script>${LIVE_SCRIPT}</script>` : "";
  const attrs = options.live
    ? ` data-needs-you="${options.needsYou}" data-revision="${escapeHtml(options.revision)}"`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(options.title)}</title>
<style>
${options.css}
</style>
</head>
<body${attrs}>
<header class="top">
  <a class="kiln-mark" href="/">Kiln</a>
  ${options.headerExtra ?? ""}
  ${options.live ? `<p class="refresh">Checks every 3s</p>` : ""}
</header>
<main>
${options.main}
</main>
${script}
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
