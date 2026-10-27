import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { reapLaunches } from "./reap.js";

const root = packageRoot();
const keep: string[] = [];
const children: ChildProcess[] = [];
const TOKEN = "kiln-test-jira-token-do-not-render";
const TOKEN_B = "reloaded-jira-token-bbbb";
const EMAIL = "dev@example.com";

function kilnEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
  delete env.KILN_HOME;
  return env;
}

function runCli(
  args: string[],
  options: { cwd: string; home: string; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: kilnEnv(options.home, options.env),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Async spawn so an in-process stub (the Jira stand-in) can answer while the CLI runs. */
function runCliAsync(
  args: string[],
  options: { cwd: string; home: string; env?: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist", "cli.js"), ...args], {
      cwd: options.cwd,
      env: kilnEnv(options.home, options.env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function workDir(prefix: string): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  keep.push(cwd);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home };
}

function register(cwd: string, home: string, name: string, dir: string): void {
  const result = runCli(["repo", "add", name, dir, "--test", "true"], { cwd, home });
  assert.equal(result.status, 0, result.stderr);
}

function useMock(home: string, token = TOKEN): void {
  const path = join(home, ".kiln", "kiln.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.adapter = "mock";
  raw.maxConcurrent = 2;
  raw.jira = { baseUrl: "https://example.atlassian.net", email: EMAIL, apiToken: token };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

interface RunningServe {
  url: string;
  child: ChildProcess;
}

function startServe(
  args: string[],
  options: { cwd: string; home: string; env?: NodeJS.ProcessEnv },
): Promise<RunningServe> {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "serve", ...args], {
    cwd: options.cwd,
    env: kilnEnv(options.home, options.env),
  });
  children.push(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`serve did not listen\n${output.stdout}\n${output.stderr}`));
    }, 10_000);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: string) => {
      output.stdout += chunk;
      const match = output.stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(() => resolve({ url: match[1], child }));
    });
    child.stderr?.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => reject(new Error(`serve exited ${code}\n${output.stdout}\n${output.stderr}`)));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function text(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

function csrfFrom(html: string): string {
  const match = html.match(/data-csrf="([a-f0-9]+)"/);
  assert.ok(match?.[1], "page is missing a csrf token");
  return match[1];
}

function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

interface StoredJob {
  id: string;
  repo: string;
  workflow: string;
  spec: string;
  title: string;
  dependsOn?: string[];
  stack?: boolean;
  source?: { kind: string; ref: string };
}

function readJobs(home: string): StoredJob[] {
  const dir = join(home, ".kiln", "jobs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as StoredJob);
}

function specOf(home: string, job: StoredJob): string {
  return readFileSync(join(home, ".kiln", job.spec), "utf8");
}

function digest(home: string): unknown[] {
  const jobs = readJobs(home);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return jobs
    .map((job) => ({
      repo: job.repo,
      workflow: job.workflow,
      title: job.title,
      stack: Boolean(job.stack),
      dependsOn: (job.dependsOn ?? []).map((id) => byId.get(id)?.title ?? id).sort(),
      source: job.source,
      spec: specOf(home, job),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function addedId(stdout: string): string {
  const id = stdout.match(/^added (\S+)/m)?.[1];
  assert.ok(id, stdout);
  return id;
}

async function postJob(
  url: string,
  csrf: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return text(`${url}/api/jobs`, {
    method: "POST",
    headers: {
      Origin: url,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Kiln-CSRF": csrf,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

function initCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "kiln-test@example.com"]);
  git(dir, ["config", "user.name", "Kiln Test"]);
  writeFileSync(join(dir, "test.mjs"), "import test from 'node:test';\ntest('ok', () => {});\n");
  const fixtures = join(dir, "test", "fixtures", "kiln-feature");
  mkdirSync(fixtures, { recursive: true });
  const step = (name: string, output: unknown): void => {
    writeFileSync(join(fixtures, `${name}.json`), `${JSON.stringify([{ output }])}\n`);
  };
  step("spec", { goal: "Show the weekly summary.", design: "Touch the named module.", acceptance: "The job's checks pass." });
  step("build", { summary: "Mock build.", status: "READY" });
  for (const name of ["security", "ux", "ui", "code"]) step(name, { verdict: "PASS", findings: "No must-fix findings." });
  step("approver", { decision: "APPROVE", reason: "Reviews passed." });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function writeTickets(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "01-probe-platform.md"),
    ["# 01: Probe the platform", "", "**What to build:** Name the library.", "", "**Blocked by:**", "None", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "02-render-empty.md"),
    ["# 02: Render the empty state", "", "**What to build:** Show one sentence.", "", "**Blocked by:**", "- 01: Probe the platform", ""].join("\n"),
  );
}

function jiraStub(token: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url.startsWith("/rest/api/3/field")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (url.includes("/rest/api/3/issue/PROJ-9")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorMessages: [`bad ${token}`] }));
      return;
    }
    if (url.includes("/rest/api/3/issue/PROJ-1")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          key: "PROJ-1",
          fields: {
            summary: "Show a quiet empty state",
            description: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: `Keep ${token} out of the spec.` }] }],
            },
            issuetype: { name: "Story" },
            issuelinks: [],
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => exited(child)));
  for (const dir of keep) await reapLaunches(dir);
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("serve intake", () => {
  it("creates the same prompt, spec, and jira job files as the CLI", async () => {
    const { cwd, home } = workDir("kiln-serve-add-");
    const web = join(home, "web");
    mkdirSync(web);
    register(cwd, home, "web", web);
    useMock(home);
    const stub = await jiraStub(TOKEN);
    const spec = join(home, "specs", "sunday.md");
    mkdirSync(join(home, "specs"));
    const specText = "# Show the Sunday summary\n\nA person can read it.\n";
    writeFileSync(spec, specText);
    const prompt = "Show a quiet empty state\n\nOne sentence when the list is empty.\n";
    const server = await startServe(["--port", "0", "--no-tick"], {
      cwd,
      home,
      env: { JIRA_BASE_URL: stub.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN },
    });
    try {
      const page = await text(`${server.url}/`);
      assert.equal(page.status, 200);
      assert.match(page.body, /id="add-job"/);
      assert.match(page.body, /aria-label="Add job"/);
      assert.match(page.body, /id="intake"/);
      assert.match(page.body, />Prompt</);
      assert.match(page.body, />Spec file</);
      assert.match(page.body, />Tickets folder</);
      assert.match(page.body, />Jira</);
      assert.match(page.body, /<option value="feature" selected>/);
      assert.match(page.body, /<option value="fix">/);
      assert.match(page.body, /<option value="investigation">/);
      assert.match(page.body, /data-csrf="[a-f0-9]{64}"/);
      assert.equal(page.body.includes(TOKEN), false);
      const csrf = csrfFrom(page.body);

      const upstreamCli = runCli(["add", "feature", "--repo", "web", "--prompt", "Upstream work\n"], { cwd, home });
      assert.equal(upstreamCli.status, 0, upstreamCli.stderr);
      const upstream = addedId(upstreamCli.stdout);

      const cliPrompt = runCli(
        ["add", "feature", "--repo", "web", "--prompt", prompt, "--after", upstream, "--stack"],
        { cwd, home },
      );
      assert.equal(cliPrompt.status, 0, cliPrompt.stderr);
      const apiPrompt = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        after: [upstream],
        stack: true,
        source: { kind: "prompt", text: prompt },
      });
      assert.equal(apiPrompt.status, 200, apiPrompt.body);
      const promptIds = JSON.parse(apiPrompt.body) as { ids: string[] };
      assert.equal(promptIds.ids.length, 1);
      const promptJobs = readJobs(home).filter((job) => job.title === "Show a quiet empty state");
      assert.equal(promptJobs.length, 2);
      const promptCli = promptJobs.find((job) => job.id === addedId(cliPrompt.stdout));
      const promptApi = promptJobs.find((job) => job.id === promptIds.ids[0]);
      assert.ok(promptCli && promptApi);
      assert.equal(promptApi.repo, promptCli.repo);
      assert.equal(promptApi.workflow, promptCli.workflow);
      assert.equal(promptApi.title, promptCli.title);
      assert.equal(promptApi.stack, true);
      assert.deepEqual(promptApi.dependsOn, [upstream]);
      assert.deepEqual(promptApi.source, { kind: "prompt", ref: "inline" });
      assert.equal(specOf(home, promptApi), specOf(home, promptCli));
      assert.equal(specOf(home, promptApi), prompt);

      const cliSpec = runCli(["add", "feature", "--repo", "web", "--spec", spec], { cwd, home });
      assert.equal(cliSpec.status, 0, cliSpec.stderr);
      const apiSpec = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "spec", path: spec },
      });
      assert.equal(apiSpec.status, 200, apiSpec.body);
      const specIds = JSON.parse(apiSpec.body) as { ids: string[] };
      const specJobs = readJobs(home).filter((job) => job.source?.kind === "file");
      assert.equal(specJobs.length, 2);
      for (const job of specJobs) {
        assert.equal(job.source?.ref, spec);
        assert.equal(job.title, "Show the Sunday summary");
        assert.equal(specOf(home, job), specText);
      }
      assert.ok(specIds.ids[0] && specIds.ids[0] !== addedId(cliSpec.stdout));

      const cliJira = await runCliAsync(["add", "feature", "--repo", "web", "--jira", "proj-1"], {
        cwd,
        home,
        env: { JIRA_BASE_URL: stub.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN },
      });
      assert.equal(cliJira.status, 0, cliJira.stderr);
      const other = workDir("kiln-serve-jira-api-");
      const otherWeb = join(other.home, "web");
      mkdirSync(otherWeb);
      register(other.cwd, other.home, "web", otherWeb);
      useMock(other.home);
      const otherServer = await startServe(["--port", "0", "--no-tick"], {
        cwd: other.cwd,
        home: other.home,
        env: { JIRA_BASE_URL: stub.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN },
      });
      try {
        const otherPage = await text(`${otherServer.url}/`);
        const apiJira = await postJob(otherServer.url, csrfFrom(otherPage.body), {
          repo: "web",
          workflow: "feature",
          source: { kind: "jira", key: "proj-1" },
        });
        assert.equal(apiJira.status, 200, apiJira.body);
        assert.equal(apiJira.body.includes(TOKEN), false);
        assert.deepEqual(digest(home).filter((job) => (job as { source?: { kind: string } }).source?.kind === "jira"), digest(other.home));
        const jiraJob = readJobs(other.home)[0];
        assert.ok(jiraJob);
        assert.equal(jiraJob.source?.ref, "PROJ-1");
        assert.equal(specOf(other.home, jiraJob).includes(TOKEN), false);
        assert.match(specOf(other.home, jiraJob), /\[redacted\]/);
      } finally {
        await stop(otherServer.child);
      }
    } finally {
      await stop(server.child);
      await stub.close();
    }
  });

  it("previews a tickets import and then writes the same jobs as the CLI", async () => {
    const { cwd, home } = workDir("kiln-serve-tickets-");
    const web = join(home, "web");
    mkdirSync(web);
    register(cwd, home, "web", web);
    const dir = join(home, "tickets");
    writeTickets(dir);
    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const csrf = csrfFrom((await text(`${server.url}/`)).body);
      const dryCli = runCli(["import", dir, "--repo", "web", "--workflow", "feature", "--dry-run"], { cwd, home });
      assert.equal(dryCli.status, 0, dryCli.stderr);
      const dry = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        dryRun: true,
        source: { kind: "tickets", dir },
      });
      assert.equal(dry.status, 200, dry.body);
      const preview = JSON.parse(dry.body) as {
        dryRun: boolean;
        ids: string[];
        report: string;
        jobs: { label: string; workflow: string; dependsOn: string[]; status: string }[];
      };
      assert.equal(preview.dryRun, true);
      assert.deepEqual(preview.ids, []);
      assert.equal(preview.report, dryCli.stdout);
      assert.equal(preview.jobs.find((job) => job.label === "02")?.workflow, "feature");
      assert.deepEqual(preview.jobs.find((job) => job.label === "02")?.dependsOn, ["01"]);
      assert.equal(existsSync(join(home, ".kiln", "jobs")), false);

      const created = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "tickets", dir },
      });
      assert.equal(created.status, 200, created.body);
      const ids = (JSON.parse(created.body) as { ids: string[] }).ids;
      assert.equal(ids.length, 2);

      const other = workDir("kiln-serve-tickets-cli-");
      mkdirSync(join(other.home, "web"));
      register(other.cwd, other.home, "web", join(other.home, "web"));
      const cli = runCli(["import", dir, "--repo", "web", "--workflow", "feature"], { cwd: other.cwd, home: other.home });
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(digest(home), digest(other.home));

      const again = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "tickets", dir },
      });
      assert.equal(again.status, 200, again.body);
      const second = JSON.parse(again.body) as { ids: string[]; report: string };
      assert.deepEqual(second.ids, []);
      assert.match(second.report, /unchanged/);
      assert.equal(readJobs(home).length, 2);
    } finally {
      await stop(server.child);
    }
  });

  it("returns readable validation errors and rejects a bad origin, host, or csrf token", async () => {
    const { cwd, home } = workDir("kiln-serve-reject-");
    const web = join(home, "web");
    mkdirSync(web);
    register(cwd, home, "web", web);
    useMock(home);
    const outside = join(cwd, "outside.md");
    writeFileSync(outside, "# Outside\n\nno\n");
    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const page = await text(`${server.url}/`);
      const csrf = csrfFrom(page.body);
      const before = readJobs(home).length;

      const empty = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "prompt", text: "  \n" },
      });
      assert.equal(empty.status, 400);
      assert.match(JSON.parse(empty.body).error, /Prompt is empty/);

      const kind = await postJob(server.url, csrf, { repo: "web", workflow: "feature", source: { kind: "clipboard" } });
      assert.equal(kind.status, 400);
      assert.match(JSON.parse(kind.body).error, /Source kind must be prompt, spec, tickets, or jira/);

      const repo = await postJob(server.url, csrf, { workflow: "feature", source: { kind: "prompt", text: "Hi\n" } });
      assert.equal(repo.status, 400);
      assert.match(JSON.parse(repo.body).error, /Name a repo/);

      const missing = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        after: ["missing-job"],
        source: { kind: "prompt", text: "Depends on nothing\n" },
      });
      assert.equal(missing.status, 400);
      assert.match(JSON.parse(missing.body).error, /does not exist/);

      const relative = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "spec", path: "sunday.md" },
      });
      assert.equal(relative.status, 400);
      assert.match(JSON.parse(relative.body).error, /Spec path must be an absolute path/);

      const escaped = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "spec", path: outside },
      });
      assert.equal(escaped.status, 403);
      assert.match(JSON.parse(escaped.body).error, /outside the home directory/);

      const key = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        source: { kind: "jira", key: "not a key" },
      });
      assert.equal(key.status, 400);
      assert.match(JSON.parse(key.body).error, /not a KEY-123/);

      const titled = await postJob(server.url, csrf, {
        repo: "web",
        workflow: "feature",
        title: "Nope",
        source: { kind: "tickets", dir: join(home, "tickets") },
      });
      assert.equal(titled.status, 400);
      assert.match(JSON.parse(titled.body).error, /does not take a title/);

      const noToken = await text(`${server.url}/api/jobs`, {
        method: "POST",
        headers: { Origin: server.url, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "web", workflow: "feature", source: { kind: "prompt", text: "Hi\n" } }),
      });
      assert.equal(noToken.status, 403);
      assert.match(noToken.body, /CSRF token rejected/);

      const wrongToken = await postJob(server.url, "0".repeat(64), {
        repo: "web",
        workflow: "feature",
        source: { kind: "prompt", text: "Hi\n" },
      });
      assert.equal(wrongToken.status, 403);
      assert.match(wrongToken.body, /CSRF token rejected/);

      const evil = await postJob(
        server.url,
        csrf,
        { repo: "web", workflow: "feature", source: { kind: "prompt", text: "Hi\n" } },
        { Origin: "http://evil.example" },
      );
      assert.equal(evil.status, 403);
      assert.match(evil.body, /Cross-origin request rejected/);

      const evilHost = await raw(`${server.url}/api/jobs`, {
        method: "POST",
        headers: {
          Host: "evil.example",
          Origin: server.url,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Kiln-CSRF": csrf,
        },
        body: JSON.stringify({ repo: "web", workflow: "feature", source: { kind: "prompt", text: "Hi\n" } }),
      });
      assert.equal(evilHost.status, 403);
      assert.match(evilHost.body, /Cross-origin request rejected/);
      assert.equal(readJobs(home).length, before);
      assert.equal(page.body.includes(TOKEN), false);
    } finally {
      await stop(server.child);
    }
  });

  it("lists markdown under the home directory and refuses the rest", async () => {
    const { cwd, home } = workDir("kiln-serve-fs-");
    const web = join(home, "web");
    mkdirSync(web);
    register(cwd, home, "web", web);
    const lines = Array.from({ length: 50 }, (_, index) => `L${index + 1}`);
    lines[0] = "SENTINEL-LINE";
    writeFileSync(join(home, "note.md"), `${lines.join("\n")}\n`);
    mkdirSync(join(home, "docs"));
    writeFileSync(join(home, "notes.txt"), "not markdown\n");
    mkdirSync(join(home, ".hidden"));
    writeFileSync(join(home, ".hidden", "secret.md"), "DOT-SECRET\n");
    const outside = join(cwd, "outside.md");
    writeFileSync(outside, "# Outside\n");
    symlinkSync(outside, join(home, "link.md"));
    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const csrf = csrfFrom((await text(`${server.url}/`)).body);
      const listing = await text(`${server.url}/api/fs?path=${encodeURIComponent(home)}`);
      assert.equal(listing.status, 200, listing.body);
      const listed = JSON.parse(listing.body) as { entries: { name: string; kind: string }[]; parent: string | null };
      const names = listed.entries.map((entry) => entry.name);
      assert.ok(names.includes("docs"));
      assert.ok(names.includes("note.md"));
      assert.ok(names.includes("web"));
      assert.equal(names.includes("notes.txt"), false);
      assert.equal(names.some((name) => name.startsWith(".")), false);
      assert.equal(listing.body.includes("SENTINEL-LINE"), false);
      assert.equal(listing.body.includes("DOT-SECRET"), false);
      assert.equal(listed.parent, null);

      const preview = await text(`${server.url}/api/fs?path=${encodeURIComponent(join(home, "note.md"))}`);
      assert.equal(preview.status, 200, preview.body);
      const file = JSON.parse(preview.body) as { preview: string; kind: string; truncated: boolean };
      assert.equal(file.kind, "file");
      assert.equal(file.truncated, true);
      assert.match(file.preview, /SENTINEL-LINE/);
      assert.match(file.preview, /L40/);
      assert.doesNotMatch(file.preview, /L41/);

      const textFile = await text(`${server.url}/api/fs?path=${encodeURIComponent(join(home, "notes.txt"))}`);
      assert.equal(textFile.status, 400);
      assert.match(textFile.body, /Only \.md files can be previewed/);

      const hidden = await text(`${server.url}/api/fs?path=${encodeURIComponent(join(home, ".hidden"))}`);
      assert.equal(hidden.status, 403);
      assert.match(hidden.body, /Hidden files are not listed/);

      const outsideDir = await text(`${server.url}/api/fs?path=${encodeURIComponent(join(home, ".."))}`);
      assert.equal(outsideDir.status, 403);
      assert.match(outsideDir.body, /outside the home directory/);

      const link = await text(`${server.url}/api/fs?path=${encodeURIComponent(join(home, "link.md"))}`);
      assert.equal(link.status, 403);
      assert.match(link.body, /outside the home directory/);

      const evil = await text(`${server.url}/api/fs?path=${encodeURIComponent(home)}`, {
        headers: { Origin: "http://evil.example" },
      });
      assert.equal(evil.status, 403);
      assert.match(evil.body, /Cross-origin request rejected/);

      const evilHost = await raw(`${server.url}/api/fs?path=${encodeURIComponent(home)}`, {
        headers: { Host: "evil.example", "X-Kiln-CSRF": csrf },
      });
      assert.equal(evilHost.status, 403);
      assert.match(evilHost.body, /Cross-origin request rejected/);
      assert.equal(evilHost.body.includes("SENTINEL-LINE"), false);
    } finally {
      await stop(server.child);
    }
  });
});

