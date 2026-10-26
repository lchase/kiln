import type { AttentionItem, AttentionView, GraphEdge, GraphNode } from "./attention.js";
import { INVESTIGATION_WORKFLOW } from "./findings.js";
import type { StatusJobView, StepProgress } from "./report.js";

const NODE_W = 184;
const NODE_H = 58;
const GAP_X = 72;
const GAP_Y = 18;
const PAD = 20;
const DONE_CAP = 4;

const STATE_COLOR: Record<string, string> = {
  queued: "#94a3b8",
  blocked: "#fbbf24",
  running: "#38bdf8",
  "needs-human": "#fbbf24",
  approved: "#38bdf8",
  rejected: "#94a3b8",
  failed: "#fb7185",
  dead: "#fb7185",
  "in-review": "#a78bfa",
  done: "#34d399",
  invalid: "#fb7185",
  missing: "#64748b",
};

const LIVE_SCRIPT = `
(function () {
  var KEY = "kiln-needs-you";
  var body = document.body;
  var board = document.getElementById("board");
  var drawer = document.getElementById("drawer");
  var scrim = document.getElementById("scrim");
  var graphPanel = document.getElementById("graph-panel");
  var graphToggle = document.getElementById("graph-toggle");
  var count = Number(body.getAttribute("data-needs-you") || "0");
  document.title = "(" + count + ") Kiln";
  var selected = null;
  var hoverId = null;

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

  function depsOf(el) {
    return (el.getAttribute("data-deps") || "").split(/\\s+/).filter(Boolean);
  }

  function family(id) {
    var up = [];
    var down = [];
    if (!id) return { up: up, down: down };
    var cards = document.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var job = card.getAttribute("data-job");
      var deps = depsOf(card);
      if (job === id) up = deps;
      if (deps.indexOf(id) !== -1 && job) down.push(job);
    }
    return { up: up, down: down };
  }

  function paint(id) {
    var fam = family(id);
    var hot = {};
    if (id) hot[id] = "selected";
    for (var u = 0; u < fam.up.length; u++) hot[fam.up[u]] = hot[fam.up[u]] || "upstream";
    for (var d = 0; d < fam.down.length; d++) hot[fam.down[d]] = hot[fam.down[d]] || "downstream";
    if (board) board.classList.toggle("lit", Boolean(id));
    if (graphPanel) graphPanel.classList.toggle("lit", Boolean(id));
    var cards = document.querySelectorAll(".card, .node-link");
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      el.classList.remove("selected", "upstream", "downstream");
      var job = el.getAttribute("data-job");
      if (job && hot[job]) el.classList.add(hot[job]);
    }
    var edges = document.querySelectorAll(".edge");
    for (var e = 0; e < edges.length; e++) {
      var edge = edges[e];
      var from = edge.getAttribute("data-from");
      var to = edge.getAttribute("data-to");
      var on = Boolean(id) && ((from && hot[from]) || (to && hot[to]));
      edge.classList.toggle("hot", on);
    }
  }

  function focusId() {
    return hoverId || selected;
  }

  function openDrawer(id) {
    if (!drawer || !id) return;
    var panels = drawer.querySelectorAll(".drawer-panel");
    var found = false;
    for (var i = 0; i < panels.length; i++) {
      var on = panels[i].getAttribute("data-job") === id;
      panels[i].hidden = !on;
      if (on) found = true;
    }
    if (!found) return;
    selected = id;
    drawer.hidden = false;
    if (scrim) scrim.hidden = false;
    body.classList.add("drawer-open");
    paint(focusId());
    try { sessionStorage.setItem("kiln-drawer", id); } catch (err) { /* private mode */ }
  }

  function closeDrawer() {
    selected = null;
    if (drawer) drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    body.classList.remove("drawer-open");
    var panels = document.querySelectorAll(".drawer-panel");
    for (var i = 0; i < panels.length; i++) panels[i].hidden = true;
    paint(focusId());
    try { sessionStorage.removeItem("kiln-drawer"); } catch (err) { /* private mode */ }
  }

  function setGraph(open) {
    if (!graphPanel) return;
    graphPanel.hidden = !open;
    if (graphToggle) graphToggle.setAttribute("aria-expanded", open ? "true" : "false");
    try { sessionStorage.setItem("kiln-graph", open ? "1" : "0"); } catch (err) { /* private mode */ }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest("#drawer-close") || target.closest("#scrim")) {
      closeDrawer();
      return;
    }
    if (target.closest("#graph-toggle")) {
      setGraph(graphPanel ? graphPanel.hidden : false);
      return;
    }
    if (target.closest("#graph-close")) {
      setGraph(false);
      return;
    }
    var opener = target.closest(".card-open");
    if (opener) {
      var card = opener.closest(".card");
      if (card) openDrawer(card.getAttribute("data-job"));
      return;
    }
    var link = target.closest("a[href^='#job-']");
    if (!link) return;
    var href = link.getAttribute("href") || "";
    var id = decodeURIComponent(href.slice("#job-".length));
    var panels = document.querySelectorAll(".drawer-panel");
    var known = false;
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].getAttribute("data-job") === id) known = true;
    }
    if (!known) return;
    event.preventDefault();
    openDrawer(id);
  });

  if (board) {
    board.addEventListener("mouseover", function (event) {
      var card = event.target && event.target.closest ? event.target.closest(".card") : null;
      hoverId = card ? card.getAttribute("data-job") : hoverId;
      if (card) paint(focusId());
    });
    board.addEventListener("mouseout", function (event) {
      var card = event.target && event.target.closest ? event.target.closest(".card") : null;
      if (!card) return;
      var next = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest(".card") : null;
      if (next === card) return;
      hoverId = null;
      paint(focusId());
    });
  }
  if (graphPanel) {
    graphPanel.addEventListener("mouseover", function (event) {
      var node = event.target && event.target.closest ? event.target.closest(".node-link") : null;
      if (!node) return;
      hoverId = node.getAttribute("data-job");
      paint(focusId());
    });
    graphPanel.addEventListener("mouseout", function (event) {
      var node = event.target && event.target.closest ? event.target.closest(".node-link") : null;
      if (!node) return;
      var next = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest(".node-link") : null;
      if (next === node) return;
      hoverId = null;
      paint(focusId());
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (selected) closeDrawer();
    else setGraph(false);
  });

  try {
    var storedGraph = sessionStorage.getItem("kiln-graph");
    if (storedGraph === "1") setGraph(true);
    var storedDrawer = sessionStorage.getItem("kiln-drawer");
    if (storedDrawer) openDrawer(storedDrawer);
  } catch (err) { /* private mode */ }

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
        applyTails(attention.needsYou);
        applyTails(attention.inFlight);
        applyTails(attention.doneRecently);
      })
      .catch(function () { /* the next poll retries */ });
  }
  setInterval(poll, 3000);
})();
`;

