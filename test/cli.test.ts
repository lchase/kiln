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
  options: { cwd: string; home: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: options.home },
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
    assert.equal(existsJobs(cwd), false);

    const unknownWorkflow = runCli(["add", "no-such-flow", "--repo", "web", "--spec", spec], { cwd, home });
    assert.equal(unknownWorkflow.status, 1);
    assert.match(unknownWorkflow.stderr, /Unknown workflow no-such-flow/);
    assert.equal(existsJobs(cwd), false);
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
    const jobPath = join(cwd, ".kiln", "jobs", `${id}.json`);
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
    assert.equal(readFileSync(join(cwd, ".kiln", job.spec), "utf8"), readFileSync(spec, "utf8"));

    const missingAfter = runCli(["add", "feature", "--repo", "api", "--spec", spec, "--after", "missing-job"], {
      cwd,
      home,
    });
    assert.equal(missingAfter.status, 1);
    assert.match(missingAfter.stderr, /missing-job/);
  });
});

function existsJobs(cwd: string): boolean {
  return existsSync(join(cwd, ".kiln", "jobs"));
}
