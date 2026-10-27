import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, sep } from "node:path";

const SKIP = new Set([process.pid, process.ppid]);

/**
 * Stop detached yak runs started from a test directory, and wait until they
 * are gone. `kiln tick` and `kiln serve` spawn those processes with
 * `detached: true`, so killing the CLI does not stop them. They keep creating
 * files under `<checkout>/.yak` after the test has moved on.
 */
export async function reapLaunches(root: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    // Scan again after each kill. A detached yak can fork a writer into its
    // own session between the first look and the signal.
    const live = collectPids(root).filter((pid) => writing(pid));
    if (live.length === 0) return;
    for (const pid of live) killGroup(pid);
    if (Date.now() >= deadline) {
      await pause(50);
      const left = collectPids(root).filter((pid) => writing(pid));
      if (left.length === 0) return;
      throw new Error(`detached launch still writing under ${root}: ${left.join(", ")}`);
    }
    await pause(20);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A zombie cannot create files. `kill(pid, 0)` still succeeds for one, so it is not "still writing". */
function writing(pid: number): boolean {
  const state = processState(pid);
  if (state === undefined) return false;
  return state !== "Z" && state !== "X";
}

function collectPids(root: string): number[] {
  const found = new Set<number>();
  harvestTree(root, found);
  harvestCwd(root, found);
  return [...found];
}

function harvestTree(dir: string, found: Set<number>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === ".git") continue;
    const path = join(dir, name);
    let directory = false;
    try {
      directory = lstatSync(path).isDirectory();
    } catch {
      continue;
    }
    if (directory) {
      harvestTree(path, found);
      continue;
    }
    if (name === "journal.jsonl" || (name.endsWith(".json") && basename(dir) === "launching")) {
      harvestFile(path, found);
    }
  }
}

function harvestFile(path: string, found: Set<number>): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (path.endsWith("journal.jsonl")) {
    for (const line of text.split("\n")) {
      if (!line.includes('"pid"')) continue;
      try {
        const event = JSON.parse(line) as { t?: string; pid?: unknown };
        if ((event.t === "run.started" || event.t === "run.resumed") && typeof event.pid === "number") {
          remember(event.pid, found);
        }
      } catch {
        // A torn last line is not a pid.
      }
    }
    return;
  }
  try {
    const crumb = JSON.parse(text) as { pid?: unknown };
    if (typeof crumb.pid === "number") remember(crumb.pid, found);
  } catch {
    // Not a breadcrumb.
  }
}

/** Any live process whose cwd is still inside the temp dir, including ones the journal has not recorded yet. */
function harvestCwd(root: string, found: Set<number>): void {
  let real = "";
  try {
    if (lstatSync(root).isDirectory()) real = root;
  } catch {
    return;
  }
  if (!real) return;
  const recorded = new Set(found);
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return;
  }
  const prefix = real.endsWith(sep) ? real : `${real}${sep}`;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!remember(pid, found, true)) continue;
    let cwd = "";
    try {
      cwd = readlinkSync(join("/proc", name, "cwd"));
    } catch {
      found.delete(pid);
      continue;
    }
    if (cwd !== real && !cwd.startsWith(prefix) && !recorded.has(pid)) found.delete(pid);
  }
}

function remember(pid: number, found: Set<number>, probe = false): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || SKIP.has(pid)) return false;
  if (!probe && !alive(pid)) return false;
  found.add(pid);
  return true;
}

function killGroup(pid: number): void {
  // Only signal the group when this pid leads it. A detached `yak run` does.
  // Killing -pid for an ordinary member can hit an unrelated group that reused the number.
  if (processGroup(pid) === pid) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The group is already gone; still try the pid below.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function processState(pid: number): string | undefined {
  const fields = statFields(pid);
  return fields?.[0];
}

function processGroup(pid: number): number | undefined {
  const fields = statFields(pid);
  if (!fields) return undefined;
  const pgid = Number(fields[2]);
  return Number.isInteger(pgid) ? pgid : undefined;
}

function statFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    return stat.slice(end + 2).split(" ");
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
    return code === "EPERM";
  }
}
