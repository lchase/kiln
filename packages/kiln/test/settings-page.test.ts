import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import vm from "node:vm";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import { renderApp, type SettingsSectionId } from "../src/serve-page.js";
import { readSettings, saveSettings } from "../src/settings.js";
import { buildBoard } from "../src/board-view.js";

const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");
const TOKEN = "settings-page-test-token-not-real";
const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

// A small DOM: enough HTML parsing and selector matching for the settings script.

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  type: string;
  target: Node;
  button?: number;
  defaultPrevented: boolean;
  returnValue?: unknown;
  preventDefault(): void;
}

const VOID = new Set(["input", "br", "meta", "link", "img", "hr", "source", "wbr"]);
const RAW = new Set(["script", "style"]);

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

class Node {
  tagName: string;
  attrs: Record<string, string> = {};
  children: Node[] = [];
  parentNode: Node | null = null;
  text = "";
  value = "";
  checked = false;
  readOnly = false;
  disabled = false;
  listeners: Record<string, Listener[]> = {};
  style = { setProperty() {} };
  focused = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get parentElement(): Node | null {
    return this.parentNode && this.parentNode.tagName !== "#ROOT" ? this.parentNode : null;
  }
  get id(): string {
    return this.attrs.id ?? "";
  }
  get hidden(): boolean {
    return "hidden" in this.attrs;
  }
  set hidden(on: boolean) {
    if (on) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  get className(): string {
    return this.attrs.class ?? "";
  }
  set className(value: string) {
    this.attrs.class = value;
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => list().includes(name),
      add: (name: string) => {
        if (!list().includes(name)) this.className = [...list(), name].join(" ");
      },
      remove: (name: string) => {
        this.className = list().filter((item) => item !== name).join(" ");
      },
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !list().includes(name);
        if (on && !list().includes(name)) this.className = [...list(), name].join(" ");
        if (!on) this.className = list().filter((item) => item !== name).join(" ");
        return on;
      },
    };
  }
  get textContent(): string {
    if (this.tagName === "#TEXT") return this.text;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    const node = new Node("#text");
    node.text = String(value);
    node.parentNode = this;
    this.children = [node];
  }
  set innerHTML(html: string) {
    this.children = [];
    parseInto(this, html);
  }
  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? (this.attrs[name] ?? "") : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attrs, name);
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  focus(): void {
    this.focused += 1;
  }
  select(): void {}
  scrollIntoView(): void {}
  elements(): Node[] {
    const out: Node[] = [];
    const walk = (node: Node) => {
      for (const child of node.children) {
        if (child.tagName === "#TEXT") continue;
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(selector: string): Node[] {
    return this.elements().filter((node) => matches(node, selector));
  }
  querySelector(selector: string): Node | null {
    return this.elements().find((node) => matches(node, selector)) ?? null;
  }
  closest(selector: string): Node | null {
    let current: Node | null = this;
    while (current && current.tagName !== "#ROOT") {
      if (current.tagName !== "#TEXT" && matches(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
}

function parseInto(root: Node, html: string): void {
  const stack: Node[] = [root];
  const top = () => stack[stack.length - 1] as Node;
  const append = (node: Node) => {
    node.parentNode = top();
    top().children.push(node);
  };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      i = html.indexOf("-->", i) + 3;
      continue;
    }
    if (html.startsWith("<!", i)) {
      i = html.indexOf(">", i) + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const name = html.slice(i + 2, end).trim().toUpperCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]?.tagName === name) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    if (html[i] === "<" && /[a-zA-Z]/.test(html[i + 1] ?? "")) {
      const tag = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i));
      const name = (tag?.[1] ?? "").toLowerCase();
      let j = i + 1 + name.length;
      const node = new Node(name);
      let selfClose = false;
      for (;;) {
        while (/\s/.test(html[j] ?? "")) j++;
        if (html[j] === ">") {
          j++;
          break;
        }
        if (html.startsWith("/>", j)) {
          selfClose = true;
          j += 2;
          break;
        }
        const attr = /^([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(html.slice(j));
        assert.ok(attr, `bad attribute near ${html.slice(j, j + 40)}`);
        node.attrs[(attr[1] ?? "").toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4] ?? "");
        j += attr[0].length;
      }
      if (name === "input") {
        node.value = node.attrs.value ?? "";
        node.checked = "checked" in node.attrs;
      }
      if ("readonly" in node.attrs) node.readOnly = true;
      if ("disabled" in node.attrs) node.disabled = true;
      append(node);
      i = j;
      if (RAW.has(name) || name === "textarea") {
        const close = html.toLowerCase().indexOf(`</${name}>`, i);
        const inner = html.slice(i, close);
        if (name === "textarea") node.value = decode(inner);
        i = close + name.length + 3;
        continue;
      }
      if (!selfClose && !VOID.has(name)) stack.push(node);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const end = next === -1 ? html.length : next;
    const text = new Node("#text");
    text.text = decode(html.slice(i, end));
    append(text);
    i = end;
  }
}

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
  checked: boolean;
}

function parseCompound(text: string): Compound {
  const out: Compound = { classes: [], attrs: [], checked: false };
  const pattern = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|(:checked)/gy;
  let rest = 0;
  for (const match of text.matchAll(pattern)) {
    rest = (match.index ?? 0) + match[0].length;
    if (match[1]) out.tag = match[1].toUpperCase();
    else if (match[2]) out.id = match[2];
    else if (match[3]) out.classes.push(match[3]);
    else if (match[4]) out.attrs.push({ name: match[4], value: match[5] ?? match[6] ?? match[7] });
    else if (match[8]) out.checked = true;
  }
  assert.equal(rest, text.length, `unsupported selector ${text}`);
  return out;
}

function matchCompound(node: Node, part: Compound): boolean {
  if (part.tag && node.tagName !== part.tag) return false;
  if (part.id && node.id !== part.id) return false;
  for (const name of part.classes) if (!node.classList.contains(name)) return false;
  for (const attr of part.attrs) {
    const value = node.getAttribute(attr.name);
    if (value === null) return false;
    if (attr.value !== undefined && value !== attr.value) return false;
  }
  if (part.checked && !node.checked) return false;
  return true;
}

function matches(node: Node, selector: string): boolean {
  return selector.split(",").some((group) => {
    const parts = group.trim().split(/\s+(?![^[]*\])/).map(parseCompound);
    let index = parts.length - 1;
    if (!matchCompound(node, parts[index] as Compound)) return false;
    let current = node.parentElement;
    index -= 1;
    while (index >= 0 && current) {
      if (matchCompound(current, parts[index] as Compound)) index -= 1;
      current = current.parentElement;
    }
    return index < 0;
  });
}

// The page and the script.

interface Fixture {
  home: string;
  configPath: string;
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "kiln-settings-page-"));
  keep.push(home);
  for (const dir of ["kiln", "web", "skills-extra"]) mkdirSync(join(home, dir), { recursive: true });
  const configPath = join(home, "kiln.config.json");
  const config = {
    repos: {
      kiln: {
        path: join(home, "kiln"),
        test: "npm test",
        deliver: "pr",
        base: "main",
        prTitle: "[{issue}] {title}",
        branch: "{issue}-{slug}",
        maxAttempts: 4,
        maxFixRounds: 3,
      },
      web: { path: join(home, "web"), test: "npm run check", deliver: "local" },
    },
    stallTimeoutMs: 600000,
    maxAttempts: 3,
    keepWorktrees: true,
    maxFixRounds: 2,
    maxSameFingerprint: 4,
    dailyDollarCap: 5,
    maxConcurrent: 2,
    adapter: "mock",
    sandbox: { mode: "docker", allowDomains: ["example.com"] },
    triggers: [
      { id: "nightly", kind: "schedule", cron: "0 2 * * *", label: "sample", maxNew: 2, maxQueued: 4 },
      { id: "sample-ready", kind: "jira", every: "5m", label: "sample", status: "Ready", repo: "kiln" },
      { id: "sample-prs", kind: "pr", enabled: false },
    ],
    routes: [{ id: "ready-to-feature", trigger: "sample-ready", action: "create", workflow: "feature", repo: "kiln" }],
    jira: {
      baseUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      acceptanceField: "customfield_10001",
      apiToken: TOKEN,
    },
    overlay: { workflows: "workflows", prompts: "prompts", skills: "skills", skillPaths: [join(home, "skills-extra")] },
    board: { theme: "nord" },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { home, configPath };
}

function pageHtml(section: SettingsSectionId): string {
  return renderApp({
    css: "",
    section: "settings",
    board: buildBoard([], []),
    attention: buildAttention([]),
    page: { csrf: "abc", repos: [], workflows: ["feature", "review"] },
    settingsSection: section,
  });
}

interface Request {
  method: string;
  body?: Record<string, unknown>;
}

interface Page {
  doc: Node;
  byId(id: string): Node;
  requests: Request[];
  respond: { next?: { status: number; data: unknown } };
  history: { pushed: string[]; replaced: string[] };
  location: { pathname: string; search: string };
  click(node: Node): FakeEvent;
  type(id: string, value: string): void;
  submit(): void;
  unload(): FakeEvent;
  pop(path: string): void;
  confirmAnswer: { value: boolean };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function openPage(fx: Fixture, path = "/settings", section: SettingsSectionId = "repos"): Promise<Page> {
  const html = pageHtml(section);
  const root = new Node("#root");
  parseInto(root, html);
  const htmlEl = root.querySelector("html");
  const bodyEl = root.querySelector("body");
  assert.ok(htmlEl && bodyEl);
  const docListeners: Record<string, Listener[]> = {};
  const winListeners: Record<string, Listener[]> = {};
  const requests: Request[] = [];
  const respond: Page["respond"] = {};
  const history = { pushed: [] as string[], replaced: [] as string[] };
  const [pathname, search = ""] = path.split("?");
  const location = { pathname: pathname ?? "/settings", search: search ? `?${search}` : "", hash: "", reload() {} };
  const confirmAnswer = { value: true };
  const document = {
    body: bodyEl,
    documentElement: htmlEl,
    title: "",
    getElementById: (id: string) => root.querySelector(`#${id}`),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    addEventListener: (type: string, fn: Listener) => {
      (docListeners[type] ??= []).push(fn);
    },
  };
  const json = (status: number, data: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) });
  const fetch = (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (url !== "/api/settings") return json(200, {});
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, ...(body ? { body } : {}) });
    if (respond.next) {
      const next = respond.next;
      delete respond.next;
      return json(next.status, next.data);
    }
    const result = method === "PUT" ? saveSettings(fx.configPath, body, fx.home, {}) : readSettings(fx.configPath, {});
    return result.ok ? json(200, result.document) : json(result.status, result.body);
  };
  const window = {
    location,
    confirm: () => confirmAnswer.value,
    addEventListener: (type: string, fn: Listener) => {
      (winListeners[type] ??= []).push(fn);
    },
  };
  const historyApi = {
    pushState: (_state: unknown, _title: string, url: string) => {
      history.pushed.push(url);
      location.pathname = url;
      location.search = "";
    },
    replaceState: (_state: unknown, _title: string, url: string) => {
      history.replaced.push(url);
      location.pathname = url;
      location.search = "";
    },
  };
  const memory = () => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
    };
  };
  const context = vm.createContext({
    document,
    window,
    location,
    history: historyApi,
    localStorage: memory(),
    sessionStorage: memory(),
    fetch,
    URLSearchParams,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    clearInterval: () => {},
    console,
    Promise,
    Date,
    Number,
    String,
    Boolean,
    JSON,
    Object,
    Array,
    Math,
    Error,
    RegExp,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  });
  vm.runInContext(script, context);
  await settle();

  const dispatch = (target: Node, type: string, extra: Partial<FakeEvent> = {}): FakeEvent => {
    const event: FakeEvent = {
      type,
      target,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    let current: Node | null = target;
    while (current) {
      for (const fn of current.listeners[type] ?? []) fn(event);
      current = current.parentNode;
    }
    for (const fn of docListeners[type] ?? []) fn(event);
    return event;
  };
  const byId = (id: string) => {
    const node = document.getElementById(id);
    assert.ok(node, `#${id}`);
    return node;
  };
  return {
    doc: root,
    byId,
    requests,
    respond,
    history,
    location,
    confirmAnswer,
    click: (node) => dispatch(node, "click"),
    type: (id, value) => {
      const node = byId(id);
      node.value = value;
      dispatch(node, "input");
    },
    submit: () => {
      dispatch(byId("settings-form"), "submit");
    },
    unload: () => {
      const event: FakeEvent = {
        type: "beforeunload",
        target: bodyEl,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const fn of winListeners.beforeunload ?? []) fn(event);
      return event;
    },
    pop: (next) => {
      location.pathname = next;
      for (const fn of winListeners.popstate ?? []) fn({ type: "popstate", target: bodyEl, defaultPrevented: false, preventDefault() {} });
    },
  };
}

