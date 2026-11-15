import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { formatServeStartup, formatVersionReport, runtimeVersions } from "../src/version.js";
import { overlayLoadCounts } from "../src/workflow.js";

const keep: string[] = [];
const children: ChildProcess[] = [];

const SECRETS = {
  JIRA_API_TOKEN: "jira-env-token-value",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-oauth-secret-value",
  ANTHROPIC_API_KEY: "sk-ant-api03-anthropic-secret-value",
  GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz012345",
  GH_TOKEN: "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
} as const;

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("runtime versions", () => {
  it("reads the kiln package.json and the resolved yak package.json", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
    const require = createRequire(import.meta.url);
    const yak = JSON.parse(readFileSync(require.resolve("@lchase/yak/package.json"), "utf8")) as { version: string };
    const versions = runtimeVersions();
    assert.equal(versions.kiln, pkg.version);
    assert.equal(versions.yak, yak.version);
    assert.equal(formatVersionReport(), `kiln ${pkg.version}\nyak ${yak.version}\n`);

    assert.equal(
      runtimeVersions({
        resolveYak() {
          throw new Error("missing");
        },
      }).yak,
      "unknown",
    );
    const dir = mkdtempSync(join(tmpdir(), "kiln-version-"));
    keep.push(dir);
    assert.equal(runtimeVersions({ resolveYak: () => join(dir, "missing.json") }).yak, "unknown");
    const bare = join(dir, "package.json");
    writeFileSync(bare, "{}\n");
    assert.equal(runtimeVersions({ resolveYak: () => bare }).yak, "unknown");
    writeFileSync(bare, `${JSON.stringify({ version: "9.9.9" })}\n`);
    assert.equal(runtimeVersions({ resolveYak: () => bare }).yak, "9.9.9");
  });
});

