import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import {
  cancelJob,
  holdJob,
  prioritizeJob,
  readStatus,
  releaseJob,
  renderQueue,
  runTick,
} from "../src/driver.js";
import { eventsPath, queueControls, readEvents } from "../src/events.js";
import { defaultHost, type KilnHost } from "../src/host.js";
import { writeJob } from "../src/jobs.js";
import { renderLedger } from "../src/ledger.js";
import { canRetry, decide, inFlightCount, launchOrder, type Observation, type ObservedJob } from "../src/reconcile.js";

const keep: string[] = [];
/** Process groups this file spawned. The after hook kills only these. */
const spawned: number[] = [];

after(() => {
  for (const pid of spawned) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

function box(): { config: LoadedKilnConfig; checkout: string } {
  const dir = mkdtempSync(join(tmpdir(), "kiln-queue-"));
  keep.push(dir);
  const checkout = join(dir, "web");
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "kiln-test@example.com"]);
  git(checkout, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(checkout, "readme.md"), "sample\n");
  git(checkout, ["add", "readme.md"]);
  git(checkout, ["commit", "-q", "-m", "sample"]);
  const configPath = join(dir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ adapter: "mock", maxConcurrent: 1, repos: { web: { path: checkout, test: "node --test test.mjs" } } }, null, 2)}\n`,
  );
  return { config: loadKilnConfig(configPath, { home: dir }), checkout };
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");

/** Each job is one second younger than the last, so `createdAt` order is add order. */
function add(config: LoadedKilnConfig, title: string, dependsOn: string[] = []): string {
  clock += 1000;
  return writeJob(config, {
    workflow: "feature",
    repo: "web",
    specText: `# ${title}\n`,
    title,
    dependsOn,
    source: { kind: "prompt", ref: "inline" },
    now: new Date(clock),
  }).job.id;
}

/** `yak run` is a sleeping process this file owns. */
function host(): KilnHost {
  return {
    ...defaultHost(),
    startAgent() {
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      if (child.pid) spawned.push(child.pid);
      child.unref();
      return { pid: child.pid ?? 0 };
    },
  };
}

/** One tick. Returns the launched job id, then stops it so the slot is free for the next tick. */
function tickLaunch(config: LoadedKilnConfig, agent: KilnHost): string | undefined {
  const output = runTick(config, agent, { startup: false, now: new Date() });
  const launched = /^(?:launch|retry) (\S+)/m.exec(output)?.[1];
  if (launched) cancelJob(config, launched, agent);
  return launched;
}

function launches(config: LoadedKilnConfig, agent: KilnHost, count: number): (string | undefined)[] {
  return Array.from({ length: count }, () => tickLaunch(config, agent));
}

function eventLines(config: LoadedKilnConfig): number {
  return readFileSync(eventsPath(config.kilnDir), "utf8").split("\n").filter((line) => line.trim()).length;
}

/** Ids in the order `kiln queue` prints them. */
function queueIds(config: LoadedKilnConfig): string[] {
  return renderQueue(config)
    .trim()
    .split("\n")
    .map((line) => line.split("  ")[1] ?? "");
}