function bar(page: Page): { hidden: boolean; text: string } {
  const node = page.byId("settings-unsaved");
  return { hidden: node.hidden, text: page.byId("settings-unsaved-count").textContent + page.byId("settings-unsaved-list").textContent };
}

function puts(page: Page): Request[] {
  return page.requests.filter((request) => request.method === "PUT");
}

function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...keyPaths(inner, path)];
    });
  }
  return [];
}

function uniqueSorted(list: string[]): string[] {
  return [...new Set(list)].sort();
}

function nav(page: Page): Node[] {
  return page.byId("settings-nav").querySelectorAll("a");
}

describe("settings page script", () => {
  it("opens the section named by the address and switches sections in place", async () => {
    const fx = fixture();
    const page = await openPage(fx, "/settings/limits", "limits");
    assert.equal(page.byId("settings-limits").hidden, false);
    assert.equal(page.byId("settings-repos").hidden, true);
    assert.equal(nav(page)[1]?.getAttribute("aria-current"), "page");

    page.type("stall-timeout", "700000");
    const event = page.click(nav(page)[3] as Node);
    assert.equal(event.defaultPrevented, true, "a nav click does not load a new page");
    assert.deepEqual(page.history.pushed, ["/settings/triggers"]);
    assert.equal(page.byId("settings-triggers").hidden, false);
    assert.equal(page.byId("settings-limits").hidden, true);
    assert.equal(nav(page)[3]?.getAttribute("aria-current"), "page");
    assert.equal(nav(page)[1]?.getAttribute("aria-current"), null);
    assert.equal(page.byId("stall-timeout").value, "700000", "edits in other sections stay in the form");

    page.pop("/settings/limits");
    assert.equal(page.byId("settings-limits").hidden, false);
    assert.equal(page.byId("settings-triggers").hidden, true);

    const facts = page.byId("settings-nav");
    assert.equal(facts.querySelector('[data-settings-fact="repos"]')?.textContent, "2");
    assert.equal(facts.querySelector('[data-settings-fact="triggers"]')?.textContent, "5", "three file triggers and two built-ins");
    assert.equal(facts.querySelector('[data-settings-fact="jira"]')?.textContent, "connected");
  });

  it("opens a queried repo on /settings/repos", async () => {
    const page = await openPage(fixture(), "/settings/repos?repo=web&field=test");
    assert.equal(page.byId("repo-editor").hidden, false);
    assert.equal(page.byId("repo-name").value, "web");
    assert.equal(page.byId("repo-test").focused > 0, true);
  });

  it("builds the same payload keys as before and keeps the file's keys on a round trip", async () => {
    const fx = fixture();
    const before = JSON.parse(readFileSync(fx.configPath, "utf8")) as Record<string, unknown>;
    const page = await openPage(fx);
    assert.equal(bar(page).hidden, true);
    // Enter in a field with nothing changed does not write.
    page.submit();
    await settle();
    assert.equal(puts(page).length, 0);

    page.type("max-same-fingerprint", "5");
    page.submit();
    await settle();
    const sent = puts(page);
    assert.equal(sent.length, 1);
    const body = sent[0]?.body ?? {};
    // The key set the pre-redesign settingsPayload() built for this document
    // (captured by running the old serve.js against this same page).
    const old = [
      "adapter",
      "board",
      "board.theme",
      "dailyDollarCap",
      "jira",
      "jira.acceptanceField",
      "jira.baseUrl",
      "jira.email",
      "keepWorktrees",
      "maxAttempts",
      "maxConcurrent",
      "maxFixRounds",
      "maxSameFingerprint",
      "overlay",
      "overlay.prompts",
      "overlay.skillPaths",
      "overlay.skills",
      "overlay.workflows",
      "repos",
      "repos.kiln",
      "repos.kiln.base",
      "repos.kiln.branch",
      "repos.kiln.deliver",
      "repos.kiln.maxAttempts",
      "repos.kiln.maxFixRounds",
      "repos.kiln.path",
      "repos.kiln.prTitle",
      "repos.kiln.test",
      "repos.web",
      "repos.web.deliver",
      "repos.web.path",
      "repos.web.test",
      "revision",
      "routes",
      "routes[].action",
      "routes[].id",
      "routes[].repo",
      "routes[].trigger",
      "routes[].workflow",
      "sandbox",
      "sandbox.allowDomains",
      "sandbox.mode",
      "stallTimeoutMs",
      "triggers",
      "triggers[].cron",
      "triggers[].enabled",
      "triggers[].every",
      "triggers[].id",
      "triggers[].kind",
      "triggers[].label",
      "triggers[].maxNew",
      "triggers[].maxQueued",
      "triggers[].repo",
      "triggers[].status",
    ];
    assert.deepEqual(uniqueSorted(keyPaths(body)), old);
    assert.equal(body.stallTimeoutMs, 600000, "milliseconds stay milliseconds");

    const afterSave = JSON.parse(readFileSync(fx.configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(uniqueSorted(keyPaths(afterSave)), uniqueSorted(keyPaths(before)));
    assert.equal(afterSave.stallTimeoutMs, 600000);
    assert.equal(afterSave.maxSameFingerprint, 5);
    assert.equal((afterSave.jira as { apiToken?: string }).apiToken, TOKEN);
  });

  it("shows the bar for a change, names it, and hides it when the value goes back", async () => {
    const page = await openPage(fixture());
    assert.equal(bar(page).hidden, true);
    page.type("stall-timeout", "700000");
    assert.deepEqual(bar(page), { hidden: false, text: "1 unsaved change, in Limits and retries: Stall timeout (ms)" });
    assert.equal(page.unload().defaultPrevented, true);
    page.type("stall-timeout", "600000");
    assert.equal(bar(page).hidden, true);
    assert.equal(page.unload().defaultPrevented, false);

    page.click(page.byId("theme-pick").querySelector('[data-theme-choice="kiln"]') as Node);
    await settle();
    assert.equal(bar(page).hidden, true, "a theme saves on click and is not an unsaved change");
  });

  it("names repo changes: added, removed, and an edit in the open editor", async () => {
    const fx = fixture();
    mkdirSync(join(fx.home, "docs"));
    const page = await openPage(fx);

    page.click(page.byId("repo-list").querySelector('[data-repo-edit="kiln"]') as Node);
    assert.equal(bar(page).hidden, true, "opening the editor is not a change");
    page.type("repo-test", "npm ci && npm test");
    assert.deepEqual(bar(page), { hidden: false, text: "1 unsaved change, in Repos: kiln test command" });
    page.click(page.byId("repo-done"));

    page.click(page.byId("repo-list").querySelector('[data-repo-remove="web"]') as Node);
    page.click(page.byId("repo-add"));
    page.type("repo-name", "docs");
    page.type("repo-path", join(fx.home, "docs"));
    assert.deepEqual(bar(page), {
      hidden: false,
      text: "3 unsaved changes, in Repos: kiln test command, web removed, docs added",
    });

    page.click(page.byId("settings-discard"));
    assert.equal(bar(page).hidden, true);
    assert.equal(page.byId("repo-editor").hidden, true);
    const list = page.byId("repo-list");
    assert.ok(list.querySelector('[data-repo-edit="web"]'), "a removed repo is back");
    assert.equal(list.querySelector('[data-repo-edit="docs"]'), null, "an added repo is gone");
    page.click(list.querySelector('[data-repo-edit="kiln"]') as Node);
    assert.equal(page.byId("repo-test").value, "npm test");
    assert.equal(puts(page).length, 0);
  });

  it("does not count an opened trigger or route editor as a change", async () => {
    const page = await openPage(fixture(), "/settings/triggers", "triggers");
    const edits = page.byId("settings-triggers").querySelectorAll("[data-row-edit]");
    assert.ok(edits.length > 0);
    for (const edit of edits) {
      page.click(edit);
      assert.equal(bar(page).hidden, true, edit.getAttribute("data-row-edit") ?? "");
    }
    const scheduled = edits.find((edit) => {
      page.click(edit);
      return page.byId("trigger-editor").hidden === false && page.byId("trigger-id").value === "nightly";
    });
    assert.ok(scheduled);
    page.type("trigger-cron", "0 3 * * *");
    assert.deepEqual(bar(page), { hidden: false, text: "1 unsaved change, in Triggers: trigger nightly changed" });
  });

  it("saves with one PUT, then hides the bar and says Saved", async () => {
    const fx = fixture();
    const loaded = readSettings(fx.configPath, {});
    assert.ok(loaded.ok);
    const page = await openPage(fx);
    page.type("stall-timeout", "700000");
    page.type("jira-email", "qa@example.com");
    assert.equal(bar(page).text, "2 unsaved changes, in Limits and retries: Stall timeout (ms); in Jira: Email");
    page.click(page.byId("settings-save"));
    page.submit();
    await settle();
    const sent = puts(page);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.body?.revision, loaded.document.revision);
    assert.equal(bar(page).hidden, true);
    assert.equal(page.byId("settings-saved").hidden, false);
    assert.equal(page.byId("settings-saved").textContent, "Saved");
    assert.equal(page.byId("stall-timeout").value, "700000");
  });

  it("keeps the edits and the bar when a save is refused", async () => {
    const page = await openPage(fixture());
    page.type("stall-timeout", "700000");

    page.respond.next = { status: 409, data: { error: "The settings file changed on disk. Reload and try again." } };
    page.submit();
    await settle();
    assert.equal(puts(page).length, 1);
    assert.equal(page.byId("stall-timeout").value, "700000");
    assert.equal(bar(page).hidden, false);
    assert.equal(page.byId("settings-error").hidden, false);
    assert.match(page.byId("settings-error").textContent, /changed on disk/);

    page.respond.next = {
      status: 400,
      data: { error: "Settings are invalid.", fields: { stallTimeoutMs: "Must be 0 or more." } },
    };
    page.submit();
    await settle();
    assert.equal(puts(page).length, 2);
    assert.equal(page.byId("stall-timeout").value, "700000");
    assert.equal(bar(page).hidden, false);
    const slot = page.byId("settings-limits").querySelector('[data-error="stallTimeoutMs"]');
    assert.equal(slot?.hidden, false);
    assert.equal(slot?.textContent, "Must be 0 or more.");
    assert.equal(page.byId("settings-error").hidden, false);
  });

  it("saves the file text alone, and refuses to mix it with form changes", async () => {
    const fx = fixture();
    const page = await openPage(fx);
    const box = page.byId("settings-json");
    const file = JSON.parse(box.value) as Record<string, unknown>;
    page.type("settings-json", JSON.stringify({ ...file, maxAttempts: 6 }, null, 2));
    assert.deepEqual(bar(page), { hidden: false, text: "1 unsaved change, in Edit the file: kiln.config.json" });

    page.type("stall-timeout", "700000");
    page.submit();
    await settle();
    assert.equal(puts(page).length, 0);
    assert.match(page.byId("settings-error").textContent, /Edit the file and other sections/);

    page.type("stall-timeout", "600000");
    page.submit();
    await settle();
    const sent = puts(page);
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]?.body ?? {}).sort(), ["file", "revision"]);
    assert.equal(bar(page).hidden, true);
    assert.equal((JSON.parse(readFileSync(fx.configPath, "utf8")) as { maxAttempts: number }).maxAttempts, 6);
  });

  it("refreshes the nav facts from a saved document", async () => {
    const page = await openPage(fixture());
    page.type("jira-email", "");
    page.submit();
    await settle();
    const facts = page.byId("settings-nav");
    assert.equal(facts.querySelector('[data-settings-fact="jira"]')?.textContent, "not set up");
    assert.equal(facts.querySelector('[data-settings-fact="jira"]')?.getAttribute("data-state"), null);
  });
});
