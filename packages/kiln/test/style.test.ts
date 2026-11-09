import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import type { StatusJobView, StatusState } from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";

const css = readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");

function outsideTokens(source: string): string {
  const start = source.indexOf("/* tokens:start */");
  const end = source.indexOf("/* tokens:end */");
  assert.ok(start !== -1 && end > start, "serve.css is missing the tokens block");
  return source.slice(0, start) + source.slice(end + "/* tokens:end */".length);
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
  it("keeps px spacing and color literals inside the token block", () => {
    const rest = outsideTokens(css)
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
    const inbox = renderConsole(css, attention, { csrf: "abc", repos: many, workflows, section: "inbox" });
    const inboxForm = addForm(inbox);
    assert.match(inbox, /Inbox/);
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
});