describe("serve config reload", () => {
  it("picks up a repo and maxAttempts, keeps the last good config when the file breaks, and redacts the new token", async () => {
    const { cwd, home } = workDir("kiln-serve-reload-");
    const web = join(home, "web");
    mkdirSync(web);
    register(cwd, home, "web", web);
    useMock(home);
    const configPath = join(home, ".kiln", "kiln.config.json");
    const created = runCli(["add", "feature", "--repo", "web", "--prompt", "Hold the config\n"], { cwd, home });
    assert.equal(created.status, 0, created.stderr);
    const id = addedId(created.stdout);
    const server = await startServe(["--port", "0", "--no-tick"], { cwd, home });
    try {
      const before = JSON.parse((await text(`${server.url}/api/status`)).body) as {
        repos: { name: string }[];
        configError: string | null;
      };
      assert.deepEqual(before.repos.map((repo) => repo.name), ["web"]);
      assert.equal(before.configError, null);
      const job = JSON.parse((await text(`${server.url}/api/jobs/${id}`)).body) as { maxAttempts: number };
      assert.equal(job.maxAttempts, 3);

      const api = join(home, "api");
      mkdirSync(api);
      register(cwd, home, "api", api);
      const added = JSON.parse((await text(`${server.url}/api/status`)).body) as { repos: { name: string }[] };
      assert.deepEqual(added.repos.map((repo) => repo.name).sort(), ["api", "web"]);

      const raw = JSON.parse(readFileSync(configPath, "utf8")) as { maxAttempts?: number };
      raw.maxAttempts = 9;
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
      const bumped = JSON.parse((await text(`${server.url}/api/jobs/${id}`)).body) as { maxAttempts: number };
      assert.equal(bumped.maxAttempts, 9);

      const good = readFileSync(configPath, "utf8");
      writeFileSync(configPath, "{");
      const brokenPage = await text(`${server.url}/`);
      assert.match(brokenPage.body, /id="config-error"/);
      assert.doesNotMatch(brokenPage.body, /id="config-error"[^>]*hidden/);
      assert.match(brokenPage.body, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(brokenPage.body, /Could not read kiln config/);
      const broken = JSON.parse((await text(`${server.url}/api/status`)).body) as {
        repos: { name: string }[];
        configError: string;
        jobs: { jobId: string }[];
      };
      assert.match(broken.configError, /Could not read kiln config/);
      assert.match(broken.configError, /kiln\.config\.json/);
      assert.deepEqual(broken.repos.map((repo) => repo.name).sort(), ["api", "web"]);
      assert.ok(broken.jobs.some((item) => item.jobId === id));
      const still = await text(`${server.url}/api/jobs/${id}`);
      assert.equal(still.status, 200);

      writeFileSync(configPath, good);
      const fixed = JSON.parse((await text(`${server.url}/api/status`)).body) as { configError: string | null };
      assert.equal(fixed.configError, null);
      const cleared = await text(`${server.url}/`);
      assert.match(cleared.body, /id="config-error"[^>]*hidden/);
      assert.doesNotMatch(cleared.body, /Could not read kiln config/);

      const next = JSON.parse(readFileSync(configPath, "utf8")) as { jira: { apiToken: string } };
      next.jira.apiToken = TOKEN_B;
      writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
      const titled = runCli(["add", "feature", "--repo", "web", "--prompt", "A quiet line\n", "--title", TOKEN_B], {
        cwd,
        home,
      });
      assert.equal(titled.status, 0, titled.stderr);
      const html = await text(`${server.url}/`);
      assert.equal(html.body.includes(TOKEN_B), false);
      assert.equal(html.body.includes(TOKEN), false);
      assert.match(html.body, /\[redacted\]/);
      const listed = await text(`${server.url}/api/status`);
      assert.equal(listed.body.includes(TOKEN_B), false);
    } finally {
      await stop(server.child);
    }
  });

  it("ticks a repo that was registered after serve started", { timeout: 120_000 }, async () => {
    const { cwd, home } = workDir("kiln-serve-tick-repo-");
    const web = join(home, "web");
    initCheckout(web);
    register(cwd, home, "web", web);
    useMock(home);
    const server = await startServe(["--port", "0", "--tick", "1"], { cwd, home });
    try {
      const api = join(home, "api");
      initCheckout(api);
      register(cwd, home, "api", api);
      const config = JSON.parse(readFileSync(join(home, ".kiln", "kiln.config.json"), "utf8")) as { adapter?: string };
      assert.equal(config.adapter, "mock");
      const status = JSON.parse((await text(`${server.url}/api/status`)).body) as { repos: { name: string }[] };
      assert.ok(status.repos.some((repo) => repo.name === "api"));
      const created = runCli(["add", "feature", "--repo", "api", "--prompt", "Launch from the new repo\n"], { cwd, home });
      assert.equal(created.status, 0, created.stderr);
      const id = addedId(created.stdout);
      const start = Date.now();
      let state = "";
      let last = "";
      while (Date.now() - start < 60_000) {
        const job = await text(`${server.url}/api/jobs/${id}`);
        last = job.body;
        if (job.status === 200) state = (JSON.parse(job.body) as { state: string }).state;
        if (state && state !== "queued" && state !== "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.match(state, /running|needs-human|approved|done/, last);
      assert.doesNotMatch(last, /Unknown repo/);
    } finally {
      await stop(server.child);
      await reapLaunches(cwd);
    }
  });
});
