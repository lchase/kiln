import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { truncateCaptured, VERIFY_MAX_BYTES, VERIFY_MAX_LINES } from "../src/truncate-output.js";

const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("truncate verify output", () => {
  it("leaves a short stream unchanged", () => {
    assert.equal(truncateCaptured("ok\n", "stdout"), "ok\n");
    assert.equal(truncateCaptured("", "stderr"), "");
  });

  it("keeps the last 200 lines and says the head was cut", () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`);
    const out = truncateCaptured(`${lines.join("\n")}\n`, "stderr");
    assert.match(out, /^\[truncated: showing the last 200 lines or 20480 bytes of stderr\]\n/);
    assert.equal(VERIFY_MAX_LINES, 200);
    assert.doesNotMatch(out, /(^|\n)line-49\n/);
    assert.match(out, /(^|\n)line-50\n/);
    assert.match(out, /(^|\n)line-249\n/);
  });

  it("keeps the last 20KB without splitting a utf-8 character", () => {
    const text = "é".repeat(20_000);
    const out = truncateCaptured(text, "stdout");
    assert.match(out, /^\[truncated: showing the last 200 lines or 20480 bytes of stdout\]\n/);
    const body = out.slice(out.indexOf("\n") + 1);
    assert.ok(Buffer.byteLength(body, "utf8") <= VERIFY_MAX_BYTES);
    assert.equal(VERIFY_MAX_BYTES, 20 * 1024);
    assert.doesNotMatch(body, /\uFFFD/);
    assert.match(body, /é$/);
  });

  it("re-emits the test exit code and a truncated stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-truncate-"));
    keep.push(dir);
    const script = join(dir, "run.mjs");
    writeFileSync(
      script,
      [
        "for (let i = 0; i < 250; i += 1) console.error('err-' + i);",
        "console.log('hello-out');",
        "process.exit(4);",
        "",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [join(packageRoot(), "dist", "truncate-output.js")], {
      encoding: "utf8",
      env: { ...process.env, KILN_TEST: `node ${JSON.stringify(script)}` },
    });
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stdout.trim(), "hello-out");
    assert.doesNotMatch(result.stdout, /truncated/);
    assert.match(result.stderr, /\[truncated: showing the last 200 lines or 20480 bytes of stderr\]/);
    assert.match(result.stderr, /(^|\n)err-249\n/);
    assert.doesNotMatch(result.stderr, /(^|\n)err-0\n/);
  });
});
