import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import { renderConsole } from "../src/serve-page.js";

const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

interface PageEvent {
  target: PageEl;
  preventDefault: () => void;
  stopPropagation: () => void;
  key?: string;
}

interface PageEl {
  tagName: string;
  id: string;
  attrs: Record<string, string>;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  value: string;
  childNodes: Array<PageEl | string>;
  parent: PageEl | null;
  listeners: Record<string, Array<(event: PageEvent) => void>>;
  classList: {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
    toggle: (name: string, force?: boolean) => boolean;
  };
  textContent: string;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  closest: (selector: string) => PageEl | null;
  querySelector: (selector: string) => PageEl | null;
  querySelectorAll: (selector: string) => PageEl[];
  addEventListener: (type: string, fn: (event: PageEvent) => void) => void;
}

function createEl(tag: string, attrs: Record<string, string> = {}): PageEl {
  const classes = new Set((attrs.class ?? "").split(/\s+/).filter(Boolean));
  const listeners: PageEl["listeners"] = {};
  const el: PageEl = {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    attrs: { ...attrs },
    hidden: Object.hasOwn(attrs, "hidden"),
    disabled: Object.hasOwn(attrs, "disabled"),
    checked: Object.hasOwn(attrs, "checked"),
    value: attrs.value ?? "",
    childNodes: [],
    parent: null,
    listeners,
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => {
        classes.add(name);
      },
      remove: (name) => {
        classes.delete(name);
      },
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    get textContent() {
      return el.childNodes.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
    },
    set textContent(value: string) {
      el.childNodes = [value];
    },
    getAttribute: (name) => (Object.hasOwn(el.attrs, name) ? (el.attrs[name] ?? "") : null),
    setAttribute: (name, value) => {
      el.attrs[name] = String(value);
      if (name === "id") el.id = String(value);
    },
    removeAttribute: (name) => {
      delete el.attrs[name];
    },
    closest: (selector) => {
      let node: PageEl | null = el;
      while (node) {
        if (matches(node, selector)) return node;
        node = node.parent;
      }
      return null;
    },
    querySelector: (selector) => queryAll(el, selector, false)[0] ?? null,
    querySelectorAll: (selector) => queryAll(el, selector, false),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  return el;
}

function elementsOf(el: PageEl): PageEl[] {
  return el.childNodes.filter((child): child is PageEl => typeof child !== "string");
}

function queryAll(root: PageEl, selector: string, includeRoot: boolean): PageEl[] {
  const out: PageEl[] = [];
  const walk = (el: PageEl, self: boolean): void => {
    if (self && matches(el, selector)) out.push(el);
    for (const child of elementsOf(el)) walk(child, true);
  };
  walk(root, includeRoot);
  return out;
}

function findId(el: PageEl, id: string): PageEl | null {
  if (el.id === id) return el;
  for (const child of elementsOf(el)) {
    const found = findId(child, id);
    if (found) return found;
  }
  return null;
}

function matches(el: PageEl, selector: string): boolean {
  return splitOutside(selector, ",").some((part) => matchesComplex(el, part));
}

function matchesComplex(el: PageEl, selector: string): boolean {
  const parts = splitWhitespace(selector);
  const last = parts[parts.length - 1];
  if (!last || !matchesCompound(el, last)) return false;
  let node = el.parent;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const part = parts[index] ?? "";
    while (node && !matchesCompound(node, part)) node = node.parent;
    if (!node) return false;
    node = node.parent;
  }
  return true;
}

function matchesCompound(el: PageEl, compound: string): boolean {
  let index = 0;
  let saw = false;
  while (index < compound.length) {
    const ch = compound[index] ?? "";
    if (ch === "#") {
      const ident = readIdent(compound, index + 1);
      if (!ident.value || el.id !== ident.value) return false;
      saw = true;
      index = ident.next;
      continue;
    }
    if (ch === ".") {
      const ident = readIdent(compound, index + 1);
      if (!ident.value || !el.classList.contains(ident.value)) return false;
      saw = true;
      index = ident.next;
      continue;
    }
    if (ch === "[") {
      const attr = readAttr(compound, index);
      if (!attr || !attrMatches(el, attr)) return false;
      saw = true;
      index = attr.next;
      continue;
    }
    if (ch === ":") {
      const ident = readIdent(compound, index + 1);
      if (ident.value !== "checked" || !el.checked) return false;
      saw = true;
      index = ident.next;
      continue;
    }
    if (/[a-z]/i.test(ch)) {
      const ident = readIdent(compound, index);
      if (!ident.value || el.tagName !== ident.value.toUpperCase()) return false;
      saw = true;
      index = ident.next;
      continue;
    }
    return false;
  }
  return saw;
}

function readIdent(source: string, start: number): { value: string; next: number } {
  let index = start;
  while (index < source.length && /[A-Za-z0-9_-]/.test(source[index] ?? "")) index += 1;
  return { value: source.slice(start, index), next: index };
}

