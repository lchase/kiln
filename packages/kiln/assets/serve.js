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
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
  var issueDirty = false;
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
    var issueField = document.getElementById("issue-field");
    var afterField = document.getElementById("after-field");
    var preview = document.getElementById("preview-job");
    if (titleField) titleField.hidden = sourceKind === "tickets";
    if (issueField) issueField.hidden = sourceKind === "tickets";
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
    syncIssueDefault();
    if (sourceKind === "spec" || sourceKind === "tickets") openBrowser();
  }

  function syncIssueDefault() {
    var input = document.getElementById("job-issue");
    if (!input || issueDirty) return;
    if (sourceKind !== "jira") {
      input.value = "";
      return;
    }
    var key = document.getElementById("jira-key");
    input.value = key ? key.value.trim().toUpperCase() : "";
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
      var issue = document.getElementById("job-issue");
      if (issue && issue.value.trim()) payload.issue = issue.value.trim();
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

  var settingsDoc = null;
  var repoDraft = {};
  var editing = null;
  var settingsSaving = false;
  var settingsDefaults = {};

  function showSettingsError(message) {
    var el = document.getElementById("settings-error");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
  }

  function markSettingsDirty() {
    var saved = document.getElementById("settings-saved");
    if (saved) saved.hidden = true;
  }

  function clearSettingsErrors() {
    var nodes = document.querySelectorAll("#settings .field-error");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].hidden = true;
      nodes[i].textContent = "";
    }
    showSettingsError("");
  }

  function showSlot(name, message) {
    var slot = document.querySelector('#settings [data-error="' + name + '"]');
    if (!slot) return;
    slot.hidden = !message;
    slot.textContent = message || "";
    if (message && slot.scrollIntoView) slot.scrollIntoView({ block: "nearest" });
  }

  function setSettingsTab(tab) {
    var repos = document.getElementById("settings-repos");
    var globalPane = document.getElementById("settings-global");
    if (repos) repos.hidden = tab !== "repos";
    if (globalPane) globalPane.hidden = tab !== "global";
    var buttons = document.querySelectorAll("#settings-form [data-settings-tab]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-settings-tab") === tab ? "true" : "false");
    }
  }

  function setPressed(selector, attr, value) {
    var buttons = document.querySelectorAll(selector);
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute(attr) === value ? "true" : "false");
    }
  }

  function selectedAttr(selector, attr, fallback) {
    var pressed = document.querySelector(selector + '[aria-pressed="true"]');
    return pressed ? pressed.getAttribute(attr) || fallback : fallback;
  }

  function cloneRepos(repos) {
    var out = {};
    var names = Object.keys(repos || {});
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var repo = repos[name] || {};
      out[name] = {
        path: repo.path || "",
        test: repo.test || "",
        deliver: repo.deliver === "pr" ? "pr" : "local",
        base: repo.base || "",
        prTitle: repo.prTitle || "",
        branch: repo.branch || "",
        maxAttempts: repo.maxAttempts != null ? String(repo.maxAttempts) : "",
        maxFixRounds: repo.maxFixRounds != null ? String(repo.maxFixRounds) : "",
      };
    }
    return out;
  }

  function fillHints(defaults) {
    settingsDefaults = defaults || {};
    var pr = document.getElementById("hint-pr-title");
    var branch = document.getElementById("hint-branch");
    var title = settingsDefaults.prTitle || "[{issue}] {title}";
    var template = settingsDefaults.branch || "{issue}-{slug}";
    if (pr) pr.textContent = "Default " + title + ", which renders as [ABC-123] Title.";
    if (branch) branch.textContent = "Default " + template + ", which renders as ABC-123-slug.";
    var prInput = document.getElementById("repo-pr-title");
    var branchInput = document.getElementById("repo-branch");
    if (prInput) prInput.placeholder = title;
    if (branchInput) branchInput.placeholder = template;
    var attempts = document.getElementById("hint-attempts");
    var stall = document.getElementById("hint-stall");
    var rounds = document.getElementById("hint-fix");
    if (attempts) attempts.textContent = "Default " + (settingsDefaults.maxAttempts != null ? settingsDefaults.maxAttempts : 3) + ". Transient failures before the job needs a person.";
    var fingerprint = document.getElementById("hint-fingerprint");
    var cap = document.getElementById("hint-cap");
    if (fingerprint) fingerprint.textContent = "Default " + (settingsDefaults.maxSameFingerprint != null ? settingsDefaults.maxSameFingerprint : 3) + ". Identical fingerprints before the job needs a person.";
    if (cap) cap.textContent = "Empty means no daily cap. Recorded dollars, local day.";
    if (stall) stall.textContent = "Default " + (settingsDefaults.stallTimeoutMs != null ? settingsDefaults.stallTimeoutMs : 900000) + " (15 minutes). 0 disables stall detection.";
    if (rounds) rounds.textContent = "Default " + (settingsDefaults.maxFixRounds != null ? settingsDefaults.maxFixRounds : 2) + ". Fix rounds before the job needs a person.";
    var attemptInput = document.getElementById("max-attempts");
    var stallInput = document.getElementById("stall-timeout");
    var roundInput = document.getElementById("max-fix-rounds");
    if (attemptInput) attemptInput.placeholder = String(settingsDefaults.maxAttempts != null ? settingsDefaults.maxAttempts : 3);
    if (stallInput) stallInput.placeholder = String(settingsDefaults.stallTimeoutMs != null ? settingsDefaults.stallTimeoutMs : 900000);
    if (roundInput) roundInput.placeholder = String(settingsDefaults.maxFixRounds != null ? settingsDefaults.maxFixRounds : 2);
    var fingerprintInput = document.getElementById("max-same-fingerprint");
    if (fingerprintInput) fingerprintInput.placeholder = String(settingsDefaults.maxSameFingerprint != null ? settingsDefaults.maxSameFingerprint : 3);
  }

  function fillGlobal(data) {
    fillHints(data.defaults || {});
    var attempts = document.getElementById("max-attempts");
    var stall = document.getElementById("stall-timeout");
    var rounds = document.getElementById("max-fix-rounds");
    if (attempts) attempts.value = data.maxAttempts != null ? String(data.maxAttempts) : "";
    if (stall) stall.value = data.stallTimeoutMs != null ? String(data.stallTimeoutMs) : "";
    if (rounds) rounds.value = data.maxFixRounds != null ? String(data.maxFixRounds) : "";
    var fingerprint = document.getElementById("max-same-fingerprint");
    var cap = document.getElementById("daily-dollar-cap");
    if (fingerprint) fingerprint.value = data.maxSameFingerprint != null ? String(data.maxSameFingerprint) : "";
    if (cap) cap.value = data.dailyDollarCap != null ? String(data.dailyDollarCap) : "";
    setPressed("#sandbox-mode [data-sandbox]", "data-sandbox", data.sandbox && data.sandbox.mode === "docker" ? "docker" : "off");
    var domains = document.getElementById("sandbox-domains");
    if (domains) domains.value = data.sandbox && data.sandbox.allowDomains ? data.sandbox.allowDomains.join("\n") : "";
  }

  function renderRepoList() {
    var host = document.getElementById("repo-list");
    if (!host) return;
    var names = Object.keys(repoDraft).sort();
    var html = "";
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (editing && editing.original === name) continue;
      var repo = repoDraft[name];
      var bits = [repo.deliver || "local"];
      if (repo.base) bits.push("base " + repo.base);
      if (repo.test) bits.push(repo.test);
      html += '<div class="repo-row"><div><div class="num">' + esc(name) + '</div><div class="branch">' + esc(repo.path || "") + '</div><div class="meta">' + esc(bits.join(" · ")) + '</div></div><div class="d-actions"><button type="button" data-repo-edit="' + esc(name) + '">Edit</button><button type="button" data-repo-remove="' + esc(name) + '">Remove</button></div></div>';
    }
    if (!html && !editing) html = '<p class="empty">No repos yet.</p>';
    host.innerHTML = html;
  }

  function fillEditor(name, repo) {
    var nameInput = document.getElementById("repo-name");
    var pathInput = document.getElementById("repo-path");
    var testInput = document.getElementById("repo-test");
    var baseInput = document.getElementById("repo-base");
    var titleInput = document.getElementById("repo-pr-title");
    var branchInput = document.getElementById("repo-branch");
    var attemptsInput = document.getElementById("repo-max-attempts");
    var roundsInput = document.getElementById("repo-max-fix-rounds");
    if (nameInput) nameInput.value = name || "";
    if (pathInput) pathInput.value = repo.path || "";
    if (testInput) testInput.value = repo.test || "";
    if (baseInput) baseInput.value = repo.base || "";
    if (titleInput) titleInput.value = repo.prTitle || "";
    if (branchInput) branchInput.value = repo.branch || "";
    if (attemptsInput) attemptsInput.value = repo.maxAttempts != null && repo.maxAttempts !== "" ? String(repo.maxAttempts) : "";
    if (roundsInput) roundsInput.value = repo.maxFixRounds != null && repo.maxFixRounds !== "" ? String(repo.maxFixRounds) : "";
    setPressed("#repo-deliver [data-deliver]", "data-deliver", repo.deliver === "pr" ? "pr" : "local");
    var browser = document.getElementById("repo-browser");
    if (browser) { browser.hidden = true; browser.innerHTML = ""; }
  }

  function readEditor() {
    function value(id) {
      var el = document.getElementById(id);
      return el ? el.value.trim() : "";
    }
    return {
      name: value("repo-name"),
      path: value("repo-path"),
      test: value("repo-test"),
      deliver: selectedAttr("#repo-deliver [data-deliver]", "data-deliver", "local"),
      base: value("repo-base"),
      prTitle: value("repo-pr-title"),
      branch: value("repo-branch"),
      maxAttempts: value("repo-max-attempts"),
      maxFixRounds: value("repo-max-fix-rounds"),
    };
  }

  function flushEditor() {
    if (!editing) return true;
    var repo = readEditor();
    showSlot("name", "");
    if (!repo.name) {
      showSlot("name", "Name is required.");
      return false;
    }
    if (repo.name !== editing.original && Object.prototype.hasOwnProperty.call(repoDraft, repo.name)) {
      showSlot("name", "A repo named " + repo.name + " is already in the list.");
      return false;
    }
    if (editing.original && editing.original !== repo.name) delete repoDraft[editing.original];
    repoDraft[repo.name] = repo;
    editing.original = repo.name;
    return true;
  }

  function openEditor(name, repo) {
    editing = { original: name };
    fillEditor(name, repo);
    var editor = document.getElementById("repo-editor");
    if (editor) editor.hidden = false;
    renderRepoList();
    var nameInput = document.getElementById("repo-name");
    if (nameInput && nameInput.focus) nameInput.focus();
  }

  function closeEditor() {
    editing = null;
    var editor = document.getElementById("repo-editor");
    if (editor) editor.hidden = true;
    renderRepoList();
  }

  function startEdit(name) {
    if (!Object.prototype.hasOwnProperty.call(repoDraft, name)) return;
    if (editing && editing.original !== name && !flushEditor()) return;
    if (editing && editing.original === name) return;
    openEditor(name, repoDraft[name]);
  }

  function startAdd() {
    if (editing && !flushEditor()) return;
    openEditor(null, { path: "", test: "", deliver: "local", base: "", prTitle: "", branch: "" });
  }

  function removeRepo(name) {
    var ok = window.confirm("Remove " + name + " from the kiln config? This only edits the config. The checkout on disk is left as it is.");
    if (!ok) return;
    if (editing && editing.original === name) {
      editing = null;
      var editor = document.getElementById("repo-editor");
      if (editor) editor.hidden = true;
    } else if (editing && !flushEditor()) {
      return;
    }
    delete repoDraft[name];
    markSettingsDirty();
    renderRepoList();
  }

  function optionalNumber(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (!text) return undefined;
    if (!/^\d+(\.\d+)?$/.test(text)) return text;
    return Number(text);
  }

  function optionalInt(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (!text) return undefined;
    if (!/^-?\d+$/.test(text)) return text;
    return Number(text);
  }

  function domainList(raw) {
    return String(raw || "").split(/[\s,]+/).filter(function (part) { return part.trim(); }).map(function (part) { return part.trim(); });
  }

  function inputValue(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }

  function settingsPayload() {
    var repos = {};
    var names = Object.keys(repoDraft);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var repo = repoDraft[name];
      var entry = { path: repo.path || "" };
      if (repo.test) entry.test = repo.test;
      if (repo.deliver === "pr" || repo.deliver === "local") entry.deliver = repo.deliver;
      if (repo.base) entry.base = repo.base;
      if (repo.prTitle) entry.prTitle = repo.prTitle;
      if (repo.branch) entry.branch = repo.branch;
      var repoAttempts = optionalInt(repo.maxAttempts);
      var repoRounds = optionalInt(repo.maxFixRounds);
      if (repoAttempts !== undefined) entry.maxAttempts = repoAttempts;
      if (repoRounds !== undefined) entry.maxFixRounds = repoRounds;
      repos[name] = entry;
    }
    var body = { revision: settingsDoc ? settingsDoc.revision : "", repos: repos };
    var attempts = optionalInt(inputValue("max-attempts"));
    var stall = optionalInt(inputValue("stall-timeout"));
    var rounds = optionalInt(inputValue("max-fix-rounds"));
    if (attempts !== undefined) body.maxAttempts = attempts;
    if (stall !== undefined) body.stallTimeoutMs = stall;
    if (rounds !== undefined) body.maxFixRounds = rounds;
    var fingerprint = optionalInt(inputValue("max-same-fingerprint"));
    var cap = optionalNumber(inputValue("daily-dollar-cap"));
    if (fingerprint !== undefined) body.maxSameFingerprint = fingerprint;
    if (cap !== undefined) body.dailyDollarCap = cap;
    var mode = selectedAttr("#sandbox-mode [data-sandbox]", "data-sandbox", "off");
    var domains = domainList(inputValue("sandbox-domains"));
    var sandbox = {};
    if (mode) sandbox.mode = mode;
    if (domains.length) sandbox.allowDomains = domains;
    if (mode || domains.length) body.sandbox = sandbox;
    return body;
  }

  function applyFieldErrors(fields) {
    var keys = Object.keys(fields || {});
    var lines = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var message = fields[key];
      lines.push(message);
      var repoField = /^repos\.([^.]+)\.([^.]+)$/.exec(key);
      if (repoField) {
        setSettingsTab("repos");
        if (Object.prototype.hasOwnProperty.call(repoDraft, repoField[1])) startEdit(repoField[1]);
        var slotName = repoField[2] === "maxAttempts" ? "repoAttempts" : repoField[2] === "maxFixRounds" ? "repoRounds" : repoField[2];
        showSlot(slotName, message);
        continue;
      }
      if (key.indexOf("sandbox.allowDomains") === 0) {
        setSettingsTab("global");
        showSlot("sandbox.allowDomains", message);
        continue;
      }
      if (key === "sandbox.mode" || key === "maxAttempts" || key === "stallTimeoutMs" || key === "maxFixRounds" || key === "maxSameFingerprint" || key === "dailyDollarCap") {
        setSettingsTab("global");
        showSlot(key, message);
        continue;
      }
      if (key === "name" || key.indexOf("repos.") === 0) {
        setSettingsTab("repos");
        showSlot("name", message);
      }
    }
    if (lines.length) showSettingsError(lines.join("\n"));
  }

  function applySettingsDocument(data) {
    settingsDoc = data;
    repoDraft = cloneRepos(data.repos || {});
    var pathEl = document.getElementById("settings-path");
    if (pathEl) pathEl.textContent = data.path || "";
    fillGlobal(data);
    if (editing && editing.original && Object.prototype.hasOwnProperty.call(repoDraft, editing.original)) {
      fillEditor(editing.original, repoDraft[editing.original]);
    } else {
      closeEditor();
    }
    renderRepoList();
  }

  function loadSettings() {
    clearSettingsErrors();
    var saved = document.getElementById("settings-saved");
    if (saved) saved.hidden = true;
    fetch("/api/settings", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, status: response.status, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          showSettingsError((result.data && result.data.error) || "Could not load settings.");
          return;
        }
        editing = null;
        var editor = document.getElementById("repo-editor");
        if (editor) editor.hidden = true;
        applySettingsDocument(result.data);
        setSettingsTab("repos");
      })
      .catch(function () { showSettingsError("Could not load settings."); });
  }

  function toggleTrigger(button) {
    var id = button.getAttribute("data-trigger-toggle");
    var enabled = button.getAttribute("data-enabled") !== "true";
    var error = document.getElementById("trigger-error");
    if (error) error.hidden = true;
    button.disabled = true;
    fetch("/api/settings", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || "Could not load settings.");
        var data = result.data;
        var toggles = [];
        var buttons = document.querySelectorAll("[data-trigger-toggle]");
        for (var i = 0; i < buttons.length; i++) {
          var buttonId = buttons[i].getAttribute("data-trigger-toggle");
          var on = buttons[i].getAttribute("data-enabled") === "true";
          if (buttonId === id) on = enabled;
          toggles.push({ id: buttonId, enabled: on });
        }
        var body = { revision: data.revision, repos: data.repos || {}, triggers: toggles };
        ["stallTimeoutMs", "maxAttempts", "maxFixRounds", "maxSameFingerprint", "dailyDollarCap"].forEach(function (key) {
          if (data[key] !== undefined && data[key] !== null) body[key] = data[key];
        });
        if (data.sandbox) body.sandbox = data.sandbox;
        return fetch("/api/settings", {
          method: "PUT",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Kiln-CSRF": document.body.getAttribute("data-csrf") || "",
          },
          body: JSON.stringify(body),
        });
      })
      .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || "Could not save settings.");
        location.reload();
      })
      .catch(function (err) {
        button.disabled = false;
        if (error) {
          error.hidden = false;
          error.textContent = err && err.message ? err.message : "Could not update the trigger.";
        }
      });
  }

  function saveSettings() {
    if (settingsSaving) return;
    if (!flushEditor()) return;
    clearSettingsErrors();
    var payload = settingsPayload();
    settingsSaving = true;
    fetch("/api/settings", {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Kiln-CSRF": body.getAttribute("data-csrf") || "",
      },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, status: response.status, data: data }; });
      })
      .then(function (result) {
        settingsSaving = false;
        if (result.status === 400) {
          applyFieldErrors((result.data && result.data.fields) || {});
          if (!document.getElementById("settings-error") || document.getElementById("settings-error").hidden) {
            showSettingsError((result.data && result.data.error) || "Settings are invalid.");
          }
          return;
        }
        if (!result.ok) {
          showSettingsError((result.data && result.data.error) || "Could not save settings.");
          return;
        }
        applySettingsDocument(result.data);
        var saved = document.getElementById("settings-saved");
        if (saved) {
          saved.hidden = false;
          saved.textContent = "Saved";
        }
      })
      .catch(function () {
        settingsSaving = false;
        showSettingsError("Could not save settings.");
      });
  }

  function renderRepoListing(data) {
    var host = document.getElementById("repo-browser");
    if (!host) return;
    host.hidden = false;
    var html = '<div class="branch">' + esc(data.path || "") + "</div>";
    if (data.parent) html += '<button type="button" class="fs-up" data-path="' + esc(data.parent) + '">Up</button>';
    html += '<div class="fs-list">';
    var entries = data.entries || [];
    var dirs = 0;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].kind !== "dir") continue;
      dirs += 1;
      html += '<button type="button" class="fs-item" data-kind="dir" data-path="' + esc(entries[i].path) + '">' + esc(entries[i].name) + "</button>";
    }
    if (!dirs) html += '<div class="empty">No folders here.</div>';
    html += '</div><button type="button" class="fs-use" data-path="' + esc(data.path || "") + '">Use this folder</button>';
    host.innerHTML = html;
  }

  function loadRepoFs(path, fallback) {
    var query = path ? "?path=" + encodeURIComponent(path) : "";
    fetch("/api/fs" + query, { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          if (fallback && path) {
            loadRepoFs("", false);
            return;
          }
          showSlot("path", (result.data && result.data.error) || "Could not list that directory.");
          return;
        }
        showSlot("path", "");
        if (result.data.kind === "file") {
          var parent = String(result.data.path || "").replace(/\/[^/]+$/, "");
          loadRepoFs(parent, false);
          return;
        }
        renderRepoListing(result.data);
      })
      .catch(function () { showSlot("path", "Could not list that directory."); });
  }

  function openSettings() {
    var sheets = document.querySelectorAll(".sheet");
    for (var i = 0; i < sheets.length; i++) sheets[i].hidden = sheets[i].id !== "settings";
    body.classList.add("open");
    try { localStorage.removeItem("kiln-drawer"); } catch (err) { /* private mode */ }
    loadSettings();
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var triggerToggle = target.closest("[data-trigger-toggle]");
    if (triggerToggle) {
      toggleTrigger(triggerToggle);
      return;
    }
    var settingsControl = target.closest("#open-settings");
    if (settingsControl) {
      if (settingsControl.tagName !== "A") openSettings();
      return;
    }
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
    var settingsTab = target.closest("#settings-form [data-settings-tab]");
    if (settingsTab) {
      setSettingsTab(settingsTab.getAttribute("data-settings-tab") || "repos");
      return;
    }
    var deliverBtn = target.closest("#repo-deliver [data-deliver]");
    if (deliverBtn) {
      setPressed("#repo-deliver [data-deliver]", "data-deliver", deliverBtn.getAttribute("data-deliver") || "local");
      markSettingsDirty();
      return;
    }
    var sandboxBtn = target.closest("#sandbox-mode [data-sandbox]");
    if (sandboxBtn) {
      setPressed("#sandbox-mode [data-sandbox]", "data-sandbox", sandboxBtn.getAttribute("data-sandbox") || "off");
      markSettingsDirty();
      return;
    }
    if (target.closest("#repo-add")) {
      startAdd();
      return;
    }
    if (target.closest("#repo-done")) {
      if (flushEditor()) closeEditor();
      return;
    }
    if (target.closest("#repo-browse")) {
      var currentPath = document.getElementById("repo-path");
      loadRepoFs(currentPath ? currentPath.value.trim() : "", true);
      return;
    }
    var editBtn = target.closest("[data-repo-edit]");
    if (editBtn) {
      startEdit(editBtn.getAttribute("data-repo-edit") || "");
      return;
    }
    var removeBtn = target.closest("[data-repo-remove]");
    if (removeBtn) {
      removeRepo(removeBtn.getAttribute("data-repo-remove") || "");
      return;
    }
    var repoFs = target.closest("#repo-browser .fs-item, #repo-browser .fs-up, #repo-browser .fs-use");
    if (repoFs) {
      var nextPath = repoFs.getAttribute("data-path") || "";
      if (repoFs.classList.contains("fs-use")) {
        var pathInput = document.getElementById("repo-path");
        if (pathInput) pathInput.value = nextPath;
        markSettingsDirty();
        var browser = document.getElementById("repo-browser");
        if (browser) browser.hidden = true;
        return;
      }
      loadRepoFs(nextPath, false);
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
    localizeTimes(document);
    var el = document.getElementById("status");
    if (!el) return;
    if (!ok) {
      el.className = "status err";
      el.textContent = "Failed to fetch";
      return;
    }
    el.className = "status";
    var jobs = document.querySelectorAll(".job").length;
    el.textContent = jobs + (jobs === 1 ? " job · " : " jobs · ") + new Date().toLocaleTimeString();
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
        var toggle = document.getElementById("pause-toggle");
        var form = document.getElementById("pause-form");
        if (toggle && form && data && typeof data.paused === "boolean") {
          toggle.textContent = data.paused ? "Resume" : "Pause";
          toggle.setAttribute("aria-pressed", data.paused ? "true" : "false");
          form.setAttribute("action", data.paused ? "/api/resume" : "/api/pause");
          var label = document.getElementById("run-label");
          var dot = document.getElementById("run-dot");
          if (label) label.textContent = data.paused ? "Paused" : "Running";
          if (dot) dot.classList.toggle("paused", data.paused);
        }
        var spend = document.getElementById("spend");
        if (spend && data && data.spend) {
          var capText = data.spend.cap == null ? "no cap" : "$" + Number(data.spend.cap).toFixed(2);
          spend.textContent = "today " + data.spend.day + "  $" + Number(data.spend.usd).toFixed(2) + " / " + capText;
          var capNote = document.getElementById("cap-note");
          if (capNote) {
            var blocked = data.spend.blocked === true || (data.spend.cap != null && Number(data.spend.usd) >= Number(data.spend.cap));
            capNote.hidden = !blocked;
          }
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
  var issueInput = document.getElementById("job-issue");
  if (issueInput) issueInput.addEventListener("input", function () { issueDirty = true; });
  var jiraKey = document.getElementById("jira-key");
  if (jiraKey) jiraKey.addEventListener("input", syncIssueDefault);
  var addForm = document.getElementById("add-form");
  if (addForm) addForm.addEventListener("submit", function (event) {
    event.preventDefault();
    submitIntake(false);
  });
  var settingsForm = document.getElementById("settings-form");
  if (settingsForm) {
    settingsForm.addEventListener("submit", function (event) {
      event.preventDefault();
      saveSettings();
    });
    settingsForm.addEventListener("input", function () {
      markSettingsDirty();
      clearSettingsErrors();
    });
  }
  var previewBtn = document.getElementById("preview-job");
  if (previewBtn) previewBtn.addEventListener("click", function () { submitIntake(true); });
  function readSeen() {
    try {
      var raw = localStorage.getItem("kiln-seen");
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function writeSeen(map) {
    try { localStorage.setItem("kiln-seen", JSON.stringify(map)); } catch (err) { /* private mode */ }
  }

  function paintCount(node, count) {
    if (!node) return;
    if (!count) {
      node.hidden = true;
      node.textContent = "";
      return;
    }
    node.hidden = false;
    node.textContent = count === 1 ? "1 change since you last looked" : count + " changes since you last looked";
  }

  function paintUnseen() {
    var seen = readSeen();
    var params = [];
    for (var id in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, id)) continue;
      if (typeof seen[id] !== "string" || !seen[id]) continue;
      params.push("seen=" + encodeURIComponent(id + "|" + seen[id]));
    }
    fetch("/api/unseen" + (params.length ? "?" + params.join("&") : ""), { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data) return;
        var counts = {};
        var jobs = data.jobs || [];
        for (var i = 0; i < jobs.length; i++) counts[jobs[i].jobId] = jobs[i].count;
        var nodes = document.querySelectorAll("[data-unseen-for]");
        for (var n = 0; n < nodes.length; n++) paintCount(nodes[n], counts[nodes[n].getAttribute("data-unseen-for")] || 0);
        paintCount(document.getElementById("inbox-unseen"), data.inbox || 0);
      })
      .catch(function () { /* the list still works without the badge */ });
  }

  function markLooking() {
    var id = body.getAttribute("data-job");
    var latest = body.getAttribute("data-latest");
    if (!id || !latest) return;
    var seen = readSeen();
    seen[id] = latest;
    writeSeen(seen);
  }

  showFresh();
  renderCompact();
  notifyLabel();
  applyRepo();
  stamp(true);
  paintUnseen();
  markLooking();
  if (document.getElementById("settings-form")) loadSettings();
  try {
    var open = localStorage.getItem("kiln-drawer");
    if (open) openJob(open);
  } catch (err) { /* private mode */ }
  poll();
  setInterval(poll, 3000);
})();
