import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import type { StatusJobView, StatusState } from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";
import { BOARD_THEME_IDS } from "../src/theme.js";

const css = readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");

function outsideTokens(source: string): string {
  const start = source.indexOf("/* tokens:start */");
  const end = source.indexOf("/* tokens:end */");
  assert.ok(start !== -1 && end > start, "serve.css is missing the tokens block");
  return source.slice(0, start) + source.slice(end + "/* tokens:end */".length);
}

function themeBlocks(source: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const pattern = /\/\* theme:([a-z0-9-]+) \*\/([\s\S]*?)\/\* theme:end \*\//g;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    const body = match[2];
    assert.ok(id && body !== undefined);
    assert.equal(blocks.has(id), false, `duplicate theme ${id}`);
    blocks.set(id, body);
  }
  return blocks;
}

function withoutTokenOrTheme(source: string): string {
  return outsideTokens(source).replace(/\/\* theme:[a-z0-9-]+ \*\/[\s\S]*?\/\* theme:end \*\//g, "");
}

function colorProps(block: string): string[] {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? "").filter(Boolean).sort();
}

function job(id: string, state: StatusState, repo: string, title = id): StatusJobView {
  return {
    jobId: id,
    title,
    repo,
    workflow: "feature",
    state,
    dependsOn: [],
    stack: false,
    launchFailed: false,
    attemptCount: 0,
    maxAttempts: 3,
    prPending: false,
    prClosedUnmerged: false,
    noReadableApproval: false,
    gates: [],
    canApprove: state === "needs-human",
    canReject: state === "needs-human",
    canRevise: false,
    steps: [],
  };
}

const workflows = ["feature", "fix", "investigation", "review"];

function repos(names: string[]) {
  return names.map((name) => ({ name, path: `/repos/${name}` }));
}

function addForm(html: string): string {
  const start = html.indexOf('id="add-form"');
  const end = html.indexOf("</form>", start);
  return html.slice(start, end);
}

