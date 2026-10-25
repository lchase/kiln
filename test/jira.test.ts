import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadKilnConfig, type LoadedKilnConfig } from "../src/config.js";
import { addFromJira, type AddJiraInput } from "../src/intake/jira.js";
import { writeJob } from "../src/jobs.js";
import { packageRoot } from "../src/paths.js";

const TOKEN = "kiln-test-token";
const EMAIL = "dev@example.com";
const BASE = "https://acme.atlassian.net";
const root = packageRoot();
const keep: string[] = [];

interface StoredJob {
  id: string;
  repo: string;
  workflow: string;
  spec: string;
  title: string;
  dependsOn?: string[];
  source?: { kind: string; ref: string };
  createdAt: string;
}

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function tempKiln(jira?: Record<string, string>): { cwd: string; home: string; config: LoadedKilnConfig } {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-jira-"));
  keep.push(cwd);
  const home = join(cwd, "home");
  const kiln = join(home, ".kiln");
  const checkout = join(cwd, "web");
  mkdirSync(kiln, { recursive: true });
  mkdirSync(checkout);
  const file: Record<string, unknown> = { repos: { web: { path: checkout } } };
  if (jira) file.jira = jira;
  const configPath = join(kiln, "kiln.config.json");
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`);
  return { cwd, home, config: loadKilnConfig(configPath, { home }) };
}

function envCreds(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    JIRA_BASE_URL: BASE,
    JIRA_EMAIL: EMAIL,
    JIRA_API_TOKEN: TOKEN,
    ...overrides,
  };
}

function readJobs(config: LoadedKilnConfig): StoredJob[] {
  const dir = config.jobsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as StoredJob);
}

function specText(config: LoadedKilnConfig, job: StoredJob): string {
  return readFileSync(join(config.kilnDir, job.spec), "utf8");
}

function assertNoSecret(text: string): void {
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(Buffer.from(`${EMAIL}:${TOKEN}`, "utf8").toString("base64")), false);
}

interface Route {
  status: number;
  body: unknown;
}

function stubFetch(handler: (url: string) => Route): {
  fetch: typeof fetch;
  calls: { url: string; authorization: string }[];
} {
  const calls: { url: string; authorization: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, authorization: authorizationOf(init) });
    const route = handler(url);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

function authorizationOf(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get("authorization") ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find(([name]) => name.toLowerCase() === "authorization");
    return found?.[1] ?? "";
  }
  const record = headers as Record<string, string>;
  return record.Authorization ?? record.authorization ?? "";
}

function boomFetch(): typeof fetch {
  return async () => {
    throw new Error("fetch should not be called");
  };
}

function routes(issueBody: unknown, fields: unknown = []): (url: string) => Route {
  return (url) => {
    if (url.includes("/rest/api/3/field")) return { status: 200, body: fields };
    if (url.includes("/rest/api/3/issue/")) return { status: 200, body: issueBody };
    return { status: 404, body: { errorMessages: ["Unknown Jira route."] } };
  };
}

function issue(key: string, fields: Record<string, unknown>): unknown {
  return { id: "10001", key, fields };
}

const realisticDescription = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "The sample page lists items for " },
        { type: "text", text: "PROJ", marks: [{ type: "strong" }] },
        { type: "text", text: ". When the list is empty, show a " },
        { type: "text", text: "quiet", marks: [{ type: "em" }] },
        { type: "text", text: " sentence. See " },
        {
          type: "text",
          text: "the notes",
          marks: [{ type: "link", attrs: { href: "https://example.com/notes" } }],
        },
        { type: "text", text: ". Use " },
        { type: "text", text: "empty", marks: [{ type: "code" }] },
        { type: "text", text: " as the state name." },
        { type: "media", attrs: { id: "file-1" } },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Details" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Read the list" }] }],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Show the sentence" },
                { type: "hardBreak" },
                { type: "text", text: "Keep the layout" },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { order: 1 },
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Ship the copy" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Link the summary" }] }],
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: 'const state = "empty";\n' }],
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "No product code in the notes." }],
        },
      ],
    },
    { type: "rule" },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Done when the page renders. " },
        { type: "mention", attrs: { text: "@dev" } },
      ],
    },
    {
      type: "panel",
      attrs: { panelType: "info" },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Ask before renaming the module." }],
        },
      ],
    },
  ],
};

const expectedSpec = [
  "# PROJ-1: Show the empty state",
  "Source: https://acme.atlassian.net/browse/PROJ-1",
  "",
  "The sample page lists items for **PROJ**. When the list is empty, show a *quiet* sentence. See [the notes](https://example.com/notes). Use `empty` as the state name.",
  "",
  "## Details",
  "",
  "- Read the list",
  "- Show the sentence\\",
  "  Keep the layout",
  "",
  "1. Ship the copy",
  "2. Link the summary",
  "",
  "```ts",
  'const state = "empty";',
  "```",
  "",
  "> No product code in the notes.",
  "",
  "---",
  "",
  "Done when the page renders. @dev",
  "",
  "Ask before renaming the module.",
  "",
].join("\n");

