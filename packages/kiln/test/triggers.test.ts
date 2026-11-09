import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { readStatus, runTick } from "../src/driver.js";
import { listReviewRequests, realGitRemote, reviewSearchQuery, type GitHubHost, type KilnHost, type ReviewRequest } from "../src/host.js";
import type { JiraPollIssue } from "../src/intake/jira.js";
import { buildAttention } from "../src/attention.js";
import { buildBoard } from "../src/board-view.js";
import { writeJob } from "../src/jobs.js";
import { packageRoot } from "../src/paths.js";
import { pauseFactory } from "../src/rails.js";
import { readSettings, saveSettings } from "../src/settings.js";
import { renderApp } from "../src/serve-page.js";
import {
  compileJql,
  evaluateTriggers,
  isKilnOwnActivity,
  prTriggerEvents,
  recordOwnedPullRequest,
  reviewSlotsInUse,
  routeTrigger,
  triggerRows,
  effectiveRoutes,
  type JiraSearch,
} from "../src/triggers.js";
import { materializeWorkflow } from "../src/workflow.js";

const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function local(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function harness(extra: Record<string, unknown> = {}): { dir: string; config: LoadedKilnConfig } {
  const dir = mkdtempSync(join(tmpdir(), "kiln-trigger-"));
  keep.push(dir);
  const checkout = join(dir, "web");
  mkdirSync(checkout, { recursive: true });
  const configPath = join(dir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ adapter: "mock", repos: { web: { path: checkout, test: "node --test test.mjs" } }, ...extra }, null, 2)}\n`,
  );
  return { dir, config: loadKilnConfig(configPath, { home: dir }) };
}

function scheduleFires(kilnDir: string): number {
  return readEvents(kilnDir, { warn: () => {} }).filter(
    (event) => event.event === "trigger.fired" && event.properties.source === "schedule",
  ).length;
}

function jobs(config: LoadedKilnConfig): string[] {
  try {
    return readdirSync(config.jobsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("cron slots", () => {
  it("fires once per slot and once on startup for a missed slot", () => {
    const { config } = harness();
    let calls = 0;
    const reviews = {
      list(): ReviewRequest[] {
        calls += 1;
        return [];
      },
    };
    evaluateTriggers({ config, now: local(2026, 11, 3, 8, 0), startup: false, reviews });
    assert.equal(scheduleFires(config.kilnDir), 1);
    evaluateTriggers({ config, now: local(2026, 11, 3, 8, 20), startup: false, reviews });
    assert.equal(scheduleFires(config.kilnDir), 1);
    assert.equal(calls, 1);
    evaluateTriggers({ config, now: local(2026, 11, 3, 9, 0), startup: false, reviews });
    assert.equal(scheduleFires(config.kilnDir), 2);

    evaluateTriggers({ config, now: local(2026, 11, 3, 12, 30), startup: false, reviews });
    assert.equal(scheduleFires(config.kilnDir), 2, "a running tick does not replay missed hours");
    evaluateTriggers({ config, now: local(2026, 11, 3, 12, 30), startup: true, reviews });
    assert.equal(scheduleFires(config.kilnDir), 3, "startup fires the latest missed slot once");
    assert.equal(calls, 3);
  });
});

describe("trigger failures", () => {
  it("records last_error and does not retry until the next slot", () => {
    const { config } = harness();
    let calls = 0;
    const reviews = {
      list(): ReviewRequest[] {
        calls += 1;
        throw new Error("gh list failed");
      },
    };
    evaluateTriggers({ config, now: local(2026, 11, 3, 10, 0), startup: false, reviews });
    const state = JSON.parse(readFileSync(join(config.kilnDir, "triggers", "state.json"), "utf8")) as {
      "review-requests": { lastError?: string; lastErrorAt?: string; lastFire?: string };
    };
    assert.match(state["review-requests"]?.lastError ?? "", /gh list failed/);
    assert.ok(state["review-requests"]?.lastErrorAt);
    const failed = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.failed");
    assert.equal(failed.length, 1);
    evaluateTriggers({ config, now: local(2026, 11, 3, 10, 20), startup: false, reviews });
    assert.equal(calls, 1);
    evaluateTriggers({ config, now: local(2026, 11, 3, 11, 0), startup: false, reviews });
    assert.equal(calls, 2);
  });

  it("records a paused trigger as skipped and does not queue it", () => {
    const { config } = harness();
    let calls = 0;
    pauseFactory(config.kilnDir, local(2026, 11, 3, 9, 0));
    evaluateTriggers({
      config,
      now: local(2026, 11, 3, 10, 0),
      startup: false,
      reviews: {
        list(): ReviewRequest[] {
          calls += 1;
          return [{ repo: "web", number: 7, title: "Sample", url: "https://example.com/sample/pull/7", headSha: "abc1234" }];
        },
      },
    });
    assert.equal(calls, 0);
    assert.equal(jobs(config).length, 0);
    const skipped = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.skipped");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.event === "trigger.skipped" ? skipped[0].properties.reason : "", "paused");
    evaluateTriggers({ config, now: local(2026, 11, 3, 10, 5), startup: false, reviews: { list: () => [] } });
    assert.equal(readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.skipped").length, 1);
  });

  it("records a capped trigger as skipped", () => {
    const { config } = harness({ dailyDollarCap: 0 });
    let calls = 0;
    evaluateTriggers({
      config,
      now: local(2026, 11, 3, 10, 0),
      startup: false,
      reviews: {
        list(): ReviewRequest[] {
          calls += 1;
          return [];
        },
      },
    });
    assert.equal(calls, 0);
    const skipped = readEvents(config.kilnDir, { warn: () => {} }).find((event) => event.event === "trigger.skipped");
    assert.ok(skipped && skipped.event === "trigger.skipped");
    assert.equal(skipped.properties.reason, "capped");
  });
});

describe("router", () => {
  it("ignores Kiln's own comment and commit", () => {
    const { config } = harness();
    const activity = {
      jobId: "jexisting",
      repo: "web",
      prNumber: 4,
      headSha: "abc1234abc",
      comments: [
        { id: "own", author: "kiln", body: "shipped the draft", resolved: false },
        { id: "bot", author: "sample[bot]", body: "coverage", resolved: false },
        { id: "human", author: "ada", body: "Please rename the helper.", resolved: false },
      ],
      commits: [{ sha: "abc1234abc", message: "kiln: Sample heading\n\nKiln-Job: jexisting\nKiln-Round: 1\n" }],
    };
    const produced = prTriggerEvents(activity);
    assert.deepEqual(produced.map((event) => event.id), ["comment:human"]);
    assert.equal(isKilnOwnActivity({ body: "kiln: Sample heading\n\nKiln-Job: jexisting\n" }), true);
    const decision = routeTrigger(
      { ...produced[0]!, kilnOwn: true },
      effectiveRoutes([]),
      new Set(),
    );
    assert.equal(decision.type, "ignore");
    recordOwnedPullRequest(config, activity, local(2026, 11, 3, 10, 0));
    const routed = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.routed");
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.event === "trigger.routed" ? routed[0].properties.action : "", "attach");
    assert.equal(routed[0]?.event === "trigger.routed" ? routed[0].properties.dedupe : "", "pr:jexisting:comment:human");
    assert.equal(jobs(config).length, 0);
  });

  it("creates one job per new Jira issue and does not create it again", () => {
    const { config } = harness({
      triggers: [{ id: "sample-ready", kind: "jira", repo: "web", every: "5m", label: "sample", status: "Ready" }],
      routes: [{ id: "sample-ready", trigger: "sample-ready", action: "create", workflow: "feature", repo: "web" }],
    });
    assert.equal(compileJql({ label: "sample", status: "Ready" }), 'labels = "sample" AND status = "Ready"');
    const issues: JiraPollIssue[] = [
      { key: "SAMPLE-1", summary: "Add the empty state", updated: "2026-11-03T10:00:00.000Z", description: "Show the sentence. JIRA_API_TOKEN=supersecretvalue" },
      { key: "SAMPLE-2", summary: "Name the heading", updated: "2026-11-03T10:00:00.000Z" },
    ];
    const seen: string[] = [];
    const jira: JiraSearch = {
      search(jql: string): JiraPollIssue[] {
        seen.push(jql);
        return issues;
      },
    };
    const first = local(2026, 11, 3, 10, 0);
    evaluateTriggers({ config, now: first, startup: true, jira });
    evaluateTriggers({ config, now: new Date(first.getTime() + 60_000), startup: false, jira });
    assert.equal(seen.length, 1, "a failed or finished poll waits for the interval");
    evaluateTriggers({ config, now: new Date(first.getTime() + 5 * 60_000), startup: false, jira });
    assert.equal(seen.length, 2);
    assert.equal(jobs(config).length, 2);
    const specs = readdirSync(join(config.kilnDir, "specs")).map((name) => readFileSync(join(config.kilnDir, "specs", name), "utf8"));
    assert.equal(specs.some((text) => text.includes("supersecretvalue")), false);
    const raw = readFileSync(join(config.kilnDir, "events.jsonl"), "utf8");
    assert.equal(raw.includes("supersecretvalue"), false);
    const keys = readEvents(config.kilnDir, { warn: () => {} })
      .filter((event) => event.event === "trigger.routed")
      .map((event) => (event.event === "trigger.routed" ? event.properties.dedupe : ""));
    assert.deepEqual(keys.sort(), ["jira:sample-ready:SAMPLE-1", "jira:sample-ready:SAMPLE-2"]);
  });
});

describe("review request drafts", () => {
  it("skips the same head SHA and lands in the Inbox without posting", { timeout: 120_000 }, () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-review-"));
    keep.push(cwd);
    const origin = join(cwd, "origin.git");
    const checkout = join(cwd, "checkout");
    mkdirSync(origin, { recursive: true });
    git(origin, ["init", "--bare", "-q", "-b", "main"]);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    mkdirSync(checkout, { recursive: true });
    git(checkout, ["init", "-q", "-b", "main"]);
    git(checkout, ["config", "user.email", "kiln-test@example.com"]);
    git(checkout, ["config", "user.name", "Kiln Test"]);
    writeFileSync(join(checkout, "test.mjs"), "import test from 'node:test';\ntest('sample', () => {});\n");
    const fixture = join(checkout, "test", "fixtures", "kiln-review");
    mkdirSync(fixture, { recursive: true });
    const markdown = [
      "# Draft review: Sample heading",
      "",
      "## Findings",
      "",
      "- **warning** `src/sample.ts:12`",
      "  Suggested comment: Name the empty state before rendering it.",
      "",
    ].join("\n");
    writeFileSync(
      join(fixture, "draft.json"),
      `${JSON.stringify([{ output: { markdown, findings: [{ severity: "warning", file: "src/sample.ts", line: 12, comment: "Name the empty state before rendering it." }] } }])}\n`,
    );
    git(checkout, ["add", "-A"]);
    git(checkout, ["commit", "-q", "-m", "initial"]);
    git(checkout, ["remote", "add", "origin", origin]);
    git(checkout, ["push", "-q", "-u", "origin", "main"]);
    const sha = git(checkout, ["rev-parse", "HEAD"]).trim();
    const home = join(cwd, "kiln");
    mkdirSync(home, { recursive: true });
    const configPath = join(home, "kiln.config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        adapter: "mock",
        repos: { web: { path: checkout, test: "node --test test.mjs", deliver: "pr", base: "main" } },
      })}\n`,
    );
    const config = loadKilnConfig(configPath, { home });
    const calls: string[] = [];
    const github: GitHubHost = {
      findByHead() {
        calls.push("find");
        return null;
      },
      createDraft() {
        calls.push("create");
        throw new Error("posted");
      },
      view() {
        calls.push("view");
        return { state: "OPEN", mergedAt: null };
      },
    };
    const request: ReviewRequest = {
      repo: "web",
      number: 7,
      title: "Sample heading",
      url: "https://example.com/sample/pull/7",
      headSha: sha,
    };
    const host: KilnHost = {
      git: realGitRemote,
      github,
      reviews: { list: () => [request] },
    };
    const ghLog = join(cwd, "gh.log");
    writeFileSync(ghLog, "");
    const ghBin = join(cwd, "gh");
    writeFileSync(ghBin, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GH_LOG\"\necho 'gh should not be called' >&2\nexit 1\n");
    spawnSync("chmod", ["+x", ghBin]);
    const previousGh = process.env.KILN_GH;
    const previousLog = process.env.GH_LOG;
    process.env.KILN_GH = ghBin;
    process.env.GH_LOG = ghLog;
    try {
      const now = local(2026, 11, 3, 15, 0);
      const launched = runTick(config, host, { startup: false, triggerStartup: true, now });
      assert.match(launched, /launch/);
      assert.equal(jobs(config).length, 1);
      const id = (JSON.parse(readFileSync(join(config.jobsDir, jobs(config)[0] ?? ""), "utf8")) as { id: string }).id;
      const started = Date.now();
      let state = "";
      let rendered = "";
      let detail = "";
      while (Date.now() - started < 60_000) {
        const status = readStatus(config, id, host);
        const job = status.jobs[0];
        state = job?.state ?? "";
        rendered = job?.gates.map((gate) => gate.rendered ?? gate.prompt).join("\n") ?? "";
        detail = [job?.launchError, job?.failureDetail, job?.logTail].filter(Boolean).join("\n");
        if (state === "failed" || state === "dead") break;
        if (state === "needs-human" && rendered.includes("src/sample.ts:12")) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      assert.equal(state, "needs-human", `${rendered}\n${detail}`);
      runTick(config, host, { startup: false, triggerStartup: false, now: new Date(now.getTime() + 3_600_000) });
      assert.equal(jobs(config).length, 1, "the same head SHA does not open a second draft");
      assert.match(rendered, /does not approve the pull request or merge it/);
      assert.match(rendered, /warning/);
      assert.match(rendered, /src\/sample\.ts:12/);
      const board = buildBoard(readStatus(config).jobs, readEvents(config.kilnDir, { warn: () => {} }));
      assert.equal(board.inbox.some((job) => job.jobId === id), true);
      assert.equal(calls.includes("create"), false);
      assert.equal(readFileSync(ghLog, "utf8"), "");
    } finally {
      if (previousGh === undefined) delete process.env.KILN_GH;
      else process.env.KILN_GH = previousGh;
      if (previousLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = previousLog;
    }
  });
});

