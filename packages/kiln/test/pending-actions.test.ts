import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { packageRoot } from "../src/paths.js";

interface Control {
  tagName: string;
  textContent: string;
  disabled: boolean;
  readOnly: boolean;
  attrs: Record<string, string>;
  getAttribute(key: string): string | null;
  setAttribute(key: string, value: string): void;
  removeAttribute(key: string): void;
}

function control(tagName: string, textContent = ""): Control {
  return {
    tagName,
    textContent,
    disabled: false,
    readOnly: false,
    attrs: {},
    getAttribute(key) {
      return this.attrs[key] ?? null;
    },
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    removeAttribute(key) {
      delete this.attrs[key];
    },
  };
}

/** One `.d-actions` row: an Approve form, a Reject form, and the revise note. */
function actionRow() {
  const approve = control("BUTTON", "Approve");
  const reject = control("BUTTON", "Reject");
  const note = control("INPUT");
  const row = { querySelectorAll: () => [approve, reject, note] };
  const attrs: Record<string, string> = {};
  const form = {
    classList: { contains: (name: string) => name === "act" || name === "approve" },
    getAttribute: (key: string) => attrs[key] ?? null,
    setAttribute: (key: string, value: string) => {
      attrs[key] = value;
    },
    querySelector: () => approve,
    closest: (selector: string) => (selector === ".d-actions" ? row : null),
  };
  return { approve, reject, note, form };
}

function loadBoardScript(revisions: { page: string; server: string }) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const intervals: (() => void)[] = [];
  let reloads = 0;
  const document = {
    body: {
      getAttribute: (key: string) => (key === "data-revision" ? revisions.page : ""),
      classList: { add() {}, remove() {} },
    },
    documentElement: { getAttribute: () => null, setAttribute() {} },
    title: "",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const context = vm.createContext({
    document,
    location: {
      reload() {
        reloads += 1;
      },
      pathname: "/",
      search: "",
      hash: "",
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ attention: { revision: revisions.server }, jobs: [] }) }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return 0;
    },
    setTimeout,
    clearTimeout,
    clearInterval,
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
  vm.runInContext(readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8"), context);
  return {
    submit(event: unknown) {
      for (const fn of listeners.submit ?? []) fn(event);
    },
    pollAgain() {
      for (const fn of intervals) fn();
    },
    reloads: () => reloads,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("pending board actions", () => {
  it("marks the clicked button busy, locks the row, and posts once", async () => {
    const board = loadBoardScript({ page: "r1", server: "r1" });
    const { approve, reject, note, form } = actionRow();
    let prevented = 0;
    const event = { target: form, preventDefault: () => (prevented += 1) };

    board.submit(event);
    assert.equal(prevented, 0, "the first submit goes through");
    assert.equal(approve.getAttribute("aria-busy"), "true");
    assert.equal(approve.textContent, "Approving…");
    assert.equal(approve.disabled, false, "not disabled inside the submit event");

    await settle();
    assert.equal(approve.disabled, true);
    assert.equal(reject.disabled, true);
    assert.equal(note.readOnly, true);
    assert.equal(note.disabled, false, "a disabled field would drop the note from the post");

    board.submit(event);
    assert.equal(prevented, 1, "a second submit of the same form is stopped");
  });

  it("leaves other forms alone", () => {
    const board = loadBoardScript({ page: "r1", server: "r1" });
    const { approve, form } = actionRow();
    const plain = { ...form, classList: { contains: () => false } };
    board.submit({ target: plain, preventDefault() {} });
    assert.equal(approve.getAttribute("aria-busy"), null);
    assert.equal(approve.textContent, "Approve");
  });

  it("does not reload the page while an action is on its way", async () => {
    const board = loadBoardScript({ page: "r1", server: "r2" });
    await settle();
    assert.equal(board.reloads(), 1, "a changed revision reloads an idle page");

    const { form } = actionRow();
    board.submit({ target: form, preventDefault() {} });
    board.pollAgain();
    await settle();
    assert.equal(board.reloads(), 1, "no reload while the post is pending");
  });
});