function addInput(
  key: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
  extra: Partial<AddJiraInput> = {},
): AddJiraInput {
  return {
    workflow: "feature",
    repo: "web",
    key,
    dependsOn: [],
    dryRun: false,
    fetch: fetchImpl,
    env,
    ...extra,
  };
}

function runCli(args: string[], cwd: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILN_HOME;
  delete env.JIRA_BASE_URL;
  delete env.JIRA_EMAIL;
  delete env.JIRA_API_TOKEN;
  const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("jira intake", () => {
  it("converts a realistic ADF description into the job spec", async () => {
    const { cwd, config } = tempKiln();
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: realisticDescription,
      issuetype: { name: "Story" },
      issuelinks: [],
      status: { name: "To Do" },
    });
    const stub = stubFetch(routes(body));
    const result = await addFromJira(config, addInput("proj-1", stub.fetch, envCreds()));
    assert.equal(result.created, true);
    assert.equal(result.warnings.length, 0);
    const job = readJobs(config)[0];
    assert.ok(job);
    assert.equal(job.id, result.job?.id);
    assert.equal(job.title, "PROJ-1: Show the empty state");
    assert.equal(job.repo, "web");
    assert.equal(job.workflow, "feature");
    assert.equal(job.dependsOn, undefined);
    assert.deepEqual(job.source, { kind: "jira", ref: "PROJ-1" });
    assert.equal(specText(config, job), expectedSpec);
    assert.match(result.report, new RegExp(`^added ${job.id}\\n`));
    assert.match(result.report, /source jira PROJ-1/);
    const issueCall = stub.calls.find((call) => call.url.includes("/rest/api/3/issue/PROJ-1"));
    assert.ok(issueCall);
    const fields = new URL(issueCall.url).searchParams.get("fields");
    assert.equal(fields, "summary,description,issuetype,issuelinks,status");
    const expectedAuth = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`, "utf8").toString("base64")}`;
    for (const call of stub.calls) {
      assert.equal(call.authorization, expectedAuth);
      assert.equal(call.url.includes(TOKEN), false);
    }
    assertNoSecret(result.report);
    assertNoSecret(specText(config, job));
    assertNoSecret(JSON.stringify(job));
    assert.equal(readFileSync(config.configPath, "utf8").includes(TOKEN), false);
  });

  it("appends acceptance criteria when that custom field is listed", async () => {
    const { cwd, config } = tempKiln();
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "List the items." }] }],
      },
      issuetype: { name: "Story" },
      issuelinks: [],
      status: { name: "To Do" },
      customfield_10050: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "The page shows the empty sentence." }] },
        ],
      },
    });
    const fields = [
      { id: "customfield_10099", name: "Acceptance Criteria Notes" },
      { id: "customfield_10050", name: "Acceptance Criteria" },
    ];
    const stub = stubFetch(routes(body, fields));
    const result = await addFromJira(config, addInput("PROJ-1", stub.fetch, envCreds()));
    assert.equal(result.created, true);
    const job = readJobs(config)[0];
    assert.ok(job);
    const spec = specText(config, job);
    assert.match(spec, /^# PROJ-1: Show the empty state\nSource: https:\/\/acme\.atlassian\.net\/browse\/PROJ-1\n\nList the items\.\n\n## Acceptance criteria\n\nThe page shows the empty sentence\.\n$/);
    const issueCall = stub.calls.find((call) => call.url.includes("/rest/api/3/issue/"));
    assert.ok(issueCall);
    assert.equal(
      new URL(issueCall.url).searchParams.get("fields"),
      "summary,description,issuetype,issuelinks,status,customfield_10050",
    );
  });

  it("maps an existing blocked-by job into dependsOn and warns when the job is missing", async () => {
    const { cwd, config } = tempKiln();
    const blocker = issue("PROJ-1", {
      summary: "List the platform facts",
      description: { type: "doc", version: 1, content: [] },
      issuetype: { name: "Task" },
      issuelinks: [],
      status: { name: "Done" },
    });
    const first = await addFromJira(
      config,
      addInput("PROJ-1", stubFetch(routes(blocker)).fetch, envCreds(), {
        now: new Date("2026-10-25T01:00:00.000Z"),
      }),
    );
    assert.ok(first.job);
    const other = writeJob(config, {
      workflow: "feature",
      repo: "web",
      specText: "# Notes\n\nA separate prompt job.\n",
      title: "Notes",
      dependsOn: [],
      source: { kind: "prompt", ref: "inline" },
      now: new Date("2026-10-25T01:01:00.000Z"),
    });
    const blocked = issue("PROJ-2", {
      summary: "Render the empty state",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Show the sentence." }] }],
      },
      issuetype: { name: "Task" },
      status: { name: "To Do" },
      issuelinks: [
        {
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          inwardIssue: { key: "PROJ-1" },
        },
        {
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          inwardIssue: { key: "proj-9" },
        },
        {
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          outwardIssue: { key: "PROJ-8" },
        },
        {
          type: { name: "Relates", inward: "relates to", outward: "relates to" },
          inwardIssue: { key: "PROJ-7" },
        },
        {
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          inwardIssue: { key: "PROJ-1" },
        },
      ],
    });
    const result = await addFromJira(
      config,
      addInput("proj-2", stubFetch(routes(blocked)).fetch, envCreds(), {
        dependsOn: [first.job.id, other.job.id],
        now: new Date("2026-10-25T01:02:00.000Z"),
      }),
    );
    assert.equal(result.created, true);
    assert.deepEqual(result.warnings, ["warning: blocked by PROJ-9, which has no kiln job yet."]);
    const job = readJobs(config).find((candidate) => candidate.source?.ref === "PROJ-2");
    assert.ok(job);
    assert.deepEqual(job.dependsOn, [first.job.id, other.job.id]);
    assert.equal(job.title, "PROJ-2: Render the empty state");
    assert.match(specText(config, job), /^# PROJ-2: Render the empty state\nSource: https:\/\/acme\.atlassian\.net\/browse\/PROJ-2\n/);
    assert.doesNotMatch(result.warnings.join("\n"), /PROJ-8/);
    assert.doesNotMatch(result.warnings.join("\n"), /PROJ-7/);
  });

  it("prints the existing job id and creates nothing on a second add", async () => {
    const { cwd, config } = tempKiln();
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: null,
      issuetype: { name: "Task" },
      issuelinks: [],
      status: { name: "To Do" },
    });
    const created = await addFromJira(config, addInput("PROJ-1", stubFetch(routes(body)).fetch, envCreds()));
    assert.ok(created.job);
    const before = readFileSync(join(config.kilnDir, created.job.spec), "utf8");
    const again = await addFromJira(config, addInput("proj-1", boomFetch(), {}, { dryRun: true }));
    assert.equal(again.created, false);
    assert.equal(again.job?.id, created.job.id);
    assert.equal(again.warnings.length, 0);
    assert.match(again.report, new RegExp(`^exists ${created.job.id}\\n`));
    assert.match(again.report, /source jira PROJ-1/);
    assert.equal(readJobs(config).length, 1);
    assert.equal(readFileSync(join(config.kilnDir, created.job.spec), "utf8"), before);
  });

  it("names each missing credential and does not call fetch", async () => {
    const { config } = tempKiln();
    await assert.rejects(
      () => addFromJira(config, addInput("PROJ-1", boomFetch(), {})),
      /Jira credentials are missing: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN\./,
    );
    await assert.rejects(
      () =>
        addFromJira(
          config,
          addInput("PROJ-1", boomFetch(), { JIRA_BASE_URL: BASE, JIRA_EMAIL: EMAIL }),
        ),
      /Jira credentials are missing: JIRA_API_TOKEN\./,
    );
  });

  it("reads credentials from the jira config block when the environment is empty", async () => {
    const { cwd, config } = tempKiln({
      baseUrl: `${BASE}/`,
      email: `  ${EMAIL}  `,
      apiToken: TOKEN,
    });
    assert.equal(config.jira?.baseUrl, `${BASE}/`);
    assert.equal(config.jira?.email, EMAIL);
    assert.equal(config.jira?.apiToken, TOKEN);
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: null,
      issuetype: { name: "Task" },
      issuelinks: [],
      status: { name: "To Do" },
    });
    const stub = stubFetch(routes(body));
    const result = await addFromJira(config, addInput("PROJ-1", stub.fetch, { JIRA_BASE_URL: " ", JIRA_EMAIL: "" }));
    assert.equal(result.created, true);
    const issueCall = stub.calls.find((call) => call.url.includes("/rest/api/3/issue/"));
    assert.ok(issueCall);
    assert.equal(issueCall.url.startsWith(`${BASE}/rest/api/3/issue/PROJ-1`), true);
    assert.equal(issueCall.authorization, `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`, "utf8").toString("base64")}`);
    const job = readJobs(config)[0];
    assert.ok(job);
    assertNoSecret(specText(config, job));
    assertNoSecret(result.report);
    assertNoSecret(result.warnings.join("\n"));
  });

  it("lets environment credentials override the config block", async () => {
    const { config } = tempKiln({
      baseUrl: "https://other.example.test",
      email: "other@example.com",
      apiToken: "other-token",
    });
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: null,
      issuetype: { name: "Task" },
      issuelinks: [],
      status: { name: "To Do" },
    });
    const stub = stubFetch(routes(body));
    await addFromJira(config, addInput("PROJ-1", stub.fetch, envCreds()));
    const issueCall = stub.calls.find((call) => call.url.includes("/rest/api/3/issue/"));
    assert.ok(issueCall);
    assert.equal(issueCall.url.startsWith(`${BASE}/rest/api/3/issue/PROJ-1`), true);
    assert.equal(issueCall.authorization, `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`, "utf8").toString("base64")}`);
    assert.equal(issueCall.url.includes("other-token"), false);
  });

  it("turns HTTP 404 and 401 into errors that name the issue and hide the token", async () => {
    const { cwd, config } = tempKiln();
    const missing = stubFetch((url) => {
      if (url.includes("/rest/api/3/field")) return { status: 200, body: [] };
      return {
        status: 404,
        body: {
          errorMessages: [`Issue does not exist or you do not have permission to see it. ${TOKEN}`],
          errors: {},
        },
      };
    });
    await assert.rejects(
      () => addFromJira(config, addInput("PROJ-9", missing.fetch, envCreds())),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Jira issue PROJ-9 was not found \(HTTP 404\)/);
        assert.match(message, /Issue does not exist or you do not have permission to see it\./);
        assertNoSecret(message);
        return true;
      },
    );
    const denied = stubFetch((url) => {
      if (url.includes("/rest/api/3/field")) return { status: 200, body: [] };
      return { status: 401, body: { errorMessages: [`Unauthorized ${TOKEN}`] } };
    });
    await assert.rejects(
      () => addFromJira(config, addInput("PROJ-1", denied.fetch, envCreds())),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Jira authentication failed for PROJ-1 \(HTTP 401\)/);
        assert.match(message, /Check JIRA_EMAIL and JIRA_API_TOKEN/);
        assert.match(message, /Unauthorized \[redacted\]/);
        assertNoSecret(message);
        return true;
      },
    );
    assert.equal(existsSync(join(config.kilnDir, "jobs")), false);
    assert.equal(existsSync(join(config.kilnDir, "specs")), false);
  });

  it("dry-run prints the job and writes nothing", async () => {
    const { cwd, config } = tempKiln();
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "List the items." }] }],
      },
      issuetype: { name: "Task" },
      issuelinks: [
        {
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          inwardIssue: { key: "PROJ-9" },
        },
      ],
      status: { name: "To Do" },
    });
    const result = await addFromJira(
      config,
      addInput("PROJ-1", stubFetch(routes(body)).fetch, envCreds(), { dryRun: true }),
    );
    assert.equal(result.created, false);
    assert.equal(result.job, undefined);
    assert.match(result.report, /^dry-run PROJ-1\n/);
    assert.match(result.report, /title PROJ-1: Show the empty state/);
    assert.match(result.report, /source jira PROJ-1/);
    assert.match(result.report, /# PROJ-1: Show the empty state/);
    assert.match(result.report, /Source: https:\/\/acme\.atlassian\.net\/browse\/PROJ-1/);
    assert.match(result.report, /created nothing/);
    assert.deepEqual(result.warnings, ["warning: blocked by PROJ-9, which has no kiln job yet."]);
    assertNoSecret(result.report);
    assert.equal(existsSync(join(config.kilnDir, "jobs")), false);
    assert.equal(existsSync(join(config.kilnDir, "specs")), false);
  });

  it("routes Spike and Research issues to investigation", async () => {
    const { cwd, config } = tempKiln();
    for (const [key, issueType] of [
      ["PROJ-3", "Spike"],
      ["PROJ-4", "Research"],
    ] as const) {
      const body = issue(key, {
        summary: "Time the list query",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Write the number down." }] }],
        },
        issuetype: { name: issueType },
        issuelinks: [],
        status: { name: "To Do" },
      });
      const result = await addFromJira(config, addInput(key, stubFetch(routes(body)).fetch, envCreds()));
      assert.equal(result.created, true);
      assert.equal(result.job?.workflow, "investigation");
      assert.deepEqual(result.warnings, []);
    }
    assert.equal(readJobs(config).length, 2);
    for (const job of readJobs(config)) assert.equal(job.workflow, "investigation");
  });

  it("rejects a Jira key that is not KEY-123 before any request", async () => {
    const { config } = tempKiln();
    await assert.rejects(
      () => addFromJira(config, addInput("not a key", boomFetch(), envCreds())),
      /Jira issue key "not a key" is not a KEY-123 identifier\./,
    );
  });

  it("prints --jira in usage and refuses to mix it with a spec file", () => {
    const { cwd, home } = tempKiln();
    const usage = runCli([], cwd, home);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /--jira <KEY>/);
    const both = runCli(["add", "feature", "--repo", "web", "--jira", "PROJ-1", "--spec", "a.md"], cwd, home);
    assert.equal(both.status, 2);
    const drySpec = runCli(["add", "feature", "--repo", "web", "--spec", "a.md", "--dry-run"], cwd, home);
    assert.equal(drySpec.status, 2);
  });

  it("reports missing credentials from the CLI and does not create a job", () => {
    const { cwd, home, config } = tempKiln();
    const result = runCli(["add", "feature", "--repo", "web", "--jira", "PROJ-1"], cwd, home);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Jira credentials are missing: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
    assert.equal(existsSync(join(config.kilnDir, "jobs")), false);
    assertNoSecret(result.stderr);
  });

  it("prints the existing id from the CLI and status shows source jira", () => {
    const { cwd, home, config } = tempKiln();
    const body = issue("PROJ-1", {
      summary: "Show the empty state",
      description: null,
      issuetype: { name: "Task" },
      issuelinks: [],
      status: { name: "To Do" },
    });
    return addFromJira(config, addInput("PROJ-1", stubFetch(routes(body)).fetch, envCreds())).then((created) => {
      assert.ok(created.job);
      const again = runCli(["add", "feature", "--repo", "web", "--jira", "PROJ-1"], cwd, home);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, new RegExp(`^exists ${created.job?.id}\\n`));
      assert.equal(readJobs(config).length, 1);
      const status = runCli(["status", created.job.id], cwd, home);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /source jira PROJ-1/);
      assert.match(status.stdout, /queued/);
    });
  });
});
