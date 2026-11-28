import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import vm from "node:vm";
import { buildAttention } from "../src/attention.js";
import { packageRoot } from "../src/paths.js";
import type { StatusJobView } from "../src/report.js";
import { renderConsole, renderMessagePage, renderTextPage } from "../src/serve-page.js";
import { reapLaunches } from "./reap.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const TOKEN = "kiln-test-jira-token-do-not-render";
const testCommand = "node --test test.mjs";

function kilnEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  return env;
}

function runCli(
  args: string[],
  options: { cwd: string; home: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: kilnEnv(options.home),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function workDir(prefix: string): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(
    join(dir, "test.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('checkout', () => { assert.equal(true, true); });",
      "",
    ].join("\n"),
  );
  const fixtures = join(dir, "test", "fixtures", "kiln-feature");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(
    join(fixtures, "spec.json"),
    `${JSON.stringify([{ output: { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." } }])}\n`,
  );
  writeFileSync(
    join(fixtures, "build.json"),
    `${JSON.stringify([{ output: { summary: "Mock build.", status: "READY" } }])}\n`,
  );
  for (const step of ["security", "ux", "ui", "code"]) {
    writeFileSync(
      join(fixtures, `${step}.json`),
      `${JSON.stringify([{ output: { verdict: "PASS", findings: "No must-fix findings." } }])}\n`,
    );
  }
  writeFileSync(
    join(fixtures, "approver.json"),
    `${JSON.stringify([{ output: { decision: "APPROVE", reason: "Reviews passed." } }])}\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function useMock(home: string): void {
  const path = join(home, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = 2;
  raw.jira = {
    baseUrl: "https://example.atlassian.net",
    email: "dev@example.com",
    apiToken: TOKEN,
  };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function addJob(cwd: string, home: string, repo: string, title: string, after: string[] = []): string {
  const spec = join(cwd, `${title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.md`);
  writeFileSync(spec, `# ${title}\n\nDo the work for ${title}.\n`);
  const args = ["add", "feature", "--repo", repo, "--spec", spec, "--title", title];
  for (const id of after) args.push("--after", id);
  const created = runCli(args, { cwd, home });
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/^added (\S+)/m)?.[1];
  assert.ok(id, created.stdout);
  return id;
}

function waitForStatus(cwd: string, home: string, jobId: string, pattern: RegExp): string {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 60_000) {
    const status = runCli(["status", jobId], { cwd, home });
    last = `${status.stdout}${status.stderr}`;
    if (status.status === 0 && pattern.test(status.stdout)) return status.stdout;
    spawnSync("sleep", ["0.1"]);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${last}`);
}

interface RunningServe {
  url: string;
  child: ChildProcess;
  output: { stdout: string; stderr: string };
}

function startServe(args: string[], options: { cwd: string; home: string }): Promise<RunningServe> {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", ...args], {
    cwd: options.cwd,
    env: kilnEnv(options.home),
  });
  children.push(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`serve did not listen\n${output.stdout}\n${output.stderr}`));
    }, 10_000);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: string) => {
      output.stdout += chunk;
      const match = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(() => resolve({ url: match[1], child, output }));
    });
    child.stderr?.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => reject(new Error(`serve exited ${code}\n${output.stdout}\n${output.stderr}`)));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function text(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

function csrfFrom(html: string): string {
  const match = html.match(/data-csrf="([a-f0-9]+)"/);
  assert.ok(match?.[1], "page is missing a csrf token");
  return match[1];
}

function viewJob(overrides: Partial<StatusJobView> & Pick<StatusJobView, "jobId" | "state">): StatusJobView {
  return {
    title: overrides.jobId,
    repo: "web",
    workflow: "feature",
    dependsOn: [],
    stack: false,
    launchFailed: false,
    attemptCount: 0,
    maxAttempts: 3,
    prPending: false,
    prClosedUnmerged: false,
    noReadableApproval: false,
    gates: [],
    canApprove: false,
    canRevise: false,
    canReject: false,
    steps: [],
    ...overrides,
  };
}

function page(jobs: StatusJobView[], section: "pipeline" | "repos" | "history" = "pipeline"): string {
  return renderConsole("/* kiln-serve */", buildAttention(jobs), { csrf: "", repos: [], workflows: [], section });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => exited(child)));
  for (const dir of keep) await reapLaunches(dir);
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("serve pages", () => {
  it("uses the sidebar kiln badge as the tab icon", () => {
    const html = page([]);
    const link = html.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/);
    assert.ok(link?.[1]);
    const svg = decodeURIComponent(link[1].slice("data:image/svg+xml,".length));
    const brandStart = html.indexOf('<span class="logo"');
    const brand = html.slice(brandStart, html.indexOf("</span>", brandStart));
    const paths = (source: string) => [...source.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(paths(svg), paths(brand));
    assert.deepEqual(paths(svg), ["M3 12V6l5-3 5 3v6l-5 3-5-3z", "M3 6l5 3 5-3M8 9v6"]);
    assert.match(brand, /stroke="currentColor"/);
    assert.doesNotMatch(brand, /<rect /);
    assert.doesNotMatch(svg, /currentColor|var\(--/);

    const css = readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");
    const tokens = css.slice(css.indexOf("/* tokens:start */"), css.indexOf("/* tokens:end */"));
    const themeBlock = (id: string) => {
      const start = css.indexOf(`/* theme:${id} */`);
      assert.ok(start !== -1, id);
      const end = css.indexOf("/* theme:end */", start);
      return css.slice(start, end);
    };
    const decl = (block: string, name: string) => {
      const found = block.match(new RegExp(`${name}:\\s*([^;]+);`));
      assert.ok(found?.[1], name);
      return found[1].trim();
    };
    const badge = Number.parseInt(decl(tokens, "--logo"), 10);
    const radius = Number.parseInt(decl(tokens, "--radius-md"), 10);
    const glyph = Number.parseInt(decl(tokens, "--icon"), 10);
    const kiln = themeBlock("kiln");
    const gruvbox = themeBlock("gruvbox-dark");
    const fill = decl(kiln, "--primary");
    const stroke = decl(kiln, "--on-primary");
    const logo = css.match(/\.logo\s*\{[^}]+\}/)?.[0] ?? "";
    assert.match(logo, /width:\s*var\(--logo\)/);
    assert.match(logo, /height:\s*var\(--logo\)/);
    assert.match(logo, /border-radius:\s*var\(--radius-md\)/);
    assert.match(logo, /background:\s*var\(--primary\)/);
    assert.match(logo, /color:\s*var\(--on-primary\)/);
    const offset = (badge - glyph) / 2;
    assert.match(svg, new RegExp(`viewBox="0 0 ${badge} ${badge}"`));
    assert.match(svg, new RegExp(`<rect width="${badge}" height="${badge}" rx="${radius}" fill="${fill}"/>`));
    assert.match(svg, new RegExp(`x="${offset}" y="${offset}" width="${glyph}" height="${glyph}"`));
    assert.match(svg, new RegExp(`stroke="${stroke}"`));
    assert.ok(svg.indexOf("<rect ") < svg.indexOf("<path "));
    assert.equal(radius / badge, 4 / 28);

    const paint = (theme: "kiln" | "gruvbox-dark") =>
      renderConsole(css, buildAttention([]), { csrf: "", repos: [], workflows: [], section: "pipeline", theme });
    const iconFill = (html: string) => {
      const icon = html.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/);
      assert.ok(icon?.[1]);
      const decoded = decodeURIComponent(icon[1].slice("data:image/svg+xml,".length));
      const rect = decoded.match(/<rect[^>]*fill="([^"]+)"/);
      assert.ok(rect?.[1]);
      return rect[1];
    };
    const kilnFill = iconFill(paint("kiln"));
    const gruvboxFill = iconFill(paint("gruvbox-dark"));
    assert.equal(kilnFill, decl(kiln, "--primary"));
    assert.equal(gruvboxFill, decl(gruvbox, "--primary"));
    assert.notEqual(kilnFill, gruvboxFill);

    for (const other of [renderMessagePage("", "Not found", "Not found."), renderTextPage("", "Spec", "body")]) {
      assert.match(other, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    }
  });

  it("repaints the tab icon when the board theme changes", () => {
    const css = readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");
    const block = (id: string) => {
      const start = css.indexOf(`/* theme:${id} */`);
      const end = css.indexOf("/* theme:end */", start);
      return css.slice(start, end);
    };
    const color = (id: string, name: string) => {
      const found = block(id).match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
      assert.ok(found?.[1], `${id} ${name}`);
      return found[1];
    };
    const html = renderConsole(css, buildAttention([]), { csrf: "", repos: [], workflows: [], section: "settings", theme: "kiln" });
    const initial = html.match(/href="(data:image\/svg\+xml,[^"]+)"/)?.[1];
    assert.ok(initial);
    const attrs: Record<string, string> = { rel: "icon", href: initial };
    const link = {
      attrs,
      getAttribute: (key: string) => attrs[key] ?? null,
      setAttribute: (key: string, value: string) => {
        attrs[key] = value;
      },
    };
    const documentElement = {
      attrs: { "data-theme": "kiln" } as Record<string, string>,
      getAttribute(key: string) {
        return this.attrs[key] ?? null;
      },
      setAttribute(key: string, value: string) {
        this.attrs[key] = value;
      },
    };
    const themeButton = {
      getAttribute: (key: string) => (key === "data-theme-choice" ? "gruvbox-dark" : null),
      closest: (sel: string) => (sel === "#theme-pick [data-theme-choice]" ? themeButton : null),
    };
    const listeners: Record<string, (event: { target: typeof themeButton }) => void> = {};
    const document = {
      body: { getAttribute: () => "", classList: { add() {}, remove() {} } },
      documentElement,
      title: "",
      getElementById: () => null,
      querySelector: (sel: string) => (sel === 'link[rel="icon"]' ? link : null),
      querySelectorAll: () => [],
      addEventListener: (type: string, fn: (event: { target: typeof themeButton }) => void) => {
        listeners[type] = fn;
      },
    };
    const context = vm.createContext({
      document,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: () => new Promise(() => {}),
      getComputedStyle: () => ({
        getPropertyValue: (name: string) => {
          const id = documentElement.getAttribute("data-theme") ?? "kiln";
          if (name === "--primary") return color(id, "--primary");
          if (name === "--on-primary") return color(id, "--on-primary");
          return "";
        },
      }),
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
    vm.runInContext(readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8"), context);
    const click = listeners.click;
    assert.ok(click);
    click({ target: themeButton });
    const next = decodeURIComponent(link.getAttribute("href")?.slice("data:image/svg+xml,".length) ?? "");
    assert.match(next, new RegExp(`fill="${color("gruvbox-dark", "--primary")}"`));
    assert.match(next, new RegExp(`stroke="${color("gruvbox-dark", "--on-primary")}"`));
    assert.doesNotMatch(next, new RegExp(`fill="${color("kiln", "--primary")}"`));
    assert.equal(documentElement.getAttribute("data-theme"), "gruvbox-dark");
  });

  it("escapes job text and does not link a javascript pull request url", () => {
    const html = page([
      viewJob({
        jobId: "job-1",
        state: "needs-human",
        title: "<script>alert(1)</script>",
        canApprove: true,
        canRevise: true,
        canReject: true,
        gates: [
          {
            stepId: "approve",
            prompt: "<b>Approve?</b>",
            choices: ["approve", "reject"],
            artifacts: [{ name: "decision", summary: "APPROVE — ok" }],
            reviews: [],
          },
        ],
      }),
    ]);
    assert.match(html, /\/\* kiln-serve \*\//);
    assert.match(html, /\(1\) Kiln/);
    assert.match(html, /Needs a hand/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<b>Approve/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /<a class="card-btn" href="\/jobs\/job-1">Review<\/a>/);

    const settled = page([viewJob({ jobId: "job-1", state: "done", title: "Done", prUrl: "javascript:alert(1)" })], "history");
    assert.match(settled, /javascript:alert\(1\)/);
    assert.doesNotMatch(settled, /href="javascript:/);
    assert.match(settled, /landed locally/);
    assert.doesNotMatch(settled, /Show more/);
  });

  it("shows attempt, reason, and next retry on a Needs a hand row for a dead job", () => {
    const jobs = [
      viewJob({
        jobId: "dead-1",
        state: "dead",
        title: "Stalled build",
        attemptCount: 3,
        maxAttempts: 3,
        lastFailureReason: "stalled",
      }),
      viewJob({
        jobId: "fail-1",
        state: "failed",
        title: "Crashed build",
        attemptCount: 1,
        maxAttempts: 3,
        lastFailureReason: "orphaned",
        nextRetryAt: "2026-10-26T03:00:00.000Z",
        steps: [
          { id: "spec", phase: "done" },
          { id: "build", phase: "current" },
        ],
      }),
      viewJob({
        jobId: "gate-1",
        state: "needs-human",
        title: "Waiting",
        canApprove: true,
        canRevise: true,
      }),
    ];
    const board = page(jobs);
    const column = (name: string) => {
      const start = board.indexOf(`<section class="col" data-column="${name}"`);
      return board.slice(start, board.indexOf("</section>", start));
    };
    const hand = column("needs-hand");
    const inbox = column("needs-you");
    const repos = page(jobs, "repos");
    assert.match(board, /\(1\) Kiln/);
    assert.match(hand, /id="job-dead-1"/);
    assert.doesNotMatch(hand, /id="job-fail-1"/);
    assert.match(repos, /id="job-fail-1"/);
    assert.match(repos, /class="job retrying"/);
    assert.match(repos, /retrying <time datetime="2026-10-26T03:00:00.000Z" data-time="clock">/);
    assert.match(repos, /attempt 1\/3 · orphaned/);
    const failStart = repos.indexOf('id="job-fail-1"');
    const failEnd = repos.indexOf('id="job-', failStart + 1);
    const fail = repos.slice(failStart, failEnd === -1 ? undefined : failEnd);
    assert.doesNotMatch(fail, /next retry /);
    const gateStart = inbox.indexOf('id="job-gate-1"');
    const gateEnd = inbox.indexOf('id="job-', gateStart + 1);
    const gate = inbox.slice(gateStart, gateEnd === -1 ? undefined : gateEnd);
    assert.doesNotMatch(gate, /attempt /);
    assert.match(gate, /Waiting for your decision/);
    assert.match(hand, /action="\/api\/jobs\/dead-1\/retry"/);
  });

  it("puts queued and blocked jobs in Queued, and does not format the clock as UTC", () => {
    const html = page(
      [
        viewJob({ jobId: "q", state: "queued", title: "Wait", logTail: "started 2026-10-26T05:01:22.000Z" }),
        viewJob({
          jobId: "b",
          state: "blocked",
          title: "Hold",
          dependsOn: [{ jobId: "q", state: "queued" }],
        }),
        viewJob({
          jobId: "spec-run",
          state: "running",
          title: "Writing the spec",
          steps: [{ id: "spec", phase: "current" }],
        }),
      ],
      "repos",
    );
    assert.match(html, /id="job-q"/);
    assert.match(html, /id="job-b"/);
    assert.match(html, /depends on/);
    assert.match(html, /href="\/jobs\/q"/);
    assert.match(html, /id="job-spec-run"/);
    assert.match(html, /2026-10-26T05:01:22\.000Z/);
    assert.match(html, /toLocaleTimeString\(\)/);
    assert.match(html, /toLocaleString\(/);
    assert.doesNotMatch(html, /timeZone/);
    assert.doesNotMatch(html, /toUTCString/);
    assert.doesNotMatch(html, /toISOString\(/);
  });

  it("keeps every settled job on the board and does not render a graph", () => {
    const jobs = Array.from({ length: 5 }, (_, index) =>
      viewJob({
        jobId: `done-${index}`,
        state: "done",
        title: `Settled ${index}`,
        finishedAt: `2026-10-2${index}T00:00:00.000Z`,
      }),
    );
    const html = page(jobs, "history");
    assert.doesNotMatch(html, /id="graph-panel"/);
    assert.doesNotMatch(html, /Show more/);
    for (const index of jobs.keys()) assert.match(html, new RegExp(`id="job-done-${index}"`));
  });

  it("links findings for an investigation and keeps a failed job's retry", () => {
    const probe = viewJob({
      jobId: "probe-1",
      workflow: "investigation",
      state: "needs-human",
      title: "Probe the unconfirmed platform facts",
      findingsPath: "/tmp/kiln/findings/probe-1.md",
      gates: [
        {
          stepId: "approve",
          prompt: 'Approve findings for "Probe"?',
          rendered: 'Approve findings for "Probe"?\n\n## Questions\n\nWhich runner?',
          choices: ["approve", "reject"],
          artifacts: [],
          reviews: [],
        },
      ],
    });
    const feature = viewJob({
      jobId: "feat-1",
      state: "failed",
      title: "Render the empty state",
      launchError: "builder exploded",
      logTail: "verify: expected 1 received 0",
    });
    const inbox = page([probe, feature], "repos");
    const hand = page([probe, feature]);
    assert.match(inbox, /href="\/jobs\/probe-1\/findings"/);
    assert.match(inbox, />Findings</);
    assert.doesNotMatch(inbox, /href="\/jobs\/feat-1\/findings"/);
    assert.match(hand, /action="\/api\/jobs\/feat-1\/retry"/);
    assert.match(hand, /builder exploded/);
    assert.match(hand, /Failed: builder exploded/);
    assert.match(hand, /\(1\) Kiln/);
  });
});

describe("kiln serve", () => {
  it("rejects a bad port, a combined tick flag, and serve flags on status", () => {
    const { cwd, home } = workDir("kiln-serve-usage-");
    const missing = runCli(["serve", "--port"], { cwd, home });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /kiln serve/);

    const both = runCli(["serve", "--tick", "5", "--no-tick"], { cwd, home });
    assert.equal(both.status, 2);

    const zero = runCli(["serve", "--tick", "0"], { cwd, home });
    assert.equal(zero.status, 2);

    const status = runCli(["status", "--port", "1"], { cwd, home });
    assert.equal(status.status, 2);

    const retry = runCli(["retry"], { cwd, home });
    assert.equal(retry.status, 2);
    assert.match(retry.stderr, /kiln retry/);
  });

  it("binds 127.0.0.1, serves the console, and rejects a cross-origin POST", async () => {
    const { cwd, home } = workDir("kiln-serve-empty-");
    const repo = join(cwd, "web");
    mkdirSync(repo);
    assert.equal(runCli(["repo", "add", "web", repo, "--test", "true"], { cwd, home }).status, 0);
    useMock(home);

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const homePage = await text(server.url);
      assert.equal(homePage.status, 200);
      assert.match(homePage.body, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
      assert.match(homePage.body, /kiln-serve/);
      const favicon = await text(`${server.url}/favicon.ico`);
      assert.equal(favicon.status, 204);
      assert.equal(favicon.body, "");
      assert.match(homePage.body, /Needs a hand/);
      assert.match(homePage.body, /<title>Kiln<\/title>/);
      assert.doesNotMatch(homePage.body, new RegExp(TOKEN));

      const jobs = await text(`${server.url}/api/jobs`);
      assert.equal(jobs.status, 200);
      assert.match(jobs.body, /"jobs": \[\]/);
      assert.doesNotMatch(jobs.body, new RegExp(TOKEN));
      assert.doesNotMatch(jobs.body, /apiToken/);

      const denied = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: "http://evil.example", Accept: "application/json" },
      });
      assert.equal(denied.status, 403);
      assert.match(denied.body, /Cross-origin request rejected/);

      const wrongPort = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:1", Accept: "application/json" },
      });
      assert.equal(wrongPort.status, 403);

      const retryDenied = await text(`${server.url}/api/jobs/job-1/retry`, {
        method: "POST",
        headers: { Origin: "http://evil.example", Accept: "application/json" },
      });
      assert.equal(retryDenied.status, 403);
      assert.match(retryDenied.body, /Cross-origin request rejected/);

      const csrf = csrfFrom(homePage.body);
      const noToken = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json" },
      });
      assert.equal(noToken.status, 403);
      assert.match(noToken.body, /CSRF token rejected/);

      const missing = await text(`${server.url}/api/jobs/job-1/approve`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrf },
      });
      assert.equal(missing.status, 404);
    } finally {
      await stop(server.child);
    }
  });

  it(
    "lists a needs-human job, approves it the same way as the CLI, and shows a blocked dependency",
    { timeout: 120_000 },
    async () => {
    const { cwd, home } = workDir("kiln-serve-jobs-");
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
    useMock(home);
    const upstream = addJob(cwd, home, "web", "Show the weekly summary");
    const downstream = addJob(cwd, home, "web", "List the weekly summary", [upstream]);
    assert.equal(runCli(["tick"], { cwd, home }).status, 0);
    const suspended = waitForStatus(cwd, home, upstream, new RegExp(`${upstream}\\s+web\\s+feature\\s+needs-human`));
    assert.match(suspended, /Agent decision: APPROVE/);

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const landing = await text(`${server.url}/`);
      assert.equal(landing.status, 200);
      assert.match(landing.body, /id="board"/);
      assert.match(landing.body, /Show the weekly summary/);
      assert.match(landing.body, /data-column="queued"/);
      assert.match(landing.body, /data-column="needs-you"/);

      assert.deepEqual(
        [...landing.body.matchAll(/<section class="col" data-column="([^"]+)"/g)].map((match) => match[1]),
        ["queued", "running", "needs-you", "needs-hand", "done"],
      );
      assert.match(landing.body, /<title>\(1\) Kiln<\/title>/);
      const nav = landing.body.slice(landing.body.indexOf('<nav class="side"'), landing.body.indexOf("</nav>"));
      assert.match(nav, /<a class="nav-link" href="\/" aria-current="page"><span class="nav-label">[^]*?Pipeline<\/span><span class="badge">1<\/span><\/a>/);
      assert.match(nav, /href="\/report"/);
      assert.doesNotMatch(nav, /href="\/inbox"|href="\/hand"/);
      for (const old of ["/inbox", "/hand"]) {
        const moved = await fetch(`${server.url}${old}`, { redirect: "manual" });
        assert.equal(moved.status, 303, old);
        assert.equal(moved.headers.get("location"), "/", old);
        await moved.text();
      }
      assert.match(landing.body, new RegExp(`<a class="card-btn" href="/jobs/${upstream}">Review</a>`));
      const inbox = await text(`${server.url}/jobs/${upstream}`);
      assert.equal(inbox.status, 200);
      assert.match(inbox.body, /Show the weekly summary/);
      assert.match(inbox.body, /web/);
      assert.match(inbox.body, /feature/);
      assert.match(inbox.body, /Agent decision: APPROVE/);
      assert.match(inbox.body, /No must-fix findings/);
      assert.match(inbox.body, /Reviews passed/);
      assert.match(inbox.body, new RegExp(`action="/api/jobs/${upstream}/approve"`));
      assert.match(inbox.body, new RegExp(`action="/api/jobs/${upstream}/reject"`));
      assert.match(inbox.body, new RegExp(`href="/jobs/${upstream}/spec"`));
      assert.match(inbox.body, new RegExp(`href="/jobs/${upstream}/log"`));
      assert.doesNotMatch(inbox.body, new RegExp(TOKEN));

      const spec = await text(`${server.url}/jobs/${upstream}/spec`);
      assert.equal(spec.status, 200);
      assert.match(spec.body, /Show the weekly summary/);
      const log = await text(`${server.url}/jobs/${upstream}/log`);
      assert.equal(log.status, 200);

      const board = await text(`${server.url}/board`);
      assert.equal(board.status, 200);
      assert.match(board.body, /Needs a hand/);
      assert.doesNotMatch(board.body, /href="\/inbox"/);
      assert.match(board.body, /id="drawer"/);
      assert.doesNotMatch(board.body, /id="graph-panel"/);
      const repos = await text(`${server.url}/repos`);
      assert.equal(repos.status, 200);
      assert.match(repos.body, new RegExp(`id="job-${downstream}"`));
      assert.match(repos.body, new RegExp(`href="/jobs/${upstream}"`));
      assert.match(repos.body, /List the weekly summary/);
      assert.match(repos.body, /depends on/);
      assert.match(repos.body, new RegExp(`Waiting on ${upstream} \\(needs-human\\)`));
      const detail = await text(`${server.url}/jobs/${upstream}`);
      assert.equal(detail.status, 200);
      assert.doesNotMatch(detail.body, /class="tabs"/);
      assert.match(detail.body, /aria-label="Progress"/);
      assert.match(detail.body, /aria-label="Job facts"/);
      assert.match(detail.body, /Show the weekly summary/);
      for (const tab of ["live", "changes", "timeline"]) {
        const linked = await text(`${server.url}/jobs/${upstream}?tab=${tab}`);
        assert.equal(linked.status, 200, tab);
        assert.match(linked.body, new RegExp(`data-target="${tab}"`));
        assert.match(linked.body, new RegExp(`id="${tab}"`));
        if (tab !== "live") assert.match(linked.body, new RegExp(`<details class="job-more" id="${tab}" open>`));
      }
      assert.equal((await text(`${server.url}/jobs/${upstream}?tab=bogus`)).status, 400);

      const listed = JSON.parse((await text(`${server.url}/api/jobs`)).body) as {
        jobs: { jobId: string; state: string; dependsOn: { jobId: string; state: string }[]; stack: boolean }[];
        attention: { needsYouCount: number; needsYou: { job: { jobId: string } }[] };
      };
      assert.equal(listed.attention.needsYouCount, 1);
      assert.equal(listed.attention.needsYou[0]?.job.jobId, upstream);
      const blocked = listed.jobs.find((job) => job.jobId === downstream);
      assert.ok(blocked, JSON.stringify(listed));
      assert.equal(blocked.state, "blocked");
      assert.equal(blocked.dependsOn[0]?.jobId, upstream);
      assert.equal(blocked.dependsOn[0]?.state, "needs-human");
      assert.equal(listed.jobs.find((job) => job.jobId === upstream)?.state, "needs-human");
      assert.doesNotMatch(JSON.stringify(listed), new RegExp(TOKEN));

      const one = await text(`${server.url}/api/jobs/${upstream}`);
      assert.equal(one.status, 200);
      assert.match(one.body, /"state": "needs-human"/);

      const denied = await text(`${server.url}/api/jobs/${upstream}/approve`, {
        method: "POST",
        headers: { Origin: "https://evil.example", Accept: "application/json" },
      });
      assert.equal(denied.status, 403);
      const still = JSON.parse((await text(`${server.url}/api/jobs/${upstream}`)).body) as { state: string };
      assert.equal(still.state, "needs-human");

      const approved = await text(`${server.url}/api/jobs/${upstream}/approve`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrfFrom(inbox.body) },
      });
      assert.equal(approved.status, 200, approved.body);
      const body = JSON.parse(approved.body) as { ok: boolean; job: { state: string } };
      assert.equal(body.ok, true);
      const cli = runCli(["status", upstream], { cwd, home });
      assert.equal(cli.status, 0, cli.stderr);
      const cliState = cli.stdout.match(new RegExp(`${upstream}\\s+web\\s+feature\\s+(\\S+)`))?.[1];
      assert.equal(body.job.state, cliState, cli.stdout);
      assert.notEqual(body.job.state, "needs-human");
      // deliver=local lands when yak resume finishes, so the settled state is done.
      // `approved` is that same view while the resumed run is still alive.
      assert.equal(body.job.state, "done");
      assert.match(cli.stdout, new RegExp(`${upstream}\\s+web\\s+feature\\s+done`));

      const again = await text(`${server.url}/api/jobs/${upstream}/approve`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: server.url, "Content-Type": "application/x-www-form-urlencoded" },
        body: `csrf=${encodeURIComponent(csrfFrom(inbox.body))}`,
      });
      assert.equal(again.status, 409);
      assert.match(again.body, /<!DOCTYPE html>/);
      assert.match(again.body, /not needs-human/);
      assert.doesNotMatch(again.body, new RegExp(TOKEN));
    } finally {
      await stop(server.child);
      await reapLaunches(cwd);
    }
  },
  );

  // Kept apart from the needs-human test so these checks run even when an earlier
  // assertion there fails (the /spec route on a symlinked TMPDIR, for one).
  it("serves one step in full and 404s a step that has not started or is not in the plan", { timeout: 120_000 }, async () => {
    const { cwd, home } = workDir("kiln-serve-step-");
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
    useMock(home);
    const upstream = addJob(cwd, home, "web", "Show the weekly summary");
    assert.equal(runCli(["tick"], { cwd, home }).status, 0);
    waitForStatus(cwd, home, upstream, new RegExp(`${upstream}\\s+web\\s+feature\\s+needs-human`));

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const detail = await text(`${server.url}/jobs/${upstream}`);
      assert.equal(detail.status, 200);
      assert.match(detail.body, new RegExp(`href="/jobs/${upstream}/steps/spec"`));
      assert.doesNotMatch(detail.body, new RegExp(`href="/jobs/${upstream}/steps/land"`));
      const stepPage = await text(`${server.url}/jobs/${upstream}/steps/build`);
      assert.equal(stepPage.status, 200);
      assert.match(stepPage.body, /<nav class="step-nav" aria-label="Steps">/);
      assert.match(stepPage.body, new RegExp(`<a class="title-link" href="/jobs/${upstream}">`));
      assert.match(stepPage.body, /data-pin="true"/);
      // The mock adapter writes no session: the workflow family, marked configured, and no invented cost.
      assert.match(stepPage.body, /<span class="step-agent">builder, opus \(configured\), cost unknown<\/span>/);
      const results: [string, RegExp[]][] = [
        ["spec", [/Show the weekly summary\./, /Touch the named module\./]],
        ["build", [/<dd>READY<\/dd>/, /Mock build\./]],
        ["verify", [/<dd>passed, exit 0<\/dd>/]],
        ["security", [/<dd>PASS<\/dd>/, /No must-fix findings\./]],
        ["approver", [/<dd>APPROVE<\/dd>/, /Reviews passed\./]],
      ];
      for (const [step, patterns] of results) {
        const shown = await text(`${server.url}/jobs/${upstream}/steps/${step}?view=result`);
        assert.equal(shown.status, 200, step);
        for (const pattern of patterns) assert.match(shown.body, pattern, step);
      }
      assert.equal((await text(`${server.url}/jobs/${upstream}/steps/spec?view=activity`)).status, 200);
      assert.equal((await text(`${server.url}/jobs/${upstream}/steps/spec?view=prompt`)).status, 400);
      for (const missing of ["land", "revise", "nope", "..%2F..%2Fjournal", "build%2F..%2F..", "%2E%2E", "%E0%A4%A"]) {
        const gone = await text(`${server.url}/jobs/${upstream}/steps/${missing}`);
        assert.equal(gone.status, 404, missing);
        assert.doesNotMatch(gone.body, /<script>/, missing);
      }
      assert.match((await text(`${server.url}/jobs/${upstream}/steps/nope`)).body, /No step nope\./);
      assert.equal((await text(`${server.url}/jobs/nope-0000/steps/spec`)).status, 404);
    } finally {
      await stop(server.child);
      await reapLaunches(cwd);
    }
  });

  it("serves escaped findings for an investigation job and links them on the board", async () => {
    const { cwd, home } = workDir("kiln-serve-findings-");
    const repo = join(cwd, "web");
    mkdirSync(repo);
    assert.equal(runCli(["repo", "add", "web", repo, "--test", "true"], { cwd, home }).status, 0);
    useMock(home);

    const spec = join(cwd, "probe.md");
    writeFileSync(spec, "# Probe the unconfirmed platform facts\n\nNo product code.\n");
    const created = runCli(
      ["add", "investigation", "--repo", "web", "--spec", spec, "--title", "Probe the unconfirmed platform facts"],
      { cwd, home },
    );
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(id, created.stdout);

    const featureSpec = join(cwd, "follow.md");
    writeFileSync(featureSpec, "# Render the empty state\n\nShow a sentence.\n");
    const feature = runCli(
      ["add", "feature", "--repo", "web", "--spec", featureSpec, "--title", "Render the empty state"],
      { cwd, home },
    );
    assert.equal(feature.status, 0, feature.stderr);
    const featureId = feature.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(featureId, feature.stdout);

    const findingsDir = join(home, ".kiln", "findings");
    mkdirSync(findingsDir);
    writeFileSync(join(findingsDir, `${id}.md`), `# Findings\n\n<script>alert(1)</script>\n${TOKEN}\n`);

    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const board = await text(`${server.url}/repos`);
      assert.equal(board.status, 200);
      assert.match(board.body, new RegExp(`href="/jobs/${id}/findings"`));
      assert.doesNotMatch(board.body, new RegExp(`href="/jobs/${featureId}/findings"`));
      assert.doesNotMatch(board.body, new RegExp(TOKEN));

      const page = await text(`${server.url}/jobs/${id}/findings`);
      assert.equal(page.status, 200);
      assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(page.body, /<script>alert/);
      assert.match(page.body, /\[redacted\]/);
      assert.doesNotMatch(page.body, new RegExp(TOKEN));

      const missing = await text(`${server.url}/jobs/${featureId}/findings`);
      assert.equal(missing.status, 404);
      assert.doesNotMatch(missing.body, new RegExp(TOKEN));
    } finally {
      await stop(server.child);
    }
  });

  it(
    "retries a failed job through the same launch as the CLI and rejects a cross-origin retry",
    { timeout: 120_000 },
    async () => {
      const { cwd, home } = workDir("kiln-serve-retry-");
      const web = join(cwd, "repos", "web");
      initCheckout(web);
      assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
      useMock(home);
      const id = addJob(cwd, home, "web", "Show the weekly summary");
      const runId = "2020-01-01T00-00-00Z-old";
      const runDir = join(web, ".runs", runId);
      mkdirSync(runDir, { recursive: true });
      const gone = 2_147_483_646;
      assert.throws(() => process.kill(gone, 0));
      writeFileSync(
        join(runDir, "journal.jsonl"),
        [
          JSON.stringify({
            t: "run.started",
            at: "2020-01-01T00:00:00.000Z",
            runId,
            tag: `kiln:${id}`,
            pid: gone,
          }),
          JSON.stringify({ t: "step.started", at: "2020-01-01T00:00:01.000Z", stepId: "spec" }),
          JSON.stringify({
            t: "step.failed",
            at: "2020-01-01T00:00:02.000Z",
            stepId: "spec",
            failure: { reason: "command-failed", detail: "builder exploded" },
          }),
          JSON.stringify({ t: "run.finished", at: "2020-01-01T00:00:03.000Z", status: "failed" }),
          "",
        ].join("\n"),
      );
      const logDir = join(home, ".kiln", "logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `${id}.log`), "builder exploded\nverify: expected 1 received 0\n");

      const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
      try {
        const html = await text(`${server.url}/`);
        assert.equal(html.status, 200);
        assert.match(html.body, /<title>Kiln<\/title>/);
        const repos = await text(`${server.url}/repos`);
        assert.match(repos.body, /verify: expected 1 received 0/);
        assert.match(repos.body, new RegExp(`action="/api/jobs/${id}/retry"`));
        assert.match(repos.body, new RegExp(`id="job-${id}"`));
        assert.match(repos.body, /class="job retrying"/);
        assert.match(repos.body, /retrying <time /);
        assert.match(repos.body, /attempt 1\/3 · failed/);
        const rowStart = repos.body.indexOf(`id="job-${id}"`);
        const row = repos.body.slice(rowStart, repos.body.indexOf("</article>", rowStart));
        const handStart = html.body.indexOf('data-column="needs-hand"');
        const hand = html.body.slice(handStart, html.body.indexOf("</section>", handStart));
        assert.doesNotMatch(hand, new RegExp(`id="job-${id}"`));

        const denied = await text(`${server.url}/api/jobs/${id}/retry`, {
          method: "POST",
          headers: { Origin: "https://evil.example", Accept: "application/json" },
        });
        assert.equal(denied.status, 403);
        assert.match(denied.body, /Cross-origin request rejected/);
        const still = JSON.parse((await text(`${server.url}/api/jobs/${id}`)).body) as { state: string };
        assert.equal(still.state, "failed");

        // Per-step usage is added to the job JSON; no field present before is renamed or removed.
        const before = JSON.parse((await text(`${server.url}/api/jobs/${id}`)).body) as Record<string, unknown>;
        assert.equal(before.stepUsage, undefined);
        const plainStatus = runCli(["status"], { cwd, home });
        mkdirSync(join(runDir, "sessions"));
        writeFileSync(join(runDir, "sessions", "spec.jsonl"), readFileSync(join(root, "test", "fixtures", "usage", "spec.jsonl")));
        const withUsage = JSON.parse((await text(`${server.url}/api/jobs/${id}`)).body) as Record<string, unknown>;
        for (const key of Object.keys(before)) assert.ok(key in withUsage, `${key} is still there`);
        assert.deepEqual(withUsage.stepUsage, [
          { stepId: "spec", model: "claude-opus-5-5", modelSource: "session", rounds: [{ usd: 0.42, tokens: 1500 }], usd: 0.42, tokens: 1500 },
        ]);
        const listedUsage = JSON.parse((await text(`${server.url}/api/jobs`)).body) as { jobs: Record<string, unknown>[] };
        assert.deepEqual(listedUsage.jobs.find((job) => job.jobId === id)?.stepUsage, withUsage.stepUsage);
        const oneStatus = runCli(["status", id], { cwd, home });
        assert.equal(oneStatus.status, 0, oneStatus.stderr);
        assert.match(oneStatus.stdout, /^ {2}step spec claude-opus-5-5, \$0\.42, 1500 tokens$/m);
        const allStatus = runCli(["status"], { cwd, home });
        assert.equal(allStatus.stdout, plainStatus.stdout, "kiln status with no id is unchanged");
        assert.doesNotMatch(allStatus.stdout, /^ {2}step /m);

        const retried = await text(`${server.url}/api/jobs/${id}/retry`, {
          method: "POST",
          headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrfFrom(html.body) },
        });
        assert.equal(retried.status, 200, retried.body);
        const start = Date.now();
        let state = "";
        let last = "";
        while (Date.now() - start < 60_000) {
          const job = await text(`${server.url}/api/jobs/${id}`);
          last = job.body;
          state = (JSON.parse(job.body) as { state: string }).state;
          if (state === "running" || state === "needs-human" || state === "approved" || state === "done") break;
          await delay(200);
        }
        assert.match(state, /running|needs-human|approved|done/, last);
        const cli = runCli(["retry", id], { cwd, home });
        assert.notEqual(cli.status, 0);
        assert.match(cli.stderr, /not failed, dead, or stopped for a person/);
      } finally {
        await stop(server.child);
        await reapLaunches(cwd);
      }
    },
  );

  it(
    "runs kiln tick on an interval while serve is open",
    { timeout: 90_000 },
    async () => {
      const { cwd, home } = workDir("kiln-serve-tick-");
      const web = join(cwd, "repos", "web");
      initCheckout(web);
      assert.equal(runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home }).status, 0);
      useMock(home);
      const id = addJob(cwd, home, "web", "Show the weekly summary");
      const queued = runCli(["status", id], { cwd, home });
      assert.match(queued.stdout, new RegExp(`${id}\\s+web\\s+feature\\s+queued`));

      const server = await startServe(["--port", "0", "--tick", "1"], { cwd, home });
      try {
        const start = Date.now();
        let state = "";
        let last = "";
        while (Date.now() - start < 45_000) {
          const job = await text(`${server.url}/api/jobs/${id}`);
          last = job.body;
          if (job.status === 200) {
            state = (JSON.parse(job.body) as { state: string }).state;
            if (state === "running" || state === "needs-human" || state === "approved" || state === "done") break;
          }
          await delay(200);
        }
        assert.match(state, /running|needs-human|approved|done/, last);
        assert.doesNotMatch(server.output.stderr, /tick: .*Error/);
      } finally {
        await stop(server.child);
        await reapLaunches(cwd);
      }
    },
  );
});