describe("trigger settings", () => {
  it("disables a trigger through the settings API and keeps its cron", () => {
    const { dir, config } = harness();
    const loaded = readSettings(config.configPath);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const review = loaded.document.triggers.find((trigger) => trigger.id === "review-requests");
    assert.equal(review?.cron, "0 * * * *");
    assert.equal(review?.enabled, true);
    assert.equal(review?.label, "kiln-review");
    assert.equal(review?.maxNew, 3);
    assert.equal(review?.maxQueued, 5);
    const saved = saveSettings(
      config.configPath,
      {
        revision: loaded.document.revision,
        repos: loaded.document.repos,
        triggers: [{ id: "review-requests", enabled: false }],
      },
      dir,
    );
    assert.equal(saved.ok, true, saved.ok ? "" : saved.body.error);
    if (!saved.ok) return;
    const file = JSON.parse(readFileSync(config.configPath, "utf8")) as { triggers: { id: string; cron?: string; enabled?: boolean }[] };
    const stored = file.triggers.find((trigger) => trigger.id === "review-requests");
    assert.equal(stored?.enabled, false);
    assert.equal(stored?.cron, "0 * * * *");
    let calls = 0;
    evaluateTriggers({
      config: loadKilnConfig(config.configPath, { home: dir }),
      now: local(2026, 11, 3, 10, 0),
      startup: true,
      reviews: {
        list(): ReviewRequest[] {
          calls += 1;
          return [];
        },
      },
    });
    assert.equal(calls, 0);
    assert.equal(
      readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.fired").length,
      0,
    );
    const shown = saved.document.triggers.find((trigger) => trigger.id === "review-requests");
    assert.equal(shown?.enabled, false);
    assert.equal(shown?.label, "kiln-review");
    assert.equal(shown?.maxNew, 3);
    assert.equal(shown?.maxQueued, 5);
  });

  it("uses a review prompt from a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-prompt-"));
    keep.push(dir);
    const prompt = join(dir, "review.md");
    writeFileSync(prompt, "Plugin review prompt. Cite file and line. Do not post.\n");
    const rendered = materializeWorkflow(dir, "jreview", "review", { reviewPrompt: prompt });
    const text = readFileSync(rendered, "utf8");
    const file = text.match(/file: "([^"]+)"/)?.[1];
    assert.ok(file);
    assert.match(readFileSync(file, "utf8"), /Plugin review prompt/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /Kiln runs this review/);
  });
});

