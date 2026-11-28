(function () {
  var KEY = "kiln-needs-you";
  var NOTIFY_KEY = "kiln-notify";
  var body = document.body;
  var board = document.getElementById("board");
  var count = Number(body.getAttribute("data-needs-you") || "0");
  function titleFor(n) { return n > 0 ? "(" + n + ") Kiln" : "Kiln"; }
  document.title = titleFor(count);

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
  // The Done column shows the newest few; the rest sit behind "Show N more".
  var DONE_LIMIT = 6;
  var doneAll = false;
  try { doneAll = localStorage.getItem("kiln-done-all") === "on"; } catch (err) { doneAll = false; }

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

  // The filter box on History and the per-repo lists: hide the rows whose text lacks the query.
  function applyJobFilter() {
    var box = document.getElementById("job-filter");
    if (!box) return;
    var query = box.value.toLowerCase().trim();
    try { sessionStorage.setItem("kiln-job-filter", box.value); } catch (err) { /* private mode */ }
    var rows = document.querySelectorAll(".job");
    for (var i = 0; i < rows.length; i++) {
      rows[i].hidden = Boolean(query) && rows[i].textContent.toLowerCase().indexOf(query) === -1;
    }
    var groups = document.querySelectorAll(".state-group");
    for (var g = 0; g < groups.length; g++) {
      groups[g].hidden = Boolean(query) && groups[g].querySelectorAll(".job:not([hidden])").length === 0;
    }
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
    var doneCards = document.querySelectorAll('.board .col[data-column="done"] .card');
    var shown = 0;
    for (var d = 0; d < doneCards.length; d++) {
      if (doneCards[d].hidden) { doneCards[d].classList.remove("beyond"); continue; }
      shown += 1;
      doneCards[d].classList.toggle("beyond", !doneAll && shown > DONE_LIMIT);
    }
    var more = document.getElementById("done-more");
    if (more) {
      more.hidden = shown <= DONE_LIMIT;
      more.textContent = doneAll ? "Show fewer" : "Show " + (shown - DONE_LIMIT) + " more";
      more.setAttribute("aria-pressed", doneAll ? "true" : "false");
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
    if (mode === "date") return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

  function selectedHasTest() {
    var box = document.getElementById("repo-pick");
    if (!box) return true;
    var flag = box.getAttribute("data-has-test");
    if (flag === null || flag === "") return true;
    return flag !== "false";
  }

  function selectedNeedsTest() {
    var select = document.getElementById("workflow");
    if (select && select.options && select.selectedIndex >= 0) {
      var opt = select.options[select.selectedIndex];
      return Boolean(opt && opt.getAttribute("data-needs-test") === "true");
    }
    var host = document.getElementById("workflow-pick");
    if (!host) return false;
    var pressed = host.querySelector('[data-workflow][aria-pressed="true"]');
    return Boolean(pressed && pressed.getAttribute("data-needs-test") === "true");
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
    var jira = source.kind === "jira" && !source.key ? "Enter a Jira issue." : "";
    setFieldError("repo-error", repo ? "" : "Choose a repo.", showFieldError("repo"));
    setFieldError("workflow-error", workflow ? "" : "Choose a workflow.", showFieldError("workflow"));
    setFieldError("prompt-error", prompt, showFieldError("prompt"));
    setFieldError("source-error", spec || tickets, showFieldError("source"));
    setFieldError("jira-error", jira, showFieldError("jira"));
    var blocked = !repo || !workflow || Boolean(prompt || spec || tickets || jira);
    var warn = document.getElementById("intake-warn");
    if (warn) {
      var missingTest = Boolean(repo) && selectedNeedsTest() && !selectedHasTest();
      warn.hidden = !missingTest;
      warn.textContent = missingTest
        ? repo + " has no test command. You can still add this job. It stays blocked until Settings > Repos sets a test command."
        : "";
    }
    var submit = document.getElementById("add-submit");
    if (submit) submit.disabled = blocked || sending;
    var preview = document.getElementById("preview-job");
    if (preview) preview.disabled = blocked || sending;
    return !blocked;
  }

  function testFlag(repo) {
    if (!repo || repo.hasTest === undefined || repo.hasTest === null || repo.hasTest === "") return "";
    return repo.hasTest === false || repo.hasTest === "false" || repo.hasTest === "0" || repo.hasTest === 0 ? "0" : "1";
  }

  function hasTestAttr(repo) {
    var flag = testFlag(repo);
    if (!flag) return "";
    return ' data-has-test="' + (flag === "1" ? "true" : "false") + '"';
  }

  function applyHasTest(box, repo) {
    var flag = testFlag(repo);
    if (!flag) box.removeAttribute("data-has-test");
    else box.setAttribute("data-has-test", flag === "1" ? "true" : "false");
  }

  function repoListKey(repos) {
    var parts = [];
    for (var i = 0; i < repos.length; i++) {
      var repo = repos[i];
      if (!repo || !repo.name) continue;
      parts.push(repo.name + "\t" + (repo.path || "") + "\t" + testFlag(repo));
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
        html += '<button type="button" class="pick" data-repo="' + esc(chip.name) + '" data-path="' + esc(chip.path || "") + '"' + hasTestAttr(chip) + ' aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(chip.name) + "</button>";
      }
    }
    if (mode === "select") {
      html = '<input id="repo-pick-query" class="combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="repo-pick-list" aria-labelledby="repo-label" placeholder="Search repos" value="' + esc(value) + '" autocomplete="off" spellcheck="false">';
      html += '<ul class="combo-list" id="repo-pick-list" role="listbox" hidden>';
      for (var o = 0; o < items.length; o++) {
        var opt = items[o];
        html += '<li role="option" id="repo-opt-' + o + '" data-value="' + esc(opt.name) + '" data-path="' + esc(opt.path || "") + '"' + hasTestAttr(opt) + ' aria-selected="' + (opt.name === value ? "true" : "false") + '">' + esc(opt.name) + "</li>";
      }
      html += '<li class="empty" role="presentation" hidden>No matching repos.</li></ul>';
    }
    box.className = mode === "select" ? "combo" : "picks";
    box.setAttribute("data-mode", mode);
    box.setAttribute("data-value", value);
    box.setAttribute("data-path", path);
    applyHasTest(box, selected);
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
      var selected = box.querySelector('[role="option"][aria-selected="true"]');
      var label = selected && selected.getAttribute("data-label");
      input.value = label || box.getAttribute("data-value") || "";
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
    if (option.hasAttribute("data-has-test")) box.setAttribute("data-has-test", option.getAttribute("data-has-test") || "");
    else box.removeAttribute("data-has-test");
    var options = box.querySelectorAll("[role='option']");
    for (var i = 0; i < options.length; i++) {
      options[i].setAttribute("aria-selected", options[i] === option ? "true" : "false");
    }
    closeCombo(box);
    var input = box.querySelector("[role='combobox']");
    if (input && option.hasAttribute("data-label")) input.value = option.getAttribute("data-label") || "";
    if (box.closest && box.closest("#settings-form")) markSettingsDirty();
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
    if (titleField) titleField.hidden = sourceKind === "tickets" || sourceKind === "jira";
    if (issueField) issueField.hidden = sourceKind === "tickets" || sourceKind === "jira";
    if (afterField) afterField.hidden = sourceKind === "tickets";
    if (preview) preview.hidden = sourceKind !== "tickets" && sourceKind !== "jira";
    var pre = document.getElementById("intake-preview");
    if (pre) { pre.hidden = true; pre.textContent = ""; }
    showIntakeError("");
    if (sourceKind === "prompt" && !titleDirty) {
      var promptBox = document.getElementById("prompt-text");
      var title = document.getElementById("job-title");
      if (promptBox && title) title.value = titleFromPrompt(promptBox.value);
    }
    if (sourceKind === "spec" || sourceKind === "tickets") openBrowser();
    syncValidity();
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
    if (sourceKind === "prompt" || sourceKind === "spec") {
      var issue = document.getElementById("job-issue");
      if (issue && issue.value.trim()) payload.issue = issue.value.trim();
      var title = document.getElementById("job-title");
      if (title && titleDirty) payload.title = title.value;
    }
    if (sourceKind !== "tickets") {
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
    renderUnsaved();
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
  var triggerRows;
  var routeRows;
  // Same ids and titles as SETTINGS_SECTIONS in serve-page.ts.
  var SETTINGS_TABS = ["repos", "limits", "sandbox", "triggers", "jira", "workflows", "appearance", "file"];
  var SETTINGS_TITLES = {
    repos: "Repos",
    limits: "Limits and retries",
    sandbox: "Sandbox",
    triggers: "Triggers",
    jira: "Jira",
    workflows: "Local workflows and skills",
    appearance: "Appearance",
    file: "Edit the file",
  };
  var settingsTab = "repos";
  var settingsBaseline = null;

  function settingsSectionFromPath(path) {
    var match = /^\/settings\/([^/]+)$/.exec(String(path || ""));
    return match && SETTINGS_TABS.indexOf(match[1]) !== -1 ? match[1] : "repos";
  }

  function onSettingsPage() {
    return body.getAttribute("data-section") === "settings";
  }

  // push adds a history entry (a nav click). Otherwise the address is
  // replaced only when it names a different section (an error opened one).
  function setSettingsTab(tab, push) {
    if (SETTINGS_TABS.indexOf(tab) === -1) tab = "repos";
    settingsTab = tab;
    for (var i = 0; i < SETTINGS_TABS.length; i++) {
      var pane = document.getElementById("settings-" + SETTINGS_TABS[i]);
      if (pane) pane.hidden = SETTINGS_TABS[i] !== tab;
    }
    var links = document.querySelectorAll("#settings-nav a");
    for (var j = 0; j < links.length; j++) {
      if (settingsSectionFromPath(links[j].getAttribute("href")) === tab) links[j].setAttribute("aria-current", "page");
      else links[j].removeAttribute("aria-current");
    }
    if (!onSettingsPage() || typeof history === "undefined" || !history.replaceState) return;
    if (settingsSectionFromPath(location.pathname) === tab) return;
    try {
      if (push) history.pushState({ settings: tab }, "", "/settings/" + tab);
      else history.replaceState({ settings: tab }, "", "/settings/" + tab);
    } catch (err) { /* the address stays as it was */ }
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
    if (pr) pr.textContent = "Empty uses the default, " + title + ", which renders as [ABC-123] Title.";
    if (branch) branch.textContent = "Empty uses the default, " + template + ", which renders as ABC-123-slug.";
    var prInput = document.getElementById("repo-pr-title");
    var branchInput = document.getElementById("repo-branch");
    if (prInput) prInput.placeholder = title;
    if (branchInput) branchInput.placeholder = template;
    fillRepoHints();
    // A blank limit uses the built-in default, so the placeholder shows it.
    var placeholders = [
      ["max-attempts", settingsDefaults.maxAttempts != null ? settingsDefaults.maxAttempts : 3],
      ["max-fix-rounds", settingsDefaults.maxFixRounds != null ? settingsDefaults.maxFixRounds : 2],
      ["max-same-fingerprint", settingsDefaults.maxSameFingerprint != null ? settingsDefaults.maxSameFingerprint : 3],
      ["max-concurrent", settingsDefaults.maxConcurrent != null ? settingsDefaults.maxConcurrent : 2],
    ];
    for (var p = 0; p < placeholders.length; p++) {
      var input = document.getElementById(placeholders[p][0]);
      if (input) input.placeholder = String(placeholders[p][1]);
    }
    var stallInput = document.getElementById("stall-timeout");
    if (stallInput) stallInput.placeholder = minutesText(settingsDefaults.stallTimeoutMs != null ? settingsDefaults.stallTimeoutMs : 900000);
  }

  // The stall timeout is stored in milliseconds and edited in minutes.
  // A whole number of minutes shows as an integer, anything else to one decimal.
  function minutesText(ms) {
    var minutes = Number(ms) / 60000;
    return minutes === Math.floor(minutes) ? String(minutes) : minutes.toFixed(1);
  }

  // The loaded milliseconds and the text shown for them. Unedited text saves the
  // loaded value, so a value that is not whole minutes is not rounded by a save.
  var stallLoaded = null;

  function stallPayload() {
    var text = inputValue("stall-timeout").trim();
    if (!text) return undefined;
    if (stallLoaded && text === stallLoaded.text) return stallLoaded.ms;
    if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
    return Math.round(Number(text) * 60000);
  }

  function setWarn(id, message) {
    var slot = document.getElementById(id);
    if (!slot) return;
    slot.innerHTML = message ? '<p class="setting-warn-line">' + esc(message) + "</p>" : "";
    slot.hidden = !message;
  }

  function sandboxSwitch() {
    return document.getElementById("sandbox-mode");
  }

  function sandboxOn() {
    var toggle = sandboxSwitch();
    return Boolean(toggle && toggle.getAttribute("aria-checked") === "true");
  }

  function setSandboxSwitch(on) {
    var toggle = sandboxSwitch();
    if (toggle) toggle.setAttribute("aria-checked", on ? "true" : "false");
  }

  // Warnings are words, and follow the form as it is typed.
  function syncLimitWarnings() {
    var stall = inputValue("stall-timeout").trim();
    setWarn("stall-timeout-warn", stall !== "" && Number(stall) === 0 ? "Off. A run that hangs will not be stopped." : "");
    setWarn("sandbox-mode-warn", sandboxSwitch() && !sandboxOn() ? "Off. Agents run on this machine with your access." : "");
  }

  function fillSpend(dollars) {
    var spent = document.getElementById("daily-dollar-cap-spent");
    if (!spent) return;
    spent.textContent = typeof dollars === "number" && isFinite(dollars) ? "$" + dollars.toFixed(2) + " spent today." : "";
  }

  // What `kiln sandbox` reports when the sandbox is on and a run cannot start. Nothing when off.
  function fillSandboxCheck(check) {
    var slot = document.getElementById("sandbox-check");
    if (!slot) return;
    var problem = check && check.on && check.problem ? String(check.problem) : "";
    slot.innerHTML = problem
      ? problem.split("\n").filter(Boolean).map(function (line) { return '<p class="setting-warn-line">' + esc(line) + "</p>"; }).join("")
      : "";
    slot.hidden = !problem;
  }

  // "Empty uses the global setting, N." N is the saved global value, else the built-in default.
  function fillRepoHints() {
    var doc = settingsDoc || {};
    var attempts = doc.maxAttempts != null ? doc.maxAttempts : settingsDefaults.maxAttempts != null ? settingsDefaults.maxAttempts : 3;
    var rounds = doc.maxFixRounds != null ? doc.maxFixRounds : settingsDefaults.maxFixRounds != null ? settingsDefaults.maxFixRounds : 2;
    var attemptsHint = document.getElementById("hint-repo-attempts");
    var roundsHint = document.getElementById("hint-repo-rounds");
    if (attemptsHint) attemptsHint.textContent = "Empty uses the global setting, " + attempts + ".";
    if (roundsHint) roundsHint.textContent = "Empty uses the global setting, " + rounds + ".";
    var attemptsInput = document.getElementById("repo-max-attempts");
    var roundsInput = document.getElementById("repo-max-fix-rounds");
    if (attemptsInput) attemptsInput.placeholder = String(attempts);
    if (roundsInput) roundsInput.placeholder = String(rounds);
  }

  function fillGlobal(data) {
    fillHints(data.defaults || {});
    var attempts = document.getElementById("max-attempts");
    var stall = document.getElementById("stall-timeout");
    var rounds = document.getElementById("max-fix-rounds");
    if (attempts) attempts.value = data.maxAttempts != null ? String(data.maxAttempts) : "";
    stallLoaded = data.stallTimeoutMs != null ? { ms: data.stallTimeoutMs, text: minutesText(data.stallTimeoutMs) } : null;
    if (stall) stall.value = stallLoaded ? stallLoaded.text : "";
    var keepTrees = document.getElementById("keep-worktrees");
    if (keepTrees) keepTrees.checked = data.keepWorktrees === true;
    if (rounds) rounds.value = data.maxFixRounds != null ? String(data.maxFixRounds) : "";
    var fingerprint = document.getElementById("max-same-fingerprint");
    var cap = document.getElementById("daily-dollar-cap");
    if (fingerprint) fingerprint.value = data.maxSameFingerprint != null ? String(data.maxSameFingerprint) : "";
    if (cap) cap.value = data.dailyDollarCap != null ? String(data.dailyDollarCap) : "";
    var concurrentInput = document.getElementById("max-concurrent");
    if (concurrentInput) concurrentInput.value = data.maxConcurrent != null ? String(data.maxConcurrent) : "";
    setPressed("#adapter-mode [data-adapter]", "data-adapter", data.adapter === "mock" ? "mock" : "claude-code");
    setSandboxSwitch(Boolean(data.sandbox && data.sandbox.mode === "docker"));
    var domains = document.getElementById("sandbox-domains");
    if (domains) domains.value = data.sandbox && data.sandbox.allowDomains ? data.sandbox.allowDomains.join("\n") : "";
    fillSpend(data.spentToday);
    fillSandboxCheck(data.sandboxCheck);
    syncLimitWarnings();
  }

  // Pull request base for the table. A blank base falls back to "main" here;
  // the runtime default is origin's default branch, which the page does not know.
  function deliversAs(repo) {
    return repo.deliver === "pr" ? "Pull request to " + (repo.base || "main") : "Local branch";
  }

  function renderRepoList() {
    var host = document.getElementById("repo-list");
    if (!host) return;
    var names = Object.keys(repoDraft).sort();
    var html = "";
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var repo = repoDraft[name];
      var open = Boolean(editing && editing.original === name);
      var test = repo.test
        ? '<td class="repo-test">' + esc(repo.test) + "</td>"
        : '<td class="repo-test-missing">Not set. Jobs cannot start.</td>';
      var action = open
        ? '<span class="repo-editing">Editing</span>'
        : '<button type="button" data-repo-edit="' + esc(name) + '">Edit</button>';
      html += "<tr" + (open ? ' class="selected" aria-current="true"' : "") + ">"
        + '<td><div class="repo-name">' + esc(name) + '</div><div class="repo-path">' + esc(repo.path || "") + "</div></td>"
        + "<td>" + esc(deliversAs(repo)) + "</td>"
        + test
        + '<td class="repo-actions">' + action + "</td></tr>";
    }
    if (!html) html = '<tr><td colspan="4" class="empty">No repos yet.</td></tr>';
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
    var deliver = repo.deliver === "pr" ? "pr" : "local";
    var radios = document.querySelectorAll('#repo-deliver input[name="repo-deliver"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].getAttribute("value") === deliver;
    syncDeliver();
    var browser = document.getElementById("repo-browser");
    if (browser) { browser.hidden = true; browser.innerHTML = ""; }
    var title = document.getElementById("repo-editor-title");
    var path = document.getElementById("repo-editor-path");
    var head = document.getElementById("repo-editor-head");
    if (title) title.textContent = name || "";
    if (path) path.textContent = repo.path || "";
    if (head) head.hidden = !name;
    // Name and path show first on Add. On Edit they stay hidden unless the server rejects one.
    showIdent("name", !name);
    showIdent("path", !name);
    var remove = document.getElementById("repo-remove");
    if (remove) remove.hidden = !name;
    hideRemoveConfirm();
  }

  function editorDeliver() {
    var checked = document.querySelector("#repo-deliver input:checked");
    return checked && checked.getAttribute("value") === "pr" ? "pr" : "local";
  }

  // Base branch only matters for a pull request.
  function syncDeliver() {
    var base = document.getElementById("repo-base-field");
    if (base) base.hidden = editorDeliver() !== "pr";
  }

  function showIdent(field, on) {
    var box = document.querySelector('#repo-editor [data-repo-ident="' + field + '"]');
    if (box) box.hidden = !on;
  }

  function hideRemoveConfirm() {
    var confirmBox = document.getElementById("repo-remove-confirm");
    if (confirmBox) confirmBox.hidden = true;
    var remove = document.getElementById("repo-remove");
    if (remove && editing && editing.original) remove.hidden = false;
  }

  function askRemove() {
    if (!editing || !editing.original) return;
    var confirmBox = document.getElementById("repo-remove-confirm");
    var text = document.getElementById("repo-remove-text");
    var remove = document.getElementById("repo-remove");
    if (text) text.textContent = "Remove " + editing.original + "? The checkout on disk is left as it is.";
    if (confirmBox) confirmBox.hidden = false;
    if (remove) remove.hidden = true;
    var keep = document.getElementById("repo-remove-keep");
    if (keep && keep.focus) keep.focus();
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
      deliver: editorDeliver(),
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
    var first = document.getElementById(name ? "repo-test" : "repo-name");
    if (first && first.focus) first.focus();
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

  // The in-page confirm's Remove. Nothing reaches the file until Save changes.
  function removeRepo() {
    if (!editing || !editing.original) return;
    var name = editing.original;
    editing = null;
    var editor = document.getElementById("repo-editor");
    if (editor) editor.hidden = true;
    delete repoDraft[name];
    markSettingsDirty();
    renderRepoList();
    var add = document.getElementById("repo-add");
    if (add && add.focus) add.focus();
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

  function choiceControl(host, options, selected) {
    if (!host) return;
    var current = selected || "";
    var found = false;
    for (var i = 0; i < options.length; i++) if (options[i].value === current) found = true;
    if (!found && options[0]) current = options[0].value;
    host.setAttribute("data-value", current);
    if (options.length > pickLimit()) {
      host.className = "combo";
      host.removeAttribute("role");
      var html = '<input class="combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + host.id + '-list" placeholder="Search" value="' + esc(choiceLabel(options, current)) + '" autocomplete="off" spellcheck="false">';
      html += '<ul class="combo-list" id="' + host.id + '-list" role="listbox" hidden>';
      for (var o = 0; o < options.length; o++) {
        var opt = options[o];
        html += '<li role="option" id="' + host.id + "-opt-" + o + '" data-value="' + esc(opt.value) + '" data-label="' + esc(opt.label) + '" aria-selected="' + (opt.value === current ? "true" : "false") + '">' + esc(opt.label) + "</li>";
      }
      html += "</ul>";
      host.innerHTML = html;
      return;
    }
    host.className = "seg";
    host.setAttribute("role", "group");
    var buttons = "";
    for (var c = 0; c < options.length; c++) {
      var chip = options[c];
      buttons += '<button type="button" data-choice="' + esc(chip.value) + '" aria-pressed="' + (chip.value === current ? "true" : "false") + '">' + esc(chip.label) + "</button>";
    }
    host.innerHTML = buttons;
  }

  function choiceLabel(options, value) {
    for (var i = 0; i < options.length; i++) if (options[i].value === value) return options[i].label;
    return value;
  }

  function choiceValue(id) {
    var host = document.getElementById(id);
    return host ? host.getAttribute("data-value") || "" : "";
  }

  function repoOptions() {
    var names = Object.keys(repoDraft).sort();
    var options = [{ value: "", label: "Any" }];
    for (var i = 0; i < names.length; i++) options.push({ value: names[i], label: names[i] });
    return options;
  }

  function workflowNameList() {
    var names = [];
    var buttons = document.querySelectorAll("#workflow-pick [data-workflow]");
    for (var i = 0; i < buttons.length; i++) names.push(buttons[i].getAttribute("data-workflow") || "");
    var select = document.getElementById("workflow");
    if (select && select.options) {
      for (var o = 0; o < select.options.length; o++) if (select.options[o].value) names.push(select.options[o].value);
    }
    var seen = {};
    var out = [];
    for (var n = 0; n < names.length; n++) {
      if (!names[n] || seen[names[n]]) continue;
      seen[names[n]] = true;
      out.push(names[n]);
    }
    out.sort();
    return out;
  }

  function workflowOptions() {
    var names = workflowNameList();
    var options = [{ value: "", label: "Any" }];
    for (var i = 0; i < names.length; i++) options.push({ value: names[i], label: names[i] });
    return options;
  }

  function triggerIdOptions() {
    var options = [];
    var names = triggerRows ? triggerRows.rows() : [];
    for (var i = 0; i < names.length; i++) {
      if (names[i] && names[i].id) options.push({ value: names[i].id, label: names[i].id });
    }
    if (!options.length) options.push({ value: "", label: "None" });
    return options;
  }

  function showTriggerKind(kind) {
    var blocks = document.querySelectorAll("#trigger-editor [data-for-kind]");
    for (var i = 0; i < blocks.length; i++) blocks[i].hidden = blocks[i].getAttribute("data-for-kind") !== kind;
  }

  function writableTrigger(trigger) {
    var entry = { id: trigger.id, kind: trigger.kind };
    if (trigger.enabled === false) entry.enabled = false;
    ["cron", "every", "repo", "jql", "label", "status"].forEach(function (key) {
      if (trigger[key]) entry[key] = String(trigger[key]).trim();
    });
    var maxNew = optionalInt(trigger.maxNew);
    var maxQueued = optionalInt(trigger.maxQueued);
    if (maxNew !== undefined) entry.maxNew = maxNew;
    if (maxQueued !== undefined) entry.maxQueued = maxQueued;
    return entry;
  }

  function writableRoute(route) {
    var entry = {
      id: route.id,
      trigger: route.trigger,
      action: route.action === "attach" ? "attach" : "create",
    };
    if (route.workflow) entry.workflow = route.workflow;
    if (route.repo) entry.repo = route.repo;
    return entry;
  }

  function bindRows(spec) {
    var rows = [];
    var editing = null;
    function render() {
      var host = document.getElementById(spec.list);
      if (!host) return;
      if (!rows.length && !editing) {
        host.innerHTML = '<p class="empty">' + spec.empty + "</p>";
        return;
      }
      var html = "";
      for (var i = 0; i < rows.length; i++) {
        if (editing && editing.index === i) continue;
        var row = rows[i];
        html += '<div class="repo-row"><div><div class="num">' + esc(row.id || "Untitled") + '</div><div class="meta">' + esc(spec.summary(row)) + '</div></div><div class="d-actions"><button type="button" data-row-edit="' + spec.name + ":" + i + '">Edit</button>';
        if (!row.builtin) html += '<button type="button" data-row-remove="' + spec.name + ":" + i + '">Delete</button>';
        html += "</div></div>";
      }
      host.innerHTML = html;
    }
    function flush() {
      if (!editing) return true;
      var row = spec.read(editing);
      showSlot(spec.idError, "");
      if (!row.id) {
        showSlot(spec.idError, "Id is required.");
        return false;
      }
      if (spec.invalid && spec.invalid(row)) return false;
      for (var i = 0; i < rows.length; i++) {
        if (i !== editing.index && rows[i].id === row.id) {
          showSlot(spec.idError, "A " + spec.noun + " named " + row.id + " is already in the list.");
          return false;
        }
      }
      if (editing.index == null) rows.push(row);
      else rows[editing.index] = row;
      editing.index = editing.index == null ? rows.length - 1 : editing.index;
      return true;
    }
    function open(index, row) {
      editing = { index: index, builtin: Boolean(row.builtin) };
      spec.fill(row);
      var editor = document.getElementById(spec.editor);
      if (editor) editor.hidden = false;
      render();
      var idInput = document.getElementById(spec.idInput);
      if (idInput && idInput.focus && !row.builtin) idInput.focus();
    }
    function close() {
      editing = null;
      var editor = document.getElementById(spec.editor);
      if (editor) editor.hidden = true;
      render();
    }
    return {
      rows: function () { return rows; },
      // The rows with an open editor's values in place, without checking them.
      draft: function () {
        var out = rows.slice();
        if (!editing) return out;
        var row = spec.read(editing);
        if (editing.index != null) out[editing.index] = row;
        else if (row.id) out.push(row);
        return out;
      },
      set: function (value) { rows = value; },
      flush: flush,
      close: close,
      editing: function () { return editing; },
      edit: function (index) {
        if (!rows[index]) return;
        if (editing && editing.index !== index && !flush()) return;
        if (editing && editing.index === index) return;
        open(index, rows[index]);
      },
      add: function (blank) {
        if (editing && !flush()) return;
        open(null, blank);
      },
      remove: function (index) {
        var row = rows[index];
        if (!row || row.builtin) return;
        if (!window.confirm("Delete " + spec.noun + " " + (row.id || "untitled") + "?")) return;
        if (editing && editing.index === index) close();
        else if (editing && !flush()) return;
        rows.splice(index, 1);
        if (editing && editing.index != null && editing.index > index) editing.index -= 1;
        markSettingsDirty();
        render();
      },
    };
  }

  triggerRows = bindRows({
    name: "triggers",
    list: "trigger-list",
    editor: "trigger-editor",
    idInput: "trigger-id",
    idError: "trigger.id",
    noun: "trigger",
    empty: "No triggers.",
    read: readTriggerEditor,
    fill: fillTriggerEditor,
    summary: function (row) {
      var bits = [row.kind, row.enabled === false ? "off" : "on"];
      if (row.cron) bits.push(row.cron);
      if (row.every) bits.push(row.every);
      if (row.repo) bits.push(row.repo);
      if (row.builtin) bits.push("built in");
      return bits.join(" · ");
    },
  });

  routeRows = bindRows({
    name: "routes",
    list: "route-list",
    editor: "route-editor",
    idInput: "route-id",
    idError: "route.id",
    noun: "route",
    empty: "No routes.",
    read: readRouteEditor,
    fill: fillRouteEditor,
    invalid: function (row) {
      if (row.trigger) return false;
      showSlot("route.id", "Trigger is required.");
      return true;
    },
    summary: function (row) {
      var bits = [row.action || "create", row.trigger || ""];
      if (row.workflow) bits.push(row.workflow);
      if (row.repo) bits.push(row.repo);
      if (row.builtin) bits.push("built in");
      return bits.join(" · ");
    },
  });

  function fillTriggerEditor(trigger) {
    var idInput = document.getElementById("trigger-id");
    if (idInput) {
      idInput.value = trigger.id || "";
      idInput.readOnly = Boolean(trigger.builtin);
    }
    setPressed("#trigger-enabled [data-enabled]", "data-enabled", trigger.enabled === false ? "false" : "true");
    var kind = trigger.kind || "schedule";
    setPressed("#trigger-kind [data-kind]", "data-kind", kind);
    var kindButtons = document.querySelectorAll("#trigger-kind [data-kind]");
    for (var i = 0; i < kindButtons.length; i++) kindButtons[i].disabled = Boolean(trigger.builtin);
    showTriggerKind(kind);
    setInput("trigger-cron", trigger.cron);
    setInput("trigger-label", kind === "schedule" ? trigger.label : "");
    setInput("trigger-max-new", trigger.maxNew);
    setInput("trigger-max-queued", trigger.maxQueued);
    setInput("trigger-every", trigger.every);
    setInput("trigger-jql", trigger.jql);
    setInput("trigger-jira-label", kind === "jira" ? trigger.label : "");
    setInput("trigger-status", trigger.status);
    choiceControl(document.getElementById("trigger-repo"), repoOptions(), trigger.repo || "");
  }

  function setInput(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value != null && value !== "" ? String(value) : "";
  }

  function readTriggerEditor() {
    var kind = selectedAttr("#trigger-kind [data-kind]", "data-kind", "schedule");
    var trigger = {
      id: inputValue("trigger-id").trim(),
      kind: kind,
      enabled: selectedAttr("#trigger-enabled [data-enabled]", "data-enabled", "true") !== "false",
      builtin: Boolean(triggerRows && triggerRows.editing() && triggerRows.editing().builtin),
    };
    if (kind === "schedule") {
      trigger.cron = inputValue("trigger-cron").trim();
      trigger.label = inputValue("trigger-label").trim();
      trigger.maxNew = inputValue("trigger-max-new").trim();
      trigger.maxQueued = inputValue("trigger-max-queued").trim();
    } else if (kind === "jira") {
      trigger.every = inputValue("trigger-every").trim();
      trigger.jql = inputValue("trigger-jql").trim();
      trigger.label = inputValue("trigger-jira-label").trim();
      trigger.status = inputValue("trigger-status").trim();
      trigger.repo = choiceValue("trigger-repo");
    }
    return trigger;
  }

  function fillRouteEditor(route) {
    var idInput = document.getElementById("route-id");
    if (idInput) {
      idInput.value = route.id || "";
      idInput.readOnly = Boolean(route.builtin);
    }
    setPressed("#route-action [data-action]", "data-action", route.action === "attach" ? "attach" : "create");
    choiceControl(document.getElementById("route-trigger"), triggerIdOptions(), route.trigger || "");
    choiceControl(document.getElementById("route-workflow"), workflowOptions(), route.workflow || "");
    choiceControl(document.getElementById("route-repo"), repoOptions(), route.repo || "");
  }

  function readRouteEditor() {
    return {
      id: inputValue("route-id").trim(),
      trigger: choiceValue("route-trigger"),
      action: selectedAttr("#route-action [data-action]", "data-action", "create"),
      workflow: choiceValue("route-workflow"),
      repo: choiceValue("route-repo"),
      builtin: Boolean(routeRows && routeRows.editing() && routeRows.editing().builtin),
    };
  }

  function fillJira(data) {
    var jira = data.jira || {};
    var base = document.getElementById("jira-base");
    var email = document.getElementById("jira-email");
    var acceptance = document.getElementById("jira-acceptance");
    var token = document.getElementById("jira-token");
    if (base) base.value = jira.baseUrl || "";
    if (email) email.value = jira.email || "";
    if (acceptance) acceptance.value = jira.acceptanceField || "";
    if (token) token.textContent = jira.token || "not set";
  }

  function fillOverlay(data) {
    var overlay = data.overlay || {};
    var workflows = document.getElementById("overlay-workflows");
    var prompts = document.getElementById("overlay-prompts");
    var skills = document.getElementById("overlay-skills");
    var paths = document.getElementById("overlay-skill-paths");
    if (workflows) workflows.value = overlay.workflows || "";
    if (prompts) prompts.value = overlay.prompts || "";
    if (skills) skills.value = overlay.skills || "";
    if (paths) paths.value = overlay.skillPaths ? overlay.skillPaths.join("\n") : "";
    fillSkillCheck(data.skillCheck, Boolean(overlay.skills));
  }

  // Warnings name each problem folder as typed. They reflect the saved values and never block a save.
  function skillFolderWarning(folder) {
    if (!folder.exists) return "Folder not found: " + folder.typed;
    if (!folder.skills || folder.skills.length === 0) return "No skills in " + folder.typed + " (expected <name>/SKILL.md)";
    return "";
  }

  function fillSkillWarnings(id, folders) {
    var slot = document.getElementById(id);
    if (!slot) return;
    var lines = [];
    for (var i = 0; i < folders.length; i++) {
      var line = skillFolderWarning(folders[i]);
      if (line) lines.push('<p class="setting-warn-line">' + esc(line) + "</p>");
    }
    slot.innerHTML = lines.join("");
    slot.hidden = lines.length === 0;
  }

  // A blank skills folder is the optional Kiln home default, which may be missing or empty.
  function fillSkillCheck(check, skillsTyped) {
    var folders = (check && check.folders) || [];
    fillSkillWarnings("overlay-skills-warn", skillsTyped ? folders.slice(0, 1) : []);
    fillSkillWarnings("overlay-skill-paths-warn", folders.slice(1));
    var list = document.getElementById("overlay-skill-names");
    if (!list) return;
    var names = (check && check.skills) || [];
    list.innerHTML = names.length === 0
      ? '<p class="empty">No skills found.</p>'
      : '<ul class="setting-skills" aria-labelledby="overlay-skill-names-label">' +
        names.map(function (name) { return "<li>" + esc(name) + "</li>"; }).join("") +
        "</ul>";
  }

  function fillAdvanced(file) {
    var box = document.getElementById("settings-json");
    if (box) box.value = JSON.stringify(file || {}, null, 2);
  }

  function currentSettingsTab() {
    return settingsTab;
  }

  function routeSettingsError(key, message) {
    var rules = [
      ["maxConcurrent", "limits", "maxConcurrent"],
      ["adapter", "limits", "adapter"],
      ["sandbox.", "sandbox", ""],
      ["triggers.", "triggers", "trigger.form"],
      ["routes.", "triggers", "route.form"],
      ["jira.", "jira", ""],
      ["overlay.", "workflows", ""],
      ["file", "file", "file"],
    ];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var prefix = rule[0].charAt(rule[0].length - 1) === ".";
      var match = prefix ? key.indexOf(rule[0]) === 0 : key === rule[0] || (rule[0] === "file" && key.indexOf("file.") === 0);
      if (!match) continue;
      setSettingsTab(rule[1]);
      var index = /^(triggers|routes)\.(\d+)\./.exec(key);
      if (index && index[1] === "triggers") triggerRows.edit(Number(index[2]));
      if (index && index[1] === "routes") routeRows.edit(Number(index[2]));
      showSlot(rule[2] || key, message);
      return true;
    }
    return false;
  }

  function settingsPayload() {
    return buildSettingsPayload(repoDraft, triggerRows.rows(), routeRows.rows());
  }

  function buildSettingsPayload(draft, triggers, routes) {
    var repos = {};
    var names = Object.keys(draft);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var repo = draft[name];
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
    var stall = stallPayload();
    var rounds = optionalInt(inputValue("max-fix-rounds"));
    if (attempts !== undefined) body.maxAttempts = attempts;
    if (stall !== undefined) body.stallTimeoutMs = stall;
    if (rounds !== undefined) body.maxFixRounds = rounds;
    var keepTreesInput = document.getElementById("keep-worktrees");
    if (keepTreesInput && keepTreesInput.checked) body.keepWorktrees = true;
    var fingerprint = optionalInt(inputValue("max-same-fingerprint"));
    var cap = optionalNumber(inputValue("daily-dollar-cap"));
    if (fingerprint !== undefined) body.maxSameFingerprint = fingerprint;
    if (cap !== undefined) body.dailyDollarCap = cap;
    var mode = sandboxOn() ? "docker" : "off";
    var domains = domainList(inputValue("sandbox-domains"));
    var sandbox = {};
    if (mode) sandbox.mode = mode;
    if (domains.length) sandbox.allowDomains = domains;
    if (mode || domains.length) body.sandbox = sandbox;
    var themeButton = document.querySelector('#theme-pick [aria-pressed="true"]');
    var themeId = themeButton ? themeButton.getAttribute("data-theme-choice") : "";
    if (themeId) body.board = { theme: themeId };
    var concurrent = optionalInt(inputValue("max-concurrent"));
    body.maxConcurrent = concurrent === undefined ? null : concurrent;
    var adapter = selectedAttr("#adapter-mode [data-adapter]", "data-adapter", "claude-code");
    if (adapter === "mock" || (settingsDoc && settingsDoc.adapter)) body.adapter = adapter;
    body.triggers = triggers.map(writableTrigger);
    body.routes = routes.map(writableRoute);
    body.jira = {
      baseUrl: inputValue("jira-base").trim(),
      email: inputValue("jira-email").trim(),
      acceptanceField: inputValue("jira-acceptance").trim(),
    };
    body.overlay = {
      workflows: inputValue("overlay-workflows").trim(),
      prompts: inputValue("overlay-prompts").trim(),
      skills: inputValue("overlay-skills").trim(),
      skillPaths: inputValue("overlay-skill-paths").split(/\n/).map(function (line) { return line.trim(); }).filter(Boolean),
    };
    return body;
  }

  function preservedSettings(data) {
    var body = { revision: data.revision, repos: data.repos || {} };
    ["stallTimeoutMs", "maxAttempts", "maxFixRounds", "maxSameFingerprint", "dailyDollarCap", "maxConcurrent"].forEach(function (key) {
      if (data[key] !== undefined && data[key] !== null) body[key] = data[key];
    });
    if (data.adapter) body.adapter = data.adapter;
    if (data.sandbox) body.sandbox = data.sandbox;
    if (data.keepWorktrees === true) body.keepWorktrees = true;
    return body;
  }

  // repoDraft with an open editor's values in place, without checking them.
  function draftRepos() {
    var out = {};
    var names = Object.keys(repoDraft);
    for (var i = 0; i < names.length; i++) out[names[i]] = repoDraft[names[i]];
    if (!editing) return out;
    var repo = readEditor();
    var name = repo.name || editing.original;
    if (!name) return out;
    if (editing.original && editing.original !== name) delete out[editing.original];
    out[name] = repo;
    return out;
  }

  // What Discard and the bar compare against. The theme is left out: it saves on click.
  function settingsSnapshot() {
    var payload = buildSettingsPayload(draftRepos(), triggerRows.draft(), routeRows.draft());
    delete payload.revision;
    delete payload.board;
    return { payload: payload, file: inputValue("settings-json") };
  }

  var REPO_FIELDS = [
    ["path", "path"],
    ["test", "test command"],
    ["deliver", "deliver"],
    ["base", "base branch"],
    ["prTitle", "PR title template"],
    ["branch", "branch template"],
    ["maxAttempts", "max attempts"],
    ["maxFixRounds", "max fix rounds"],
  ];
  var SETTINGS_FIELDS = [
    ["limits", "maxConcurrent", "Jobs at once"],
    ["limits", "dailyDollarCap", "Daily spending cap"],
    ["limits", "stallTimeoutMs", "Stop a silent run after"],
    ["limits", "maxAttempts", "Attempts per job"],
    ["limits", "maxSameFingerprint", "Stop after the same failure"],
    ["limits", "maxFixRounds", "Fix rounds on a pull request"],
    ["limits", "adapter", "Agent"],
    ["limits", "keepWorktrees", "Keep finished worktrees"],
    ["sandbox", "sandbox.mode", "Run agents in Docker"],
    ["sandbox", "sandbox.allowDomains", "Sites agents may reach"],
    ["jira", "jira.baseUrl", "Base URL"],
    ["jira", "jira.email", "Email"],
    ["jira", "jira.acceptanceField", "Acceptance field"],
    ["workflows", "overlay.workflows", "Local workflows"],
    ["workflows", "overlay.prompts", "Prompt overrides"],
    ["workflows", "overlay.skills", "Skills folder"],
    ["workflows", "overlay.skillPaths", "More skill folders"],
  ];

  function same(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  function valueAt(object, path) {
    var parts = path.split(".");
    var value = object;
    for (var i = 0; i < parts.length; i++) value = value == null ? undefined : value[parts[i]];
    return value;
  }

  function rowChanges(section, noun, before, after, out) {
    var was = {};
    var now = {};
    for (var i = 0; i < (before || []).length; i++) was[before[i].id] = before[i];
    for (var j = 0; j < (after || []).length; j++) now[after[j].id] = after[j];
    Object.keys(was).forEach(function (id) {
      if (!Object.prototype.hasOwnProperty.call(now, id)) out.push({ section: section, field: noun + " " + id + " removed" });
      else if (!same(was[id], now[id])) out.push({ section: section, field: noun + " " + id + " changed" });
    });
    Object.keys(now).forEach(function (id) {
      if (!Object.prototype.hasOwnProperty.call(was, id)) out.push({ section: section, field: noun + " " + id + " added" });
    });
  }

  // Pure: two settingsSnapshot() results in, [{ section, field }] out, in nav order, with the labels the page shows.
  function settingsChanges(baseline, current) {
    var out = [];
    if (!baseline || !current) return out;
    var before = baseline.payload || {};
    var after = current.payload || {};
    var was = before.repos || {};
    var now = after.repos || {};
    Object.keys(was).sort().forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(now, name)) {
        out.push({ section: SETTINGS_TITLES.repos, field: name + " removed" });
        return;
      }
      for (var i = 0; i < REPO_FIELDS.length; i++) {
        var key = REPO_FIELDS[i][0];
        if (!same(was[name][key], now[name][key])) out.push({ section: SETTINGS_TITLES.repos, field: name + " " + REPO_FIELDS[i][1] });
      }
    });
    Object.keys(now).sort().forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(was, name)) out.push({ section: SETTINGS_TITLES.repos, field: name + " added" });
    });
    for (var f = 0; f < SETTINGS_FIELDS.length; f++) {
      var field = SETTINGS_FIELDS[f];
      if (field[0] !== "limits") continue;
      if (!same(valueAt(before, field[1]), valueAt(after, field[1]))) out.push({ section: SETTINGS_TITLES.limits, field: field[2] });
    }
    for (var g = 0; g < SETTINGS_FIELDS.length; g++) {
      if (SETTINGS_FIELDS[g][0] !== "sandbox") continue;
      if (!same(valueAt(before, SETTINGS_FIELDS[g][1]), valueAt(after, SETTINGS_FIELDS[g][1]))) out.push({ section: SETTINGS_TITLES.sandbox, field: SETTINGS_FIELDS[g][2] });
    }
    rowChanges(SETTINGS_TITLES.triggers, "trigger", before.triggers, after.triggers, out);
    rowChanges(SETTINGS_TITLES.triggers, "route", before.routes, after.routes, out);
    for (var h = 0; h < SETTINGS_FIELDS.length; h++) {
      var later = SETTINGS_FIELDS[h];
      if (later[0] !== "jira" && later[0] !== "workflows") continue;
      if (!same(valueAt(before, later[1]), valueAt(after, later[1]))) out.push({ section: SETTINGS_TITLES[later[0]], field: later[2] });
    }
    if (baseline.file !== current.file) out.push({ section: SETTINGS_TITLES.file, field: "kiln.config.json" });
    return out;
  }

  function currentSettingsChanges() {
    if (!settingsBaseline) return [];
    return settingsChanges(settingsBaseline, settingsSnapshot());
  }

  function unsavedSummary(changes) {
    var groups = [];
    var bySection = {};
    for (var i = 0; i < changes.length; i++) {
      var change = changes[i];
      if (!bySection[change.section]) {
        bySection[change.section] = [];
        groups.push(change.section);
      }
      bySection[change.section].push(change.field);
    }
    return groups.map(function (section) { return "in " + section + ": " + bySection[section].join(", "); }).join("; ");
  }

  function renderUnsaved() {
    var bar = document.getElementById("settings-unsaved");
    if (!bar) return;
    var changes = currentSettingsChanges();
    bar.hidden = changes.length === 0;
    var countEl = document.getElementById("settings-unsaved-count");
    var listEl = document.getElementById("settings-unsaved-list");
    if (countEl) countEl.textContent = changes.length === 1 ? "1 unsaved change" : changes.length + " unsaved changes";
    if (listEl) listEl.textContent = changes.length ? ", " + unsavedSummary(changes) : "";
  }

  function setSettingsFact(id, text, state) {
    var fact = document.querySelector('#settings-nav [data-settings-fact="' + id + '"]');
    if (!fact) return;
    fact.textContent = text;
    if (state) fact.setAttribute("data-state", state);
    else fact.removeAttribute("data-state");
  }

  function fillFacts(data) {
    setSettingsFact("repos", String(Object.keys(data.repos || {}).length));
    setSettingsFact("triggers", String((data.triggers || []).length));
    var jira = data.jira || {};
    var connected = Boolean(jira.baseUrl && jira.email && jira.token && jira.token !== "not set");
    setSettingsFact("jira", connected ? "connected" : "not set up", connected ? "connected" : "");
  }

  function discardSettings() {
    if (!settingsDoc) return;
    clearSettingsErrors();
    editing = null;
    var editor = document.getElementById("repo-editor");
    if (editor) editor.hidden = true;
    applySettingsDocument(settingsDoc);
    var saved = document.getElementById("settings-saved");
    if (saved) saved.hidden = true;
  }

  function safePaint(value) {
    var color = String(value || "").trim();
    if (!color || /["'<>\\]/.test(color)) return "";
    return color;
  }

  function paintFavicon() {
    if (typeof getComputedStyle !== "function") return;
    var link = document.querySelector('link[rel="icon"]');
    if (!link || !link.getAttribute || !link.setAttribute) return;
    var styles = getComputedStyle(document.documentElement);
    if (!styles || !styles.getPropertyValue) return;
    var fill = safePaint(styles.getPropertyValue("--primary"));
    var stroke = safePaint(styles.getPropertyValue("--on-primary"));
    if (!fill || !stroke) return;
    var href = link.getAttribute("href") || "";
    var prefix = "data:image/svg+xml,";
    if (href.indexOf(prefix) !== 0) return;
    var svg = decodeURIComponent(href.slice(prefix.length));
    var next = svg
      .replace(/(<rect\b[^>]*\bfill=")[^"]+(")/, "$1" + fill + "$2")
      .replace(/(stroke=")[^"]+(")/, "$1" + stroke + "$2");
    if (next !== svg) link.setAttribute("href", prefix + encodeURIComponent(next));
  }

  function chooseTheme(id) {
    if (!id) return;
    settingsEpoch += 1;
    document.documentElement.setAttribute("data-theme", id);
    markTheme(id);
    paintFavicon();
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
    paintFavicon();
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
        showRepoError(repoField[1], repoField[2], message);
        continue;
      }
      if (key.indexOf("sandbox.allowDomains") === 0) {
        setSettingsTab("sandbox");
        showSlot("sandbox.allowDomains", message);
        continue;
      }
      if (key === "sandbox.mode") {
        setSettingsTab("sandbox");
        showSlot(key, message);
        continue;
      }
      if (key === "maxAttempts" || key === "stallTimeoutMs" || key === "maxFixRounds" || key === "maxSameFingerprint" || key === "dailyDollarCap") {
        setSettingsTab("limits");
        showSlot(key, message);
        continue;
      }
      if (key === "board.theme") {
        setSettingsTab("appearance");
        showSlot("board.theme", message);
        continue;
      }
      if (key === "maxConcurrent" || key === "adapter") {
        setSettingsTab("limits");
        showSlot(key, message);
        continue;
      }
      var routed = routeSettingsError(key, message);
      if (routed) continue;
      if (key === "name" || key.indexOf("repos.") === 0) {
        setSettingsTab("repos");
        var repoName = /^repos\.([^.]+)$/.exec(key);
        showRepoError(repoName ? repoName[1] : "", "name", message);
      }
    }
    if (lines.length) showSettingsError(lines.join("\n"));
  }

  // Opens the rejected repo's form (a just-added repo's form is already open)
  // and shows the message on that field, revealing name or path on Edit.
  var REPO_ERROR_SLOTS = {
    name: "name", path: "path", test: "test", base: "base", deliver: "deliver",
    prTitle: "prTitle", branch: "branch", maxAttempts: "repoAttempts", maxFixRounds: "repoRounds",
  };

  function showRepoError(name, field, message) {
    if (name && Object.prototype.hasOwnProperty.call(repoDraft, name) && !(editing && editing.original === name)) {
      // Show the rejected repo even when the open form will not flush; its
      // invalid edit was never in the refused payload.
      if (!flushEditor()) editing = null;
      openEditor(name, repoDraft[name]);
    }
    var editor = document.getElementById("repo-editor");
    if (!editing || !editor || editor.hidden) return;
    if (field === "name" || field === "path") showIdent(field, true);
    if (field === "prTitle" || field === "branch" || field === "maxAttempts" || field === "maxFixRounds") {
      var more = document.getElementById("repo-more");
      if (more) more.open = true;
    }
    // Only known fields map to a slot; the general error banner shows the rest.
    var slotName = REPO_ERROR_SLOTS[field];
    if (slotName) showSlot(slotName, message);
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
      paintFavicon();
    }
    if (editing && editing.original && Object.prototype.hasOwnProperty.call(repoDraft, editing.original)) {
      fillEditor(editing.original, repoDraft[editing.original]);
    } else {
      closeEditor();
    }
    renderRepoList();
    triggerRows.set((data.triggers || []).map(function (trigger) {
      return {
        id: trigger.id,
        kind: trigger.kind,
        enabled: trigger.enabled !== false,
        builtin: Boolean(trigger.builtin),
        cron: trigger.cron || "",
        every: trigger.every || "",
        repo: trigger.repo || "",
        jql: trigger.jql || "",
        label: trigger.label || "",
        status: trigger.status || "",
        maxNew: trigger.maxNew != null ? String(trigger.maxNew) : "",
        maxQueued: trigger.maxQueued != null ? String(trigger.maxQueued) : "",
      };
    }));
    routeRows.set((data.routes || []).map(function (route) {
      return {
        id: route.id,
        trigger: route.trigger,
        action: route.action === "attach" ? "attach" : "create",
        workflow: route.workflow || "",
        repo: route.repo || "",
        builtin: Boolean(route.builtin),
      };
    }));
    triggerRows.close();
    routeRows.close();
    fillJira(data);
    fillOverlay(data);
    fillAdvanced(data.file);
    fillFacts(data);
    settingsBaseline = settingsSnapshot();
    renderUnsaved();
  }

  function openQueriedRepo() {
    if (!onSettingsPage() || settingsTab !== "repos") return;
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (err) { return; }
    var repo = params.get("repo") || "";
    if (!repo || !Object.prototype.hasOwnProperty.call(repoDraft, repo)) return;
    startEdit(repo);
    if (params.get("field") !== "test") return;
    var input = document.getElementById("repo-test");
    if (input && input.focus) input.focus();
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
        setSettingsTab(onSettingsPage() ? settingsSectionFromPath(location.pathname) : "repos");
        openQueriedRepo();
      })
      .catch(function () { showSettingsError("Could not load settings."); });
  }

  function putDocument(payload) {
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
        var tab = currentSettingsTab();
        applySettingsDocument(result.data);
        setSettingsTab(tab);
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

  function saveAdvanced() {
    var box = document.getElementById("settings-json");
    var text = box ? box.value : "";
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      showSlot("file", "Invalid JSON. Nothing was written.");
      showSettingsError("Invalid JSON. Nothing was written.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showSlot("file", "Config must be a JSON object.");
      showSettingsError("Config must be a JSON object.");
      return;
    }
    putDocument({ revision: settingsDoc ? settingsDoc.revision : "", file: parsed });
  }

  function saveSettings() {
    if (settingsSaving) return;
    clearSettingsErrors();
    var changes = currentSettingsChanges();
    if (!changes.length) return;
    var fileChanged = false;
    var formChanged = false;
    for (var i = 0; i < changes.length; i++) {
      if (changes[i].section === SETTINGS_TITLES.file) fileChanged = true;
      else formChanged = true;
    }
    if (fileChanged && formChanged) {
      showSettingsError("Edit the file and other sections both have changes. Undo one of them, or Discard, then save.");
      return;
    }
    if (fileChanged) {
      saveAdvanced();
      return;
    }
    if (!flushEditor() || !triggerRows.flush() || !routeRows.flush()) return;
    putDocument(settingsPayload());
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
        if (pick.hasAttribute("data-has-test")) repoBox.setAttribute("data-has-test", pick.getAttribute("data-has-test") || "");
        else repoBox.removeAttribute("data-has-test");
      }
      syncValidity();
      return;
    }
    var themeChoice = target.closest("#theme-pick [data-theme-choice]");
    if (themeChoice) {
      chooseTheme(themeChoice.getAttribute("data-theme-choice") || "");
      return;
    }
    var settingsChoice = target.closest("#settings-form [data-choice]");
    if (settingsChoice) {
      var choiceHost = settingsChoice.parentElement;
      if (choiceHost && choiceHost.id) {
        setPressed("#" + choiceHost.id + " [data-choice]", "data-choice", settingsChoice.getAttribute("data-choice") || "");
        choiceHost.setAttribute("data-value", settingsChoice.getAttribute("data-choice") || "");
        markSettingsDirty();
      }
      return;
    }
    var kindBtn = target.closest("#trigger-kind [data-kind]");
    if (kindBtn) {
      var kind = kindBtn.getAttribute("data-kind") || "schedule";
      setPressed("#trigger-kind [data-kind]", "data-kind", kind);
      showTriggerKind(kind);
      markSettingsDirty();
      return;
    }
    var enabledBtn = target.closest("#trigger-enabled [data-enabled]");
    if (enabledBtn) {
      setPressed("#trigger-enabled [data-enabled]", "data-enabled", enabledBtn.getAttribute("data-enabled") || "true");
      markSettingsDirty();
      return;
    }
    var actionBtn = target.closest("#route-action [data-action]");
    if (actionBtn) {
      setPressed("#route-action [data-action]", "data-action", actionBtn.getAttribute("data-action") || "create");
      markSettingsDirty();
      return;
    }
    var adapterBtn = target.closest("#adapter-mode [data-adapter]");
    if (adapterBtn) {
      setPressed("#adapter-mode [data-adapter]", "data-adapter", adapterBtn.getAttribute("data-adapter") || "claude-code");
      markSettingsDirty();
      return;
    }
    if (target.closest("#repo-deliver input")) {
      syncDeliver();
      markSettingsDirty();
      return;
    }
    if (target.closest("#sandbox-mode")) {
      setSandboxSwitch(!sandboxOn());
      syncLimitWarnings();
      markSettingsDirty();
      return;
    }
    var resetDomains = target.closest("#sandbox-domains-reset");
    if (resetDomains) {
      var domainBox = document.getElementById("sandbox-domains");
      if (domainBox) domainBox.value = (resetDomains.getAttribute("data-default-domains") || "").split(" ").filter(Boolean).join("\n");
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
    if (target.closest("#repo-remove")) {
      askRemove();
      return;
    }
    if (target.closest("#repo-remove-yes")) {
      removeRepo();
      return;
    }
    if (target.closest("#repo-remove-keep")) {
      hideRemoveConfirm();
      var removeAgain = document.getElementById("repo-remove");
      if (removeAgain && removeAgain.focus) removeAgain.focus();
      return;
    }
    var rowAdd = target.closest("[data-row-add]");
    if (rowAdd) {
      var added = rowAdd.getAttribute("data-row-add") === "routes" ? routeRows : triggerRows;
      added.add(rowAdd.getAttribute("data-row-add") === "routes"
        ? { id: "", trigger: "", action: "create", workflow: "", repo: "" }
        : { id: "", kind: "schedule", enabled: true, cron: "" });
      return;
    }
    var rowDone = target.closest("[data-row-done]");
    if (rowDone) {
      var done = rowDone.getAttribute("data-row-done") === "routes" ? routeRows : triggerRows;
      if (done.flush()) done.close();
      return;
    }
    var rowEdit = target.closest("[data-row-edit]");
    if (rowEdit) {
      var editParts = (rowEdit.getAttribute("data-row-edit") || "").split(":");
      (editParts[0] === "routes" ? routeRows : triggerRows).edit(Number(editParts[1]));
      return;
    }
    var rowRemove = target.closest("[data-row-remove]");
    if (rowRemove) {
      var removeParts = (rowRemove.getAttribute("data-row-remove") || "").split(":");
      (removeParts[0] === "routes" ? routeRows : triggerRows).remove(Number(removeParts[1]));
      return;
    }
    var sectionLink = target.closest("#settings-nav a");
    if (sectionLink) {
      if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Switch in place so edits in other sections stay in the form.
      event.preventDefault();
      setSettingsTab(settingsSectionFromPath(sectionLink.getAttribute("href")), true);
      return;
    }
    if (target.closest("#settings-discard")) {
      discardSettings();
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
    if (target.closest("#show-shortcuts")) {
      showShortcuts(true);
      return;
    }
    if (target.closest("#close-shortcuts")) {
      showShortcuts(false);
      return;
    }
    if (target.closest("#done-more")) {
      doneAll = !doneAll;
      try { localStorage.setItem("kiln-done-all", doneAll ? "on" : "off"); } catch (err) { /* private mode */ }
      applyRepo();
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

  // Keyboard shortcuts. The list in the Shortcuts panel (SHORTCUTS_PANEL in serve-page.ts) must match.
  var chordUntil = 0;
  function typingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || Boolean(el.isContentEditable);
  }
  function jobLinks() {
    return Array.prototype.slice.call(document.querySelectorAll(".board .card:not([hidden]):not(.beyond) .job-title, .job:not([hidden]) .job-title"));
  }
  function showShortcuts(open) {
    var panel = document.getElementById("shortcuts");
    if (!panel) return;
    panel.hidden = !open;
    if (open) {
      var close = document.getElementById("close-shortcuts");
      if (close) close.focus();
    } else {
      var opener = document.getElementById("show-shortcuts");
      if (opener) opener.focus();
    }
  }
  function handleShortcut(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    var panel = document.getElementById("shortcuts");
    var panelOpen = Boolean(panel) && !panel.hidden;
    if (event.key === "Escape" && panelOpen) { showShortcuts(false); return true; }
    if (typingTarget(event.target) || body.classList.contains("open")) return false;
    if (event.key === "?") { event.preventDefault(); showShortcuts(!panelOpen); return true; }
    if (panelOpen) return false;
    var now = Date.now();
    if (chordUntil > now) {
      chordUntil = 0;
      var go = { p: "/", r: "/repos", h: "/history", t: "/triggers", s: "/settings" }[event.key];
      if (go) { event.preventDefault(); location.href = go; return true; }
      return false;
    }
    if (event.key === "g") { chordUntil = now + 1200; return true; }
    if (event.key === "j" || event.key === "k") {
      var links = jobLinks();
      if (links.length === 0) return false;
      var at = links.indexOf(document.activeElement);
      var next = event.key === "j" ? (at < 0 ? 0 : Math.min(at + 1, links.length - 1)) : (at < 0 ? links.length - 1 : Math.max(at - 1, 0));
      event.preventDefault();
      links[next].focus();
      return true;
    }
    return false;
  }

  document.addEventListener("keydown", function (event) {
    if (handleShortcut(event)) return;
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
    var filterBox = document.getElementById("job-filter");
    if (filterBox && event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      var tag = keyTarget && keyTarget.tagName ? keyTarget.tagName.toLowerCase() : "";
      if (tag !== "input" && tag !== "textarea" && tag !== "select" && !(keyTarget && keyTarget.isContentEditable)) {
        event.preventDefault();
        filterBox.focus();
        return;
      }
    }
    if (event.key === "Escape" && keyTarget === filterBox && filterBox) {
      filterBox.value = "";
      applyJobFilter();
      filterBox.blur();
      return;
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

  function paintLiveness() {
    var stall = Number(body.getAttribute("data-stall") || "0");
    var quietAfter = Number(body.getAttribute("data-quiet") || "120000");
    var now = Date.now();
    var nodes = document.querySelectorAll(".liveness");
    for (var i = 0; i < nodes.length; i++) {
      var live = nodes[i];
      var card = live.closest("[data-activity]");
      if (!card) continue;
      if ((card.getAttribute("data-column") || "") !== "running") {
        live.hidden = true;
        continue;
      }
      var at = Date.parse(card.getAttribute("data-activity") || "");
      if (!isFinite(at)) continue;
      var age = now - at;
      var label = live.querySelector(".liveness-label");
      var dot = live.querySelector(".live-dot");
      live.classList.remove("working", "quiet", "stalled");
      live.hidden = false;
      if (stall > 0 && age > stall) {
        live.classList.add("stalled");
        if (label) label.textContent = "stalled";
        if (dot) dot.hidden = true;
      } else if (age > quietAfter) {
        var minutes = Math.max(2, Math.floor(age / 60000));
        live.classList.add("quiet");
        if (label) label.textContent = "quiet for " + minutes + "m";
        if (dot) dot.hidden = false;
      } else {
        live.classList.add("working");
        if (label) label.textContent = "Working";
        if (dot) dot.hidden = false;
      }
    }
  }

  var actionPending = false;
  var PENDING_LABEL = { approve: "Approving", reject: "Rejecting", revise: "Sending back", retry: "Retrying" };

  var swapping = false;

  function boardFocused() {
    var active = document.activeElement;
    return Boolean(active && board && active !== body && board.contains(active));
  }

  function sameCard(old, fresh) {
    var hidden = old.hidden;
    old.hidden = false;
    var same = old.outerHTML === fresh.outerHTML;
    old.hidden = hidden;
    return same;
  }

  // The pipeline updates in place: fetch the board, swap each column's cards
  // by id, then the counts, the status line, the sidebar badge, and the title.
  function swapBoard(rev) {
    if (swapping || !board || typeof DOMParser === "undefined") return;
    swapping = true;
    fetch("/", { cache: "no-store", headers: { Accept: "text/html" } })
      .then(function (response) {
        if (!response.ok) throw new Error("status");
        return response.text();
      })
      .then(function (html) {
        swapping = false;
        if (actionPending || boardFocused()) return;
        var next = new DOMParser().parseFromString(html, "text/html");
        var nextBoard = next.getElementById("board");
        if (!nextBoard) return;
        var columns = nextBoard.querySelectorAll(".col");
        for (var i = 0; i < columns.length; i++) {
          var col = board.querySelector('.col[data-column="' + columns[i].getAttribute("data-column") + '"]');
          if (!col) continue;
          var fresh = columns[i].querySelectorAll(".card");
          var keep = {};
          var anchor = col.querySelector(".empty");
          for (var c = 0; c < fresh.length; c++) {
            keep[fresh[c].id] = true;
            var old = document.getElementById(fresh[c].id);
            var node = old && sameCard(old, fresh[c]) ? old : document.importNode(fresh[c], true);
            if (old && old !== node && old.parentNode) old.parentNode.removeChild(old);
            col.insertBefore(node, anchor);
          }
          var stale = col.querySelectorAll(".card");
          for (var k = 0; k < stale.length; k++) if (!keep[stale[k].id]) col.removeChild(stale[k]);
        }
        var status = document.getElementById("board-status");
        var nextStatus = next.getElementById("board-status");
        if (status && nextStatus) status.innerHTML = nextStatus.innerHTML;
        var link = document.querySelector('.nav-link[href="/"]');
        var nextLink = next.querySelector('.nav-link[href="/"]');
        if (link && nextLink) link.innerHTML = nextLink.innerHTML;
        var n = Number(next.body.getAttribute("data-needs-you") || "0");
        body.setAttribute("data-needs-you", String(n));
        var nextRev = next.body.getAttribute("data-revision") || rev;
        if (nextRev) body.setAttribute("data-revision", nextRev);
        count = n;
        document.title = titleFor(n);
        note(n);
        applyRepo();
        paintLiveness();
        localizeTimes(document);
      })
      .catch(function () { swapping = false; });
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
        var onBoard = body.getAttribute("data-section") === "pipeline";
        if (rev && current && rev !== current) {
          // A reload here would cancel the form post that is still on its way.
          if (actionPending) return;
          if (!onBoard) {
            location.reload();
            return;
          }
          swapBoard(rev);
        } else if (onBoard && board && board.querySelector('.col[data-column="running"] .card')) {
          // Running cards carry elapsed time and the newest note, so they refresh each poll.
          swapBoard(rev);
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
        paintLiveness();
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
  var jiraKey = document.getElementById("jira-key");
  if (jiraKey) jiraKey.addEventListener("input", function () { syncValidity(); });
  document.addEventListener("input", function (event) {
    var field = event.target;
    if (!field || !field.getAttribute) return;
    if (field.getAttribute("role") === "combobox") {
      openCombo(field.closest(".combo"), true);
      return;
    }
    if (field.id === "job-filter") {
      applyJobFilter();
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
    if (field && field.closest && field.closest("#repo-deliver")) {
      syncDeliver();
      markSettingsDirty();
    }
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
      syncLimitWarnings();
      markSettingsDirty();
      clearSettingsErrors();
    });
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("popstate", function () {
        if (onSettingsPage()) setSettingsTab(settingsSectionFromPath(location.pathname));
      });
      window.addEventListener("beforeunload", function (event) {
        if (!currentSettingsChanges().length) return;
        event.preventDefault();
        event.returnValue = "";
      });
    }
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
  var filterStart = document.getElementById("job-filter");
  if (filterStart) {
    try { filterStart.value = sessionStorage.getItem("kiln-job-filter") || ""; } catch (err) { filterStart.value = ""; }
    applyJobFilter();
  }
  applyRepo();
  stamp(true);
  paintUnseen();
  markLooking();
  if (document.getElementById("settings-form")) loadSettings();
  try {
    var open = localStorage.getItem("kiln-drawer");
    if (open) openJob(open);
  } catch (err) { /* private mode */ }
  // Approve, reject, revise, and retry are plain form posts, and the server
  // takes a moment to answer. Mark the clicked button busy and lock the rest
  // of its row, so the click is seen and a second one cannot post twice.
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.classList || !form.classList.contains("act")) return;
    if (form.getAttribute("data-pending") === "true") {
      event.preventDefault();
      return;
    }
    form.setAttribute("data-pending", "true");
    actionPending = true;
    var button = form.querySelector("button");
    var kind = "";
    for (var name in PENDING_LABEL) if (form.classList.contains(name)) kind = name;
    if (button) {
      button.setAttribute("data-label", button.textContent || "");
      button.setAttribute("aria-busy", "true");
      button.textContent = (PENDING_LABEL[kind] || button.textContent || "Working") + "\u2026";
    }
    // After this event, or the browser may drop the submit and the note.
    setTimeout(function () {
      var row = (form.closest && form.closest(".d-actions")) || form;
      var controls = row.querySelectorAll("button, input");
      for (var i = 0; i < controls.length; i += 1) {
        if (controls[i].tagName === "INPUT") controls[i].readOnly = true;
        else controls[i].disabled = true;
      }
    }, 0);
  });
  // Coming back with the back button restores the page as it was left.
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted) return;
      actionPending = false;
      var forms = document.querySelectorAll('form.act[data-pending="true"]');
      for (var i = 0; i < forms.length; i += 1) {
        forms[i].removeAttribute("data-pending");
        var row = (forms[i].closest && forms[i].closest(".d-actions")) || forms[i];
        var controls = row.querySelectorAll("button, input");
        for (var k = 0; k < controls.length; k += 1) {
          controls[k].disabled = false;
          controls[k].readOnly = false;
          if (controls[k].getAttribute("aria-busy") === "true") {
            controls[k].removeAttribute("aria-busy");
            controls[k].textContent = controls[k].getAttribute("data-label") || controls[k].textContent;
          }
        }
      }
    });
  }

  paintLiveness();
  poll();
  setInterval(poll, 3000);
  startLive();

  function startLive() {
    var targetRoot = document.querySelector ? document.querySelector("[data-target]") : null;
    if (targetRoot && !location.hash) {
      var target = targetRoot.getAttribute("data-target") || "";
      if (target && document.getElementById(target)) location.replace("#" + target);
    }
    var root = document.getElementById("live");
    var feed = document.getElementById("live-feed");
    if (!root || !feed) return;
    var jobId = body.getAttribute("data-job") || "";
    if (!jobId) return;
    var cursor = root.getAttribute("data-cursor") || "";
    var running = root.getAttribute("data-running") === "true";
    var phase = root.getAttribute("data-phase") || "";
    // The step page pins the feed to one step. It never reloads to follow the run to the next step.
    var pinned = root.getAttribute("data-pin") === "true";
    var stick = running || pinned;
    var ignoreScroll = true;
    var reloading = false;
    var timer = 0;
    var error = document.getElementById("live-error");
    var followStatus = document.getElementById("follow-status");
    var jump = document.getElementById("jump-latest");
    var expand = document.getElementById("expand-log");
    var nowNote = document.getElementById("now-note");
    var nowCommand = document.getElementById("now-command");

    function showFollow() {
      if (followStatus) followStatus.textContent = stick ? "Following the latest line" : "Paused. Jump to latest to follow.";
    }

    // Scrolls the activity list only. The page stays where the operator left it.
    function follow() {
      if (!stick) return;
      ignoreScroll = true;
      feed.scrollTop = feed.scrollHeight;
      requestAnimationFrame(function () { ignoreScroll = false; });
    }

    feed.addEventListener("scroll", function () {
      if (ignoreScroll || !stick) return;
      if (feed.scrollHeight - feed.scrollTop - feed.clientHeight > 48) {
        stick = false;
        showFollow();
      }
    });

    if (jump) {
      jump.addEventListener("click", function () {
        stick = true;
        showFollow();
        follow();
      });
    }

    if (expand) {
      expand.addEventListener("click", function () {
        var on = expand.getAttribute("aria-pressed") !== "true";
        expand.setAttribute("aria-pressed", on ? "true" : "false");
        feed.classList.toggle("expanded", on);
        follow();
      });
    }

    feed.addEventListener("click", function (event) {
      var button = event.target && event.target.closest ? event.target.closest("button.live-summary") : null;
      if (!button) return;
      var open = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", open ? "false" : "true");
      button.textContent = open ? button.getAttribute("data-summary") || "" : button.getAttribute("data-detail") || "";
    });

    function timeEl(iso, mode) {
      var node = document.createElement("time");
      node.setAttribute("datetime", iso);
      node.setAttribute("data-time", mode);
      node.textContent = iso;
      return node;
    }

    function renderEvent(event) {
      var li = document.createElement("li");
      li.className = "live-event " + event.kind;
      li.setAttribute("data-kind", event.kind);
      li.setAttribute("data-summary", event.summary);
      li.appendChild(timeEl(event.at, "clock"));
      if (event.detail) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "live-summary";
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("data-summary", event.summary);
        button.setAttribute("data-detail", event.detail);
        button.textContent = event.summary;
        li.appendChild(button);
      } else {
        var span = document.createElement("span");
        span.className = "live-summary";
        span.textContent = event.summary;
        li.appendChild(span);
      }
      localizeTimes(li);
      return li;
    }

    function showNow(event) {
      if (nowNote && (event.role === "note" || event.kind === "message")) {
        nowNote.textContent = event.summary;
        nowNote.hidden = false;
      }
      if (nowCommand && event.kind === "command") {
        // Same strip as commandText in src/serve-page.ts; change both together.
        nowCommand.textContent = event.summary.replace(/^Ran\s+/, "");
        nowCommand.hidden = false;
      }
    }

    function place(event) {
      if (phase && event.phase && event.phase !== phase) {
        // Pinned to one step: another step's event is not this page's to show.
        if (pinned) return;
        // A new step started: reload so its section opens. The page scroll is kept by the browser.
        if (!reloading && !actionPending) {
          reloading = true;
          location.reload();
        }
        return;
      }
      showNow(event);
      var empty = feed.querySelector(".empty");
      if (empty) empty.remove();
      if (event.kind === "command" || event.kind === "edit") {
        var items = feed.querySelectorAll(".live-event");
        for (var i = items.length - 1; i >= 0; i--) {
          if (items[i].getAttribute("data-kind") !== event.kind) continue;
          var prev = items[i].getAttribute("data-summary") || "";
          if (event.summary.indexOf(prev) === 0 && prev) {
            if (event.summary !== prev) items[i].replaceWith(renderEvent(event));
            return;
          }
          break;
        }
      }
      feed.appendChild(renderEvent(event));
    }

    function apply(data) {
      if (error) error.hidden = true;
      var events = data && data.events ? data.events : [];
      var kinds = { message: 1, tool: 1, edit: 1, command: 1, result: 1, error: 1 };
      for (var i = 0; i < events.length; i++) {
        var event = events[i];
        if (!event || !kinds[event.kind] || typeof event.summary !== "string" || typeof event.at !== "string") continue;
        place(event);
      }
      if (typeof data.cursor === "string") {
        cursor = data.cursor;
        root.setAttribute("data-cursor", cursor);
      }
      running = data.running === true;
      root.setAttribute("data-running", running ? "true" : "false");
      follow();
      if (!running && timer) {
        clearInterval(timer);
        timer = 0;
      }
    }

    function pull() {
      if (document.visibilityState === "hidden") return;
      var query = cursor ? "?after=" + encodeURIComponent(cursor) : "";
      fetch("/api/jobs/" + encodeURIComponent(jobId) + "/activity" + query, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          if (!response.ok) throw new Error("status");
          return response.json();
        })
        .then(apply)
        .catch(function () {
          if (!error) return;
          error.hidden = false;
          error.textContent = "Could not refresh activity.";
        });
    }

    showFollow();
    if (running) {
      requestAnimationFrame(follow);
      pull();
      timer = setInterval(pull, 2000);
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && running) pull();
      });
    } else if (pinned) {
      // A finished step opens at its last line.
      requestAnimationFrame(follow);
    } else {
      ignoreScroll = false;
    }
  }
})();