describe("kiln next", () => {
  it("launches the moved job first, then the rest in createdAt order", () => {
    const { config } = box();
    const a = add(config, "SAMPLE-A");
    const b = add(config, "SAMPLE-B");
    const c = add(config, "SAMPLE-C");
    assert.equal(prioritizeJob(config, c).changed, true);
    assert.deepEqual(launches(config, host(), 3), [c, a, b]);
  });

  it("puts the most recent move first", () => {
    const { config } = box();
    const a = add(config, "SAMPLE-A");
    const b = add(config, "SAMPLE-B");
    const c = add(config, "SAMPLE-C");
    prioritizeJob(config, c);
    prioritizeJob(config, b);
    assert.deepEqual(launches(config, host(), 3), [b, c, a]);
  });

  it("does not start a blocked job early, and starts it first once its dependency is done", () => {
    const { config, checkout } = box();
    const upstream = add(config, "SAMPLE-UP");
    const a = add(config, "SAMPLE-A");
    const b = add(config, "SAMPLE-B");
    const blocked = add(config, "SAMPLE-BLOCKED", [upstream]);
    // Held so the upstream does not launch here. It lands below from a journal.
    holdJob(config, upstream);
    assert.equal(prioritizeJob(config, blocked).changed, true);
    assert.equal(readStatus(config, blocked).jobs[0]?.queueReason, `waits for ${upstream}`);
    const agent = host();
    assert.equal(tickLaunch(config, agent), a);

    // The upstream lands: a run that finished ok with an approve decision.
    const runDir = join(checkout, ".runs", "2026-01-01T00-00-00Z-up");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${[{ t: "run.started", at, runId: "2026-01-01T00-00-00Z-up", tag: `kiln:${upstream}` }, { t: "run.finished", at, status: "ok" }]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    writeFileSync(join(runDir, "artifacts", "approval.json"), `${JSON.stringify({ decision: "approve" })}\n`);
    assert.equal(readStatus(config, upstream).jobs[0]?.state, "done");
    assert.equal(tickLaunch(config, agent), blocked);
    assert.equal(tickLaunch(config, agent), b);
  });
});

describe("kiln hold and release", () => {
  it("never launches a held job, gives it no slot, and launches it after release", () => {
    const { config } = box();
    const a = add(config, "SAMPLE-A");
    const b = add(config, "SAMPLE-B");
    assert.equal(holdJob(config, a).changed, true);
    const status = readStatus(config, a).jobs[0];
    assert.equal(status?.state, "queued");
    assert.equal(status?.held, true);
    const agent = host();
    // With one slot, the tick launches B: the held job holds no slot.
    assert.equal(tickLaunch(config, agent), b);
    // Every tick observes from disk, as a restarted kiln serve does.
    assert.equal(tickLaunch(config, agent), undefined);
    assert.equal(tickLaunch(config, agent), undefined);
    assert.equal(releaseJob(config, a).changed, true);
    assert.equal(tickLaunch(config, agent), a);
  });

  it("stops a pending retry, and does not count toward inFlightCount", () => {
    const failed: ObservedJob = {
      jobId: "SAMPLE-RETRY",
      repo: "web",
      workflow: "feature",
      title: "SAMPLE-RETRY",
      dependsOn: [],
      launching: false,
      launchFailed: true,
      nextRetryAt: "2026-01-01T00:00:00.000Z",
      attemptCount: 1,
    };
    const observation: Observation = { maxConcurrent: 1, maxAttempts: 3, jobs: [failed], breadcrumbsToClear: [] };
    const now = new Date("2026-01-02T00:00:00.000Z");
    assert.equal(canRetry(failed, observation, now), true);
    assert.deepEqual(decide(observation, now), [{ type: "retry", jobId: "SAMPLE-RETRY", repo: "web" }]);

    const held = { ...failed, held: true };
    const holding: Observation = { ...observation, jobs: [held] };
    assert.equal(canRetry(held, holding, now), false);
    assert.deepEqual(decide(holding, now), []);
    assert.equal(inFlightCount(holding), 0);
    assert.deepEqual(
      launchOrder(holding, now).map((entry) => entry.reason),
      ["held"],
    );
  });

  it("refuses running, done, and cancelled jobs without writing an event", () => {
    const { config, checkout } = box();
    const running = add(config, "SAMPLE-RUN");
    const done = add(config, "SAMPLE-DONE");
    const cancelled = add(config, "SAMPLE-CANCEL");
    const agent = host();
    cancelJob(config, cancelled, agent);
    const runDir = join(checkout, ".runs", "2026-01-01T00-00-00Z-done");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${[{ t: "run.started", at, runId: "2026-01-01T00-00-00Z-done", tag: `kiln:${done}` }, { t: "run.finished", at, status: "ok" }]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    writeFileSync(join(runDir, "artifacts", "approval.json"), `${JSON.stringify({ decision: "approve" })}\n`);
    const output = runTick(config, agent, { startup: false, now: new Date() });
    assert.match(output, new RegExp(`launch ${running}`));
    assert.equal(readStatus(config, running).jobs[0]?.state, "running");

    const before = eventLines(config);
    for (const [id, state] of [
      [running, "running"],
      [done, "done"],
      [cancelled, "cancelled"],
    ] as const) {
      for (const act of [holdJob, releaseJob, prioritizeJob]) {
        const result = act(config, id);
        assert.equal(result.changed, false);
        assert.match(result.message, new RegExp(`${id} is ${state}; \\w+ only applies to jobs that have not started`));
      }
    }
    assert.equal(eventLines(config), before);
    cancelJob(config, running, agent);
  });

  it("writes no second event for a repeated next, hold, or release", () => {
    const { config } = box();
    const a = add(config, "SAMPLE-A");
    const b = add(config, "SAMPLE-B");
    assert.throws(() => holdJob(config, "SAMPLE-NONE"), /No job SAMPLE-NONE/);
    assert.throws(() => holdJob(config, "../escape"), /./);

    assert.equal(prioritizeJob(config, a).changed, true);
    const afterNext = eventLines(config);
    assert.equal(prioritizeJob(config, a).changed, false);
    assert.match(prioritizeJob(config, a).message, /already first/);
    assert.equal(eventLines(config), afterNext);

    // Moving B and then A again is a real change: A was no longer first.
    assert.equal(prioritizeJob(config, b).changed, true);
    assert.equal(prioritizeJob(config, a).changed, true);

    assert.equal(holdJob(config, b).changed, true);
    const afterHold = eventLines(config);
    assert.equal(holdJob(config, b).changed, false);
    assert.equal(eventLines(config), afterHold);

    assert.equal(releaseJob(config, b).changed, true);
    const afterRelease = eventLines(config);
    assert.equal(releaseJob(config, b).changed, false);
    assert.equal(releaseJob(config, a).changed, false);
    assert.equal(eventLines(config), afterRelease);

    const events = readEvents(config.kilnDir, { warn: () => {} });
    assert.deepEqual(queueControls(events, b), { prioritizedIndex: events.findIndex((event) => event.event === "job.prioritized" && event.job_id === b), held: false });
  });
});

describe("kiln queue", () => {
  it("prints jobs in the order the next ticks launch them", () => {
    const { config } = box();
    const a = add(config, "SAMPLE-A");
    const b = add(config, "SAMPLE-B");
    const c = add(config, "SAMPLE-C");
    const d = add(config, "SAMPLE-D", [a]);
    assert.equal(renderQueue(config).split("\n")[0], `1  ${a}  web  SAMPLE-A  ready`);

    prioritizeJob(config, c);
    holdJob(config, b);
    const lines = renderQueue(config).trim().split("\n");
    assert.deepEqual(lines, [
      `1  ${c}  web  SAMPLE-C  moved to front`,
      `2  ${a}  web  SAMPLE-A  ready`,
      `3  ${d}  web  SAMPLE-D  waits for ${a}`,
      `4  ${b}  web  SAMPLE-B  held`,
    ]);
    const status = readStatus(config).jobs;
    assert.deepEqual(
      [c, a, d, b].map((id) => status.find((job) => job.jobId === id)?.queuePosition),
      [1, 2, 3, 4],
    );

    releaseJob(config, b);
    const order = queueIds(config);
    assert.deepEqual(order, [c, a, b, d]);
    // D waits on A, which is cancelled after its launch here, so D never launches.
    assert.deepEqual(launches(config, host(), 3), [c, a, b]);
  });

  it("names a pending retry with its time", () => {
    const failed: ObservedJob = {
      jobId: "SAMPLE-LATER",
      repo: "web",
      workflow: "feature",
      title: "SAMPLE-LATER",
      dependsOn: [],
      launching: false,
      launchFailed: true,
      nextRetryAt: "2026-01-03T00:00:00.000Z",
    };
    const ready: ObservedJob = { ...failed, jobId: "SAMPLE-NOW", title: "SAMPLE-NOW", launchFailed: false, nextRetryAt: undefined };
    delete ready.nextRetryAt;
    const observation: Observation = { maxConcurrent: 1, maxAttempts: 3, jobs: [failed, ready], breadcrumbsToClear: [] };
    const entries = launchOrder(observation, new Date("2026-01-02T00:00:00.000Z"));
    assert.deepEqual(
      entries.map((entry) => [entry.job.jobId, entry.reason]),
      [
        ["SAMPLE-NOW", "ready"],
        ["SAMPLE-LATER", "retries at 2026-01-03T00:00:00.000Z"],
      ],
    );
  });

  it("counts a move to the front and a hold in the ledger, not a release", () => {
    const { config } = box();
    const a = add(config, "SAMPLE-A");
    prioritizeJob(config, a);
    holdJob(config, a);
    releaseJob(config, a);
    const ledger = renderLedger(readEvents(config.kilnDir, { warn: () => {} }), {});
    assert.match(ledger, /moved to front by hand/);
    assert.match(ledger, /held by hand/);
    assert.doesNotMatch(ledger, /release/);
  });
});