describe("review request label", () => {
  it("asks gh for the label and drops a pull request that does not carry it", () => {
    const { config } = harness();
    const checkout = config.repos.web?.path ?? "";
    git(checkout, ["init", "-q", "-b", "main"]);
    git(checkout, ["remote", "add", "origin", "https://github.com/example/web.git"]);
    const sha = "abc1234abc1234";
    const body = JSON.stringify([
      {
        number: 1,
        title: "SAMPLE-1",
        url: "https://example.com/web/pull/1",
        headRefOid: sha,
        labels: [{ name: "kiln-review" }],
      },
      {
        number: 2,
        title: "SAMPLE-2",
        url: "https://example.com/web/pull/2",
        headRefOid: sha,
        labels: [{ name: "other" }],
      },
    ]);
    const log = join(config.kilnDir, "gh.log");
    const payload = join(config.kilnDir, "prs.json");
    const bin = join(config.kilnDir, "gh");
    writeFileSync(payload, body);
    writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GH_LOG\"\ncat \"$GH_PAYLOAD\"\n");
    spawnSync("chmod", ["+x", bin]);
    const previousGh = process.env.KILN_GH;
    const previousLog = process.env.GH_LOG;
    const previousPayload = process.env.GH_PAYLOAD;
    process.env.KILN_GH = bin;
    process.env.GH_LOG = log;
    process.env.GH_PAYLOAD = payload;
    try {
      assert.equal(reviewSearchQuery("kiln-review"), 'review-requested:@me label:"kiln-review"');
      const labeled = listReviewRequests([{ name: "web", path: checkout }]);
      assert.deepEqual(labeled.map((item) => item.title), ["SAMPLE-1"]);
      const searched = readFileSync(log, "utf8");
      assert.match(searched, /label:"kiln-review"/);
      assert.doesNotMatch(searched, /--search review-requested:@me --state/);
      writeFileSync(log, "");
      const custom = listReviewRequests([{ name: "web", path: checkout, label: "needs-eyes" }]);
      assert.deepEqual(custom, []);
      assert.match(readFileSync(log, "utf8"), /label:"needs-eyes"/);
    } finally {
      if (previousGh === undefined) delete process.env.KILN_GH;
      else process.env.KILN_GH = previousGh;
      if (previousLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = previousLog;
      if (previousPayload === undefined) delete process.env.GH_PAYLOAD;
      else process.env.GH_PAYLOAD = previousPayload;
    }
  });

  it("uses kiln-review when the trigger sets no label, and a per-repo override when one is set", () => {
    const { dir, config } = harness();
    const seen: string[] = [];
    evaluateTriggers({
      config,
      now: local(2026, 11, 9, 4, 0),
      startup: false,
      reviews: {
        list(repos) {
          seen.push(...repos.map((repo) => repo.label ?? ""));
          return [];
        },
      },
    });
    assert.deepEqual(seen, ["kiln-review"]);

    const raw = JSON.parse(readFileSync(config.configPath, "utf8")) as {
      repos: { web: { reviewLabel?: string } };
      triggers?: unknown[];
    };
    raw.repos.web.reviewLabel = "needs-eyes";
    raw.triggers = [{ id: "review-requests", kind: "schedule", label: "kiln-review", maxNew: 1, maxQueued: 2 }];
    writeFileSync(config.configPath, `${JSON.stringify(raw, null, 2)}\n`);
    const reloaded = loadKilnConfig(config.configPath, { home: dir });
    const passed: string[] = [];
    evaluateTriggers({
      config: reloaded,
      now: local(2026, 11, 9, 5, 0),
      startup: false,
      reviews: {
        list(repos) {
          passed.push(...repos.map((repo) => `${repo.name}:${repo.label ?? ""}`));
          return [];
        },
      },
    });
    assert.deepEqual(passed, ["web:needs-eyes"]);
    const row = triggerRows(reloaded, [], local(2026, 11, 9, 5, 0)).find((trigger) => trigger.id === "review-requests");
    assert.equal(row?.label, "kiln-review");
    assert.equal(row?.maxNew, 1);
    assert.equal(row?.maxQueued, 2);
    assert.deepEqual(row?.repoLabels, [{ repo: "web", label: "needs-eyes" }]);
    const html = renderApp({
      css: "/* kiln */",
      section: "triggers",
      board: buildBoard([], []),
      attention: buildAttention([]),
      page: { csrf: "abc", repos: [], workflows: ["review"] },
      triggers: triggerRows(reloaded, readEvents(reloaded.kilnDir, { warn: () => {} }), local(2026, 11, 9, 5, 0)),
    });
    assert.match(html, /label kiln-review/);
    assert.match(html, /1 new\/fire/);
    assert.match(html, /2 queued or running/);
    assert.match(html, /web label needs-eyes/);
    assert.match(html, /<time datetime="[^"]+" data-time>/);
    const script = readFileSync(join(packageRoot(), "assets", "serve.js"), "utf8");
    const stamp = script.slice(script.indexOf("function stamp"), script.indexOf("function poll"));
    assert.ok(stamp.indexOf("localizeTimes") !== -1 && stamp.indexOf("localizeTimes") < stamp.indexOf('getElementById("status")'));
    assert.match(script, /dateStyle: "medium"/);
  });
});

