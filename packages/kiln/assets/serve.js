(function () {
  var KEY = "kiln-needs-you";
  var NOTIFY_KEY = "kiln-notify";
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
    if (notifyMode() !== "on") return;
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
  var workflow = "";
  try { workflow = localStorage.getItem("kiln-workflow") || ""; } catch (err) { workflow = ""; }

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
      tracks.push(slim ? "var(--col-slim)" : "minmax(var(--col-min), 1fr)");
    }
    board.style.setProperty("--cols", tracks.join(" "));
  }

  function applyRepo() {
    var cards = document.querySelectorAll(".board .card");
    for (var i = 0; i < cards.length; i++) {
      var cardRepo = cards[i].getAttribute("data-repo") || "";
      var cardWorkflow = cards[i].getAttribute("data-workflow") || "";
      var hideRepo = Boolean(repo) && cardRepo !== repo;
      var hideWorkflow = Boolean(workflow) && cardWorkflow !== workflow;
      cards[i].hidden = hideRepo || hideWorkflow;
    }
    var chips = document.querySelectorAll(".repo-f");
    for (var j = 0; j < chips.length; j++) {
      chips[j].setAttribute("aria-pressed", (chips[j].getAttribute("data-repo") || "") === repo ? "true" : "false");
    }
    var flows = document.querySelectorAll(".wf-f");
    for (var k = 0; k < flows.length; k++) {
      flows[k].setAttribute("aria-pressed", (flows[k].getAttribute("data-workflow") || "") === workflow ? "true" : "false");
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

  function relativeTime(iso) {
    var date = new Date(iso);
    if (!isFinite(date.getTime())) return iso;
    var delta = Date.now() - date.getTime();
    var future = delta < 0;
    var abs = Math.abs(delta);
    var sec = Math.round(abs / 1000);
    if (sec < 45) return future ? "in a moment" : "just now";
    var min = Math.round(sec / 60);
    var prefix = future ? "in " : "";
    var suffix = future ? "" : " ago";
    if (min < 60) return prefix + min + "m" + suffix;
    var hr = Math.round(min / 60);
    if (hr < 36) return prefix + hr + "h" + suffix;
    var day = Math.round(hr / 24);
    if (day < 14) return prefix + day + "d" + suffix;
    return date.toLocaleString();
  }

  function localTime(iso, mode) {
    var date = new Date(iso);
    if (!isFinite(date.getTime())) return iso;
    if (mode === "clock" || mode === false) return date.toLocaleTimeString();
    if (mode === "rel") return relativeTime(iso);
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
    if (iso) nodes[i].textContent = localTime(iso, nodes[i].getAttribute("data-time") || "local");
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

  var notifyAsking = false;

  function notifyPref() {
    try { return localStorage.getItem(NOTIFY_KEY) === "off" ? "off" : "on"; }
    catch (err) { return "on"; }
  }

  function setNotifyPref(value) {
    try { localStorage.setItem(NOTIFY_KEY, value); } catch (err) { /* private mode */ }
  }

  function notifyMode() {
    if (typeof Notification === "undefined") return "unavailable";
    if (Notification.permission === "denied") return "blocked";
    if (Notification.permission === "granted") return notifyPref() === "off" ? "off" : "on";
    return "ask";
  }

  function notifyCopy(mode) {
    if (mode === "unavailable") return { label: "Notifications unavailable", note: "" };
    if (mode === "blocked") return { label: "Notifications blocked", note: "Allow notifications for this site in the browser." };
    if (mode === "on") return { label: "Notifications on", note: "" };
    return { label: "Notify me", note: "" };
  }

  function renderNotify() {
    var button = document.getElementById("notify");
    if (!button) return;
    var mode = notifyMode();
    var copy = notifyCopy(mode);
    button.hidden = false;
    button.disabled = mode === "unavailable";
    button.setAttribute("data-state", mode);
    button.setAttribute("aria-pressed", mode === "on" ? "true" : "false");
    button.setAttribute("aria-label", copy.label);
    if (copy.note) button.setAttribute("aria-describedby", "notify-note");
    else button.removeAttribute("aria-describedby");
    var label = document.getElementById("notify-label");
    if (label) label.textContent = copy.label;
    var note = document.getElementById("notify-note");
    if (note) {
      note.hidden = !copy.note;
      note.textContent = copy.note;
    }
  }

  function askNotify() {
    if (notifyAsking || typeof Notification === "undefined" || !Notification.requestPermission) return;
    notifyAsking = true;
    var pending = Notification.requestPermission();
    var done = function () {
      notifyAsking = false;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") setNotifyPref("on");
      renderNotify();
    };
    if (pending && typeof pending.then === "function") pending.then(done, done);
    else done();
  }

  var titleDirty = false;
  var issueDirty = false;
  var sourceKind = "prompt";
  var specPath = "";
  var ticketsDir = "";
  var fsPath = "";
  var sending = false;
  var intakeTouched = {};
  var intakeSubmitTried = false;
  var FS_KEY = "kiln-fs-dir";

  function pickLimit() {
    var n = Number(body.getAttribute("data-pick-limit") || "5");
    return n > 0 ? n : 5;
  }

  function selectedRepo() {
    var box = document.getElementById("repo-pick");
    return box ? box.getAttribute("data-value") || "" : "";
  }

  function intakeRepoPath() {
    var box = document.getElementById("repo-pick");
    return box ? box.getAttribute("data-path") || "" : "";
  }

  function selectedWorkflow() {
    var select = document.getElementById("workflow");
    if (select) return select.value || "";
    var host = document.getElementById("workflow-pick");
    return host ? host.getAttribute("data-workflow") || "" : "";
  }

  function setFieldError(id, message, reveal) {
    var el = document.getElementById(id);
    if (!el) return;
    var on = Boolean(message) && reveal;
    el.hidden = !on;
    el.textContent = on ? message : "";
    var field = el.closest(".field");
    if (!field) return;
    var control = field.querySelector("textarea, input, select, [role='combobox'], [role='group']");
    if (!control) return;
    if (on) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }

  function showFieldError(name) {
    return intakeSubmitTried || intakeTouched[name] === true;
  }

  function syncValidity() {
    var repo = selectedRepo();
    var workflow = selectedWorkflow();
    var source = sourceBody();
    var prompt = source.kind === "prompt" && !String(source.text || "").trim() ? "Prompt is required." : "";
    var spec = source.kind === "spec" && !source.path ? "Choose a spec file." : "";
    var tickets = source.kind === "tickets" && !source.dir ? "Choose a tickets folder." : "";
    var jira = source.kind === "jira" && !source.key ? "Enter a Jira key." : "";
    setFieldError("repo-error", repo ? "" : "Choose a repo.", showFieldError("repo"));
    setFieldError("workflow-error", workflow ? "" : "Choose a workflow.", showFieldError("workflow"));
    setFieldError("prompt-error", prompt, showFieldError("prompt"));
    setFieldError("source-error", spec || tickets, showFieldError("source"));
    setFieldError("jira-error", jira, showFieldError("jira"));
    var blocked = !repo || !workflow || Boolean(prompt || spec || tickets || jira);
    var submit = document.getElementById("add-submit");
    if (submit) submit.disabled = blocked || sending;
    var preview = document.getElementById("preview-job");
    if (preview) preview.disabled = blocked || sending;
    return !blocked;
  }

  function repoListKey(repos) {
    var parts = [];
    for (var i = 0; i < repos.length; i++) {
      var repo = repos[i];
      if (!repo || !repo.name) continue;
      parts.push(repo.name + "\t" + (repo.path || ""));
    }
    return parts.join("\n");
  }

  function paintRepos(repos) {
    var box = document.getElementById("repo-pick");
    if (!box) return;
    var items = [];
    for (var i = 0; i < repos.length; i++) if (repos[i] && repos[i].name) items.push(repos[i]);
    var key = repoListKey(items);
    if (box.getAttribute("data-list") === key) return;
    var current = box.getAttribute("data-value") || "";
    var selected = null;
    for (var s = 0; s < items.length; s++) if (items[s].name === current) selected = items[s];
    if (!selected && items.length) selected = items[0];
    var value = selected ? selected.name : "";
    var path = selected ? (selected.path || "") : "";
    var mode = !items.length ? "empty" : items.length > pickLimit() ? "select" : "chips";
    var html = "";
    if (mode === "empty") html = '<p class="empty">No repos are registered.</p>';
    if (mode === "chips") {
      for (var c = 0; c < items.length; c++) {
        var chip = items[c];
        var pressed = chip.name === value;
        html += '<button type="button" class="pick" data-repo="' + esc(chip.name) + '" data-path="' + esc(chip.path || "") + '" aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(chip.name) + "</button>";
      }
    }
    if (mode === "select") {
      html = '<input id="repo-pick-query" class="combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="repo-pick-list" aria-labelledby="repo-label" placeholder="Search repos" value="' + esc(value) + '" autocomplete="off" spellcheck="false">';
      html += '<ul class="combo-list" id="repo-pick-list" role="listbox" hidden>';
      for (var o = 0; o < items.length; o++) {
        var opt = items[o];
        html += '<li role="option" id="repo-opt-' + o + '" data-value="' + esc(opt.name) + '" data-path="' + esc(opt.path || "") + '" aria-selected="' + (opt.name === value ? "true" : "false") + '">' + esc(opt.name) + "</li>";
      }
      html += '<li class="empty" role="presentation" hidden>No matching repos.</li></ul>';
    }
    box.className = mode === "select" ? "combo" : "picks";
    box.setAttribute("data-mode", mode);
    box.setAttribute("data-value", value);
    box.setAttribute("data-path", path);
    box.setAttribute("data-list", key);
    if (mode === "select") {
      box.removeAttribute("role");
      box.removeAttribute("aria-labelledby");
    } else {
      box.setAttribute("role", "group");
      box.setAttribute("aria-labelledby", "repo-label");
    }
    box.innerHTML = html;
    syncValidity();
  }

  function visibleOptions(box) {
    var all = box.querySelectorAll("[role='option']");
    var out = [];
    for (var i = 0; i < all.length; i++) if (!all[i].hidden) out.push(all[i]);
    return out;
  }

  function applyComboFilter(box, query) {
    var q = String(query || "").trim().toLowerCase();
    var options = box.querySelectorAll("[role='option']");
    var shown = 0;
    for (var i = 0; i < options.length; i++) {
      var name = (options[i].getAttribute("data-value") || options[i].textContent || "").toLowerCase();
      var hide = q.length > 0 && name.indexOf(q) === -1;
      options[i].hidden = hide;
      if (!hide) shown += 1;
    }
    var empty = box.querySelector(".combo-list .empty");
    if (empty) empty.hidden = shown !== 0;
    setComboActive(box, 0);
  }

  function setComboActive(box, index) {
    var options = visibleOptions(box);
    var input = box.querySelector("[role='combobox']");
    if (!options.length) {
      box.removeAttribute("data-active");
      if (input) input.removeAttribute("aria-activedescendant");
      return;
    }
    if (index < 0) index = options.length - 1;
    if (index >= options.length) index = 0;
    box.setAttribute("data-active", String(index));
    for (var i = 0; i < options.length; i++) options[i].classList.toggle("active", i === index);
    if (input && options[index].id) input.setAttribute("aria-activedescendant", options[index].id);
  }

  function openCombo(box, filter) {
    if (!box) return;
    var list = box.querySelector("[role='listbox']");
    var input = box.querySelector("[role='combobox']");
    if (!list || !input) return;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    applyComboFilter(box, filter ? input.value : "");
  }

  function closeCombo(box) {
    var list = box.querySelector("[role='listbox']");
    var input = box.querySelector("[role='combobox']");
    if (list) list.hidden = true;
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      input.value = box.getAttribute("data-value") || "";
    }
    box.removeAttribute("data-active");
  }

  function closeCombos(except) {
    var boxes = document.querySelectorAll(".combo");
    for (var i = 0; i < boxes.length; i++) if (boxes[i] !== except) closeCombo(boxes[i]);
  }

  function chooseComboOption(box, option) {
    if (!box || !option) return;
    var value = option.getAttribute("data-value") || "";
    box.setAttribute("data-value", value);
    if (option.hasAttribute("data-path")) box.setAttribute("data-path", option.getAttribute("data-path") || "");
    var options = box.querySelectorAll("[role='option']");
    for (var i = 0; i < options.length; i++) {
      options[i].setAttribute("aria-selected", options[i] === option ? "true" : "false");
    }
    closeCombo(box);
    syncValidity();
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
    syncValidity();
  }

  function chooseSpec(data) {
    specPath = data.path || "";
    setPicked(specPath);
    if (!titleDirty) {
      var heading = titleFromMarkdown(data.preview || "");
      var input = document.getElementById("job-title");
      if (input && heading) input.value = heading;
    }
    syncValidity();
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
    syncValidity();
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
    intakeSubmitTried = true;
    if (!syncValidity()) return;
    var repo = selectedRepo();
    var workflow = selectedWorkflow();
    var source = sourceBody();
    var payload = { repo: repo, workflow: workflow, source: source };
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
    syncValidity();
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
        syncValidity();
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
        syncValidity();
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
    paintRepos(data.repos);
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

  var settingsEpoch = 0;
  var themeApplied = document.documentElement.getAttribute("data-theme") || "kiln";
  var themeQueued = null;
  var themeSaving = false;

  function setSettingsTab(tab) {
    var repos = document.getElementById("settings-repos");
    var globalPane = document.getElementById("settings-global");
    var appearance = document.getElementById("settings-appearance");
    if (repos) repos.hidden = tab !== "repos";
    if (globalPane) globalPane.hidden = tab !== "global";
    if (appearance) appearance.hidden = tab !== "appearance";
    var buttons = document.querySelectorAll("#settings-form [data-settings-tab]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-settings-tab") === tab ? "true" : "false");
    }
  }

  function markTheme(id) {
    var buttons = document.querySelectorAll("#theme-pick [data-theme-choice]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-theme-choice") === id ? "true" : "false");
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
    var themeButton = document.querySelector('#theme-pick [aria-pressed="true"]');
    var themeId = themeButton ? themeButton.getAttribute("data-theme-choice") : "";
    if (themeId) body.board = { theme: themeId };
    return body;
  }

  function preservedSettings(data) {
    var body = { revision: data.revision, repos: data.repos || {} };
    ["stallTimeoutMs", "maxAttempts", "maxFixRounds", "maxSameFingerprint", "dailyDollarCap"].forEach(function (key) {
      if (data[key] !== undefined && data[key] !== null) body[key] = data[key];
    });
    if (data.sandbox) body.sandbox = data.sandbox;
    return body;
  }

  function chooseTheme(id) {
    if (!id) return;
    settingsEpoch += 1;
    document.documentElement.setAttribute("data-theme", id);
    markTheme(id);
    themeQueued = id;
    if (!themeSaving) pumpTheme();
  }

  function pumpTheme() {
    if (!themeQueued) return;
    var id = themeQueued;
    themeQueued = null;
    themeSaving = true;
    fetch("/api/settings", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || "Could not load settings.");
        var body = preservedSettings(result.data);
        body.board = { theme: id };
        return fetch("/api/settings", {
          method: "PUT",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Kiln-CSRF": bodyCsrf(),
          },
          body: JSON.stringify(body),
        });
      })
      .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
      .then(function (result) {
        themeSaving = false;
        if (!result.ok) {
          if (!themeQueued) restoreTheme();
          showSettingsError((result.data && result.data.error) || "Could not save the theme.");
          var fields = result.data && result.data.fields;
          if (fields && fields["board.theme"]) showSlot("board.theme", fields["board.theme"]);
          if (themeQueued) pumpTheme();
          return;
        }
        themeApplied = (result.data.board && result.data.board.theme) || id;
        if (!settingsDoc) applySettingsDocument(result.data);
        else if (result.data.revision) {
          settingsDoc.revision = result.data.revision;
          settingsDoc.board = result.data.board;
        }
        if (themeQueued) pumpTheme();
      })
      .catch(function (err) {
        themeSaving = false;
        if (!themeQueued) restoreTheme();
        showSettingsError(err && err.message ? err.message : "Could not save the theme.");
        if (themeQueued) pumpTheme();
      });
  }

  function restoreTheme() {
    document.documentElement.setAttribute("data-theme", themeApplied);
    markTheme(themeApplied);
  }

  function bodyCsrf() {
    return body.getAttribute("data-csrf") || "";
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
      if (key === "board.theme") {
        setSettingsTab("appearance");
        showSlot("board.theme", message);
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
    var themeId = data.board && data.board.theme ? data.board.theme : "kiln";
    if (!themeSaving && !themeQueued) {
      themeApplied = themeId;
      document.documentElement.setAttribute("data-theme", themeId);
      markTheme(themeId);
    }
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
    var epoch = settingsEpoch;
    fetch("/api/settings", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, status: response.status, data: data }; });
      })
      .then(function (result) {
        if (epoch !== settingsEpoch) return;
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
        var body = preservedSettings(data);
        body.triggers = toggles;
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
        "X-Kiln-CSRF": bodyCsrf(),
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
    var option = target.closest(".combo [role='option']");
    if (option) {
      chooseComboOption(option.closest(".combo"), option);
      return;
    }
    var query = target.closest(".combo [role='combobox']");
    if (query) {
      openCombo(query.closest(".combo"), false);
      return;
    }
    if (!target.closest(".combo")) closeCombos();
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
    var flowPick = target.closest("#workflow-pick [data-workflow]");
    if (flowPick) {
      var flows = document.querySelectorAll("#workflow-pick [data-workflow]");
      for (var f = 0; f < flows.length; f++) flows[f].setAttribute("aria-pressed", flows[f] === flowPick ? "true" : "false");
      var flowHost = document.getElementById("workflow-pick");
      if (flowHost) flowHost.setAttribute("data-workflow", flowPick.getAttribute("data-workflow") || "");
      syncValidity();
      return;
    }
    var pick = target.closest("#repo-pick .pick");
    if (pick) {
      var picks = document.querySelectorAll("#repo-pick .pick");
      for (var p = 0; p < picks.length; p++) picks[p].setAttribute("aria-pressed", picks[p] === pick ? "true" : "false");
      var repoBox = document.getElementById("repo-pick");
      if (repoBox) {
        repoBox.setAttribute("data-value", pick.getAttribute("data-repo") || "");
        repoBox.setAttribute("data-path", pick.getAttribute("data-path") || "");
      }
      syncValidity();
      return;
    }
    var themeChoice = target.closest("#theme-pick [data-theme-choice]");
    if (themeChoice) {
      chooseTheme(themeChoice.getAttribute("data-theme-choice") || "");
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
        syncValidity();
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
      var mode = notifyMode();
      if (mode === "unavailable" || mode === "blocked") return;
      if (mode === "on") {
        setNotifyPref("off");
        renderNotify();
        return;
      }
      if (mode === "off") {
        setNotifyPref("on");
        renderNotify();
        return;
      }
      askNotify();
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
    var flow = target.closest(".wf-f");
    if (flow) {
      workflow = flow.getAttribute("data-workflow") || "";
      try {
        if (workflow) localStorage.setItem("kiln-workflow", workflow);
        else localStorage.removeItem("kiln-workflow");
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
    var keyTarget = event.target;
    if (keyTarget && keyTarget.getAttribute && keyTarget.getAttribute("role") === "combobox") {
      var combo = keyTarget.closest(".combo");
      var list = combo ? combo.querySelector("[role='listbox']") : null;
      var comboOpen = list && !list.hidden;
      if (combo && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        if (!comboOpen) openCombo(combo, false);
        else setComboActive(combo, Number(combo.getAttribute("data-active") || "0") + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (combo && event.key === "Enter") {
        event.preventDefault();
        if (comboOpen) {
          var choices = visibleOptions(combo);
          var index = Number(combo.getAttribute("data-active") || "0");
          if (choices[index]) chooseComboOption(combo, choices[index]);
        }
        return;
      }
      if (combo && event.key === "Escape" && comboOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeCombo(combo);
        return;
      }
    }
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
          var pauseLabel = document.getElementById("pause-label");
          if (pauseLabel) pauseLabel.textContent = data.paused ? "Resume" : "Pause";
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
  if (jiraKey) jiraKey.addEventListener("input", function () {
    syncIssueDefault();
    syncValidity();
  });
  document.addEventListener("input", function (event) {
    var field = event.target;
    if (!field || !field.getAttribute) return;
    if (field.getAttribute("role") === "combobox") {
      openCombo(field.closest(".combo"), true);
      return;
    }
    if (field.id === "prompt-text" || field.id === "workflow") syncValidity();
  });
  function intakeFieldName(target) {
    if (!target || !target.closest || !target.closest("#add-form")) return "";
    if (target.id === "prompt-text") return "prompt";
    if (target.id === "jira-key") return "jira";
    if (target.id === "workflow" || target.closest("#workflow-pick")) return "workflow";
    if (target.id === "repo-pick-query" || target.closest("#repo-pick")) return "repo";
    if (target.closest("#browser-field")) return "source";
    return "";
  }

  document.addEventListener("focusout", function (event) {
    var name = intakeFieldName(event.target);
    if (!name) return;
    var next = event.relatedTarget;
    var stay = { prompt: "#prompt-text", jira: "#jira-key", workflow: "#workflow-field", repo: "#repo-field", source: "#browser-field" };
    if (next && next.closest && next.closest(stay[name])) return;
    intakeTouched[name] = true;
    syncValidity();
  });
  document.addEventListener("focusin", function (event) {
    var field = event.target;
    if (!field || !field.getAttribute || field.getAttribute("role") !== "combobox") return;
    openCombo(field.closest(".combo"), false);
    if (field.select) field.select();
  });
  document.addEventListener("change", function (event) {
    var field = event.target;
    if (field && field.id === "workflow") syncValidity();
  });
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
  syncValidity();
  renderCompact();
  renderNotify();
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