describe("board style", () => {
  it("keeps px spacing and color literals inside the token and theme blocks", () => {
    const rest = withoutTokenOrTheme(css)
      .split("\n")
      .filter((line) => !line.includes("@media"))
      .join("\n")
      .replaceAll("white-space", "");
    const color = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black)\b/;
    const px = /\d+px\b/;
    const bad: string[] = [];
    for (const line of rest.split("\n")) {
      if (color.test(line) || px.test(line)) bad.push(line.trim());
    }
    assert.deepEqual(bad, []);
  });

  it("gives every theme the same color tokens and paints the appearance grid", () => {
    const blocks = themeBlocks(css);
    assert.deepEqual([...blocks.keys()], [...BOARD_THEME_IDS]);
    const kiln = blocks.get("kiln");
    assert.ok(kiln);
    assert.match(kiln, /:where\(:root\)/);
    assert.match(kiln, /color-scheme:\s*dark/);
    const expected = colorProps(kiln);
    const required = [
      "--bg",
      "--panel",
      "--card",
      "--card-hover",
      "--line",
      "--line-strong",
      "--ink",
      "--muted",
      "--faint",
      "--primary",
      "--on-primary",
      "--focus",
      "--code",
      "--code-bg",
      "--scrim",
      "--live",
      "--pass",
      "--changes",
      "--human",
      "--state-queued",
      "--state-running",
      "--state-needs-you",
      "--state-needs-hand",
      "--state-done",
      "--state-failed",
      "--state-cancelled",
    ];
    for (const name of required) assert.equal(expected.includes(name), true, name);
    const light = new Set(["gruvbox-light", "catppuccin-latte", "monospace-light"]);
    for (const [id, block] of blocks) {
      assert.deepEqual(colorProps(block), expected, id);
      assert.equal(/\d+px\b/.test(block), false, id);
      assert.match(block, new RegExp(`\\[data-theme="${id}"\\]`));
      assert.match(block, light.has(id) ? /color-scheme:\s*light/ : /color-scheme:\s*dark/);
    }

    const attention = buildAttention([job("SAMPLE-1", "needs-human", "web"), job("SAMPLE-2", "queued", "api")]);
    const html = renderConsole(css, attention, {
      csrf: "abc",
      repos: repos(["web", "api"]),
      workflows,
      section: "settings",
      theme: "nord",
    });
    assert.match(html, /<html lang="en" data-theme="nord">/);
    assert.match(html, /<a href="\/settings\/appearance"><span>Appearance<\/span><\/a>/);
    assert.match(html, /id="theme-pick"/);
    const picker = html.slice(html.indexOf('id="theme-pick"'), html.indexOf('data-error="board.theme"'));
    assert.doesNotMatch(picker, /role="combobox"/);
    assert.doesNotMatch(picker, /class="pick"/);
    for (const id of BOARD_THEME_IDS) {
      assert.match(html, new RegExp(`data-theme-choice="${id}"`));
      assert.match(html, new RegExp(`class="theme-swatch" data-theme="${id}"`));
    }
    assert.match(html, /data-theme-choice="nord" aria-pressed="true"/);
    const fallback = renderConsole(css, attention, { csrf: "abc", repos: repos(["web"]), workflows, section: "pipeline" });
    assert.match(fallback, /<html lang="en" data-theme="kiln">/);
  });

  it("pads the drawer, pins the footer, and switches the repo picker past five", () => {
    const attention = buildAttention([job("SAMPLE-1", "needs-human", "web"), job("SAMPLE-2", "queued", "api")]);
    const few = repos(["web", "api", "docs"]);
    const pipeline = renderConsole(css, attention, { csrf: "abc", repos: few, workflows, section: "pipeline" });
    const form = addForm(pipeline);
    assert.match(pipeline, /data-pick-limit="5"/);
    assert.match(form, /id="repo-pick"[^>]*data-mode="chips"/);
    assert.match(form, /data-workflow="feature" aria-pressed="true"/);
    assert.doesNotMatch(form, /role="combobox"/);
    assert.match(form, /class="form-footer"/);
    assert.match(
      form,
      /data-close>Cancel<\/button>\s*<button type="submit" class="btn primary" id="add-submit" disabled>Add<\/button>/,
    );
    assert.match(pipeline, /id="board"/);
    assert.match(pipeline, /SAMPLE-1/);
    const bodyRule = css.match(/\.intake-body\s*\{[^}]+\}/);
    assert.ok(bodyRule);
    assert.match(bodyRule[0], /var\(--drawer-pad\)/);
    assert.doesNotMatch(bodyRule[0], /\d+px/);
    const foot = css.match(/\.sheet \.form-footer\s*\{[^}]+\}/);
    assert.ok(foot);
    assert.match(foot[0], /position:\s*sticky/);
    assert.match(foot[0], /var\(--drawer-pad\)/);

    const many = repos([
      "web",
      "api",
      "docs",
      "widget",
      "billing",
      "search",
      "mobile",
      "worker",
      "gateway",
      "notify",
      "ledger",
      "studio",
    ]);
    const inbox = renderConsole(css, attention, { csrf: "abc", repos: many, workflows, section: "pipeline" });
    const inboxForm = addForm(inbox);
    assert.match(inbox, /SAMPLE-1/);
    assert.match(inboxForm, /id="repo-pick"[^>]*data-mode="select"/);
    assert.match(inboxForm, /role="combobox"/);
    assert.equal((inboxForm.match(/id="repo-opt-/g) || []).length, 12);
    const picker = inboxForm.slice(inboxForm.indexOf('id="repo-pick"'), inboxForm.indexOf('id="workflow-field"'));
    assert.doesNotMatch(picker, /class="pick"/);

    const wide = addForm(
      renderConsole(css, buildAttention([]), {
        csrf: "abc",
        repos: few,
        workflows: [...workflows, "migrate", "cleanup"],
        section: "pipeline",
      }),
    );
    assert.match(wide, /<select id="workflow"/);
    assert.doesNotMatch(wide, /id="workflow-pick"/);
  });

  it("uses rectangles for chips and does not underline links", () => {
    assert.doesNotMatch(css, /--radius-pill/);
    assert.match(css, /\.tick, \.chip \{[^}]*border-radius:\s*var\(--radius-md\)/);
    assert.match(css, /\.badge \{[^}]*border-radius:\s*var\(--radius-md\)/);
    assert.match(css, /\.repo-f, \.wf-f \{[^}]*border-radius:\s*var\(--radius-md\)/);
    assert.match(css, /\.repo-f, \.wf-f \{[^}]*padding:\s*0 var\(--space-2\)/);
    assert.doesNotMatch(css, /a:hover\s*\{[^}]*underline/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /\.text-btn \{/);
    assert.match(css, /\.liveness\.working \.live-dot \{[^}]*animation:\s*live-pulse/);
  });

  it("labels each After job once", () => {
    const attention = buildAttention([
      job("SAMPLE-1", "queued", "web"),
      job("j202611090001", "queued", "api", "Show the empty state"),
      job("SAMPLE-3", "queued", "docs", "   "),
      job("SAMPLE-4", "done", "web", "Finished work"),
    ]);
    const html = addForm(renderConsole(css, attention, { csrf: "abc", repos: repos(["web"]), workflows, section: "pipeline" }));
    const after = html.slice(html.indexOf('id="after-list"'), html.indexOf("</fieldset>"));
    const text = (id: string) => {
      const start = after.indexOf(`<label class="after"><input type="checkbox" name="after" value="${id}">`);
      assert.ok(start >= 0, id);
      return after
        .slice(start, after.indexOf("</label>", start))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    assert.equal(text("SAMPLE-1"), "SAMPLE-1");
    assert.equal(text("j202611090001"), "j202611090001 — Show the empty state");
    assert.equal(text("SAMPLE-3"), "SAMPLE-3");
    assert.equal(after.includes("SAMPLE-4"), false);
    assert.equal(after.includes("Finished work"), false);
    assert.match(html, /id="prompt-error"[^>]*hidden></);
    assert.doesNotMatch(html, /Prompt is required/);
  });

  it("spaces a repo status list with the shared job cards", () => {
    const queued = {
      ...job("j202611150001", "queued", "lumen", "Refresh the status list"),
      specPath: "/tmp/lumen/spec.md",
      createdAt: "2026-11-15T20:00:00.000Z",
    };
    const running = job("j202611150002", "running", "lumen", "Check the sample build");
    const other = job("j202611150003", "done", "harbor", "Ship the sample notes");
    const html = renderConsole(css, buildAttention([queued, running, other]), {
      csrf: "abc",
      repos: repos(["lumen", "harbor"]),
      workflows,
      section: "repos",
      repo: "lumen",
    });
    const mainStart = html.indexOf('<main class="main">');
    const mainEnd = html.indexOf("</main>", mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart);
    const main = html.slice(mainStart, mainEnd);
    assert.match(main, /<h2>lumen<\/h2>/);
    assert.doesNotMatch(main, /Ship the sample notes/);
    assert.doesNotMatch(main, /j202611150003/);
    assert.doesNotMatch(main, />harbor</);

    const groups = [...main.matchAll(/<section class="state-group">([\s\S]*?)<\/section>/g)].map((match) => match[1] ?? "");
    assert.deepEqual(
      groups.map((group) => group.match(/<h3>([^<]+)/)?.[1]),
      ["Queued", "Running"],
    );
    for (const group of groups) {
      assert.match(group, /^<div class="jobs"><h3>[^<]+<span class="badge">\d+<\/span><\/h3>/);
      const heading = group.slice(0, group.indexOf("</h3>"));
      assert.doesNotMatch(heading, /class="chip/);
      assert.match(group, /<article class="job"/);
    }

    const card = main.slice(main.indexOf('id="job-j202611150001"'), main.indexOf("</article>", main.indexOf('id="job-j202611150001"')));
    const titleAt = card.indexOf('class="job-title"');
    const metaAt = card.indexOf('class="job-meta"');
    const reasonAt = card.indexOf('class="reason"');
    const linksAt = card.indexOf('class="links"');
    assert.ok(titleAt >= 0 && metaAt > titleAt && reasonAt > metaAt && linksAt > reasonAt);
    assert.match(card, /Refresh the status list/);
    assert.match(card, /<span class="num">j202611150001<\/span>/);
    assert.match(card, /<span class="chip queued">queued<\/span>/);
    assert.match(card, /<span class="chip">feature<\/span>/);
    assert.match(card, /data-time="rel"/);
    assert.match(card, /Queued, ready to launch/);
    assert.match(card, /<a class="text-btn" href="\/jobs\/j202611150001\/spec">[\s\S]*?<span>Spec<\/span><\/a>/);
    assert.doesNotMatch(card, /border-left|accent/);

    const block = (selector: string) => {
      const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]+\\}`, "g");
      const matches = [...css.matchAll(pattern)].map((match) => match[0]);
      assert.ok(matches.length > 0, selector);
      return matches.join("\n");
    };
    assert.match(block(".main"), /max-width:\s*var\(--content-max\)/);
    assert.match(block(".main"), /padding:[^;]*var\(--gutter\)/);
    assert.match(block(".jobs"), /gap:\s*var\(--space-3\)/);
    assert.match(block(".jobs"), /max-width:\s*100%/);
    assert.match(block(".job-main"), /gap:\s*var\(--space-2\)/);
    assert.match(block(".job .job-meta"), /gap:\s*var\(--space-3\)/);
    assert.match(block(".state-group h3"), /margin:\s*0/);
    assert.match(block(".state-group h3"), /text-transform:\s*none/);
    assert.doesNotMatch(block(".state-group h3"), /uppercase|letter-spacing:\s*\.04em/);
    assert.match(block(".job, .card, .trigger, .stat-grid .stat"), /border-radius:\s*var\(--radius-lg\)/);
    assert.doesNotMatch(block(".job"), /border-left/);
    assert.equal(css.includes(".repo-block h3"), false);
  });
});

/** `@media (...) { ... }` bodies, matched to their closing brace. */
function mediaBlocks(source: string, query: RegExp): string[] {
  const blocks: string[] = [];
  for (const match of source.matchAll(/@media[^{]*\{/g)) {
    if (!query.test(match[0])) continue;
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(source.slice(start, index - 1));
  }
  return blocks;
}

/** Innermost `selector { body }` rules. A media query's own head is not part of a selector. */
function cssRules(source: string): { selectors: string[]; body: string }[] {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: (match[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean),
    body: match[2] ?? "",
  }));
}

describe("pipeline board style", () => {
  const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

  it("never gives a card a one-sided border", () => {
    const bad = cssRules(css)
      .filter((rule) => rule.selectors.some((selector) => selector.includes(".card")))
      .filter((rule) => /(?:^|[\s;])border-(?:left|right|top|bottom|inline-start|inline-end|inline)\b[\w-]*\s*:/.test(rule.body))
      .map((rule) => rule.selectors.join(", "));
    assert.deepEqual(bad, []);
  });

  it("switches every animation off under prefers-reduced-motion", () => {
    const reduced = mediaBlocks(css, /prefers-reduced-motion:\s*reduce/);
    assert.ok(reduced.length > 0);
    const still = new Set(
      reduced.flatMap((block) => cssRules(block).filter((rule) => /animation:\s*none/.test(rule.body)).flatMap((rule) => rule.selectors)),
    );
    let rest = css;
    for (const block of reduced) rest = rest.replace(block, "");
    const animated = cssRules(rest)
      .filter((rule) => /(?:^|[\s;])animation:(?!\s*none\b)/.test(rule.body))
      .flatMap((rule) => rule.selectors);
    for (const name of [".track .seg.sweep", ".step-pulse", ".board-pulse"]) assert.ok(animated.includes(name), name);
    const missing = animated.filter((selector) => !still.has(selector));
    assert.deepEqual(missing, []);
    for (const name of ["track-sweep", "step-pulse", "board-pulse"]) assert.match(css, new RegExp(`@keyframes ${name} \\{`));
  });

  it("stacks the board into one column at the narrow breakpoint with no sideways scroll", () => {
    const narrow = mediaBlocks(css, /max-width:\s*960px/).join("\n");
    const board = cssRules(narrow).filter((rule) => rule.selectors.includes(".board"));
    assert.ok(board.length > 0);
    for (const rule of board) assert.doesNotMatch(rule.body, /min-width/);
    assert.ok(board.some((rule) => /grid-template-columns:\s*minmax\(0, 1fr\);/.test(rule.body)));
    assert.ok(cssRules(narrow).some((rule) => rule.selectors.includes(".board-scroll") && /overflow-x:\s*visible/.test(rule.body)));
    // The wide minimum only applies above the breakpoint.
    let wide = css;
    for (const block of mediaBlocks(css, /./)) wide = wide.replace(block, "");
    for (const rule of cssRules(wide).filter((item) => item.selectors.includes(".board"))) assert.doesNotMatch(rule.body, /min-width/);
    assert.match(mediaBlocks(css, /min-width:\s*961px/).join("\n"), /\.board \{ min-width: var\(--board-min\); \}/);
  });

  it("gives every theme six repo colors and paints the repo icon with them", () => {
    for (const [id, block] of themeBlocks(css)) {
      for (let tone = 1; tone <= 6; tone += 1) assert.match(block, new RegExp(`--repo-${tone}:`), `${id} --repo-${tone}`);
    }
    for (let tone = 1; tone <= 6; tone += 1) assert.match(css, new RegExp(`\\.repo-${tone} \\.icon \\{ color: var\\(--repo-${tone}\\); \\}`));
  });

  it("swaps the board in place on poll and keeps the title and notification", () => {
    const start = script.indexOf("function swapBoard(");
    assert.ok(start >= 0);
    const swap = script.slice(start, script.indexOf("\n  function poll()", start));
    assert.match(swap, /new DOMParser\(\)\.parseFromString\(html, "text\/html"\)/);
    assert.match(swap, /fetch\("\/"/);
    assert.match(swap, /if \(actionPending \|\| boardFocused\(\)\) return;/);
    assert.match(swap, /document\.getElementById\(fresh\[c\]\.id\)/);
    assert.match(swap, /document\.title = "\(" \+ n \+ "\) Kiln";/);
    assert.match(swap, /note\(n\);/);
    assert.match(swap, /applyRepo\(\);/);
    assert.match(swap, /paintLiveness\(\);/);
    assert.match(swap, /setAttribute\("data-needs-you"/);
    assert.match(swap, /board-status/);
    assert.doesNotMatch(swap, /location\.reload/);
    const pollStart = script.indexOf("\n  function poll()");
    const poll = script.slice(pollStart, script.indexOf("\n  }\n", pollStart));
    assert.match(poll, /var onBoard = body\.getAttribute\("data-section"\) === "pipeline";/);
    assert.match(poll, /if \(!onBoard\) \{\s*location\.reload\(\);\s*return;\s*\}\s*swapBoard\(rev\);/);
    assert.match(poll, /\.col\[data-column="running"\] \.card/);
    assert.equal(poll.split("location.reload()").length - 1, 1, "only other sections reload");
  });
});

describe("job page style", () => {
  const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

  function rules(selector: string, source = css): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = [...source.matchAll(new RegExp(`(?:^|[\\n}])\\s*${escaped}\\s*\\{([^}]+)\\}`, "g"))].map((match) => match[1] ?? "");
    assert.ok(found.length > 0, selector);
    return found.join("\n");
  }

  it("scrolls the current step's activity inside its own box", () => {
    const box = rules(".step-section.open .activity");
    assert.match(box, /overflow-y:\s*auto/);
    assert.match(box, /max-height:\s*var\(--log-max-height\)/);
    assert.match(css.slice(css.indexOf("/* tokens:start */"), css.indexOf("/* tokens:end */")), /--log-max-height:/);
    assert.match(rules(".step-section.open .activity.expanded"), /max-height:\s*none/);
  });

  it("puts the side column below the main column at narrow width", () => {
    assert.match(rules(".job-body"), /grid-template-columns:\s*minmax\(0, 1fr\) var\(--rail\)/);
    const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    assert.match(block, /\.job-body \{ grid-template-columns: 1fr; \}/);
    assert.match(rules(".job-main, .job-side"), /min-width:\s*0/);
    assert.match(rules(".now-command, .file-path"), /overflow-wrap:\s*anywhere/);
    assert.doesNotMatch(css, /\.tabs\b/);
  });

  it("stacks the settings sections above the open section at narrow width", () => {
    const layout = rules(".settings-layout");
    assert.match(layout, /display:\s*flex/);
    assert.match(layout, /flex-wrap:\s*wrap/);
    const nav = rules(".settings-nav");
    assert.match(nav, /flex:\s*1 1 var\(--settings-nav-min\)/);
    assert.match(nav, /max-width:\s*var\(--settings-nav-max\)/);
    const pane = rules(".settings-pane");
    assert.match(pane, /flex:\s*999 1/);
    assert.match(pane, /min-width:\s*0/);
    assert.match(rules(".settings-foot"), /position:\s*sticky/);
    assert.match(rules('.settings-nav a[aria-current="page"]'), /background:\s*var\(--card-hover\)/);
    const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    assert.match(block, /\.settings-layout \{ flex-direction: column;[^}]*\}/);
    assert.match(block, /\.settings-nav \{ flex: none; max-width: none; width: auto; \}/);
    // The nav comes before the panes in the markup, so a column puts it on top. Nothing reorders it or fixes a width.
    assert.doesNotMatch(css, /\.settings-[a-z-]+[^{]*\{[^}]*(?:^|[\s;])order\s*:/m);
    const settingsRules = [...css.matchAll(/\.settings-[^{]*\{([^}]*)\}/g)].map((match) => match[1] ?? "").join("\n");
    assert.doesNotMatch(settingsRules, /overflow-x/);
    assert.doesNotMatch(settingsRules, /(?:^|[\s;])(?:min-|max-)?width:\s*[1-9]/m);
    assert.doesNotMatch(settingsRules, /\d+px/);
  });

  it("puts the step list above the step at narrow width and scrolls the step's log in its own box", () => {
    assert.match(rules(".step-page"), /grid-template-columns:\s*var\(--step-nav\) minmax\(0, 1fr\)/);
    assert.match(css.slice(css.indexOf("/* tokens:start */"), css.indexOf("/* tokens:end */")), /--step-nav:/);
    const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    assert.match(block, /\.step-page \{ grid-template-columns: 1fr; \}/);
    // Single column keeps DOM order, and the nav comes first in the markup (see step-page.test.ts). Nothing reorders it.
    assert.doesNotMatch(css, /\.step-(?:nav|view|page)[^{]*\{[^}]*(?:^|[\s;])order\s*:/m);
    const box = rules(".step-live .activity");
    assert.match(box, /overflow-y:\s*auto/);
    assert.match(box, /max-height:\s*var\(--log-max-height\)/);
    assert.match(rules(".step-live .activity.expanded"), /max-height:\s*none/);
    assert.match(rules(".step-row"), /overflow-wrap:\s*anywhere/);
  });

  it("follows new activity in the feed and never scrolls the page", () => {
    const start = script.indexOf("function startLive()");
    assert.ok(start >= 0);
    const live = script.slice(start);
    assert.doesNotMatch(live, /scrollingElement/);
    assert.doesNotMatch(live, /documentElement\.scrollTop/);
    assert.doesNotMatch(live, /window\.addEventListener\("scroll"/);
    assert.match(live, /feed\.scrollTop = feed\.scrollHeight/);
    assert.match(live, /feed\.addEventListener\("scroll"/);
    assert.match(live, /stick = false;/);
    assert.equal(live.split("stick = true").length - 1, 1, "only Jump to latest turns following back on");
    assert.match(live, /jump\.addEventListener\("click", function \(\) \{\s*stick = true;/);
    assert.match(live, /Following the latest line/);
    assert.match(live, /Paused\. Jump to latest to follow\./);
    assert.match(live, /classList\.toggle\("expanded"/);
    assert.match(live, /location\.replace\("#" \+ target\)/);
    assert.doesNotMatch(live, /behavior:\s*"smooth"/);
  });
});
