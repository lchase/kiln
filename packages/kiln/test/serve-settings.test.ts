import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { buildBoard } from "../src/board-view.js";
import { packageRoot } from "../src/paths.js";
import { jiraFact, renderApp } from "../src/serve-page.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const TOKEN = "kiln-test-jira-token-do-not-render";
const IMAGE = "kiln-synthetic-image:test";
const SNEAKY = "settings-should-not-store-this-token";

function kilnEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  return env;
}

function workDir(prefix: string): { cwd: string; home: string; configPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  keep.push(cwd);
  const home = join(cwd, "home");
  const web = join(home, "code", "web");
  const docs = join(home, "code", "docs");
  mkdirSync(web, { recursive: true });
  mkdirSync(docs, { recursive: true });
  const configDir = join(home, ".kiln");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "kiln.config.json");
  writeFileSync(configPath, `${JSON.stringify(seedConfig(), null, 2)}\n`);
  return { cwd, home, configPath };
}

function seedConfig(): Record<string, unknown> {
  return {
    note: "synthetic bench",
    owner: "synthetic",
    adapter: "mock",
    maxConcurrent: 2,
    sandbox: { mode: "off", image: IMAGE, allowDomains: ["example.com"] },
    workflows: { feature: { sandbox: { mode: "off" } } },
    repos: {
      web: { path: "~/code/web", test: "npm test", deliver: "local", custom: "keep-me" },
    },
    jira: {
      baseUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      apiToken: TOKEN,
    },
  };
}

interface RunningServe {
  url: string;
  child: ChildProcess;
  output: { stdout: string; stderr: string };
}

