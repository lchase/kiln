import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addRepo, loadKilnConfig, resolveKilnConfig } from "../src/config.js";
import { KilnConfigError } from "../src/errors.js";
import { jobBasename, packageRoot } from "../src/paths.js";

const root = packageRoot();

describe("kiln config", () => {
  it("resolves a relative repo path from the config directory and accepts any repo name", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cfg-"));
    const configDir = join(cwd, ".kiln");
    const checkout = join(cwd, "repos", "web");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "kiln.config.json"),
      JSON.stringify({
        adapter: "mock",
        repos: { web: { path: "../repos/web", test: "npm test" } },
      }),
    );
    try {
      const loaded = loadKilnConfig(join(configDir, "kiln.config.json"), { cwd });
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

  it("prefers .kiln in the working directory over ~/.kiln", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      writeLocal(join(cwd, ".kiln"), "from-cwd");
      writeLocal(join(home, ".kiln"), "from-home");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.match(loaded.note ?? "", /from-cwd/);
      assert.equal(loaded.jobsDir, join(cwd, ".kiln", "jobs"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses ~/.kiln when the working directory has no config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      writeLocal(join(home, ".kiln"), "from-home");
      const loaded = resolveKilnConfig({ cwd, home });
      assert.match(loaded.note ?? "", /from-home/);
      assert.equal(loaded.kilnDir, join(home, ".kiln"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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
        assert.match(error instanceof Error ? error.message : "", /kiln repo add/);
        assert.doesNotMatch(error instanceof Error ? error.message : "", /three checkout/);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes jobs under cwd/.kiln when the config file is not inside a .kiln directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const configDir = join(cwd, "elsewhere");
    const checkout = join(cwd, "repo");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "kiln.config.json"),
      JSON.stringify({ repos: { web: { path: checkout } } }),
    );
    try {
      const loaded = loadKilnConfig(join(configDir, "kiln.config.json"), { cwd });
      assert.equal(loaded.kilnDir, join(cwd, ".kiln"));
      assert.equal(loaded.jobsDir, join(cwd, ".kiln", "jobs"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stores a relative path from repo add and keeps an existing test command", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-add-"));
    const home = join(cwd, "home");
    const checkout = join(cwd, "repos", "web");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });
    try {
      const first = addRepo({ cwd, home, name: "web", repoPath: "repos/web", test: "npm test" });
      assert.match(first, new RegExp(checkout));
      const configPath = join(cwd, ".kiln", "kiln.config.json");
      const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
        repos: { web: { path: string; test?: string } };
      };
      assert.equal(stored.repos.web.path, "../repos/web");
      assert.equal(stored.repos.web.test, "npm test");
      addRepo({ cwd, home, name: "web", repoPath: checkout });
      const updated = JSON.parse(readFileSync(configPath, "utf8")) as {
        repos: { web: { path: string; test?: string } };
      };
      assert.equal(updated.repos.web.path, checkout);
      assert.equal(updated.repos.web.test, "npm test");
    } finally {
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

  it("gitignores the local kiln directory", () => {
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
