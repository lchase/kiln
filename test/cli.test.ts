import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const keep: string[] = [];

function runCli(
  args: string[],
  options: { cwd: string; home: string; kilnHome?: string },
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home };
  if (options.kilnHome) env.KILN_HOME = options.kilnHome;
  else delete env.KILN_HOME;
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempWork(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-cli-"));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home };
}

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("kiln cli", () => {
  it("prints usage and exits 2 without a command", () => {
    const { cwd, home } = tempWork();
    const result = runCli([], { cwd, home });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: kiln repo add/);
    assert.match(result.stderr, /kiln add <workflow>/);
    assert.doesNotMatch(result.stderr, /refine/);
  });

  it("rejects an unknown repo and an unknown workflow at add", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    mkdirSync(web);
    const spec = join(cwd, "spec.md");
    writeFileSync(spec, "# Show the summary\n\nA person can read it.\n");

    const added = runCli(["repo", "add", "web", web, "--test", "npm test"], { cwd, home });
    assert.equal(added.status, 0, added.stderr);

    const unknownRepo = runCli(["add", "feature", "--repo", "missing", "--spec", spec], { cwd, home });
    assert.equal(unknownRepo.status, 1);
    assert.match(unknownRepo.stderr, /Unknown repo missing/);
    assert.equal(existsJobs(home), false);

    const unknownWorkflow = runCli(["add", "no-such-flow", "--repo", "web", "--spec", spec], { cwd, home });
    assert.equal(unknownWorkflow.status, 1);
    assert.match(unknownWorkflow.stderr, /Unknown workflow no-such-flow/);
    assert.equal(existsJobs(home), false);
  });

  it("registers two repos, lists both, and stores a job with no state field", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    const api = join(cwd, "api");
    mkdirSync(web);
    mkdirSync(api);
    const spec = join(cwd, "sunday.md");
    writeFileSync(spec, "# Show the summary\n\nA person can read it.\n");

    assert.equal(runCli(["repo", "add", "web", web, "--test", "npm test"], { cwd, home }).status, 0);
    assert.equal(runCli(["repo", "add", "api", api, "--test", "npm test"], { cwd, home }).status, 0);
    const list = runCli(["repo", "list"], { cwd, home });
    assert.equal(list.status, 0, list.stderr);
    assert.ok(list.stdout.includes(`web  ${web}  test npm test`), list.stdout);
    assert.ok(list.stdout.includes(`api  ${api}  test npm test`), list.stdout);

    const created = runCli(["add", "feature", "--repo", "web", "--spec", spec, "--title", "Sunday summary"], {
      cwd,
      home,
    });
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(id);
    const jobPath = join(home, ".kiln", "jobs", `${id}.json`);
    const job = JSON.parse(readFileSync(jobPath, "utf8")) as {
      id: string;
      repo: string;
      workflow: string;
      spec: string;
      title: string;
      createdAt: string;
      state?: string;
      dependsOn?: string[];
    };
    assert.equal(job.id, id);
    assert.equal(job.repo, "web");
    assert.equal(job.workflow, "feature");
    assert.equal(job.title, "Sunday summary");
    assert.equal(job.spec, `specs/${id}.md`);
    assert.equal(job.dependsOn, undefined);
    assert.equal(job.state, undefined);
    assert.equal(typeof job.createdAt, "string");
    assert.equal(readFileSync(join(home, ".kiln", job.spec), "utf8"), readFileSync(spec, "utf8"));

    const missingAfter = runCli(["add", "feature", "--repo", "api", "--spec", spec, "--after", "missing-job"], {
      cwd,
      home,
    });
    assert.equal(missingAfter.status, 1);
    assert.match(missingAfter.stderr, /missing-job/);
  });

  it("names a missing dependency when a job is blocked on it", () => {
    const { cwd, home } = tempWork();
    const web = join(cwd, "web");
    const api = join(cwd, "api");
    mkdirSync(web);
    mkdirSync(api);
    const spec = join(cwd, "sunday.md");
    writeFileSync(spec, "# Show the summary\n\nA person can read it.\n");
    assert.equal(runCli(["repo", "add", "web", web, "--test", "npm test"], { cwd, home }).status, 0);
    assert.equal(runCli(["repo", "add", "api", api, "--test", "npm test"], { cwd, home }).status, 0);

    const upstream = runCli(["add", "feature", "--repo", "web", "--spec", spec, "--title", "Sunday summary"], {
      cwd,
      home,
    });
    const upstreamId = upstream.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(upstreamId, upstream.stdout);
    const downstream = runCli(
      ["add", "feature", "--repo", "api", "--spec", spec, "--title", "API summary", "--after", upstreamId],
      { cwd, home },
    );
    const downstreamId = downstream.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(downstreamId, downstream.stderr);

    const waiting = runCli(["status", downstreamId], { cwd, home });
    assert.equal(waiting.status, 0, waiting.stderr);
    assert.match(waiting.stdout, new RegExp(`${downstreamId}\\s+api\\s+feature\\s+blocked`));
    assert.doesNotMatch(waiting.stdout, /missing job/);

    rmSync(join(home, ".kiln", "jobs", `${upstreamId}.json`));
    const missing = runCli(["status", downstreamId], { cwd, home });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, new RegExp(`${downstreamId}\\s+api\\s+feature\\s+blocked`));
    assert.match(missing.stdout, new RegExp(`blocked on missing job ${upstreamId}`));
  });

  it("sees the same registry and jobs from two working directories", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-cli-home-"));
    const dirA = mkdtempSync(join(tmpdir(), "kiln-cli-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "kiln-cli-b-"));
    keep.push(home, dirA, dirB);
    const web = join(dirA, "web");
    mkdirSync(web);
    const spec = join(dirA, "spec.md");
    writeFileSync(spec, "# Show the summary\n\nA person can read it.\n");

    const added = runCli(["repo", "add", "web", "web", "--test", "npm test"], { cwd: dirA, home });
    assert.equal(added.status, 0, added.stderr);
    const stored = JSON.parse(readFileSync(join(home, ".kiln", "kiln.config.json"), "utf8")) as {
      repos: { web: { path: string } };
    };
    assert.equal(stored.repos.web.path, web);
    assert.equal(existsSync(join(dirA, ".kiln")), false);

    const created = runCli(["add", "feature", "--repo", "web", "--spec", spec, "--title", "Sunday summary"], {
      cwd: dirA,
      home,
    });
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/^added (\S+)/m)?.[1];
    assert.ok(id, created.stdout);

    const listed = runCli(["repo", "list"], { cwd: dirB, home });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.includes(`web  ${web}  test npm test`), listed.stdout);

    const status = runCli(["status", id], { cwd: dirB, home });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`${id}\\s+web\\s+feature\\s+queued`));
    assert.equal(existsSync(join(dirB, ".kiln")), false);
    assert.equal(existsSync(join(home, ".kiln", "jobs", `${id}.json`)), true);
  });

  it("errors when ./.kiln exists and the home config does not", () => {
    const { cwd, home } = tempWork();
    const checkout = join(cwd, "web");
    mkdirSync(join(cwd, ".kiln"), { recursive: true });
    mkdirSync(checkout);
    writeFileSync(
      join(cwd, ".kiln", "kiln.config.json"),
      `${JSON.stringify({ repos: { web: { path: checkout } } })}\n`,
    );
    const listed = runCli(["repo", "list"], { cwd, home });
    assert.equal(listed.status, 1);
    assert.match(listed.stderr, /mv \.\/\.kiln ~\/\.kiln/);
    assert.match(listed.stderr, /--config/);
    assert.match(listed.stderr, /KILN_HOME/);
    assert.equal(listed.stderr.trim().includes("\n"), false);
    const added = runCli(["repo", "add", "web", checkout], { cwd, home });
    assert.equal(added.status, 1);
    assert.match(added.stderr, /mv \.\/\.kiln ~\/\.kiln/);
    assert.equal(existsSync(join(home, ".kiln", "kiln.config.json")), false);
  });

  it("uses KILN_HOME instead of ~/.kiln", () => {
    const { cwd, home } = tempWork();
    const kilnHome = join(cwd, "kiln-home");
    const elsewhere = mkdtempSync(join(tmpdir(), "kiln-cli-else-"));
    keep.push(elsewhere);
    mkdirSync(kilnHome);
    const web = join(cwd, "web");
    mkdirSync(web);
    mkdirSync(join(home, ".kiln"), { recursive: true });
    writeFileSync(
      join(home, ".kiln", "kiln.config.json"),
      `${JSON.stringify({ note: "from-home", repos: { decoy: { path: web } } })}\n`,
    );

    const added = runCli(["repo", "add", "web", web, "--test", "npm test"], { cwd, home, kilnHome });
    assert.equal(added.status, 0, added.stderr);
    assert.equal(existsSync(join(kilnHome, "kiln.config.json")), true);
    const decoy = JSON.parse(readFileSync(join(home, ".kiln", "kiln.config.json"), "utf8")) as {
      repos: Record<string, unknown>;
    };
    assert.equal("web" in decoy.repos, false);

    const listed = runCli(["repo", "list"], { cwd: elsewhere, home, kilnHome });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.includes(`web  ${web}  test npm test`), listed.stdout);
    assert.doesNotMatch(listed.stdout, /decoy/);
  });
});

function existsJobs(home: string): boolean {
  return existsSync(join(home, ".kiln", "jobs"));
}