function startServe(options: { cwd: string; home: string }): Promise<RunningServe> {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", "--port", "0", "--no-tick"], {
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

async function text(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

function csrfFrom(html: string): string {
  const match = html.match(/data-csrf="([a-f0-9]+)"/);
  assert.ok(match?.[1], "page is missing a csrf token");
  return match[1];
}

function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function putSettings(
  url: string,
  csrf: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return text(`${url}/api/settings`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Kiln-CSRF": csrf,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

interface SettingsDoc {
  path: string;
  revision: string;
  repos: Record<string, { path?: string; test?: string; deliver?: string; base?: string; prTitle?: string; branch?: string }>;
  maxAttempts?: number;
  stallTimeoutMs?: number;
  keepWorktrees?: boolean;
  maxFixRounds?: number;
  sandbox?: { mode?: string; allowDomains?: string[]; image?: string };
  defaults: {
    deliver: string;
    prTitle: string;
    branch: string;
    maxAttempts: number;
    stallTimeoutMs: number;
    maxFixRounds: number;
    sandboxMode: string;
  };
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        }),
    ),
  );
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("serve settings", () => {
  it("round-trips a valid save, keeps unknown keys, and lists the new repo without a restart", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-ok-");
    const server = await startServe({ cwd, home });
    try {
      const homePage = await text(`${server.url}/`);
      assert.equal(homePage.status, 200);
      assert.match(homePage.body, /id="open-settings"/);
      const page = await text(`${server.url}/settings`);
      assert.equal(page.status, 200);
      assert.match(page.body, /id="settings"/);
      assert.match(page.body, /id="repo-add"/);
      assert.match(page.body, /<a href="\/settings\/file"><span>Edit the file<\/span><\/a>/);
      assert.match(page.body, /id="settings-json"/);
      assert.match(page.body, /JIRA_API_TOKEN/);
      assert.match(page.body, /aria-label="Settings sections"/);
      assert.match(page.body, /<input id="keep-worktrees" type="checkbox">/);
      assert.match(page.body, /renders as \[ABC-123\] Title/);
      assert.match(page.body, /renders as ABC-123-slug/);
      assert.equal(page.body.includes(TOKEN), false);
      const csrf = csrfFrom(page.body);

      const loaded = await text(`${server.url}/api/settings`);
      assert.equal(loaded.status, 200, loaded.body);
      assert.equal(loaded.body.includes(TOKEN), false);
      assert.equal(loaded.body.includes("keep-me"), true);
      const before = JSON.parse(loaded.body) as SettingsDoc;
      assert.equal(before.keepWorktrees, undefined);
      assert.equal(before.path, configPath);
      assert.match(before.revision, /^[a-f0-9]{64}$/);
      assert.equal(before.repos.web?.path, "~/code/web");
      assert.equal(before.repos.web?.test, "npm test");
      assert.equal(before.sandbox?.mode, "off");
      assert.deepEqual(before.sandbox?.allowDomains, ["example.com"]);
      assert.equal(before.sandbox?.image, undefined);
      assert.equal(before.defaults.deliver, "local");
      assert.equal(before.defaults.prTitle, "[{issue}] {title}");
      assert.equal(before.defaults.branch, "{issue}-{slug}");
      assert.equal(before.defaults.maxAttempts, 3);
      assert.equal(before.defaults.stallTimeoutMs, 15 * 60 * 1000);
      assert.equal(before.defaults.maxFixRounds, 2);
      assert.equal(before.defaults.sandboxMode, "off");
      const loadedDoc = JSON.parse(loaded.body) as SettingsDoc & {
        jira: { token: string };
        file: {
          sandbox?: { image?: string };
          jira?: { apiToken?: string };
          repos: { web: { custom?: string } };
        };
      };
      assert.equal(loadedDoc.jira.token, "set in file");
      assert.equal(loadedDoc.file.jira?.apiToken, "<redacted>");
      assert.equal(loadedDoc.file.sandbox?.image, IMAGE);
      assert.equal(loadedDoc.file.repos.web.custom, "keep-me");
      assert.equal((before.repos.web as { custom?: string }).custom, undefined);

      const saved = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: {
          web: {
            path: "~/code/web",
            test: "npm test",
            deliver: "pr",
            base: "main",
            prTitle: "[{issue}] {title}",
            branch: "{issue}-{slug}",
          },
          docs: { path: "~/code/docs", test: "npm test", deliver: "local" },
        },
        maxAttempts: 4,
        stallTimeoutMs: 60_000,
        keepWorktrees: true,
        maxFixRounds: 5,
        sandbox: { mode: "docker", allowDomains: ["example.com"] },
      });
      assert.equal(saved.status, 200, saved.body);
      assert.equal(saved.body.includes(TOKEN), false);
      const afterSave = JSON.parse(saved.body) as SettingsDoc;
      assert.notEqual(afterSave.revision, before.revision);
      assert.equal(afterSave.repos.web?.deliver, "pr");
      assert.equal(afterSave.repos.web?.base, "main");
      assert.equal(afterSave.repos.web?.prTitle, "[{issue}] {title}");
      assert.equal(afterSave.repos.web?.branch, "{issue}-{slug}");
      assert.equal(afterSave.repos.docs?.path, "~/code/docs");
      assert.equal(afterSave.maxAttempts, 4);
      assert.equal(afterSave.stallTimeoutMs, 60_000);
      assert.equal(afterSave.keepWorktrees, true);
      assert.equal(afterSave.maxFixRounds, 5);
      assert.equal(afterSave.sandbox?.mode, "docker");
      assert.deepEqual(afterSave.sandbox?.allowDomains, ["example.com"]);

      const again = JSON.parse((await text(`${server.url}/api/settings`)).body) as SettingsDoc;
      assert.equal(again.revision, afterSave.revision);
      assert.deepEqual(again.repos, afterSave.repos);
      assert.equal(again.maxAttempts, 4);
      assert.equal(again.keepWorktrees, true);
      assert.equal(again.sandbox?.mode, "docker");

      const file = JSON.parse(readFileSync(configPath, "utf8")) as {
        note: string;
        owner: string;
        adapter: string;
        maxConcurrent: number;
        keepWorktrees?: boolean;
        sandbox: { mode: string; image: string; allowDomains: string[] };
        workflows: { feature: { sandbox: { mode: string } } };
        repos: { web: { custom?: string; deliver?: string }; docs: { path: string } };
        jira: { apiToken: string };
      };
      assert.equal(file.note, "synthetic bench");
      assert.equal(file.owner, "synthetic");
      assert.equal(file.adapter, "mock");
      assert.equal(file.maxConcurrent, 2);
      assert.equal(file.keepWorktrees, true);
      assert.equal(file.sandbox.image, IMAGE);
      assert.equal(file.sandbox.mode, "docker");
      assert.deepEqual(file.sandbox.allowDomains, ["example.com"]);
      assert.equal(file.workflows.feature.sandbox.mode, "off");
      assert.equal(file.repos.web.custom, "keep-me");
      assert.equal(file.repos.web.deliver, "pr");
      assert.equal(file.repos.docs.path, "~/code/docs");
      assert.equal(file.jira.apiToken, TOKEN);

      const jobs = JSON.parse((await text(`${server.url}/api/jobs`)).body) as { repos: { name: string }[] };
      assert.deepEqual(
        jobs.repos.map((repo) => repo.name),
        ["docs", "web"],
      );
      assert.equal(server.output.stdout.includes(TOKEN), false);
      assert.equal(server.output.stderr.includes(TOKEN), false);
      assert.equal(server.output.stdout.includes(IMAGE), false);
    } finally {
      await stop(server.child);
    }
  });

  it("round-trips every overlay setting byte for byte, and ignores an echoed skills report", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-overlay-");
    mkdirSync(join(home, "plug", "skills", "foo"), { recursive: true });
    writeFileSync(join(home, "plug", "skills", "foo", "SKILL.md"), "# foo\n");
    const config = {
      ...seedConfig(),
      overlay: {
        workflows: "my-workflows",
        prompts: "my-prompts",
        skills: "~/my-skills",
        skillPaths: ["~/plug/skills", join(home, "missing")],
      },
    };
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(configPath, contents);
    const server = await startServe({ cwd, home });
    try {
      const csrf = csrfFrom((await text(`${server.url}/settings/workflows`)).body);
      const loaded = await text(`${server.url}/api/settings`);
      assert.equal(loaded.status, 200, loaded.body);
      const doc = JSON.parse(loaded.body) as SettingsDoc & {
        overlay: Record<string, unknown>;
        skillCheck: { skills: string[]; folders: { typed: string; exists: boolean }[] };
      };
      assert.deepEqual(doc.overlay, config.overlay);
      assert.deepEqual(doc.skillCheck.skills, ["foo"]);
      assert.deepEqual(
        doc.skillCheck.folders.map((folder) => [folder.typed, folder.exists]),
        [["~/my-skills", false], ["~/plug/skills", true], [join(home, "missing"), false]],
      );
      const saved = await putSettings(server.url, csrf, {
        revision: doc.revision,
        repos: doc.repos,
        adapter: "mock",
        maxConcurrent: 2,
        sandbox: { mode: "off", allowDomains: ["example.com"] },
        jira: { baseUrl: "https://example.atlassian.net", email: "dev@example.com", acceptanceField: "" },
        overlay: doc.overlay,
        skillCheck: doc.skillCheck,
      });
      assert.equal(saved.status, 200, saved.body);
      assert.equal(readFileSync(configPath, "utf8"), contents);
    } finally {
      await stop(server.child);
    }
  });

  it("rejects an invalid save with field errors and leaves the file unchanged", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-bad-");
    const server = await startServe({ cwd, home });
    try {
      const csrf = csrfFrom((await text(`${server.url}/`)).body);
      const before = JSON.parse((await text(`${server.url}/api/settings`)).body) as SettingsDoc;
      const original = readFileSync(configPath, "utf8");

      const missing = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: { web: { path: "~/code/missing" } },
      });
      assert.equal(missing.status, 400, missing.body);
      const missingBody = JSON.parse(missing.body) as { error: string; fields: Record<string, string> };
      assert.match(missingBody.fields["repos.web.path"] ?? "", /does not exist or is not a directory/);
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(missing.body.includes(TOKEN), false);

      const empty = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: { web: { path: "" } },
      });
      assert.equal(empty.status, 400, empty.body);
      assert.equal(JSON.parse(empty.body).fields["repos.web.path"], "Path is required.");
      assert.equal(readFileSync(configPath, "utf8"), original);

      const attempts = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: { web: { path: "~/code/web" } },
        maxAttempts: 0,
      });
      assert.equal(attempts.status, 400, attempts.body);
      assert.match(JSON.parse(attempts.body).fields.maxAttempts, /at least 1/);
      assert.equal(readFileSync(configPath, "utf8"), original);

      const token = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: { web: { path: "~/code/web" } },
        jira: { apiToken: SNEAKY },
      });
      assert.equal(token.status, 400, token.body);
      assert.match(JSON.parse(token.body).fields["jira.apiToken"] ?? "", /JIRA_API_TOKEN/);
      assert.equal(token.body.includes(SNEAKY), false);
      assert.equal(token.body.includes(TOKEN), false);
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(readFileSync(configPath, "utf8").includes(SNEAKY), false);
    } finally {
      await stop(server.child);
    }
  });

  it("rejects a missing CSRF token and a cross-origin write", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-csrf-");
    const server = await startServe({ cwd, home });
    try {
      const csrf = csrfFrom((await text(`${server.url}/`)).body);
      const before = JSON.parse((await text(`${server.url}/api/settings`)).body) as SettingsDoc;
      const original = readFileSync(configPath, "utf8");
      const body = JSON.stringify({
        revision: before.revision,
        repos: { web: { path: "~/code/docs", test: "npm test" } },
      });

      const missing = await text(`${server.url}/api/settings`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body,
      });
      assert.equal(missing.status, 403);
      assert.match(missing.body, /CSRF token rejected/);
      assert.equal(readFileSync(configPath, "utf8"), original);

      const evil = await putSettings(
        server.url,
        csrf,
        { revision: before.revision, repos: { web: { path: "~/code/docs" } } },
        { Origin: "http://evil.example" },
      );
      assert.equal(evil.status, 403);
      assert.match(evil.body, /Cross-origin request rejected/);
      assert.equal(readFileSync(configPath, "utf8"), original);

      const evilHost = await raw(`${server.url}/api/settings`, {
        method: "PUT",
        headers: {
          Host: "evil.example",
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Kiln-CSRF": csrf,
        },
        body,
      });
      assert.equal(evilHost.status, 403);
      assert.match(evilHost.body, /Cross-origin request rejected/);
      assert.equal(readFileSync(configPath, "utf8"), original);
    } finally {
      await stop(server.child);
    }
  });

  it("rejects a stale write with 409 and does not clobber the file", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-stale-");
    const server = await startServe({ cwd, home });
    try {
      const csrf = csrfFrom((await text(`${server.url}/`)).body);
      const before = JSON.parse((await text(`${server.url}/api/settings`)).body) as SettingsDoc;
      const disk = JSON.parse(readFileSync(configPath, "utf8")) as { note: string; repos: { web: { test?: string } } };
      disk.note = "edited on disk";
      writeFileSync(configPath, `${JSON.stringify(disk, null, 2)}\n`);

      const stale = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: {
          web: { path: "~/code/web", test: "npm run replaced" },
        },
        maxAttempts: 9,
      });
      assert.equal(stale.status, 409, stale.body);
      assert.match(stale.body, /changed on disk/);
      assert.equal(stale.body.includes(TOKEN), false);

      const file = JSON.parse(readFileSync(configPath, "utf8")) as {
        note: string;
        maxAttempts?: number;
        repos: { web: { test?: string } };
      };
      assert.equal(file.note, "edited on disk");
      assert.equal(file.repos.web.test, "npm test");
      assert.equal(file.maxAttempts, undefined);
    } finally {
      await stop(server.child);
    }
  });

  it("edits triggers, routes, jira, and the raw file without leaking the token", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-file-");
    const server = await startServe({ cwd, home });
    try {
      const page = await text(`${server.url}/settings`);
      const csrf = csrfFrom(page.body);
      const triggersPage = await text(`${server.url}/triggers`);
      assert.equal(triggersPage.body.includes("data-trigger-toggle"), false);
      assert.match(triggersPage.body, /<a href="\/settings\/triggers">Edit triggers in Settings/);
      const before = JSON.parse((await text(`${server.url}/api/settings`)).body) as SettingsDoc & {
        file: Record<string, unknown>;
      };
      assert.equal(JSON.stringify(before).includes(TOKEN), false);

      const saved = await putSettings(server.url, csrf, {
        revision: before.revision,
        repos: before.repos,
        maxConcurrent: 3,
        adapter: "mock",
        triggers: [{ id: "sample-ready", kind: "jira", repo: "web", every: "5m", label: "sample", status: "Ready" }],
        routes: [{ id: "sample-ready", trigger: "sample-ready", action: "create", workflow: "feature", repo: "web" }],
        jira: {
          baseUrl: "https://example.atlassian.net",
          email: "dev@example.com",
          acceptanceField: "customfield_10001",
        },
        overlay: { workflows: "workflows", skillPaths: ["/tmp/example-skills"] },
      });
      assert.equal(saved.status, 200, saved.body);
      assert.equal(saved.body.includes(TOKEN), false);
      const written = JSON.parse(readFileSync(configPath, "utf8")) as {
        owner: string;
        maxConcurrent: number;
        adapter: string;
        triggers: { id: string; every?: string }[];
        routes: { id: string }[];
        jira: { apiToken: string; acceptanceField: string; baseUrl: string };
        overlay: { workflows: string; skillPaths: string[] };
      };
      assert.equal(written.owner, "synthetic");
      assert.equal(written.maxConcurrent, 3);
      assert.equal(written.adapter, "mock");
      assert.equal(written.jira.apiToken, TOKEN);
      assert.equal(written.jira.baseUrl, "https://example.atlassian.net");
      assert.equal(written.jira.acceptanceField, "customfield_10001");
      assert.equal(written.triggers.some((item) => item.id === "sample-ready" && item.every === "5m"), true);
      assert.equal(written.routes.some((item) => item.id === "sample-ready"), true);
      assert.deepEqual(written.overlay.skillPaths, ["/tmp/example-skills"]);
      const savedDoc = JSON.parse(saved.body) as { revision: string; file: { jira?: { apiToken?: string } } };
      assert.equal(savedDoc.file.jira?.apiToken, "<redacted>");

      const broken = await text(`${server.url}/api/settings`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Kiln-CSRF": csrf,
        },
        body: "{",
      });
      assert.equal(broken.status, 400, broken.body);
      assert.match(broken.body, /not JSON/);
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).jira.apiToken, TOKEN);

      const current = JSON.parse((await text(`${server.url}/api/settings`)).body) as {
        revision: string;
        file: Record<string, unknown>;
      };
      const disk = JSON.parse(readFileSync(configPath, "utf8")) as { note?: string };
      disk.note = "on disk";
      writeFileSync(configPath, `${JSON.stringify(disk, null, 2)}\n`);
      const stale = await putSettings(server.url, csrf, { revision: current.revision, file: { ...current.file, note: "stale" } });
      assert.equal(stale.status, 409, stale.body);
      assert.equal(stale.body.includes(TOKEN), false);
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).note, "on disk");

      const fresh = JSON.parse((await text(`${server.url}/api/settings`)).body) as {
        revision: string;
        file: { jira?: { apiToken?: string }; maxConcurrent?: number };
      };
      assert.equal(JSON.stringify(fresh).includes(TOKEN), false);
      assert.equal(fresh.file.jira?.apiToken, "<redacted>");
      const round = await putSettings(server.url, csrf, {
        revision: fresh.revision,
        file: { ...fresh.file, maxConcurrent: 4 },
      });
      assert.equal(round.status, 200, round.body);
      assert.equal(round.body.includes(TOKEN), false);
      const afterRound = JSON.parse(readFileSync(configPath, "utf8")) as {
        maxConcurrent: number;
        note: string;
        jira: { apiToken: string };
        adapter: string;
      };
      assert.equal(afterRound.maxConcurrent, 4);
      assert.equal(afterRound.note, "on disk");
      assert.equal(afterRound.jira.apiToken, TOKEN);

      const planted = structuredClone(fresh.file) as { jira?: { apiToken?: string } };
      if (!planted.jira) planted.jira = {};
      planted.jira.apiToken = SNEAKY;
      const rejected = await putSettings(server.url, csrf, {
        revision: JSON.parse(round.body).revision as string,
        file: planted,
      });
      assert.equal(rejected.status, 400, rejected.body);
      assert.match(JSON.parse(rejected.body).fields["file.jira.apiToken"] ?? "", /JIRA_API_TOKEN/);
      assert.equal(rejected.body.includes(SNEAKY), false);
      assert.equal(rejected.body.includes(TOKEN), false);
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).jira.apiToken, TOKEN);

      const invalid = await putSettings(server.url, csrf, {
        revision: JSON.parse(round.body).revision as string,
        file: { ...fresh.file, adapter: "nope" },
      });
      assert.equal(invalid.status, 400, invalid.body);
      assert.ok(JSON.parse(invalid.body).fields.adapter);
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).adapter, afterRound.adapter);
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).jira.apiToken, TOKEN);
    } finally {
      await stop(server.child);
    }
  });
});

