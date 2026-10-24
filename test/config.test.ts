import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadKilnConfig, resolveKilnConfig } from "../src/config.js";
import { KilnConfigError } from "../src/errors.js";
import { packageRoot } from "../src/paths.js";
import { planBasename, writePlanFiles } from "../src/plans.js";

const root = packageRoot();
const exampleConfig = join(root, "examples", "kiln.config.json");

describe("kiln config", () => {
  it("loads the committed example config as fictional Pebble data", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-example-cwd-"));
    try {
      const loaded = loadKilnConfig(exampleConfig, { cwd });
      assert.equal(loaded.example, true);
      assert.match(loaded.note ?? "", /EXAMPLE CONFIG/);
      assert.match(loaded.checkouts.frontend, /examples\/checkouts\/frontend$/);
      assert.match(loaded.checkouts["ai-core"], /examples\/checkouts\/ai-core$/);
      assert.match(loaded.checkouts["evals-obs"], /examples\/checkouts\/evals-obs$/);
      assert.deepEqual(
        loaded.ownership.map((map) => map.repo),
        ["frontend", "ai-core", "evals-obs"],
      );
      assert.equal(loaded.plansDir, join(cwd, ".kiln", "plans"));
      assert.equal(loaded.plansDir.includes(`${join("examples", "plans")}`), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prefers .kiln in the working directory over ~/.kiln and the example config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      writeLocalConfig(join(cwd, ".kiln"), "from-cwd");
      writeLocalConfig(join(home, ".kiln"), "from-home");
      const loaded = resolveKilnConfig({
        cwd,
        home,
        requirementPath: join(root, "examples", "requirements", "thin-jira.md"),
      });
      assert.equal(loaded.example, false);
      assert.match(loaded.note ?? "", /from-cwd/);
      assert.equal(loaded.plansDir, join(cwd, ".kiln", "plans"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses ~/.kiln when the working directory has no config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      writeLocalConfig(join(home, ".kiln"), "from-home");
      const loaded = resolveKilnConfig({ cwd, home, requirementPath: join(cwd, "ticket.md") });
      assert.match(loaded.note ?? "", /from-home/);
      assert.equal(loaded.plansDir, join(home, ".kiln", "plans"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to the example config only for shipped example requirements", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "kiln-home-"));
    try {
      const loaded = resolveKilnConfig({
        cwd,
        home,
        requirementPath: join(root, "examples", "requirements", "weekly-reflection.md"),
      });
      assert.equal(loaded.example, true);
      assert.equal(loaded.configPath, exampleConfig);

      assert.throws(
        () => resolveKilnConfig({ cwd, home, requirementPath: join(cwd, "TICKET-9.md") }),
        KilnConfigError,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes plan files only inside the plans directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-plans-"));
    try {
      const written = writePlanFiles(join(dir, "plans"), "EX-202", '{"kind":"plan"}\n', "# Plan\n");
      assert.equal(written.jsonPath, join(dir, "plans", "EX-202.json"));
      assert.equal(readFileSync(written.markdownPath, "utf8"), "# Plan\n");
      assert.equal(planBasename("../EX-202"), "EX-202");
      assert.throws(() => planBasename(".."), /cannot be used as a plan filename/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gitignores the local kiln directory", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.kiln\/$/m);
  });
});

function writeLocalConfig(dir: string, note: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "kiln.config.json"),
    JSON.stringify({
      note,
      repos: {
        frontend: {
          checkout: join(root, "examples", "checkouts", "frontend"),
          ownership: join(root, "examples", "ownership", "frontend.json"),
        },
        "ai-core": {
          checkout: join(root, "examples", "checkouts", "ai-core"),
          ownership: join(root, "examples", "ownership", "ai-core.json"),
        },
        "evals-obs": {
          checkout: join(root, "examples", "checkouts", "evals-obs"),
          ownership: join(root, "examples", "ownership", "evals-obs.json"),
        },
      },
    }),
  );
}
