import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseActivityStream, readRunActivity } from "../src/activity.js";
import { packageRoot } from "../src/paths.js";
import { reapLaunches } from "./reap.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const TOKEN = "kiln-test-jira-token-do-not-render";
const MODEL_KEY = "sk-ant-FAKEKEY1234567890";
const AT = "2026-11-15T18:00:00.000Z";

const OLD_EDIT = "one\ntwo\nthree";
const NEW_EDIT = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n");

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function streamFixture(extra = ""): string {
  return [
    line({ type: "system", subtype: "init", session_id: "s1" }),
    line({
      type: "assistant",
      timestamp: "2026-11-15T18:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'll read the helper before editing it.\nThe check lives in src/foo.ts." }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-11-15T18:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/workspace/src/foo.ts" } }],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-11-15T18:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export const n = 1\n" }] },
    }),
    line({
      type: "assistant",
      timestamp: "2026-11-15T18:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "Edit",
            input: { file_path: "/workspace/src/foo.ts", old_string: OLD_EDIT, new_string: NEW_EDIT },
          },
        ],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-11-15T18:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-11-15T18:00:05.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t3",
            content: "FAIL src/foo.test.ts\nTests: 3 failed, 1 passed\n",
          },
        ],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-11-15T18:00:06.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `The token is ${MODEL_KEY} and must not show.` }],
      },
    }),
    line({
      type: "result",
      subtype: "success",
      timestamp: "2026-11-15T18:00:07.000Z",
      result: "Updated the helper.",
      permission_denials: [],
    }),
    extra,
  ].join("");
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  for (const dir of keep) await reapLaunches(dir);
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("activity parser", () => {
  it("turns a stream-json fixture into a readable feed", () => {
    const events = parseActivityStream(streamFixture(), "build", AT);
    assert.deepEqual(
      events.map((event) => event.summary),
      [
        "I'll read the helper before editing it. The check lives in src/foo.ts.",
        "Read src/foo.ts",
        "Edit src/foo.ts (+12 -3)",
        "Ran npm test - 3 failed",
        `The token is [redacted] and must not show.`,
        "Updated the helper.",
      ],
    );
    assert.deepEqual(
      events.map((event) => event.kind),
      ["message", "tool", "edit", "command", "message", "result"],
    );
    const message = events[0];
    assert.equal(message?.detail, "I'll read the helper before editing it.\nThe check lives in src/foo.ts.");
    assert.equal(message?.phase, "build");
    assert.equal(events[3]?.detail?.includes("3 failed"), true);
    const dumped = JSON.stringify(events);
    assert.equal(dumped.includes("tool_use"), false);
    assert.equal(dumped.includes("file_path"), false);
    assert.equal(dumped.includes(MODEL_KEY), false);
    assert.equal(dumped.includes("[redacted]"), true);
  });

  it("ignores a partial trailing line and returns only events after the cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-activity-"));
    keep.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(join(runDir, "sessions"), { recursive: true });
    const file = join(runDir, "sessions", "build.jsonl");
    const partial = streamFixture().trimEnd();
    writeFileSync(file, `${partial}\n{"type":"assistant","timestamp":"2026-11-15T18:00:08.000Z","message":{"content":[{"type":"text","text":"still writing"`);
    const first = readRunActivity(runDir, { running: true });
    assert.equal(first.events.some((event) => event.summary === "still writing"), false);
    assert.equal(first.phase, "build");
    assert.equal(first.raw.includes("tool_use"), false);
    assert.equal(first.raw.includes(MODEL_KEY), false);
    assert.equal(first.raw.includes("I'll read the helper"), true);

    writeFileSync(
      file,
      `${streamFixture()}{"type":"assistant","timestamp":"2026-11-15T18:00:08.000Z","message":{"content":[{"type":"text","text":"The helper now returns the weekly count."}]}}\n`,
    );
    const next = readRunActivity(runDir, { running: true, after: first.cursor });
    assert.deepEqual(
      next.events.map((event) => event.summary),
      ["The helper now returns the weekly count."],
    );
    assert.notEqual(next.cursor, first.cursor);
    const again = readRunActivity(runDir, { running: true, after: next.cursor });
    assert.deepEqual(again.events, []);

    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(
      join(runDir, "artifacts", "verify.json"),
      `${JSON.stringify({ stdout: "not ok 1\n# fail 2\n", stderr: "", exitCode: 1 })}\n`,
    );
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ t: "step.started", stepId: "build" })}\n${JSON.stringify({ t: "step.started", stepId: "verify" })}\n`,
    );
    const withVerify = readRunActivity(runDir, { running: true, after: next.cursor });
    assert.equal(withVerify.events.some((event) => event.phase === "verify" && event.summary === "Ran tests - 2 failed"), true);
    assert.equal(withVerify.phase, "verify");
    assert.equal(withVerify.raw.includes("# fail 2"), true);
    assert.equal(withVerify.raw.includes("tool_use"), false);
  });
});

describe("activity endpoint", () => {
  it("polls incrementally, redacts secrets, and defaults a running job to Live", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-activity-http-"));
    keep.push(cwd);
    const home = join(cwd, "home");
    mkdirSync(home);
    const repo = join(cwd, "widget");
    mkdirSync(repo);
    const added = runCli(["repo", "add", "widget", repo, "--test", "true"], cwd, home);
    assert.equal(added.status, 0, added.stderr);
    const configPath = join(home, ".kiln", "kiln.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.adapter = "mock";
    config.jira = { baseUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: TOKEN };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const spec = join(cwd, "live.md");
    writeFileSync(spec, "# Show the weekly summary\n\nList it.\n");
    const created = runCli(["add", "feature", "--repo", "widget", "--spec", spec, "--title", "Show the weekly summary"], cwd, home);
    assert.equal(created.status, 0, created.stderr);
    const jobId = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(jobId);

    const doneSpec = join(cwd, "done.md");
    writeFileSync(doneSpec, "# Landed already\n\nDone.\n");
    const done = runCli(["add", "feature", "--repo", "widget", "--spec", doneSpec, "--title", "Landed already"], cwd, home);
    assert.equal(done.status, 0, done.stderr);
    const doneId = done.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(doneId);

    const runDir = join(repo, ".runs", "run-live");
    mkdirSync(join(runDir, "sessions"), { recursive: true });
    const session = join(runDir, "sessions", "build.jsonl");
    writeFileSync(session, streamFixture(line({
      type: "assistant",
      timestamp: "2026-11-15T18:00:09.000Z",
      message: { role: "assistant", content: [{ type: "text", text: `config leaked ${TOKEN}` }] },
    })));
    writeFileSync(
      join(runDir, "journal.jsonl"),
      [
        JSON.stringify({
          t: "run.started",
          at: AT,
          runId: "run-live",
          tag: `kiln:${jobId}`,
          pid: process.pid,
          workflow: "kiln-feature",
        }),
        JSON.stringify({ t: "step.started", at: AT, stepId: "build" }),
        "",
      ].join("\n"),
    );

    const doneDir = join(repo, ".runs", "run-done");
    mkdirSync(join(doneDir, "sessions"), { recursive: true });
    writeFileSync(
      join(doneDir, "sessions", "spec.jsonl"),
      line({
        type: "assistant",
        timestamp: "2026-11-15T17:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Wrote the spec." }] },
      }),
    );
    writeFileSync(
      join(doneDir, "journal.jsonl"),
      [
        JSON.stringify({
          t: "run.started",
          at: "2026-11-15T17:00:00.000Z",
          runId: "run-done",
          tag: `kiln:${doneId}`,
          pid: process.pid,
          workflow: "kiln-feature",
        }),
        JSON.stringify({ t: "step.started", at: "2026-11-15T17:00:00.000Z", stepId: "spec" }),
        JSON.stringify({ t: "step.completed", at: "2026-11-15T17:05:00.000Z", stepId: "spec" }),
        JSON.stringify({ t: "run.finished", at: "2026-11-15T17:05:00.000Z", status: "failed" }),
        "",
      ].join("\n"),
    );

    const server = await startServe(cwd, home);
    try {
      const missing = await json(`${server.url}/api/jobs/missing-job/activity`);
      assert.equal(missing.status, 404);

      const denied = await json(`${server.url}/api/jobs/${jobId}/activity`, {
        headers: { Origin: "http://evil.example", Accept: "application/json" },
      });
      assert.equal(denied.status, 403);
      assert.match(String((denied.body as { error?: string }).error), /Cross-origin/);

      const bad = await json(`${server.url}/api/jobs/${jobId}/activity?after=not-a-cursor`);
      assert.equal(bad.status, 400);

      const first = await json(`${server.url}/api/jobs/${jobId}/activity`);
      assert.equal(first.status, 200);
      const opened = first.body as {
        running: boolean;
        phase: string;
        cursor: string;
        lastActivityAt: string;
        events: { summary: string; kind: string }[];
        raw: string;
      };
      assert.equal(opened.running, true);
      assert.equal(opened.phase, "build");
      assert.equal(opened.events.some((event) => event.summary === "Read src/foo.ts"), true);
      assert.equal(opened.events.some((event) => event.summary === "Edit src/foo.ts (+12 -3)"), true);
      assert.equal(opened.events.some((event) => event.summary === "Ran npm test - 3 failed"), true);
      const body = JSON.stringify(first.body);
      assert.equal(body.includes(TOKEN), false);
      assert.equal(body.includes(MODEL_KEY), false);
      assert.equal(body.includes("tool_use"), false);
      assert.equal(opened.raw.includes(TOKEN), false);
      assert.equal(opened.raw.includes("I'll read the helper"), true);

      const status = await json(`${server.url}/api/jobs/${jobId}`);
      assert.equal(status.status, 200);
      assert.equal((status.body as { lastActivityAt?: string }).lastActivityAt, opened.lastActivityAt);

      writeFileSync(
        session,
        `${readFileSync(session, "utf8")}{"type":"assistant","timestamp":"2026-11-15T18:00:10.000Z","message":{"content":[{"type":"text","text":"Pushed the helper."}]}}\n`,
      );
      const more = await json(`${server.url}/api/jobs/${jobId}/activity?after=${encodeURIComponent(opened.cursor)}`);
      assert.equal(more.status, 200);
      const addedEvents = (more.body as { events: { summary: string }[]; cursor: string }).events;
      assert.deepEqual(
        addedEvents.map((event) => event.summary),
        ["Pushed the helper."],
      );

      const page = await text(`${server.url}/jobs/${jobId}`);
      assert.equal(page.status, 200);
      assert.match(page.body, /aria-current="page">Live</);
      assert.match(page.body, /Read src\/foo\.ts/);
      assert.match(page.body, /Edit src\/foo\.ts \(\+12 -3\)/);
      assert.match(page.body, /Ran npm test - 3 failed/);
      assert.match(page.body, /id="live-note">Watching Build</);
      assert.equal(page.body.includes("tool_use"), false);
      assert.equal(page.body.includes(TOKEN), false);
      assert.equal(page.body.includes(MODEL_KEY), false);

      const finished = await text(`${server.url}/jobs/${doneId}?tab=live`);
      assert.equal(finished.status, 200);
      assert.match(finished.body, /id="live-note">Last session</);
      assert.match(finished.body, /Wrote the spec\./);
      const overview = await text(`${server.url}/jobs/${doneId}`);
      assert.match(overview.body, /aria-current="page">Overview</);
      assert.doesNotMatch(overview.body, /aria-current="page">Live</);
    } finally {
      if (server.child.exitCode === null) server.child.kill("SIGTERM");
    }
  });
});

function runCli(args: string[], cwd: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function startServe(cwd: string, home: string): Promise<{ url: string; child: ChildProcess }> {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", "--port", "0", "--no-tick"], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  children.push(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not listen\n${output.stdout}\n${output.stderr}`)), 10_000);
    child.stdout?.on("data", (chunk: string) => {
      output.stdout += chunk;
      const match = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ url: match[1], child });
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}\n${output.stdout}\n${output.stderr}`));
    });
  });
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function text(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}