describe("review caps", () => {
  it("creates at most maxNew jobs and records burst-cap for the rest", () => {
    const { config } = harness();
    const sha = commitCheckout(config.repos.web?.path ?? "");
    evaluateTriggers({
      config,
      now: local(2026, 11, 9, 4, 0),
      startup: false,
      reviews: { list: () => sampleReviews(sha, 5) },
    });
    assert.equal(jobs(config).length, 3);
    const skipped = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.skipped");
    assert.equal(skipped.length, 2);
    assert.ok(skipped.every((event) => event.event === "trigger.skipped" && event.properties.reason === "burst-cap"));
  });

  it("does not create a review when queued or running reviews already fill the cap", () => {
    const { config } = harness();
    const sha = commitCheckout(config.repos.web?.path ?? "");
    for (let n = 0; n < 4; n += 1) queueReview(config, `SAMPLE-held-${n}`);
    const running = queueReview(config, "SAMPLE-running");
    mkdirSync(join(config.kilnDir, "launching"), { recursive: true });
    writeFileSync(
      join(config.kilnDir, "launching", `${running}.json`),
      `${JSON.stringify({ jobId: running, pid: process.pid, logPath: "" })}\n`,
    );
    assert.equal(reviewSlotsInUse(config), 5);
    evaluateTriggers({
      config,
      now: local(2026, 11, 9, 4, 0),
      startup: false,
      reviews: { list: () => sampleReviews(sha, 2) },
    });
    assert.equal(jobs(config).length, 5);
    const skipped = readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.skipped");
    assert.equal(skipped.length, 2);
    assert.ok(skipped.every((event) => event.event === "trigger.skipped" && event.properties.reason === "queued-cap"));
  });

  it("does not count a review that is already waiting on its gate", () => {
    const { config } = harness();
    const checkout = config.repos.web?.path ?? "";
    const sha = commitCheckout(checkout);
    for (let n = 0; n < 5; n += 1) {
      const id = queueReview(config, `SAMPLE-gate-${n}`);
      const runDir = join(checkout, ".runs", `run-${n}`);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "journal.jsonl"),
        `${JSON.stringify({ t: "run.started", tag: `kiln:${id}` })}\n${JSON.stringify({ t: "run.finished", status: "suspended" })}\n`,
      );
    }
    assert.equal(reviewSlotsInUse(config), 0);
    evaluateTriggers({
      config,
      now: local(2026, 11, 9, 4, 0),
      startup: false,
      reviews: { list: () => sampleReviews(sha, 1) },
    });
    assert.equal(jobs(config).length, 6);
    assert.equal(
      readEvents(config.kilnDir, { warn: () => {} }).filter((event) => event.event === "trigger.skipped").length,
      0,
    );
  });

  it("does not fire a trigger that is disabled while the list is in flight", () => {
    const { dir, config } = harness();
    let calls = 0;
    evaluateTriggers({
      config,
      now: local(2026, 11, 9, 4, 0),
      startup: true,
      reviews: {
        list() {
          calls += 1;
          const raw = JSON.parse(readFileSync(config.configPath, "utf8")) as { triggers?: unknown[] };
          raw.triggers = [{ id: "review-requests", kind: "schedule", cron: "0 * * * *", enabled: false }];
          writeFileSync(config.configPath, `${JSON.stringify(raw, null, 2)}\n`);
          return [
            { repo: "web", number: 1, title: "SAMPLE-1", url: "https://example.com/web/pull/1", headSha: "abc1234abc1234" },
          ];
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(jobs(config).length, 0);
    const names = readEvents(config.kilnDir, { warn: () => {} }).map((event) => event.event);
    assert.equal(names.includes("trigger.fired"), false);
    assert.equal(names.includes("trigger.routed"), false);
    const row = triggerRows(loadKilnConfig(config.configPath, { home: dir }), readEvents(config.kilnDir, { warn: () => {} })).find(
      (trigger) => trigger.id === "review-requests",
    );
    assert.equal(row?.enabled, false);
  });
});

function sampleReviews(sha: string, count: number): ReviewRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    repo: "web",
    number: index + 1,
    title: `SAMPLE-${index + 1}`,
    url: `https://example.com/web/pull/${index + 1}`,
    headSha: sha,
  }));
}

function queueReview(config: LoadedKilnConfig, title: string): string {
  return writeJob(config, {
    workflow: "review",
    repo: "web",
    specText: `# ${title}\n`,
    title,
    dependsOn: [],
    source: { kind: "prompt", ref: "inline" },
  }).job.id;
}

function commitCheckout(dir: string): string {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(dir, "readme.md"), "sample\n");
  git(dir, ["add", "readme.md"]);
  git(dir, ["commit", "-q", "-m", "sample"]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}