function readAttr(source: string, start: number): { name: string; value?: string; next: number } | undefined {
  let index = start + 1;
  const nameStart = index;
  while (index < source.length && source[index] !== "=" && source[index] !== "]" && !/\s/.test(source[index] ?? "")) index += 1;
  const name = source.slice(nameStart, index).trim().toLowerCase();
  if (!name) return undefined;
  while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
  if (source[index] !== "=") return { name, next: source[index] === "]" ? index + 1 : index };
  index += 1;
  while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
  const quote = source[index];
  if (quote === "'" || quote === '"') {
    const end = source.indexOf(quote, index + 1);
    if (end < 0) return undefined;
    let next = end + 1;
    while (next < source.length && /\s/.test(source[next] ?? "")) next += 1;
    if (source[next] === "]") next += 1;
    return { name, value: source.slice(index + 1, end), next };
  }
  const valueStart = index;
  while (index < source.length && source[index] !== "]") index += 1;
  return { name, value: source.slice(valueStart, index).trim(), next: index + 1 };
}

function attrMatches(el: PageEl, attr: { name: string; value?: string }): boolean {
  const actual = el.getAttribute(attr.name);
  if (actual === null) return false;
  return attr.value === undefined || actual === attr.value;
}

function splitOutside(source: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let bracket = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index] ?? "";
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[") bracket += 1;
    else if (ch === "]" && bracket > 0) bracket -= 1;
    else if (bracket === 0 && ch === separator) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitWhitespace(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let bracket = 0;
  let index = 0;
  while (index < source.length) {
    const ch = source[index] ?? "";
    if (quote) {
      if (ch === quote) quote = "";
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "[") bracket += 1;
    else if (ch === "]" && bracket > 0) bracket -= 1;
    else if (bracket === 0 && /\s/.test(ch)) {
      const token = source.slice(start, index).trim();
      if (token) parts.push(token);
      while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  const last = source.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseHtml(html: string): PageEl[] {
  const root = createEl("div");
  const stack = [root];
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const text = decode(html.slice(index, next < 0 ? html.length : next));
      if (text) stack[stack.length - 1]?.childNodes.push(text);
      index = next < 0 ? html.length : next;
      continue;
    }
    if (html.startsWith("</", index)) {
      const end = html.indexOf(">", index);
      const name = html.slice(index + 2, end < 0 ? html.length : end).trim().toLowerCase();
      index = end < 0 ? html.length : end + 1;
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        const open = stack.pop();
        if (open?.tagName === name.toUpperCase()) break;
      }
      continue;
    }
    let nameEnd = index + 1;
    while (nameEnd < html.length && /[A-Za-z0-9]/.test(html[nameEnd] ?? "")) nameEnd += 1;
    const name = html.slice(index + 1, nameEnd).toLowerCase();
    const parsed = parseAttributes(html, nameEnd);
    const el = createEl(name, parsed.attrs);
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.childNodes.push(el);
      el.parent = parent;
    }
    index = parsed.next;
    if (!parsed.selfClosing && !VOID_TAGS.has(name)) stack.push(el);
  }
  return elementsOf(root);
}

function parseAttributes(source: string, start: number): { attrs: Record<string, string>; selfClosing: boolean; next: number } {
  const attrs: Record<string, string> = {};
  let index = start;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source.startsWith("/>", index)) return { attrs, selfClosing: true, next: index + 2 };
    if (source[index] === ">") return { attrs, selfClosing: false, next: index + 1 };
    const nameStart = index;
    while (index < source.length && /[^\s=/>]/.test(source[index] ?? "")) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!name) break;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") {
      attrs[name] = "";
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, index + 1);
      attrs[name] = decode(source.slice(index + 1, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    const valueStart = index;
    while (index < source.length && /[^\s>]/.test(source[index] ?? "")) index += 1;
    attrs[name] = decode(source.slice(valueStart, index));
  }
  return { attrs, selfClosing: false, next: index };
}

interface IntakePayload {
  repo?: string;
  workflow?: string;
  title?: string;
  issue?: string;
  dryRun?: boolean;
  source?: { kind?: string; key?: string; text?: string };
}

function board(): string {
  return renderConsole("", buildAttention([]), {
    csrf: "abc",
    repos: [{ name: "web", path: "/repos/web" }],
    workflows: ["feature", "fix", "investigation", "review"],
  });
}

