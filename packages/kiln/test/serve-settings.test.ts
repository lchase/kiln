import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

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
      const page = await text(`${server.url}/`);
      assert.equal(page.status, 200);
      assert.match(page.body, /id="open-settings"/);
      assert.match(page.body, /id="settings"/);
      assert.match(page.body, /id="repo-add"/);
      assert.match(page.body, /renders as \[ABC-123\] Title/);
      assert.match(page.body, /renders as ABC-123-slug/);
      assert.equal(page.body.includes(TOKEN), false);
      const csrf = csrfFrom(page.body);

      const loaded = await text(`${server.url}/api/settings`);
      assert.equal(loaded.status, 200, loaded.body);
      assert.equal(loaded.body.includes(TOKEN), false);
      assert.equal(loaded.body.includes(IMAGE), false);
      assert.equal(loaded.body.includes("apiToken"), false);
      assert.equal(loaded.body.includes("keep-me"), false);
      const before = JSON.parse(loaded.body) as SettingsDoc;
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
        maxFixRounds: 5,
        sandbox: { mode: "docker", allowDomains: ["example.com"] },
      });
      assert.equal(saved.status, 200, saved.body);
      assert.equal(saved.body.includes(TOKEN), false);
      assert.equal(saved.body.includes(IMAGE), false);
      assert.equal(saved.body.includes("apiToken"), false);
      const afterSave = JSON.parse(saved.body) as SettingsDoc;
      assert.notEqual(afterSave.revision, before.revision);
      assert.equal(afterSave.repos.web?.deliver, "pr");
      assert.equal(afterSave.repos.web?.base, "main");
      assert.equal(afterSave.repos.web?.prTitle, "[{issue}] {title}");
      assert.equal(afterSave.repos.web?.branch, "{issue}-{slug}");
      assert.equal(afterSave.repos.docs?.path, "~/code/docs");
      assert.equal(afterSave.maxAttempts, 4);
      assert.equal(afterSave.stallTimeoutMs, 60_000);
      assert.equal(afterSave.maxFixRounds, 5);
      assert.equal(afterSave.sandbox?.mode, "docker");
      assert.deepEqual(afterSave.sandbox?.allowDomains, ["example.com"]);

      const again = JSON.parse((await text(`${server.url}/api/settings`)).body) as SettingsDoc;
      assert.equal(again.revision, afterSave.revision);
      assert.deepEqual(again.repos, afterSave.repos);
      assert.equal(again.maxAttempts, 4);
      assert.equal(again.sandbox?.mode, "docker");

      const file = JSON.parse(readFileSync(configPath, "utf8")) as {
        note: string;
        owner: string;
        adapter: string;
        maxConcurrent: number;
        sandbox: { mode: string; image: string; allowDomains: string[] };
        workflows: { feature: { sandbox: { mode: string } } };
        repos: { web: { custom?: string; deliver?: string }; docs: { path: string } };
        jira: { apiToken: string };
      };
      assert.equal(file.note, "synthetic bench");
      assert.equal(file.owner, "synthetic");
      assert.equal(file.adapter, "mock");
      assert.equal(file.maxConcurrent, 2);
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
      assert.equal(JSON.parse(token.body).fields.jira, "Unknown field.");
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
});
