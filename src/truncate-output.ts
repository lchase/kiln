import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Last lines of verify output kept for later prompts. */
export const VERIFY_MAX_LINES = 200;
/** Last bytes of verify output kept for later prompts, after the line cut. */
export const VERIFY_MAX_BYTES = 20 * 1024;

const RAW_CAP = 1024 * 1024;

/**
 * Keep the tail of a verify stream so a long test log cannot land whole in
 * the next prompt. A cut is marked on the first line.
 */
export function truncateCaptured(text: string, stream: "stdout" | "stderr"): string {
  const lined = lastLines(text, VERIFY_MAX_LINES);
  const tailed = lastBytes(lined.text, VERIFY_MAX_BYTES);
  if (!lined.cut && !tailed.cut) return text;
  const note = `[truncated: showing the last ${VERIFY_MAX_LINES} lines or ${VERIFY_MAX_BYTES} bytes of ${stream}]\n`;
  return note + tailed.text;
}

function lastLines(text: string, maxLines: number): { text: string; cut: boolean } {
  if (text.length === 0) return { text, cut: false };
  const trailingNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (trailingNewline) parts.pop();
  if (parts.length <= maxLines) return { text, cut: false };
  const kept = parts.slice(-maxLines);
  return { text: kept.join("\n") + (trailingNewline ? "\n" : ""), cut: true };
}

function lastBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, cut: false };
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return { text: buf.subarray(start).toString("utf8"), cut: true };
}

function capTail(current: string, chunk: string, cap: number): { text: string; cut: boolean } {
  let piece = chunk;
  let cut = false;
  if (Buffer.byteLength(piece, "utf8") > cap) {
    piece = lastBytes(piece, cap).text;
    cut = true;
    current = "";
  }
  const next = current + piece;
  if (Buffer.byteLength(next, "utf8") <= cap) return { text: next, cut };
  return { text: lastBytes(next, cap).text, cut: true };
}

/**
 * `process.stdout.write` queues behind an in-flight write. `process.exit`
 * leaves that queue in the process and the parent's `close` handler never
 * sees it. A blocking write puts the bytes in the pipe first.
 */
function writeAll(fd: number, text: string): void {
  if (text.length === 0) return;
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) {
    let wrote = 0;
    try {
      wrote = writeSync(fd, buf, offset);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "EAGAIN" || code === "EWOULDBLOCK") continue;
      throw error;
    }
    if (wrote <= 0) return;
    offset += wrote;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function main(): void {
  const command = process.env.KILN_TEST;
  if (!command?.trim()) {
    writeAll(2, "KILN_TEST is empty\n");
    process.exit(1);
  }
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    writeAll(1, truncateCaptured(stdout, "stdout"));
    writeAll(2, truncateCaptured(stderr, "stderr"));
    process.exit(code);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = capTail(stdout, chunk, RAW_CAP).text;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = capTail(stderr, chunk, RAW_CAP).text;
  });
  child.on("error", (error) => {
    stderr += `${error.message}\n`;
    finish(1);
  });
  child.on("close", (code) => {
    finish(code ?? 1);
  });
}

if (isDirectRun()) main();