function boot(html: string) {
  const start = html.indexOf('<form id="add-form"');
  const end = html.indexOf("</form>", start);
  assert.ok(start >= 0 && end > start);
  const [form] = parseHtml(html.slice(start, end + "</form>".length));
  assert.ok(form);
  const documentElement = createEl("html");
  documentElement.attrs["data-theme"] = "kiln";
  const body = createEl("body");
  body.attrs = {
    "data-needs-you": "0",
    "data-revision": "rev",
    "data-csrf": "abc",
    "data-pick-limit": "5",
  };
  body.parent = documentElement;
  documentElement.childNodes.push(body);
  form.parent = body;
  body.childNodes.push(form);

  const posts: IntakePayload[] = [];
  const documentListeners: Record<string, Array<(event: PageEvent) => void>> = {};
  const document = {
    body,
    documentElement,
    title: "",
    getElementById: (id: string) => findId(documentElement, id),
    querySelector: (selector: string) => queryAll(documentElement, selector, true)[0] ?? null,
    querySelectorAll: (selector: string) => queryAll(documentElement, selector, true),
    addEventListener: (type: string, fn: (event: PageEvent) => void) => {
      (documentListeners[type] ??= []).push(fn);
    },
  };
  const storage = () => {
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
  };
  const eventFor = (target: PageEl): PageEvent => ({ target, preventDefault() {}, stopPropagation() {} });
  const context = vm.createContext({
    document,
    localStorage: storage(),
    sessionStorage: storage(),
    fetch: (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}") as IntakePayload);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            init?.method === "POST"
              ? { ids: [], dryRun: true, report: "dry-run PROJ-123\ntitle Show the empty state\n" }
              : {},
          ),
      });
    },
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    clearInterval,
    location: { reload() {} },
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
    undefined,
    NaN,
    Infinity,
  });
  vm.runInContext(script, context);
  return {
    document,
    posts,
    click(el: PageEl) {
      const event = eventFor(el);
      let node: PageEl | null = el;
      while (node) {
        for (const fn of [...(node.listeners.click ?? [])]) fn(event);
        node = node.parent;
      }
      for (const fn of documentListeners.click ?? []) fn(event);
    },
    input(el: PageEl) {
      const event = eventFor(el);
      for (const fn of el.listeners.input ?? []) fn(event);
    },
    submit(el: PageEl) {
      const event = eventFor(el);
      for (const fn of el.listeners.submit ?? []) fn(event);
    },
  };
}

function byId(page: ReturnType<typeof boot>, id: string): PageEl {
  const el = page.document.getElementById(id);
  assert.ok(el, id);
  return el;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("jira add form", () => {
  it("does not render or send Issue and Title, and previews the summary", async () => {
    const page = boot(board());
    await flush();
    const pane = page.document.querySelector('[data-pane="jira"]');
    assert.ok(pane);
    assert.equal(pane.querySelector("#job-issue"), null);
    assert.equal(pane.querySelector("#job-title"), null);
    assert.equal(pane.querySelector(".k")?.textContent, "Jira issue");
    assert.equal(byId(page, "jira-key").getAttribute("placeholder"), "PROJ-123 or issue URL");
    assert.equal(byId(page, "issue-field").hidden, false);
    assert.equal(byId(page, "title-field").hidden, false);

    byId(page, "job-issue").value = "ABC-999";
    byId(page, "job-title").value = "Typed title";
    page.input(byId(page, "job-title"));
    const jira = page.document.querySelector('[data-source="jira"]');
    assert.ok(jira);
    page.click(jira);

    assert.equal(pane.hidden, false);
    assert.equal(byId(page, "issue-field").hidden, true);
    assert.equal(byId(page, "title-field").hidden, true);
    assert.equal(byId(page, "after-field").hidden, false);
    assert.equal(byId(page, "preview-job").hidden, false);
    byId(page, "jira-key").value = "https://example.atlassian.net/browse/PROJ-123";
    page.input(byId(page, "jira-key"));
    assert.equal(byId(page, "add-submit").disabled, false);
    page.click(byId(page, "preview-job"));
    await flush();

    assert.equal(page.posts.length, 1);
    const preview = page.posts[0];
    assert.ok(preview);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.source?.kind, "jira");
    assert.equal(preview.source?.key, "https://example.atlassian.net/browse/PROJ-123");
    assert.equal(Object.hasOwn(preview, "issue"), false);
    assert.equal(Object.hasOwn(preview, "title"), false);
    assert.equal(byId(page, "intake-preview").hidden, false);
    assert.match(byId(page, "intake-preview").textContent, /title Show the empty state/);

    const prompt = page.document.querySelector('[data-source="prompt"]');
    assert.ok(prompt);
    page.click(prompt);
    assert.equal(byId(page, "issue-field").hidden, false);
    assert.equal(byId(page, "title-field").hidden, false);
    assert.equal(byId(page, "preview-job").hidden, true);
    byId(page, "prompt-text").value = "Show a quiet empty state\n";
    page.submit(byId(page, "add-form"));
    await flush();

    const created = page.posts[1];
    assert.ok(created);
    assert.equal(created.dryRun, undefined);
    assert.equal(created.source?.kind, "prompt");
    assert.equal(created.source?.text, "Show a quiet empty state\n");
    assert.equal(created.issue, "ABC-999");
    assert.equal(created.title, "Typed title");
  });
});