export function renderConsole(css: string, attention: AttentionView): string {
  const n = attention.needsYouCount;
  const countLabel = n === 1 ? "1 job needs you" : `${n} jobs need you`;
  const columns = boardColumns(attention);
  const drawers = columns.flatMap((column) => column.items).map(renderDrawer).join("\n");
  return document({
    css,
    title: `(${n}) Kiln`,
    live: true,
    needsYou: n,
    revision: attention.revision,
    main: `<div class="board" id="board">
${columns.map(renderColumn).join("\n")}
</div>
<div id="graph-panel" hidden>
<div class="panel-bar"><h2>Dependencies</h2><button type="button" id="graph-close">Close</button></div>
${renderGraph(attention)}
</div>
<aside id="drawer" hidden>
<div class="panel-bar"><h2>Job</h2><button type="button" id="drawer-close">Close</button></div>
${drawers}
</aside>
<div id="scrim" hidden></div>`,
    headerExtra: `<p class="needs-count" id="needs-count">${escapeHtml(countLabel)}</p>
<button type="button" id="graph-toggle" aria-expanded="false" aria-controls="graph-panel">Graph</button>
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

interface BoardColumn {
  id: string;
  title: string;
  tone: string;
  items: AttentionItem[];
  showElapsed: boolean;
  cap?: number;
}

function boardColumns(attention: AttentionView): BoardColumn[] {
  const running = new Set(["running", "approved"]);
  return [
    {
      id: "needs-you",
      title: "Needs you",
      tone: "amber",
      items: attention.needsYou.filter((item) => item.job.state !== "in-review"),
      showElapsed: false,
    },
    {
      id: "running",
      title: "Running",
      tone: "sky",
      items: attention.inFlight.filter((item) => running.has(item.job.state)),
      showElapsed: true,
    },
    {
      id: "up-next",
      title: "Up next",
      tone: "slate",
      items: attention.inFlight.filter((item) => !running.has(item.job.state)),
      showElapsed: false,
    },
    {
      id: "in-review",
      title: "In review",
      tone: "violet",
      items: attention.needsYou.filter((item) => item.job.state === "in-review"),
      showElapsed: false,
    },
    {
      id: "done",
      title: "Done",
      tone: "emerald",
      items: attention.doneRecently,
      showElapsed: false,
      cap: DONE_CAP,
    },
  ];
}

function renderColumn(column: BoardColumn): string {
  const visible = column.cap === undefined ? column.items : column.items.slice(0, column.cap);
  const rest = column.cap === undefined ? [] : column.items.slice(column.cap);
  const more =
    rest.length === 0
      ? ""
      : `<details class="done-more"><summary>Show more</summary>${rest.map((item) => renderCard(item, column.showElapsed)).join("\n")}</details>`;
  const body =
    column.items.length === 0
      ? `<p class="empty">Nothing here.</p>`
      : `${visible.map((item) => renderCard(item, column.showElapsed)).join("\n")}
${more}`;
  return `<section class="column tone-${column.tone}" id="${column.id}">
<header class="column-head"><h2>${escapeHtml(column.title)}</h2><span class="count">${column.items.length}</span></header>
<div class="column-body">
${body}
</div>
</section>`;
}

function renderCard(item: AttentionItem, showElapsed: boolean): string {
  const job = item.job;
  const deps = job.dependsOn.map((dep) => dep.jobId).join(" ");
  const time = showElapsed ? elapsedHtml(item.since) : "";
  return `<article class="card tone-${escapeHtml(job.state)}" id="job-${escapeHtml(job.jobId)}" data-job="${escapeHtml(job.jobId)}" data-deps="${escapeHtml(deps)}">
<button type="button" class="card-open">
<p class="kicker"><span class="repo">${escapeHtml(job.repo || "job")}</span> <span class="badge">${escapeHtml(job.workflow || "job")}</span> <span class="chip state-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></p>
<h2>${escapeHtml(job.title || job.jobId)}</h2>
<p class="reason">${escapeHtml(item.reason)}</p>
${stepStrip(job.steps)}
${time}
</button>
${inlineActions(item)}
</article>`;
}

function renderDrawer(item: AttentionItem): string {
  const job = item.job;
  const question = gateBody(job);
  const findings = item.findings
    ? `<h3>Findings</h3><pre class="excerpt">${escapeHtml(item.findings)}</pre>`
    : "";
  const diff = !item.findings && job.diffSummary
    ? `<h3>Diff</h3><pre class="excerpt">${escapeHtml(job.diffSummary)}</pre>`
    : "";
  const tail = item.errorTail ? `<pre class="tail">${escapeHtml(item.errorTail)}</pre>` : "";
  const pr = job.prUrl ? renderPr(job.prUrl) : "";
  return `<div class="drawer-panel" data-job="${escapeHtml(job.jobId)}" hidden>
<p class="kicker"><span class="repo">${escapeHtml(job.repo || "job")}</span> <span class="badge">${escapeHtml(job.workflow || "job")}</span> <span class="chip state-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></p>
<h2>${escapeHtml(job.title || job.jobId)}</h2>
<p class="meta"><code>${escapeHtml(job.jobId)}</code></p>
<p class="reason">${escapeHtml(item.reason)}</p>
${stepStrip(job.steps)}
${elapsedHtml(item.since)}
${question}
${findings}
${diff}
${reviews(job)}
${artifacts(job)}
${tail}
${pr}
${depends(job)}
${resourceLinks(job)}
${logBlock(job)}
${actionForms(item)}
</div>`;
}

function inlineActions(item: AttentionItem): string {
  const forms: string[] = [];
  const id = encodeURIComponent(item.job.jobId);
  if (item.job.canApprove) {
    forms.push(
      `<form method="post" action="/api/jobs/${id}/approve"><button class="approve" type="submit">Approve</button></form>`,
    );
  }
  if (item.retry) {
    forms.push(`<form method="post" action="/api/jobs/${id}/retry"><button class="retry" type="submit">Retry</button></form>`);
  }
  if (forms.length === 0) return "";
  return `<div class="card-actions">${forms.join("")}</div>`;
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

function logBlock(job: StatusJobView): string {
  if (!job.logTail && !job.logPath) return "";
  const body = job.logTail ? escapeHtml(job.logTail) : "No log yet.";
  return `<h3>Log</h3><pre class="log" id="log-${escapeHtml(job.jobId)}">${body}</pre>`;
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
      return `<path class="${cls}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" d="${d}" marker-end="${marker}"/>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node) => {
      const at = placed.pos.get(node.jobId);
      if (!at) return "";
      const color = STATE_COLOR[node.state] ?? "#94a3b8";
      const title = clip(node.title || node.jobId, 22);
      const sub = clip(node.repo ? `${node.repo} · ${node.state}` : node.state, 26);
      return `<a class="node-link" data-job="${escapeHtml(node.jobId)}" href="#job-${encodeURIComponent(node.jobId)}">
<g class="node">
<rect x="${at.x}" y="${at.y}" width="${NODE_W}" height="${NODE_H}" rx="8"/>
<rect class="bar" x="${at.x}" y="${at.y}" width="6" height="${NODE_H}" rx="3" fill="${color}"/>
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
        `<li><span class="swatch" style="background:${STATE_COLOR[state] ?? "#94a3b8"}"></span>${escapeHtml(state)}</li>`,
    )
    .join("");
  const stackNote = graph.edges.some((edge) => edge.stack)
    ? `<li class="stack-key"><span class="swatch dash"></span>stacked</li>`
    : "";
  return `<div class="graph">
<svg viewBox="0 0 ${placed.width} ${placed.height}" width="${placed.width}" height="${placed.height}" role="img" aria-label="Job dependencies">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M 0 1 L 9 5 L 0 9 z" fill="#94a3b8"/>
</marker>
<marker id="arrow-stack" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M 0 1 L 9 5 L 0 9 z" fill="#fbbf24"/>
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
