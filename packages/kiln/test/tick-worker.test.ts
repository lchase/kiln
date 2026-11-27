import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKilnConfig } from "../src/config.js";
import type { TickReply, TickRequest } from "../src/tick-worker.js";

describe("serve tick worker", () => {
  it("runs one tick with the config it is sent, replies, and exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-tick-worker-"));
    try {
      const configPath = join(dir, "kiln.config.json");
      writeFileSync(configPath, JSON.stringify({ repos: {} }));
      const request: TickRequest = { config: loadKilnConfig(configPath), triggerStartup: false };
      const child = fork(fileURLToPath(new URL("../src/tick-worker.js", import.meta.url)), [], { serialization: "advanced" });
      const reply = new Promise<TickReply>((resolve) => child.once("message", resolve));
      const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.send(request);
      const got = await reply;
      assert.equal(got.error, undefined);
      assert.match(got.report ?? "", /tick /);
      assert.deepEqual(got.views, []);
      assert.equal(await exit, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
