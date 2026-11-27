import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendEvent, eventsPath } from "../src/events.js";

function phase(once: string) {
  return { job_id: "j1", run_id: "r1", event: "phase.started" as const, step: "build", properties: { once } };
}

function lines(dir: string): string[] {
  return readFileSync(eventsPath(dir), "utf8").split("\n").filter(Boolean);
}

describe("once events already in the log", () => {
  it("are skipped without taking the event log lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-once-"));
    try {
      appendEvent(dir, phase("phase.started:1"));
      assert.equal(lines(dir).length, 1);
      // A lock held by a live process. An append that needs it waits five seconds and gives up.
      writeFileSync(join(dir, "events.lock"), String(process.pid));
      const started = Date.now();
      for (let index = 0; index < 50; index += 1) appendEvent(dir, phase("phase.started:1"));
      assert.ok(Date.now() - started < 1_000, "a recorded event waited for the lock");
      assert.equal(lines(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees a line another process appended", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-once-"));
    try {
      appendEvent(dir, phase("phase.started:1"));
      const other = JSON.parse(lines(dir)[0] ?? "{}") as { id: string; properties: { once: string } };
      other.id = "00000000-0000-4000-8000-000000000002";
      other.properties.once = "phase.started:2";
      appendFileSync(eventsPath(dir), `${JSON.stringify(other)}\n`);
      appendEvent(dir, phase("phase.started:2"));
      assert.equal(lines(dir).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts over when the log was replaced by a shorter one", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-once-"));
    try {
      appendEvent(dir, phase("phase.started:1"));
      appendEvent(dir, phase("phase.started:2"));
      writeFileSync(eventsPath(dir), "");
      appendEvent(dir, phase("phase.started:1"));
      assert.equal(lines(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
