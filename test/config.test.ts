import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addRepo, loadKilnConfig, renderRepoList, resolveKilnConfig } from "../src/config.js";
import { KilnConfigError } from "../src/errors.js";
import { writeJob } from "../src/jobs.js";
import { jobBasename, packageRoot } from "../src/paths.js";

const root = packageRoot();

delete process.env.KILN_HOME;

describe("kiln config", { concurrency: 1 }, () => {
  it("resolves a relative repo path from the config directory and accepts any repo name", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cfg-"));
    const home = join(cwd, "home");
    const configDir = join(cwd, ".kiln");
    const checkout = join(cwd, "repos", "web");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "kiln.config.json"),
      JSON.stringify({
        adapter: "mock",
        repos: { web: { path: "../repos/web", test: "npm test" } },
      }),
    );
    try {
      const loaded = loadKilnConfig(join(configDir, "kiln.config.json"), { cwd, home });
      assert.equal(loaded.repos.web?.path, checkout);
      assert.equal(loaded.repos.web?.test, "npm test");
      assert.equal(loaded.kilnDir, configDir);
      assert.equal(loaded.jobsDir, join(configDir, "jobs"));
      assert.equal(loaded.adapter, "mock");
      assert.equal("frontend" in loaded.repos, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("expands ~ in a repo path", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const checkout = join(home, "checkouts", "api");
    mkdirSync(checkout, { recursive: true });
    const configDir = join(home, ".kiln");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "kiln.config.json"),
      JSON.stringify({ repos: { api: { path: "~/checkouts/api" } } }),
    );
    try {
      const loaded = loadKilnConfig(join(configDir, "kiln.config.json"), { cwd, home });
      assert.equal(loaded.repos.api?.path, checkout);
      assert.equal(loaded.repos.api?.test, undefined);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses ~/.kiln from any working directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      writeLocal(join(home, ".kiln"), "from-home");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.match(loaded.note ?? "", /from-home/);
      assert.equal(loaded.kilnDir, join(home, ".kiln"));
      assert.equal(loaded.jobsDir, join(home, ".kiln", "jobs"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sees the same registry and jobs from two working directories", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    const dirA = mkdtempSync(join(tmpdir(), "kiln-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "kiln-b-"));
    const checkout = join(dirA, "web");
    mkdirSync(checkout, { recursive: true });
    try {
      addRepo({ cwd: dirA, home, name: "web", repoPath: "web", test: "npm test" });
      const fromA = resolveKilnConfig({ cwd: dirA, home });
      const written = writeJob(fromA, {
        workflow: "feature",
        repo: "web",
        specText: "# Show the summary\n\nA person can read it.\n",
        title: "Sunday summary",
        dependsOn: [],
        source: { kind: "prompt", ref: "inline" },
      });
      const fromB = resolveKilnConfig({ cwd: dirB, home });
      assert.equal(fromA.configPath, fromB.configPath);
      assert.equal(fromA.kilnDir, join(home, ".kiln"));
      assert.equal(fromB.kilnDir, fromA.kilnDir);
      assert.equal(fromB.jobsDir, fromA.jobsDir);
      assert.equal(fromB.repos.web?.path, checkout);
      assert.equal(fromB.repos.web?.test, "npm test");
      const stored = JSON.parse(readFileSync(fromB.configPath, "utf8")) as {
        repos: { web: { path: string } };
      };
      assert.equal(stored.repos.web.path, checkout);
      assert.equal(readFileSync(join(fromB.jobsDir, `${written.job.id}.json`), "utf8").includes(written.job.id), true);
      assert.equal(existsSync(join(dirA, ".kiln")), false);
      assert.equal(existsSync(join(dirB, ".kiln")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("errors with a migration hint when ./.kiln exists and the home config does not", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    const checkout = join(cwd, "web");
    mkdirSync(checkout, { recursive: true });
    try {
      writeLocal(join(cwd, ".kiln"), "stale");
      assert.throws(() => resolveKilnConfig({ cwd, home }), KilnConfigError);
      try {
        resolveKilnConfig({ cwd, home });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /mv \.\/\.kiln ~\/\.kiln/);
        assert.match(message, /--config/);
        assert.match(message, /KILN_HOME/);
        assert.equal(message.includes("\n"), false);
      }
      assert.throws(() => addRepo({ cwd, home, name: "web", repoPath: checkout }), /mv \.\/\.kiln ~\/\.kiln/);
      assert.equal(existsSync(join(home, ".kiln", "kiln.config.json")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("loads --config even when ./.kiln exists and the home config does not", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    const configDir = join(cwd, "custom");
    try {
      writeLocal(join(cwd, ".kiln"), "stale");
      writeLocal(configDir, "explicit");
      const loaded = resolveKilnConfig({
        cwd,
        home,
        configPath: join(configDir, "kiln.config.json"),
      });
      assert.match(loaded.note ?? "", /explicit/);
      assert.equal(loaded.kilnDir, configDir);
      assert.equal(existsSync(join(home, ".kiln", "kiln.config.json")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a leftover ./.kiln when the home config already exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      writeLocal(join(cwd, ".kiln"), "from-cwd");
      writeLocal(join(home, ".kiln"), "from-home");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.match(loaded.note ?? "", /from-home/);
      assert.equal(loaded.kilnDir, join(home, ".kiln"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lets KILN_HOME override ~/.kiln", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    const kilnHome = mkdtempSync(join(tmpdir(), "kiln-env-"));
    const previous = process.env.KILN_HOME;
    process.env.KILN_HOME = kilnHome;
    try {
      writeLocal(join(home, ".kiln"), "from-home");
      writeLocal(kilnHome, "from-env");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.match(loaded.note ?? "", /from-env/);
      assert.equal(loaded.kilnDir, kilnHome);
      assert.equal(loaded.configPath, join(kilnHome, "kiln.config.json"));
      const elsewhere = mkdtempSync(join(tmpdir(), "kiln-else-"));
      try {
        const again = resolveKilnConfig({ cwd: elsewhere, home });
        assert.equal(again.configPath, loaded.configPath);
        assert.match(again.note ?? "", /from-env/);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.KILN_HOME;
      else process.env.KILN_HOME = previous;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(kilnHome, { recursive: true, force: true });
    }
  });

  it("refuses to run when no config exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      assert.throws(() => resolveKilnConfig({ cwd, home }), KilnConfigError);
      try {
        resolveKilnConfig({ cwd, home });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /kiln repo add/);
        assert.match(message, new RegExp(escapeRegExp(join(home, ".kiln", "kiln.config.json"))));
        assert.doesNotMatch(message, /three checkout/);
        assert.doesNotMatch(message, /\.\/\.kiln/);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps jobs next to the config file when that directory is not named .kiln", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = join(cwd, "home");
    const configDir = join(cwd, "elsewhere");
    const checkout = join(cwd, "repo");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "kiln.config.json"),
      JSON.stringify({ repos: { web: { path: checkout } } }),
    );
    try {
      const loaded = loadKilnConfig(join(configDir, "kiln.config.json"), { cwd, home });
      assert.equal(loaded.kilnDir, configDir);
      assert.equal(loaded.jobsDir, join(configDir, "jobs"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stores an absolute path from repo add and keeps an existing test command", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-add-"));
    const home = join(cwd, "home");
    const checkout = join(cwd, "repos", "web");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });
    try {
      const first = addRepo({ cwd, home, name: "web", repoPath: "repos/web", test: "npm test" });
      assert.match(first, new RegExp(escapeRegExp(checkout)));
      assert.match(first, /deliver local/);
      assert.match(first, /Change delivery with: kiln repo add web repos\/web --deliver pr --base main/);
      const configPath = join(home, ".kiln", "kiln.config.json");
      const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
        repos: { web: { path: string; test?: string; deliver?: string; prTitle?: string; branch?: string } };
      };
      assert.equal(stored.repos.web.path, checkout);
      assert.equal(stored.repos.web.test, "npm test");
      assert.equal(stored.repos.web.deliver, undefined);
      assert.equal(existsSync(join(cwd, ".kiln")), false);
      stored.repos.web.prTitle = "{issue} / {title}";
      stored.repos.web.branch = "{issue}/{slug}";
      writeFileSync(configPath, `${JSON.stringify(stored, null, 2)}\n`);
      const switched = addRepo({ cwd, home, name: "web", repoPath: checkout, deliver: "pr", base: "main" });
      assert.match(switched, /deliver pr/);
      assert.match(switched, /Change delivery with: kiln repo add web .+ --deliver local/);
      const updated = JSON.parse(readFileSync(configPath, "utf8")) as {
        repos: { web: { path: string; test?: string; deliver?: string; prTitle?: string; branch?: string } };
      };
      assert.equal(updated.repos.web.path, checkout);
      assert.equal(updated.repos.web.test, "npm test");
      assert.equal(updated.repos.web.deliver, "pr");
      assert.equal(updated.repos.web.prTitle, "{issue} / {title}");
      assert.equal(updated.repos.web.branch, "{issue}/{slug}");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.match(renderRepoList(loaded), /web {2}\S+ {2}test npm test {2}deliver pr {2}base main {2}prTitle \{issue\} \/ \{title\} {2}branch \{issue\}\/\{slug\}/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stores a ~ repo path and expands it when the config is read", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-tilde-"));
    const cwd = mkdtempSync(join(tmpdir(), "kiln-tilde-cwd-"));
    const checkout = join(home, "src", "api");
    mkdirSync(checkout, { recursive: true });
    try {
      const added = addRepo({ cwd, home, name: "api", repoPath: "~/src/api" });
      assert.match(added, new RegExp(escapeRegExp(checkout)));
      const stored = JSON.parse(readFileSync(join(home, ".kiln", "kiln.config.json"), "utf8")) as {
        repos: { api: { path: string } };
      };
      assert.equal(stored.repos.api.path, "~/src/api");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.equal(loaded.repos.api?.path, checkout);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a repo name that is not a single path segment", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-name-"));
    try {
      assert.throws(() => addRepo({ cwd, home: cwd, name: "../web", repoPath: cwd }), /Repo name/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("turns a job id into one safe path segment", () => {
    assert.equal(jobBasename("../job-1"), "job-1");
    assert.throws(() => jobBasename(".."), /cannot be used as a file name/);
  });

  it("gitignores a leftover local kiln directory", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.kiln\/$/m);
  });
});

function writeLocal(dir: string, note: string): void {
  const checkout = join(dir, "repo");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(
    join(dir, "kiln.config.json"),
    JSON.stringify({ note, repos: { web: { path: checkout } } }),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