describe("serve startup banner", () => {
  it("starts with the version report and includes the home and board URL", () => {
    const versions = { kiln: "1.2.3", yak: "9.9.9" };
    const text = formatServeStartup({
      versions,
      node: "v22.0.0",
      home: "/tmp/kiln-home",
      url: "http://127.0.0.1:4100",
      tickSeconds: 15,
      paused: true,
      sandbox: "docker",
    });
    assert.equal(text.startsWith(formatVersionReport(versions)), true);
    assert.equal(
      text,
      [
        "kiln 1.2.3",
        "yak 9.9.9",
        "node v22.0.0",
        "home /tmp/kiln-home",
        "listening http://127.0.0.1:4100",
        "tick every 15s, paused, sandbox docker",
        "",
      ].join("\n"),
    );
  });

  it("counts an empty overlay and leaves the line off when the feature is absent", () => {
    const base = {
      versions: { kiln: "1.2.3", yak: "unknown" },
      node: "v22.0.0",
      home: "/tmp/kiln-home",
      url: "http://127.0.0.1:4100",
      paused: false,
      sandbox: "off" as const,
    };
    const counted = formatServeStartup({
      ...base,
      overlay: { workflows: 1, promptOverrides: 1, skillDirs: 1 },
    });
    assert.match(counted, /tick off, running, sandbox off\nlocal 1 workflow, 1 prompt override, 1 skill dir\n$/);
    const empty = formatServeStartup({
      ...base,
      overlay: { workflows: 0, promptOverrides: 0, skillDirs: 0 },
    });
    assert.match(empty, /local 0 workflows, 0 prompt overrides, 0 skill dirs\n$/);
    const absent = formatServeStartup(base);
    assert.equal(absent.includes("local "), false);
  });

  it("does not include environment secret values", () => {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(SECRETS)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
      const home = "/tmp/kiln-home";
      const text = formatServeStartup({
        node: process.version,
        home,
        url: "http://127.0.0.1:4100",
        tickSeconds: 30,
        paused: false,
        sandbox: "off",
        overlay: { workflows: 0, promptOverrides: 0, skillDirs: 0 },
      });
      assert.match(text, new RegExp(`^kiln ${pkg.version}\\n`));
      assert.match(text, new RegExp(`^yak ${runtimeVersions().yak}\\n`, "m"));
      assert.match(text, new RegExp(`home ${home}\\n`));
      assert.match(text, /listening http:\/\/127\.0\.0\.1:4100\n/);
      assert.equal(text.startsWith(formatVersionReport()), true);
      for (const [key, value] of Object.entries(SECRETS)) {
        assert.equal(text.includes(key), false, key);
        assert.equal(text.includes(value), false, key);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("overlay counts", () => {
  it("counts local workflow files, prompt files, and skill directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-overlay-count-"));
    keep.push(dir);
    const workflows = join(dir, "workflows");
    const prompts = join(dir, "prompts");
    const skills = join(dir, "skills");
    mkdirSync(join(prompts, "kiln"), { recursive: true });
    mkdirSync(workflows);
    mkdirSync(join(skills, "demo"), { recursive: true });
    writeFileSync(join(workflows, "spike.yaml"), "name: spike\n");
    writeFileSync(join(workflows, "feature.yaml"), "name: feature\n");
    writeFileSync(join(workflows, ".hidden.yaml"), "name: hidden\n");
    writeFileSync(join(workflows, "not a name.yaml"), "nope\n");
    writeFileSync(join(prompts, "kiln", "review.md"), "Local review.\n");
    writeFileSync(join(prompts, "kiln", "notes.txt"), "skip\n");
    writeFileSync(join(prompts, "README.md"), "skip\n");
    writeFileSync(join(skills, "demo", "SKILL.md"), "name: demo\n");
    const review = join(dir, "other-review.md");
    writeFileSync(review, "Operator review.\n");

    assert.deepEqual(
      overlayLoadCounts(
        { workflowsDir: workflows, promptsDir: prompts, skillDirs: [skills, join(dir, "also-skills")] },
        review,
      ),
      { workflows: 2, promptOverrides: 1, skillDirs: 2 },
    );

    const emptyPrompts = join(dir, "empty-prompts");
    mkdirSync(emptyPrompts);
    assert.equal(
      overlayLoadCounts(
        { workflowsDir: join(dir, "missing-workflows"), promptsDir: emptyPrompts, skillDirs: [] },
        review,
      ).promptOverrides,
      1,
    );
    writeFileSync(join(dir, "not-a-dir"), "x\n");
    assert.equal(
      overlayLoadCounts({ workflowsDir: workflows, promptsDir: join(dir, "not-a-dir"), skillDirs: [] }).promptOverrides,
      0,
    );
    assert.deepEqual(
      overlayLoadCounts({
        workflowsDir: join(dir, "missing-workflows"),
        promptsDir: join(dir, "missing-prompts"),
        skillDirs: [],
      }),
      { workflows: 0, promptOverrides: 0, skillDirs: 0 },
    );
  });
});

describe("kiln serve startup", () => {
  it("prints the banner with version, home, and URL and no secret values", async () => {
    const parent = mkdtempSync(join(tmpdir(), "kiln-serve-startup-"));
    keep.push(parent);
    const kilnDir = join(parent, "kiln");
    const checkout = join(parent, "sample-repo");
    const home = join(parent, "home");
    mkdirSync(join(kilnDir, "workflows"), { recursive: true });
    mkdirSync(join(kilnDir, "prompts", "kiln"), { recursive: true });
    mkdirSync(join(kilnDir, "skills", "demo"), { recursive: true });
    mkdirSync(checkout);
    mkdirSync(home);
    writeFileSync(join(kilnDir, "workflows", "spike.yaml"), "name: spike\n");
    writeFileSync(join(kilnDir, "prompts", "kiln", "review.md"), "Local review.\n");
    writeFileSync(join(kilnDir, "prompts", "README.md"), "not a prompt\n");
    writeFileSync(join(kilnDir, "skills", "demo", "SKILL.md"), "name: demo\n");
    const configToken = "jira-config-token-value";
    writeFileSync(
      join(kilnDir, "kiln.config.json"),
      `${JSON.stringify(
        {
          adapter: "mock",
          jira: { baseUrl: "https://example.test", email: "dev@example.test", apiToken: configToken },
          repos: { sample: { path: checkout, test: "npm test" } },
        },
        null,
        2,
      )}\n`,
    );

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      KILN_HOME: kilnDir,
      ...SECRETS,
    };
    const output = await runServe(kilnDir, childEnv);
    const url = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(url, output.stdout);
    const expected = formatServeStartup({
      node: process.version,
      home: kilnDir,
      url,
      paused: false,
      sandbox: "off",
      overlay: { workflows: 1, promptOverrides: 1, skillDirs: 1 },
    });
    assert.equal(output.stdout, expected);
    assert.equal(output.stdout.startsWith(formatVersionReport()), true);
    assert.equal(output.stdout.includes(configToken), false);
    for (const value of Object.values(SECRETS)) assert.equal(output.stdout.includes(value), false);
    await stop(output.child);
  });
});

function runServe(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [join(packageRoot(), "dist", "cli.js"), "serve", "--port", "0", "--no-tick"], {
    cwd,
    env,
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`serve did not listen\n${stdout}\n${stderr}`)));
    }, 10_000);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (/listening http:\/\/127\.0\.0\.1:\d+/.test(stdout) && stdout.includes("\nlocal ")) {
        finish(() => resolve({ stdout, stderr, child }));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => reject(new Error(`serve exited ${code}\n${stdout}\n${stderr}`)));
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