const SECTIONS = [
  ["repos", "Repos"],
  ["limits", "Limits and retries"],
  ["sandbox", "Sandbox"],
  ["triggers", "Triggers"],
  ["jira", "Jira"],
  ["workflows", "Local workflows and skills"],
  ["appearance", "Appearance"],
  ["file", "Edit the file"],
] as const;

/** Every control id the form had before the sections were split (repo editor, Global, Triggers, Routes, Jira, Overlay, Appearance, Advanced). */
const OLD_CONTROL_IDS = [
  "repo-editor", "repo-name", "repo-path", "repo-browse", "repo-browser", "repo-test", "repo-deliver", "repo-base",
  "repo-pr-title", "hint-pr-title", "repo-branch", "hint-branch", "repo-max-attempts", "repo-max-fix-rounds", "repo-done",
  "repo-list", "repo-add", "sandbox-mode", "sandbox-domains", "max-attempts", "hint-attempts", "stall-timeout", "hint-stall",
  "keep-worktrees", "max-fix-rounds", "hint-fix", "max-same-fingerprint", "hint-fingerprint", "daily-dollar-cap", "hint-cap",
  "max-concurrent", "hint-concurrent", "adapter-mode", "hint-adapter", "trigger-editor", "trigger-id", "trigger-enabled",
  "trigger-kind", "trigger-cron", "trigger-label", "trigger-max-new", "trigger-max-queued", "trigger-every", "trigger-jql",
  "trigger-jira-label", "trigger-status", "trigger-repo", "trigger-list", "route-editor", "route-id", "route-trigger",
  "route-action", "route-workflow", "route-repo", "route-list", "jira-base", "jira-email", "jira-acceptance", "jira-token",
  "overlay-workflows", "overlay-prompts", "overlay-skills", "overlay-skill-paths", "theme-pick", "settings-json",
  "advanced-hint", "advanced-errors",
];

