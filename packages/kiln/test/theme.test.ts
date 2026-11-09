import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addRepo, loadKilnConfig } from "../src/config.js";
import { readSettings, saveSettings } from "../src/settings.js";

describe("board theme", () => {
  it("defaults a new config to kiln and falls back when the value is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-theme-"));
    const cwd = mkdtempSync(join(tmpdir(), "kiln-theme-cwd-"));
    const checkout = join(home, "src", "web");
    mkdirSync(checkout, { recursive: true });
    try {
      addRepo({ cwd, home, name: "web", repoPath: "~/src/web" });
      const configPath = join(home, ".kiln", "kiln.config.json");
      const created = JSON.parse(readFileSync(configPath, "utf8")) as { board?: { theme?: string } };
      assert.equal(created.board?.theme, "kiln");
      assert.equal(loadKilnConfig(configPath, { cwd, home }).boardTheme, "kiln");

      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      raw.board = { theme: "not-a-palette" };
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
      assert.equal(loadKilnConfig(configPath, { cwd, home }).boardTheme, "kiln");
      const loaded = readSettings(configPath);
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.document.board.theme, "kiln");

      const saved = saveSettings(
        configPath,
        { revision: loaded.document.revision, repos: loaded.document.repos, board: { theme: "catppuccin-latte" } },
        home,
      );
      assert.equal(saved.ok, true, saved.ok ? "" : saved.body.error);
      if (!saved.ok) return;
      assert.equal(saved.document.board.theme, "catppuccin-latte");
      const file = JSON.parse(readFileSync(configPath, "utf8")) as { board: { theme: string }; repos: { web: { path: string } } };
      assert.equal(file.board.theme, "catppuccin-latte");
      assert.equal(file.repos.web.path, "~/src/web");
      assert.equal(loadKilnConfig(configPath, { cwd, home }).boardTheme, "catppuccin-latte");

      const again = readSettings(configPath);
      assert.equal(again.ok, true);
      if (!again.ok) return;
      const rejected = saveSettings(
        configPath,
        { revision: again.document.revision, repos: again.document.repos, board: { theme: "slate" } },
        home,
      );
      assert.equal(rejected.ok, false);
      if (rejected.ok) return;
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.fields?.["board.theme"] ?? "", /Invalid/);
      const kept = JSON.parse(readFileSync(configPath, "utf8")) as { board: { theme: string } };
      assert.equal(kept.board.theme, "catppuccin-latte");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
