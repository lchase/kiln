import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { buildAttention } from "../src/attention.js";
import { ICON_LUCIDE, ICONS } from "../src/icons.js";
import { packageRoot } from "../src/paths.js";
import { formatSpend, type SpendSnapshot } from "../src/rails.js";
import type { StatusJobView, StatusState } from "../src/report.js";
import { renderConsole } from "../src/serve-page.js";

const css = readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");
const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");

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
    createdAt: "2026-11-09T15:00:00.000Z",
  };
}

const workflows = ["feature", "fix", "investigation", "review"];
const repos = [
  { name: "web", path: "/repos/web" },
  { name: "api", path: "/repos/api" },
];

function board(options: { section?: "pipeline" | "inbox"; paused?: boolean; spend?: SpendSnapshot } = {}): string {
  const attention = buildAttention([
    job("SAMPLE-1", "needs-human", "web", "Empty state"),
    job("SAMPLE-2", "queued", "api", "Refresh the list"),
    job("SAMPLE-3", "queued", "web", "Quiet copy"),
  ]);
  return renderConsole(css, attention, {
    csrf: "abc",
    repos,
    workflows,
    section: options.section ?? "pipeline",
    paused: options.paused,
    spend: options.spend,
  });
}

function sidebar(html: string): string {
  const start = html.indexOf('<aside class="nav"');
  const end = html.indexOf("</aside>", start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

function rule(source: string, selector: string): string {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]+\\}`);
  const match = source.match(pattern);
  assert.ok(match, selector);
  return match[0];
}

describe("sidebar", () => {
  it("pins run status, spend, and notify in the footer and icons the nav", () => {
    const spend: SpendSnapshot = { day: "2026-11-09", usd: 0, cap: null, blocked: false };
    const html = board({ spend });
    const side = sidebar(html);
    const foot = side.slice(side.indexOf('<footer class="side-foot"'));
    assert.ok(side.indexOf('class="brand"') < side.indexOf('<nav class="side"'));
    assert.ok(side.indexOf('id="add-job"') < side.indexOf('<footer class="side-foot"'));
    assert.match(foot, /id="run-dot"/);
    assert.match(foot, /id="run-label">Running</);
    assert.match(foot, /id="pause-form"/);
    assert.match(foot, /action="\/api\/pause"/);
    assert.match(foot, /id="pause-toggle" aria-pressed="false"/);
    assert.match(foot, /id="pause-label">Pause</);
    assert.match(foot, /id="spend">today 2026-11-09 {2}\$0\.00 \/ no cap</);
    assert.equal(foot.includes(formatSpend(spend)), true);
    assert.match(foot, /id="cap-note" hidden>cap hit</);
    assert.match(foot, /id="notify"[^>]*data-state="ask"/);
    assert.match(foot, /id="notify-label">Notify me</);
    assert.match(foot, /id="notify-note" hidden>/);
    assert.doesNotMatch(foot, /id="add-job"/);
    assert.match(side, /id="add-job">Add job</);
    const pauseBtn = foot.slice(foot.indexOf('id="pause-toggle"'), foot.indexOf("</button>"));
    assert.match(pauseBtn, /class="icon icon-pause"/);
    assert.match(pauseBtn, /class="icon icon-play"/);
    const notifyBtn = foot.slice(foot.indexOf('id="notify"'), foot.indexOf("</button>", foot.indexOf('id="notify"')));
    assert.match(notifyBtn, /class="icon icon-bell"/);
    assert.match(notifyBtn, /class="icon icon-bell-off"/);

    const links = side.match(/<a class="nav-link"[\s\S]*?<\/a>/g) ?? [];
    const labels = ["Pipeline", "Inbox", "Needs a hand", "Repos", "History", "Stats", "Today", "Triggers", "Settings"];
    assert.equal(links.length, labels.length);
    for (const label of labels) {
      const link = links.find((item) => item.includes(`>${label}</span>`));
      assert.ok(link, label);
      assert.match(link, /<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">/);
    }
    const pipeline = links.find((item) => item.includes(">Pipeline</span>"));
    assert.match(pipeline ?? "", /href="\/" aria-current="page"/);
    assert.match(pipeline ?? "", /M9 3v18/);
    const subs = side.match(/<a class="nav-sub"[\s\S]*?<\/a>/g) ?? [];
    assert.deepEqual(
      subs.map((item) => item.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
      ["api 1", "web 2"],
    );
    for (const sub of subs) assert.doesNotMatch(sub, /<svg/);
    assert.match(side, /id="open-settings"/);
    assert.doesNotMatch(side, /stroke="#[0-9a-fA-F]/);
    assert.doesNotMatch(side, /var\(--primary\)/);

    const inbox = sidebar(board({ section: "inbox", spend }));
    assert.match(inbox, /href="\/inbox" aria-current="page"/);
    assert.doesNotMatch(inbox, /href="\/" aria-current="page"/);
  });

  it("keeps pause and a cap hit in the footer when the factory is paused", () => {
    const spend: SpendSnapshot = { day: "2026-11-09", usd: 8, cap: 8, blocked: true };
    const side = sidebar(board({ paused: true, spend }));
    const foot = side.slice(side.indexOf('<footer class="side-foot"'));
    assert.match(foot, /id="run-label">Paused</);
    assert.match(foot, /action="\/api\/resume"/);
    assert.match(foot, /aria-pressed="true"/);
    assert.match(foot, /id="pause-label">Resume</);
    assert.match(foot, /id="spend">today 2026-11-09 {2}\$8\.00 \/ \$8\.00</);
    assert.match(foot, /id="cap-note">cap hit</);
    assert.doesNotMatch(foot, /id="cap-note" hidden/);
    assert.ok(side.indexOf('id="runstate"') > side.indexOf("<footer"));
  });

  it("styles nav icons from tokens and keeps primary off the chrome", () => {
    const iconRule = rule(css, ".icon");
    assert.match(iconRule, /width:\s*var\(--icon\)/);
    assert.match(iconRule, /height:\s*var\(--icon\)/);
    assert.match(iconRule, /stroke:\s*currentColor/);
    assert.match(iconRule, /fill:\s*none/);
    assert.match(iconRule, /stroke-width:\s*var\(--icon-stroke\)/);
    assert.doesNotMatch(iconRule, /\d+px|var\(--primary\)/);
    const idle = rule(css, ".nav-link, .nav-sub");
    assert.match(idle, /color:\s*var\(--muted\)/);
    assert.doesNotMatch(idle, /var\(--primary\)/);
    const current = rule(css, '.nav-link[aria-current="page"], .nav-sub[aria-current="page"]');
    assert.match(current, /color:\s*var\(--ink\)/);
    assert.match(current, /background:\s*var\(--card-hover\)/);
    assert.doesNotMatch(current, /var\(--primary\)/);
    assert.match(rule(css, ".nav-scroll"), /overflow:\s*auto/);
    assert.match(rule(css, ".side-foot"), /border-top:\s*var\(--hairline\)/);
    assert.match(css, /--icon-stroke:\s*2;/);
    assert.equal(ICON_LUCIDE.pipeline, "columns-3");
    assert.equal(ICON_LUCIDE.hand, "hand-helping");
    assert.equal(ICON_LUCIDE.repos, "folder-git-2");
    assert.equal(ICONS.bell.includes("M3.262"), true);
    assert.doesNotMatch(script, /toggle\.textContent/);
    assert.doesNotMatch(script, /data-tip", "Notifications/);
  });
});

interface NotifyEl {
  id: string;
  tagName: string;
  attrs: Record<string, string>;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  classList: { toggle: (name: string, force?: boolean) => void; add: (name: string) => void; remove: (name: string) => void; contains: (name: string) => boolean };
  setAttribute: (key: string, value: string) => void;
  getAttribute: (key: string) => string | null;
  removeAttribute: (key: string) => void;
  closest: (sel: string) => NotifyEl | null;
  querySelector: () => null;
  querySelectorAll: () => never[];
}

function element(id: string, tag = "div"): NotifyEl {
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const el: NotifyEl = {
    id,
    tagName: tag.toUpperCase(),
    attrs,
    hidden: false,
    disabled: false,
    textContent: "",
    classList: {
      toggle(name: string, force?: boolean) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
      },
      add(name: string) {
        classes.add(name);
      },
      remove(name: string) {
        classes.delete(name);
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    setAttribute(key: string, value: string) {
      attrs[key] = String(value);
    },
    getAttribute(key: string) {
      return Object.prototype.hasOwnProperty.call(attrs, key) ? (attrs[key] ?? null) : null;
    },
    removeAttribute(key: string) {
      delete attrs[key];
    },
    closest(sel: string) {
      return sel === `#${id}` ? el : null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

interface BootOptions {
  permission?: "default" | "granted" | "denied" | "missing";
  requestResult?: "default" | "granted" | "denied";
  pref?: "on" | "off" | null;
  needsYou?: string;
  seen?: string | null;
  poll?: Record<string, unknown>;
}

function boot(options: BootOptions = {}) {
  const elements = new Map<string, NotifyEl>();
  const add = (id: string, tag?: string) => {
    const el = element(id, tag);
    elements.set(id, el);
    return el;
  };
  const body = add("body", "body");
  body.attrs["data-needs-you"] = options.needsYou ?? "0";
  body.attrs["data-revision"] = "rev";
  body.attrs["data-csrf"] = "abc";
  body.attrs["data-pick-limit"] = "5";
  const notify = add("notify", "button");
  const label = add("notify-label", "span");
  label.textContent = "Notify me";
  const note = add("notify-note", "p");
  note.hidden = true;
  const pauseLabel = add("pause-label", "span");
  pauseLabel.textContent = "Pause";
  const toggle = add("pause-toggle", "button");
  toggle.attrs["aria-pressed"] = "false";
  const form = add("pause-form", "form");
  form.attrs.action = "/api/pause";
  const runLabel = add("run-label", "span");
  runLabel.textContent = "Running";
  const dot = add("run-dot", "span");
  const spend = add("spend", "span");
  const capNote = add("cap-note", "span");
  capNote.hidden = true;

  const store = new Map<string, string>();
  if (options.pref) store.set("kiln-notify", options.pref);
  if (options.seen != null) store.set("kiln-needs-you", options.seen);
  const storage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  const sent: { title: string; body: string }[] = [];
  let requests = 0;
  const listeners: Record<string, (event: { target: NotifyEl; key?: string; preventDefault: () => void }) => void> = {};
  const permission = options.permission ?? "default";
  let Notification: (new (title: string, opts?: { body?: string }) => void) & { permission?: string; requestPermission?: () => Promise<string> } | undefined;
  if (permission !== "missing") {
    const Ctor = function Notification(this: unknown, title: string, opts?: { body?: string }) {
      sent.push({ title, body: opts?.body ?? "" });
    } as unknown as NonNullable<typeof Notification>;
    Ctor.permission = permission;
    Ctor.requestPermission = () => {
      requests += 1;
      const result = options.requestResult ?? "granted";
      Ctor.permission = result;
      return Promise.resolve(result);
    };
    Notification = Ctor;
  }
  const documentElement = element("html", "html");
  documentElement.attrs["data-theme"] = "kiln";
  const document = {
    body,
    documentElement,
    title: "",
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: (event: { target: NotifyEl; key?: string; preventDefault: () => void }) => void) => {
      listeners[type] = fn;
    },
  };
  const context = vm.createContext({
    document,
    localStorage: storage,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Notification,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(options.poll ?? {}) }),
    setInterval: () => 0,
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
    undefined,
    NaN,
    Infinity,
  });
  vm.runInContext(script, context);
  return {
    notify,
    label,
    note,
    pauseLabel,
    toggle,
    form,
    runLabel,
    dot,
    spend,
    capNote,
    sent,
    requests: () => requests,
    store,
    click() {
      const fn = listeners.click;
      assert.ok(fn, "click listener");
      fn({ target: notify, preventDefault() {} });
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("notify control", () => {
  it("asks when permission is default, then toggles a local off switch without asking again", async () => {
    const page = boot({ permission: "default", requestResult: "granted", seen: "0", needsYou: "0" });
    assert.equal(page.label.textContent, "Notify me");
    assert.equal(page.notify.attrs["data-state"], "ask");
    assert.equal(page.notify.disabled, false);
    assert.equal(page.note.hidden, true);
    assert.equal(page.requests(), 0);
    page.click();
    await flush();
    assert.equal(page.requests(), 1);
    assert.equal(page.label.textContent, "Notifications on");
    assert.equal(page.notify.attrs["data-state"], "on");
    assert.equal(page.notify.attrs["aria-pressed"], "true");
    assert.equal(page.store.get("kiln-notify"), "on");
    page.click();
    assert.equal(page.requests(), 1);
    assert.equal(page.label.textContent, "Notify me");
    assert.equal(page.notify.attrs["data-state"], "off");
    assert.equal(page.store.get("kiln-notify"), "off");
    page.click();
    assert.equal(page.requests(), 1);
    assert.equal(page.label.textContent, "Notifications on");
    assert.equal(page.store.get("kiln-notify"), "on");
  });

  it("shows a blocked sentence and does not ask again", () => {
    const page = boot({ permission: "denied" });
    assert.equal(page.label.textContent, "Notifications blocked");
    assert.equal(page.notify.attrs["data-state"], "blocked");
    assert.equal(page.note.hidden, false);
    assert.equal(page.note.textContent, "Allow notifications for this site in the browser.");
    assert.equal(page.notify.attrs["aria-describedby"], "notify-note");
    page.click();
    assert.equal(page.requests(), 0);
    assert.equal(page.label.textContent, "Notifications blocked");
  });

  it("says notifications are unavailable when the API is missing", () => {
    const page = boot({ permission: "missing" });
    assert.equal(page.label.textContent, "Notifications unavailable");
    assert.equal(page.notify.attrs["data-state"], "unavailable");
    assert.equal(page.notify.disabled, true);
    assert.equal(page.note.hidden, true);
    page.click();
    assert.equal(page.requests(), 0);
    assert.equal(page.label.textContent, "Notifications unavailable");
  });

  it("keeps the ask state when the prompt is dismissed", async () => {
    const page = boot({ permission: "default", requestResult: "default" });
    page.click();
    await flush();
    assert.equal(page.requests(), 1);
    assert.equal(page.label.textContent, "Notify me");
    assert.equal(page.notify.attrs["data-state"], "ask");
    assert.equal(page.store.has("kiln-notify"), false);
  });

  it("notifies for new needs-you jobs only while sending is on", () => {
    const on = boot({ permission: "granted", seen: "0", needsYou: "1" });
    assert.deepEqual(on.sent, [{ title: "Kiln", body: "1 job needs you" }]);
    const many = boot({ permission: "granted", seen: "1", needsYou: "3" });
    assert.deepEqual(many.sent, [{ title: "Kiln", body: "2 jobs need you" }]);
    const off = boot({ permission: "granted", pref: "off", seen: "0", needsYou: "2" });
    assert.deepEqual(off.sent, []);
    assert.equal(off.label.textContent, "Notify me");
    assert.equal(off.notify.attrs["data-state"], "off");
    const unasked = boot({ permission: "default", seen: "0", needsYou: "2" });
    assert.deepEqual(unasked.sent, []);
    const first = boot({ permission: "granted", seen: null, needsYou: "4" });
    assert.deepEqual(first.sent, []);
  });

  it("updates pause and spend in the footer without clearing the icons", async () => {
    const page = boot({
      permission: "default",
      poll: { paused: true, spend: { day: "2026-11-09", usd: 1.5, cap: 4, blocked: false } },
    });
    await flush();
    assert.equal(page.pauseLabel.textContent, "Resume");
    assert.equal(page.runLabel.textContent, "Paused");
    assert.equal(page.toggle.attrs["aria-pressed"], "true");
    assert.equal(page.form.attrs.action, "/api/resume");
    assert.equal(page.toggle.textContent, "");
    assert.equal(page.spend.textContent, "today 2026-11-09  $1.50 / $4.00");
    assert.equal(page.capNote.hidden, true);
  });
});