function panes(html: string): Map<string, { hidden: boolean; body: string }> {
  const out = new Map<string, { hidden: boolean; body: string }>();
  for (const match of html.matchAll(/<section class="settings-pane[^"]*" id="settings-([a-z]+)"([^>]*)>([\s\S]*?)<\/section>/g)) {
    out.set(match[1] ?? "", { hidden: /\shidden/.test(match[2] ?? ""), body: match[3] ?? "" });
  }
  return out;
}

describe("settings sections", () => {
  it("serves each section at its own address and 404s anything else", async () => {
    const { cwd, home } = workDir("kiln-settings-sections-");
    const server = await startServe({ cwd, home });
    try {
      const cases: [string, string][] = [["/settings", "repos"], ...SECTIONS.map(([id]) => [`/settings/${id}`, id] as [string, string])];
      for (const [path, open] of cases) {
        const page = await text(`${server.url}${path}`);
        assert.equal(page.status, 200, path);
        assert.equal(page.body.includes("data-settings-tab"), false, path);
        assert.equal(page.body.includes('role="tablist"'), false, path);
        assert.equal(page.body.includes("form-footer\"><button type=\"submit\" class=\"btn primary\">Save<"), false, path);
        const nav = page.body.slice(page.body.indexOf('<nav class="settings-nav"'), page.body.indexOf("</nav>", page.body.indexOf('<nav class="settings-nav"')));
        assert.match(nav, /aria-label="Settings sections"/);
        const links = [...nav.matchAll(/<a href="\/settings\/([a-z]+)"( aria-current="page")?><span>([^<]+)<\/span>/g)];
        assert.deepEqual(
          links.map((link) => [link[1], link[3]]),
          SECTIONS.map(([id, title]) => [id, title]),
          path,
        );
        assert.deepEqual(
          links.filter((link) => link[2]).map((link) => link[1]),
          [open],
          path,
        );
        const found = panes(page.body);
        assert.deepEqual([...found.keys()], SECTIONS.map(([id]) => id), path);
        assert.deepEqual(
          [...found].filter(([, pane]) => !pane.hidden).map(([id]) => id),
          [open],
          path,
        );
        assert.match(found.get(open)?.body ?? "", new RegExp(`<h2 id="settings-${open}-title">`));
        assert.match(page.body, /id="settings-unsaved" role="status" hidden/);
        assert.match(page.body, /<button type="button" class="btn" id="settings-discard">Discard<\/button>/);
        assert.match(page.body, /<button type="submit" class="btn primary" id="settings-save">Save changes<\/button>/);
        assert.equal(page.body.includes(TOKEN), false, path);
      }
      for (const path of ["/settings/global", "/settings/routes", "/settings/overlay", "/settings/advanced", "/settings/nope", "/settings/repos/x"]) {
        const page = await text(`${server.url}${path}`);
        assert.equal(page.status, 404, path);
      }

      const page = await text(`${server.url}/settings/limits`);
      const found = panes(page.body);
      for (const id of OLD_CONTROL_IDS) {
        const owners = [...found].filter(([, pane]) => pane.body.includes(`id="${id}"`)).map(([section]) => section);
        assert.equal(owners.length, 1, `${id} is in ${owners.join(", ") || "no pane"}`);
        assert.equal(page.body.split(`id="${id}"`).length - 1, 1, id);
      }
      assert.match(found.get("limits")?.body ?? "", /id="stall-timeout"/);
      assert.match(found.get("limits")?.body ?? "", /Stall timeout \(ms\)/);
      assert.match(found.get("sandbox")?.body ?? "", /id="sandbox-domains"/);
      const triggers = found.get("triggers")?.body ?? "";
      assert.ok(triggers.indexOf('id="trigger-list"') < triggers.indexOf("<h3>Routes</h3>"));
      assert.ok(triggers.indexOf("<h3>Routes</h3>") < triggers.indexOf('id="route-list"'));
    } finally {
      await stop(server.child);
    }
  });

  it("shows repo and trigger counts and the Jira state, never the token", async () => {
    const { cwd, home, configPath } = workDir("kiln-settings-facts-");
    const server = await startServe({ cwd, home });
    try {
      const page = await text(`${server.url}/settings/jira`);
      assert.equal(page.body.includes(TOKEN), false);
      assert.match(page.body, /<span class="settings-fact" data-settings-fact="repos">1<\/span>/);
      // No file triggers: the two built-ins.
      assert.match(page.body, /<span class="settings-fact" data-settings-fact="triggers">2<\/span>/);
      assert.match(page.body, /<span class="settings-fact" data-settings-fact="jira" data-state="connected">connected<\/span>/);

      const config = JSON.parse(readFileSync(configPath, "utf8")) as { jira: Record<string, string> };
      delete config.jira.email;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const after = await text(`${server.url}/settings/jira`);
      assert.match(after.body, /<span class="settings-fact" data-settings-fact="jira">not set up<\/span>/);
      assert.equal(after.body.includes(TOKEN), false);
    } finally {
      await stop(server.child);
    }
  });

  it("calls Jira connected only with a base URL, an email, and a token", () => {
    const all = { baseUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "SAMPLE-TOKEN-PLACEHOLDER" };
    assert.equal(jiraFact(all), "connected");
    assert.equal(jiraFact({ ...all, apiToken: undefined }, "SAMPLE-ENV-TOKEN"), "connected");
    assert.equal(jiraFact({ ...all, baseUrl: undefined }), "not set up");
    assert.equal(jiraFact({ ...all, email: "  " }), "not set up");
    assert.equal(jiraFact({ ...all, apiToken: undefined }), "not set up");
    assert.equal(jiraFact({ ...all, apiToken: undefined }, ""), "not set up");
    assert.equal(jiraFact(undefined), "not set up");
  });

  it("renders the open section and the facts it is given", () => {
    const html = renderApp({
      css: "",
      section: "settings",
      board: buildBoard([], []),
      attention: buildAttention([]),
      page: { csrf: "abc", repos: [], workflows: [] },
      settingsSection: "sandbox",
      settingsFacts: { repos: 0, triggers: 2, jira: "not set up" },
    });
    assert.match(html, /<a href="\/settings\/sandbox" aria-current="page">/);
    assert.match(html, /data-settings-fact="jira">not set up</);
  });
});
