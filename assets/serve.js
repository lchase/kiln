(function () {
  var KEY = "kiln-needs-you";
  var body = document.body;
  var board = document.getElementById("board");
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

  var compact = true;
  try { compact = localStorage.getItem("kiln-compact") !== "off"; } catch (err) { compact = true; }
  var repo = "";
  try { repo = localStorage.getItem("kiln-repo") || ""; } catch (err) { repo = ""; }

  var COMPACT = {
    on: ["expand empty columns", '<path d="M3 12h7m0 0-3-3m3 3-3 3M21 12h-7m0 0 3-3m-3 3 3 3M12 4v16"/>'],
    off: ["collapse empty columns", '<path d="M10 12H3m0 0 3-3m-3 3 3 3M14 12h7m0 0-3-3m3 3-3 3M12 4v16"/>'],
  };

  function renderCompact() {
    var pair = COMPACT[compact ? "on" : "off"];
    var button = document.getElementById("compact");
    if (!button) return;
    button.setAttribute("data-tip", pair[0]);
    button.setAttribute("aria-label", pair[0]);
    button.setAttribute("aria-pressed", compact ? "true" : "false");
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + pair[1] + "</svg>";
  }

  function layout() {
    if (!board) return;
    var tracks = [];
    var columns = board.querySelectorAll(".col");
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i];
      var cards = col.querySelectorAll(".card");
      var visible = 0;
      for (var c = 0; c < cards.length; c++) if (!cards[c].hidden) visible += 1;
      var slim = compact && visible === 0;
      col.classList.toggle("slim", slim);
      var fullCount = col.querySelector(".full .count");
      if (fullCount) fullCount.textContent = visible ? String(visible) : "";
      var slimCount = col.querySelector(".slim-face .count");
      if (slimCount) slimCount.textContent = String(visible);
      var empty = col.querySelector(".empty");
      if (empty) empty.hidden = visible !== 0;
      tracks.push(slim ? "40px" : "minmax(0, 1fr)");
    }
    board.style.setProperty("--cols", tracks.join(" "));
  }

  function applyRepo() {
    var cards = document.querySelectorAll(".board .card");
    for (var i = 0; i < cards.length; i++) {
      var cardRepo = cards[i].getAttribute("data-repo") || "";
      cards[i].hidden = Boolean(repo) && cardRepo !== repo;
    }
    var chips = document.querySelectorAll(".repo-f");
    for (var j = 0; j < chips.length; j++) {
      chips[j].setAttribute("aria-pressed", (chips[j].getAttribute("data-repo") || "") === repo ? "true" : "false");
    }
    layout();
  }

  function visibleSheet() {
    var sheets = document.querySelectorAll(".sheet");
    for (var i = 0; i < sheets.length; i++) if (!sheets[i].hidden) return sheets[i];
    return null;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function verdictTone(first) {
    if (/^(VERDICT:\s*PASS|APPROVE|STATUS:\s*READY)/.test(first)) return "good";
    if (/^VERDICT:\s*CHANGES/.test(first)) return "warn";
    if (/^(ESCALATE|STATUS:\s*BLOCKED|VERDICT:\s*ESCALATE|VERDICT:\s*BLOCKED)/.test(first)) return "stop";
    return "";
  }

  function inline(value) {
    var codes = [];
    var text = esc(value)
      .replace(/`([^`]+)`/g, function (_match, code) {
        codes.push(code);
        return "\u0000" + (codes.length - 1) + "\u0000";
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return text.replace(/\u0000(\d+)\u0000/g, function (_match, index) {
      return "<code>" + codes[Number(index)] + "</code>";
    });
  }

  function markdown(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var i = 0;
    var html = "";
    var tone = verdictTone(lines[0] ? lines[0].trim() : "");
    if (tone) {
      html += '<div class="verdict ' + tone + '">' + esc(lines[0].trim()) + "</div>";
      i = 1;
    }
    function isList(line) { return /^\s*([-*+]|\d+\.)\s+/.test(line); }
    function isBlock(line) { return /^(#{1,6}\s|```|\|)/.test(line) || isList(line); }
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      if (line.indexOf("```") === 0) {
        var fence = [];
        i += 1;
        while (i < lines.length && lines[i].indexOf("```") !== 0) fence.push(lines[i++]);
        i += 1;
        html += "<pre><code>" + esc(fence.join("\n")) + "</code></pre>";
        continue;
      }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        var level = Math.min(heading[1].length, 3);
        html += "<h" + level + ">" + inline(heading[2]) + "</h" + level + ">";
        i += 1;
        continue;
      }
      if (line.indexOf("|") === 0) {
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") === 0) rows.push(lines[i++]);
        html += "<table>";
        var bodyRow = 0;
        for (var r = 0; r < rows.length; r++) {
          if (/^\|[\s:|-]+\|$/.test(rows[r])) continue;
          var cells = rows[r].replace(/^\||\|$/g, "").split("|");
          var tag = bodyRow === 0 ? "th" : "td";
          html += "<tr>";
          for (var cell = 0; cell < cells.length; cell++) html += "<" + tag + ">" + inline(cells[cell].trim()) + "</" + tag + ">";
          html += "</tr>";
          bodyRow += 1;
        }
        html += "</table>";
        continue;
      }
      if (isList(line)) {
        var ordered = /^\s*\d+\./.test(line);
        var items = [];
        while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          var item = lines[i++];
          if (isList(item)) items.push(item.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
          else items[items.length - 1] += " " + item.trim();
        }
        html += ordered ? "<ol>" : "<ul>";
        for (var n = 0; n < items.length; n++) html += "<li>" + inline(items[n]) + "</li>";
        html += ordered ? "</ol>" : "</ul>";
        continue;
      }
      var paragraph = [];
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) paragraph.push(lines[i++]);
      html += "<p>" + inline(paragraph.join(" ")) + "</p>";
    }
    return html;
  }

  function renderFile(sheet) {
    var current = sheet.querySelector("button.file.on");
    var id = current ? current.getAttribute("data-file") || "" : "";
    var src = null;
    if (id && window.CSS && CSS.escape) src = sheet.querySelector('.src[data-file="' + CSS.escape(id) + '"]');
    var view = sheet.querySelector("[data-view]");
    if (!view) return;
    var text = src ? src.textContent || "" : "";
    view.innerHTML = text ? markdown(localizeIso(text)) : '<p class="empty">Nothing written yet.</p>';
  }

  function localTime(iso, withDate) {
    var date = new Date(iso);
    if (!isFinite(date.getTime())) return iso;
    if (!withDate) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return date.toLocaleString();
  }

  function localizeIso(text) {
    return String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, function (iso) {
      return localTime(iso, true);
    });
  }

  function localizeTimes(root) {
    var nodes = (root || document).querySelectorAll("time[datetime]");
    for (var i = 0; i < nodes.length; i++) {
    var iso = nodes[i].getAttribute("datetime");
    if (iso) nodes[i].textContent = localTime(iso, nodes[i].getAttribute("data-time") !== "clock");
    }
  }

  function openJob(id) {
    if (!id) return;
    var sheets = document.querySelectorAll(".sheet");
    var found = null;
    for (var i = 0; i < sheets.length; i++) {
      var match = sheets[i].getAttribute("data-job") === id;
      sheets[i].hidden = !match;
      if (match) found = sheets[i];
    }
    if (!found) return;
    body.classList.add("open");
    renderFile(found);
    try { localStorage.setItem("kiln-drawer", id); } catch (err) { /* private mode */ }
  }

  function closeDrawer() {
    body.classList.remove("open");
    var sheets = document.querySelectorAll(".sheet");
    for (var i = 0; i < sheets.length; i++) sheets[i].hidden = true;
    try { localStorage.removeItem("kiln-drawer"); } catch (err) { /* private mode */ }
  }

  function notifyLabel() {
    var button = document.getElementById("notify");
    if (!button) return;
    if (typeof Notification === "undefined") {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    if (Notification.permission === "granted") {
      button.setAttribute("data-tip", "Notifications on");
      button.setAttribute("aria-label", "Notifications on");
    } else if (Notification.permission === "denied") {
      button.setAttribute("data-tip", "Notifications blocked");
      button.setAttribute("aria-label", "Notifications blocked");
    } else {
      button.setAttribute("data-tip", "Notify me");
      button.setAttribute("aria-label", "Notify me");
    }
  }

  var titleDirty = false;
  var sourceKind = "prompt";
  var specPath = "";
  var ticketsDir = "";
  var fsPath = "";
  var sending = false;
  var FS_KEY = "kiln-fs-dir";

  function selectedRepo() {
    var pressed = document.querySelector("#repo-pick .pick[aria-pressed='true']");
    return pressed ? pressed.getAttribute("data-repo") || "" : "";
  }

  function intakeRepoPath() {
    var pressed = document.querySelector("#repo-pick .pick[aria-pressed='true']");
    return pressed ? pressed.getAttribute("data-path") || "" : "";
  }

  function showIntakeError(message) {
    var el = document.getElementById("intake-error");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
  }

  function titleFromPrompt(text) {
    var lines = String(text).split(/\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.length <= 80) return line;
      return line.slice(0, 77) + "...";
    }
    return "";
  }

  function titleFromMarkdown(text) {
    var lines = String(text).split(/\n/);
    for (var i = 0; i < lines.length; i++) {
      var match = /^#\s+(.+?)\s*$/.exec(lines[i]);
      if (match) return match[1];
    }
    return "";
  }

  function setPicked(text) {
    var el = document.getElementById("picked");
    if (el) el.textContent = text || "";
  }

  function renderListing(data) {
    fsPath = data.path || "";
    try { localStorage.setItem(FS_KEY, fsPath); } catch (err) { /* private mode */ }
    var host = document.getElementById("browser");
    if (!host) return;
    var html = '<div class="branch">' + esc(fsPath) + "</div>";
    if (data.parent) html += '<button type="button" class="fs-up" data-path="' + esc(data.parent) + '">Up</button>';
    var entries = data.entries || [];
    html += '<div class="fs-list">';
    if (!entries.length) html += '<div class="empty">Nothing here.</div>';
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      html += '<button type="button" class="fs-item" data-kind="' + esc(entry.kind) + '" data-path="' + esc(entry.path) + '">' + esc(entry.name) + "</button>";
    }
    html += "</div>";
    if (sourceKind === "tickets") html += '<button type="button" class="fs-use" data-path="' + esc(fsPath) + '">Use this folder</button>';
    host.innerHTML = html;
    if (sourceKind === "tickets") setPicked(fsPath);
  }

  function chooseSpec(data) {
    specPath = data.path || "";
    setPicked(specPath);
    if (!titleDirty) {
      var heading = titleFromMarkdown(data.preview || "");
      var input = document.getElementById("job-title");
      if (input && heading) input.value = heading;
    }
  }

  function loadFs(path, fallback) {
    var query = path ? "?path=" + encodeURIComponent(path) : "";
    fetch("/api/fs" + query, { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          if (fallback && path) {
            loadFs("", false);
            return;
          }
          showIntakeError((result.data && result.data.error) || "Could not list that directory.");
          return;
        }
        showIntakeError("");
        if (result.data.kind === "file") chooseSpec(result.data);
        else renderListing(result.data);
      })
      .catch(function () { showIntakeError("Could not list that directory."); });
  }

  function openBrowser() {
    var start = "";
    try { start = localStorage.getItem(FS_KEY) || ""; } catch (err) { start = ""; }
    if (!start) start = intakeRepoPath();
    loadFs(start, true);
  }

  function setSource(kind) {
    sourceKind = kind || "prompt";
    var buttons = document.querySelectorAll("#add-form [data-source]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-source") === sourceKind ? "true" : "false");
    }
    var panes = document.querySelectorAll("#add-form [data-pane]");
    for (var j = 0; j < panes.length; j++) panes[j].hidden = panes[j].getAttribute("data-pane") !== sourceKind;
    var browserField = document.getElementById("browser-field");
    if (browserField) browserField.hidden = sourceKind !== "spec" && sourceKind !== "tickets";
    var label = document.getElementById("browser-label");
    if (label) label.textContent = sourceKind === "tickets" ? "Tickets folder" : "Spec file";
    var titleField = document.getElementById("title-field");
    var afterField = document.getElementById("after-field");
    var preview = document.getElementById("preview-job");
    if (titleField) titleField.hidden = sourceKind === "tickets";
    if (afterField) afterField.hidden = sourceKind === "tickets";
    if (preview) preview.hidden = sourceKind !== "tickets";
    var pre = document.getElementById("intake-preview");
    if (pre) { pre.hidden = true; pre.textContent = ""; }
    showIntakeError("");
    if (sourceKind === "prompt" && !titleDirty) {
      var promptBox = document.getElementById("prompt-text");
      var title = document.getElementById("job-title");
      if (promptBox && title) title.value = titleFromPrompt(promptBox.value);
    }
    if (sourceKind === "spec" || sourceKind === "tickets") openBrowser();
  }

  function openIntake() {
    var sheets = document.querySelectorAll(".sheet");
    for (var i = 0; i < sheets.length; i++) sheets[i].hidden = sheets[i].id !== "intake";
    body.classList.add("open");
    try { localStorage.removeItem("kiln-drawer"); } catch (err) { /* private mode */ }
    setSource(sourceKind || "prompt");
  }

  function sourceBody() {
    if (sourceKind === "prompt") {
      var promptBox = document.getElementById("prompt-text");
      return { kind: "prompt", text: promptBox ? promptBox.value : "" };
    }
    if (sourceKind === "spec") return { kind: "spec", path: specPath };
    if (sourceKind === "tickets") return { kind: "tickets", dir: ticketsDir || fsPath };
    var key = document.getElementById("jira-key");
    return { kind: "jira", key: key ? key.value.trim() : "" };
  }

  function submitIntake(dryRun) {
    if (sending) return;
    var repo = selectedRepo();
    var workflow = document.getElementById("workflow");
    var source = sourceBody();
    if (!repo) { showIntakeError("Name a repo."); return; }
    if (source.kind === "prompt" && !String(source.text || "").trim()) { showIntakeError("Prompt is empty."); return; }
    if (source.kind === "spec" && !source.path) { showIntakeError("Choose a spec file."); return; }
    if (source.kind === "tickets" && !source.dir) { showIntakeError("Choose a tickets folder."); return; }
    if (source.kind === "jira" && !source.key) { showIntakeError("Enter a Jira key."); return; }
    var payload = { repo: repo, workflow: workflow ? workflow.value : "", source: source };
    if (dryRun) payload.dryRun = true;
    if (sourceKind !== "tickets") {
      var title = document.getElementById("job-title");
      if (title && titleDirty) payload.title = title.value;
      var checked = document.querySelectorAll("#after-list input:checked");
      if (checked.length) {
        payload.after = [];
        for (var i = 0; i < checked.length; i++) payload.after.push(checked[i].value);
      }
    }
    sending = true;
    showIntakeError("");
    fetch("/api/jobs", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Kiln-CSRF": body.getAttribute("data-csrf") || "",
      },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        sending = false;
        if (!result.ok) {
          showIntakeError((result.data && result.data.error) || "Could not add the job.");
          return;
        }
        if (dryRun) {
          var pre = document.getElementById("intake-preview");
          if (pre) {
            pre.hidden = false;
            pre.textContent = (result.data && result.data.report) || "";
          }
          return;
        }
        var ids = (result.data && result.data.ids) || [];
        try { sessionStorage.setItem("kiln-fresh", JSON.stringify(ids)); } catch (err) { /* private mode */ }
        closeDrawer();
        location.reload();
      })
      .catch(function () {
        sending = false;
        showIntakeError("Could not add the job.");
      });
  }

  function applyLiveConfig(data) {
    var el = document.getElementById("config-error");
    if (el) {
      if (data && data.configError) {
        el.hidden = false;
        el.textContent = data.configError;
      } else {
        el.hidden = true;
        el.textContent = "";
      }
    }
    if (!data || !Array.isArray(data.repos)) return;
    var box = document.getElementById("repo-pick");
    if (!box) return;
    var current = selectedRepo();
    var still = false;
    var html = "";
    if (!data.repos.length) html = '<p class="empty">No repos are registered.</p>';
    for (var i = 0; i < data.repos.length; i++) {
      var repo = data.repos[i];
      if (!repo || !repo.name) continue;
      if (repo.name === current) still = true;
    }
    if (data.repos.length) {
      html = "";
      for (var j = 0; j < data.repos.length; j++) {
        var item = data.repos[j];
        var pressed = still ? item.name === current : j === 0;
        html += '<button type="button" class="pick" data-repo="' + esc(item.name) + '" data-path="' + esc(item.path || "") + '" aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(item.name) + "</button>";
      }
    }
    if (box.getAttribute("data-repos") === html) return;
    box.setAttribute("data-repos", html);
    box.innerHTML = html;
  }

  function showFresh() {
    var raw = null;
    try { raw = sessionStorage.getItem("kiln-fresh"); } catch (err) { raw = null; }
    if (!raw) return;
    try { sessionStorage.removeItem("kiln-fresh"); } catch (err) { /* private mode */ }
    var ids = [];
    try { ids = JSON.parse(raw); } catch (err) { return; }
    if (!ids || !ids.length) return;
    for (var i = 0; i < ids.length; i++) {
      var card = document.getElementById("job-" + ids[i]);
      if (!card) continue;
      card.classList.add("fresh");
      if (i === 0 && card.scrollIntoView) card.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest("#add-job")) {
      openIntake();
      return;
    }
    var sourceBtn = target.closest("#add-form [data-source]");
    if (sourceBtn) {
      setSource(sourceBtn.getAttribute("data-source") || "prompt");
      return;
    }
    var pick = target.closest("#repo-pick .pick");
    if (pick) {
      var picks = document.querySelectorAll("#repo-pick .pick");
      for (var p = 0; p < picks.length; p++) picks[p].setAttribute("aria-pressed", picks[p] === pick ? "true" : "false");
      return;
    }
    var fsButton = target.closest(".fs-item, .fs-up, .fs-use");
    if (fsButton) {
      var next = fsButton.getAttribute("data-path") || "";
      if (fsButton.classList.contains("fs-use")) {
        ticketsDir = next;
        setPicked(next);
        return;
      }
      loadFs(next, false);
      return;
    }
    if (target.closest("#compact")) {
      compact = !compact;
      try { localStorage.setItem("kiln-compact", compact ? "on" : "off"); } catch (err) { /* private mode */ }
      renderCompact();
      layout();
      return;
    }
    if (target.closest("#notify")) {
      if (typeof Notification === "undefined" || Notification.permission !== "default") return;
      Notification.requestPermission().then(notifyLabel);
      return;
    }
    var act = target.closest("[data-act]");
    if (act) {
      var name = act.getAttribute("data-act");
      var sheet = visibleSheet();
      if (!sheet || !name) return;
      if (name === "pr") {
        var url = sheet.getAttribute("data-pr");
        if (url) window.open(url, "_blank", "noopener");
        return;
      }
      var form = sheet.querySelector("form." + name);
      if (form && form.submit) form.submit();
      return;
    }
    var chip = target.closest(".repo-f");
    if (chip) {
      repo = chip.getAttribute("data-repo") || "";
      try {
        if (repo) localStorage.setItem("kiln-repo", repo);
        else localStorage.removeItem("kiln-repo");
      } catch (err) { /* private mode */ }
      applyRepo();
      return;
    }
    if (target.closest("a[href]")) return;
    if (target.closest("[data-close]")) {
      closeDrawer();
      return;
    }
    var file = target.closest("button.file");
    if (file) {
      var fileSheet = file.closest(".sheet");
      if (!fileSheet) return;
      var buttons = fileSheet.querySelectorAll("button.file");
      for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle("on", buttons[i] === file);
      var doc = fileSheet.querySelector(".doc");
      if (doc) doc.scrollTop = 0;
      renderFile(fileSheet);
      return;
    }
    var card = target.closest(".card");
    if (card) openJob(card.getAttribute("data-job") || "");
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeDrawer();
    var el = event.target;
    if ((event.key === "Enter" || event.key === " ") && el && el.classList && el.classList.contains("card")) {
      event.preventDefault();
      openJob(el.getAttribute("data-job") || "");
    }
  });

  function stamp(ok) {
    var el = document.getElementById("status");
    if (!el) return;
    if (!ok) {
      el.className = "status err";
      el.textContent = "Failed to fetch";
      return;
    }
    el.className = "status";
    var jobs = document.querySelectorAll(".board .card").length;
    el.textContent = jobs + (jobs === 1 ? " job · " : " jobs · ") + new Date().toLocaleTimeString();
    localizeTimes(document);
  }

  function poll() {
    fetch("/api/jobs", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("status");
        return response.json();
      })
      .then(function (data) {
        applyLiveConfig(data);
        var rev = data && data.attention && data.attention.revision;
        var current = body.getAttribute("data-revision");
        if (rev && current && rev !== current) {
          location.reload();
          return;
        }
        stamp(true);
      })
      .catch(function () { stamp(false); });
  }

  var promptBox = document.getElementById("prompt-text");
  if (promptBox) {
    promptBox.addEventListener("input", function () {
      if (titleDirty || sourceKind !== "prompt") return;
      var input = document.getElementById("job-title");
      if (input) input.value = titleFromPrompt(promptBox.value);
    });
  }
  var titleInput = document.getElementById("job-title");
  if (titleInput) titleInput.addEventListener("input", function () { titleDirty = true; });
  var addForm = document.getElementById("add-form");
  if (addForm) addForm.addEventListener("submit", function (event) {
    event.preventDefault();
    submitIntake(false);
  });
  var previewBtn = document.getElementById("preview-job");
  if (previewBtn) previewBtn.addEventListener("click", function () { submitIntake(true); });
  showFresh();
  renderCompact();
  notifyLabel();
  applyRepo();
  stamp(true);
  try {
    var open = localStorage.getItem("kiln-drawer");
    if (open) openJob(open);
  } catch (err) { /* private mode */ }
  poll();
  setInterval(poll, 3000);
})();
