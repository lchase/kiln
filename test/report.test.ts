import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { yakCliPath } from "../src/report.js";

describe("yakCliPath", () => {
  it("points at the installed @lchase/yak bin", () => {
    const bin = yakCliPath();
    assert.equal(existsSync(bin), true);
    let dir = dirname(bin);
    let pkg: { name?: string } | undefined;
    for (let i = 0; i < 5; i += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    assert.equal(pkg?.name, "@lchase/yak");
  });
});