describe("reap launches", () => {
  it("kills a detached writer before the temp dir is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-reap-"));
    keep.push(dir);
    const runDir = join(dir, ".runs", "2026-10-27T00-00-00Z-reap");
    mkdirSync(runDir, { recursive: true });
    const child = spawn("bash", ["-c", "while true; do mkdir -p .yak/nested; echo x > .yak/nested/note; done"], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid;
    assert.ok(pid && pid > 1);
    writeFileSync(join(runDir, "journal.jsonl"), `${JSON.stringify({ t: "run.started", pid })}\n`);
    await delay(30);
    await reapLaunches(dir);
    await exited(child);
    assert.throws(() => process.kill(pid, 0));
    // Without /proc (macOS) the reaper finds nothing and the fallback SIGKILLs bash alone, so a
    // `mkdir` it had already forked can finish after bash is gone. Retry over that one last write.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});

describe("queue routes and board", () => {
  it("guards next, hold, and release, and draws Queued in launch order with Held in words", { timeout: 60_000 }, async () => {
    const { cwd, home } = workDir("kiln-serve-queue-");
    const web = join(cwd, "repos", "web");
    initCheckout(web);
    const added = runCli(["repo", "add", "web", web, "--test", testCommand], { cwd, home });
    assert.equal(added.status, 0, added.stderr);
    const ids: string[] = [];
    for (const title of ["SAMPLE-A", "SAMPLE-B", "SAMPLE-C"]) {
      const created = runCli(["add", "feature", "--repo", "web", "--prompt", `Do ${title}.`, "--title", title], { cwd, home });
      assert.equal(created.status, 0, created.stderr);
      const id = created.stdout.match(/^added (\S+)/m)?.[1];
      assert.ok(id);
      ids.push(id);
      spawnSync("sleep", ["0.01"]);
    }
    const [a, b, c] = ids as [string, string, string];
    const moved = runCli(["next", c], { cwd, home });
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`moved ${c} to the front`));
    const badCli = runCli(["hold", "a..b"], { cwd, home });
    assert.equal(badCli.status, 1);
    const queue = runCli(["queue"], { cwd, home });
    assert.equal(queue.status, 0, queue.stderr);
    assert.match(queue.stdout, new RegExp(`^1  ${c}  web  SAMPLE-C  moved to front\\n2  ${a}  web  SAMPLE-A  ready\\n3  ${b}  web  SAMPLE-B  ready\\n$`));

    const events = () => readFileSync(join(home, ".kiln", "events.jsonl"), "utf8").split("\n").filter(Boolean).length;
    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const repos = await text(`${server.url}/repos`);
      const csrf = csrfFrom(repos.body);
      for (const id of ids) {
        assert.match(repos.body, new RegExp(`action="/api/jobs/${id}/next" class="act next">.*?<button type="submit">Run next</button>`));
        assert.match(repos.body, new RegExp(`action="/api/jobs/${id}/hold" class="act hold">.*?<button type="submit">Hold</button>`));
      }
      assert.doesNotMatch(repos.body, /Release/);

      const before = events();
      for (const action of ["next", "hold", "release"]) {
        const noToken = await text(`${server.url}/api/jobs/${b}/${action}`, {
          method: "POST",
          headers: { Origin: server.url, Accept: "application/json" },
        });
        assert.equal(noToken.status, 403);
        for (const bad of ["a%2Fb", "..", "a..b", "%2e%2e"]) {
          const res = await text(`${server.url}/api/jobs/${bad}/${action}`, {
            method: "POST",
            headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrf },
          });
          assert.equal(res.status, 404, `${bad}/${action}`);
        }
      }
      assert.equal(events(), before);

      const held = await text(`${server.url}/api/jobs/${b}/hold`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrf },
      });
      assert.equal(held.status, 200, held.body);
      const body = JSON.parse(held.body) as { ok: boolean; changed: boolean; job?: { held?: boolean } };
      assert.equal(body.changed, true);
      assert.equal(body.job?.held, true);
      assert.equal(events(), before + 1);
      const again = await text(`${server.url}/api/jobs/${b}/hold`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrf },
      });
      assert.equal((JSON.parse(again.body) as { changed: boolean }).changed, false);
      assert.equal(events(), before + 1);

      const after = await text(`${server.url}/repos`);
      assert.match(after.body, new RegExp(`action="/api/jobs/${b}/release" class="act release">.*?<button type="submit">Release</button>`));
      assert.doesNotMatch(after.body, new RegExp(`/api/jobs/${b}/hold"`));
      assert.match(after.body, /<span class="chip">Held<\/span>/);

      const pipeline = await text(`${server.url}/`);
      const order = [...pipeline.body.matchAll(/<article class="card queued" id="job-([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(order, [c, a, b]);
      assert.match(pipeline.body, new RegExp(`id="job-${b}"[^]*?<span class="chip">Held</span>`));

      const released = await text(`${server.url}/api/jobs/${b}/release`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrf },
      });
      assert.equal(released.status, 200, released.body);
      assert.equal(events(), before + 2);
      const missing = await text(`${server.url}/api/jobs/SAMPLE-NONE/next`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "X-Kiln-CSRF": csrf },
      });
      assert.equal(missing.status, 404);
    } finally {
      await stop(server.child);
    }
  });
});
