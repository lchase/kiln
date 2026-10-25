import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // process.exit() returns while stderr writes are still queued in this
    // process. The wrapper listens for close, and those bytes are not in the
    // pipe, so a parallel suite sees fewer than 200 lines and does not truncate.
    writeFileSync(
      script,
      [
        "for (let i = 0; i < 250; i += 1) console.error('err-' + i);",
        "console.log('hello-out');",
        "process.exitCode = 4;",
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

  it("writes the truncated tail before exiting, so a late reader still sees it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-truncate-"));
    keep.push(dir);
    const script = join(dir, "big.mjs");
    const stdoutText = `${"o".repeat(30_000)}\n`;
    const stderrText = `${"e".repeat(80)}\n`.repeat(400);
    writeFileSync(
      script,
      [
        `process.stdout.write(${JSON.stringify(stdoutText)});`,
        `process.stderr.write(${JSON.stringify(stderrText)});`,
        "process.exitCode = 4;",
        "",
      ].join("\n"),
    );
    const expectedOut = truncateCaptured(stdoutText, "stdout");
    const expectedErr = truncateCaptured(stderrText, "stderr");
    const outPath = join(dir, "stdout.txt");
    const errPath = join(dir, "stderr.txt");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    const status = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [join(packageRoot(), "dist", "truncate-output.js")], {
        stdio: ["ignore", outFd, errFd],
        env: { ...process.env, KILN_TEST: `node ${JSON.stringify(script)}` },
      });
      const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.on("close", (code) => {
        clearTimeout(killer);
        resolve(code);
      });
    });
    closeSync(outFd);
    closeSync(errFd);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = {
      status,
      stdout: readFileSync(outPath, "utf8"),
      stderr: readFileSync(errPath, "utf8"),
    };
    assert.equal(result.status, 4);
    assert.equal(result.stdout, expectedOut);
    assert.equal(result.stderr, expectedErr);
  });
});
