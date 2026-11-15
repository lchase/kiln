import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { formatServeStartup, runtimeVersions } from "../src/version.js";

const keep: string[] = [];
const children: ChildProcess[] = [];

const SECRETS: Record<string, string> = {
  JIRA_API_TOKEN: "jira-env-token-value",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-oauth-secret-value",
  GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz012345",
};
const CONFIG_TOKEN = "jira-config-token-value";

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function kilnVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

describe("startup banner", () => {
  it("reads the kiln package version and reports unknown when yak cannot be resolved", () => {
    assert.equal(runtimeVersions().kiln, kilnVersion());
    assert.equal(
      runtimeVersions({
        resolveYak() {
          throw new Error("missing");
        },
      }).yak,
      "unknown",
    );
  });

  it("includes version, home, url, tick, and plural overlay counts", () => {
    const text = formatServeStartup({
      node: process.version,
      home: "/tmp/kiln-home",
      url: "http://127.0.0.1:4100",
      tickSeconds: 30,
      paused: false,
      sandbox: "off",
      overlay: { workflows: 1, promptOverrides: 2, skillDirs: 1 },
    });
    assert.match(text, new RegExp(`^kiln ${kilnVersion()}\\nyak ${runtimeVersions().yak}\\n`));
    assert.match(text, /home \/tmp\/kiln-home\nlistening http:\/\/127\.0\.0\.1:4100\n/);
    assert.match(text, /tick every 30s, running, sandbox off\nlocal 1 workflow, 2 prompt overrides, 1 skill dir\n$/);
  });

  it("prints real overlay counts from kiln serve and no config token", async () => {
    const parent = mkdtempSync(join(tmpdir(), "kiln-serve-"));
    keep.push(parent);
    const kilnDir = join(parent, "kiln");
    const checkout = join(parent, "sample-repo");
    mkdirSync(join(kilnDir, "workflows"), { recursive: true });
    mkdirSync(join(kilnDir, "prompts", "kiln"), { recursive: true });
    mkdirSync(join(kilnDir, "skills", "demo"), { recursive: true });
    mkdirSync(checkout);
    mkdirSync(join(parent, "home"));
    writeFileSync(join(kilnDir, "workflows", "spike.yaml"), "name: spike\n");
    writeFileSync(join(kilnDir, "prompts", "kiln", "review.md"), "Local review.\n");
    writeFileSync(join(kilnDir, "prompts", "kiln", "build.md"), "Local build.\n");
    writeFileSync(join(kilnDir, "prompts", "kiln", "notes.txt"), "not a prompt\n");
    writeFileSync(join(kilnDir, "skills", "demo", "SKILL.md"), "name: demo\n");
    writeFileSync(
      join(kilnDir, "kiln.config.json"),
      `${JSON.stringify({
        adapter: "mock",
        jira: { baseUrl: "https://example.test", email: "dev@example.test", apiToken: CONFIG_TOKEN },
        repos: { sample: { path: checkout, test: "npm test" } },
      })}\n`,
    );

    const stdout = await serveStdout(kilnDir, {
      ...process.env,
      HOME: join(parent, "home"),
      KILN_HOME: kilnDir,
      ...SECRETS,
    });
    assert.match(stdout, new RegExp(`^kiln ${kilnVersion()}\\n`));
    assert.match(stdout, new RegExp(`home ${kilnDir}\nlistening http://127\\.0\\.0\\.1:\\d+\n`));
    assert.match(stdout, /tick every 30s, running, sandbox off\nlocal 1 workflow, 2 prompt overrides, 1 skill dir\n$/);
    assert.equal(stdout.includes(CONFIG_TOKEN), false);
    assert.equal(stdout.includes("[redacted]"), false);
    for (const [key, value] of Object.entries(SECRETS)) {
      assert.equal(stdout.includes(key), false, key);
      assert.equal(stdout.includes(value), false, key);
    }
  });
});

function serveStdout(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(process.execPath, [join(packageRoot(), "dist", "cli.js"), "serve", "--port", "0"], {
    cwd,
    env,
  });
  children.push(child);
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error(`serve did not listen\n${stdout}`))), 10_000);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes("\nlocal ")) return;
      child.kill("SIGTERM");
      finish(() => resolve(stdout));
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => finish(() => reject(new Error(`serve exited ${code}\n${stdout}`))));
  });
}
