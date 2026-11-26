import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import { renderConsole } from "../src/serve-page.js";

const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

function addForm(): string {
  const html = renderConsole("", buildAttention([]), {
    csrf: "abc",
    repos: [{ name: "web", path: "/repos/web" }],
    workflows: ["feature"],
  });
  const start = html.indexOf('id="add-form"');
  const end = html.indexOf("</form>", start);
  return html.slice(start, end);
}

interface El {
  id: string;
  attrs: Record<string, string>;
  value: string;
  parent: El | null;
  listeners: Record<string, Array<(event: { target: El; preventDefault(): void }) => void>>;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => El | null;
  addEventListener: (type: string, fn: (event: { target: El; preventDefault(): void }) => void) => void;
}

function el(id: string, attrs: Record<string, string> = {}): El {
  const node: El = {
    id,
    attrs: { ...attrs },
    value: "",
    parent: null,
    listeners: {},
    getAttribute: (name) => (Object.hasOwn(node.attrs, name) ? (node.attrs[name] ?? "") : null),
    closest: (selector) => {
      let current: El | null = node;
      while (current) {
        const source = selector.includes("[data-source]") && current.attrs["data-source"] && hasId(current, "add-form");
        if (current.id && selector === `#${current.id}`) return current;
        if (source) return current;
        current = current.parent;
      }
      return null;
    },
    addEventListener: (type, fn) => {
      (node.listeners[type] ??= []).push(fn);
    },
  };
  return node;
}

function hasId(node: El, id: string): boolean {
  let current: El | null = node;
  while (current) {
    if (current.id === id) return true;
    current = current.parent;
  }
  return false;
}

function boot() {
  const byId = new Map<string, El>();
  const add = (id: string, attrs?: Record<string, string>) => {
    const node = el(id, attrs);
    byId.set(id, node);
    return node;
  };
  const body = add("body", { "data-needs-you": "0", "data-revision": "rev", "data-csrf": "abc", "data-pick-limit": "5" });
  const form = add("add-form");
  form.parent = body;
  const promptBtn = add("prompt-source", { "data-source": "prompt" });
  const jiraBtn = add("jira-source", { "data-source": "jira" });
  for (const child of [promptBtn, jiraBtn, add("jira-key"), add("job-issue"), add("job-title"), add("prompt-text")]) {
    child.parent = form;
  }
  add("repo-pick", { "data-value": "web" });
  add("workflow-pick", { "data-workflow": "feature" });
  const posts: Array<Record<string, unknown>> = [];
  const clicks: Array<(event: { target: El; preventDefault(): void }) => void> = [];
  const document = {
    body,
    documentElement: { getAttribute: () => "kiln" },
    title: "",
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: (event: { target: El; preventDefault(): void }) => void) => {
      if (type === "click") clicks.push(fn);
    },
  };
  vm.runInContext(script, vm.createContext({
    document,
    localStorage: memory(),
    sessionStorage: memory(),
    fetch: (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ids: ["job-1"] }) });
    },
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    clearInterval,
    location: { reload() {} },
    Promise,
    Date,
    Number,
    String,
    Boolean,
    JSON,
    Object,
    Array,
    isFinite,
    encodeURIComponent,
  }));
  const fire = (target: El, type: string) => {
    const event = { target, preventDefault() {} };
    for (const fn of target.listeners[type] ?? []) fn(event);
    if (type === "click") for (const fn of clicks) fn(event);
  };
  return { byId, posts, fire };
}

function memory() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("jira add form", () => {
  it("renders no Issue or Title inputs in the Jira pane", () => {
    const form = addForm();
    const pane = form.slice(form.indexOf('data-pane="jira"'), form.indexOf('id="issue-field"'));
    assert.match(pane, />Jira issue</);
    assert.match(pane, /placeholder="PROJ-123 or issue URL"/);
    assert.doesNotMatch(pane, /id="job-issue"|id="job-title"/);
    assert.match(form, /id="issue-field"/);
    assert.match(form, /id="title-field"/);
  });

  it("sends only the Jira key, and still sends Issue and Title for a prompt", async () => {
    const page = boot();
    const issue = page.byId.get("job-issue");
    const title = page.byId.get("job-title");
    const key = page.byId.get("jira-key");
    const prompt = page.byId.get("prompt-text");
    const jira = page.byId.get("jira-source");
    const promptBtn = page.byId.get("prompt-source");
    const form = page.byId.get("add-form");
    assert.ok(issue && title && key && prompt && jira && promptBtn && form);
    issue.value = "ABC-999";
    title.value = "Typed title";
    page.fire(title, "input");
    page.fire(jira, "click");
    key.value = "https://example.atlassian.net/browse/PROJ-123";
    page.fire(form, "submit");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const jiraBody = page.posts[0];
    assert.ok(jiraBody);
    assert.deepEqual(jiraBody.source, { kind: "jira", key: "https://example.atlassian.net/browse/PROJ-123" });
    assert.equal(Object.hasOwn(jiraBody, "issue"), false);
    assert.equal(Object.hasOwn(jiraBody, "title"), false);

    page.fire(promptBtn, "click");
    prompt.value = "Show a quiet empty state\n";
    page.fire(form, "submit");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const promptBody = page.posts[1];
    assert.ok(promptBody);
    assert.equal((promptBody.source as { kind?: string }).kind, "prompt");
    assert.equal(promptBody.issue, "ABC-999");
    assert.equal(promptBody.title, "Typed title");
  });
});
