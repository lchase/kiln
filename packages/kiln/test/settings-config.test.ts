import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SECRET_PLACEHOLDER } from "../src/schemas.js";
import { readSettings, saveSettings } from "../src/settings.js";

const TOKEN = "kiln-test-jira-token-do-not-render";
const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { home: string; configPath: string; revision: string } {
  const home = mkdtempSync(join(tmpdir(), "kiln-settings-config-"));
  keep.push(home);
  const checkout = join(home, "web");
  mkdirSync(checkout, { recursive: true });
  const configPath = join(home, "kiln.config.json");
  const original = {
    note: "bench",
    owner: "synthetic",
    adapter: "mock",
    maxConcurrent: 2,
    reviewPrompt: "prompts/review.md",
    workflows: { feature: { sandbox: { mode: "off" }, extra: "keep" } },
    repos: { web: { path: checkout, test: "npm test", custom: "keep-me" } },
    jira: {
      baseUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      apiToken: TOKEN,
      acceptanceField: "customfield_10001",
    },
    triggers: [{ id: "sample-ready", kind: "jira", repo: "web", every: "5m", label: "sample" }],
  };
  const contents = `${JSON.stringify(original, null, 2)}\n`;
  writeFileSync(configPath, contents);
  return { home, configPath, revision: createHash("sha256").update(contents).digest("hex") };
}

describe("settings config", () => {
  it("redacts the token on read and keeps it across a form save", () => {
    const { home, configPath, revision } = fixture();
    const loaded = readSettings(configPath, {});
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(JSON.stringify(loaded.document).includes(TOKEN), false);
    assert.equal(loaded.document.jira.token, "set in file");
    assert.equal(loaded.document.jira.acceptanceField, "customfield_10001");
    assert.equal(loaded.document.file.jira && (loaded.document.file.jira as { apiToken?: string }).apiToken, SECRET_PLACEHOLDER);
    assert.equal(loaded.document.revision, revision);
    assert.equal(loaded.document.triggers.some((trigger) => trigger.id === "sample-ready"), true);
    assert.equal(loaded.document.triggers.some((trigger) => trigger.id === "review-requests" && trigger.builtin), true);

    const saved = saveSettings(
      configPath,
      {
        revision,
        repos: { web: { path: join(home, "web"), test: "npm test" } },
        maxConcurrent: 4,
        jira: { baseUrl: "https://example.atlassian.net", email: "qa@example.com", acceptanceField: "" },
        triggers: [{ id: "sample-ready", kind: "jira", repo: "web", every: "15m", status: "Ready" }],
      },
      home,
      {},
    );
    assert.equal(saved.ok, true, saved.ok ? "" : JSON.stringify(saved.body));
    if (!saved.ok) return;
    assert.equal(JSON.stringify(saved.document).includes(TOKEN), false);
    assert.equal(saved.document.jira.email, "qa@example.com");
    assert.equal(saved.document.jira.acceptanceField, undefined);
    assert.equal(saved.document.jira.token, "set in file");
    const file = JSON.parse(readFileSync(configPath, "utf8")) as {
      owner: string;
      reviewPrompt: string;
      maxConcurrent: number;
      jira: { apiToken: string; email: string; acceptanceField?: string };
      repos: { web: { custom?: string } };
      workflows: { feature: { sandbox: { mode: string }; extra: string } };
      triggers: { id: string; every?: string; status?: string }[];
    };
    assert.equal(file.jira.apiToken, TOKEN);
    assert.equal(file.jira.email, "qa@example.com");
    assert.equal(file.jira.acceptanceField, undefined);
    assert.equal(file.owner, "synthetic");
    assert.equal(file.reviewPrompt, "prompts/review.md");
    assert.equal(file.maxConcurrent, 4);
    assert.equal(file.repos.web.custom, "keep-me");
    assert.equal(file.workflows.feature.extra, "keep");
    assert.equal(file.triggers[0]?.every, "15m");
    assert.equal(file.triggers[0]?.status, "Ready");
    assert.match(readFileSync(configPath, "utf8"), /\n  "note": "bench"/);
  });

  it("reports set in env without copying the environment token into the file", () => {
    const { configPath } = fixture();
    const envToken = "env-token-value-not-in-the-body";
    const loaded = readSettings(configPath, { JIRA_API_TOKEN: envToken });
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.document.jira.token, "set in env");
    assert.equal(JSON.stringify(loaded.document).includes(TOKEN), false);
    assert.equal(JSON.stringify(loaded.document).includes(envToken), false);
  });

  it("rejects a new token, a bad field, and a stale revision without writing", () => {
    const { home, configPath, revision } = fixture();
    const original = readFileSync(configPath, "utf8");
    const repos = { web: { path: join(home, "web") } };

    const token = saveSettings(
      configPath,
      { revision, repos, jira: { apiToken: "settings-should-not-store-this-token" } },
      home,
      {},
    );
    assert.equal(token.ok, false);
    if (token.ok) return;
    assert.equal(token.status, 400);
    assert.match(token.body.fields?.["jira.apiToken"] ?? "", /JIRA_API_TOKEN/);
    assert.equal(JSON.stringify(token.body).includes("settings-should-not-store-this-token"), false);
    assert.equal(JSON.stringify(token.body).includes(TOKEN), false);

    const bad = saveSettings(configPath, { revision, repos, adapter: "nope", maxConcurrent: 0 }, home, {});
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.status, 400);
    assert.ok(bad.body.fields?.adapter);
    assert.match(bad.body.fields?.maxConcurrent ?? "", /at least 1/);

    const duplicate = saveSettings(
      configPath,
      {
        revision,
        repos,
        routes: [
          { id: "sample-ready", trigger: "sample-ready", action: "create" },
          { id: "sample-ready", trigger: "sample-ready", action: "attach" },
        ],
      },
      home,
      {},
    );
    assert.equal(duplicate.ok, false);
    if (duplicate.ok) return;
    assert.match(duplicate.body.fields?.["routes.1.id"] ?? "", /already used/);

    writeFileSync(configPath, original.replace('"bench"', '"edited"'));
    const stale = saveSettings(configPath, { revision, repos, maxConcurrent: 9 }, home, {});
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.status, 409);
    const file = JSON.parse(readFileSync(configPath, "utf8")) as { note: string; maxConcurrent: number; jira: { apiToken: string } };
    assert.equal(file.note, "edited");
    assert.equal(file.maxConcurrent, 2);
    assert.equal(file.jira.apiToken, TOKEN);
  });

  it("saves the raw file through the same schema check and preserves a placeholder token", () => {
    const { home, configPath } = fixture();
    const loaded = readSettings(configPath, {});
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const next = {
      ...loaded.document.file,
      maxConcurrent: 6,
      reviewPrompt: "prompts/custom-review.md",
      workflows: { feature: { sandbox: { mode: "docker" }, extra: "keep" } },
    };
    const saved = saveSettings(configPath, { revision: loaded.document.revision, file: next }, home, {});
    assert.equal(saved.ok, true, saved.ok ? "" : JSON.stringify(saved.body));
    if (!saved.ok) return;
    assert.equal(JSON.stringify(saved.document).includes(TOKEN), false);
    const file = JSON.parse(readFileSync(configPath, "utf8")) as {
      maxConcurrent: number;
      reviewPrompt: string;
      jira: { apiToken: string };
      workflows: { feature: { sandbox: { mode: string }; extra: string } };
      owner: string;
    };
    assert.equal(file.maxConcurrent, 6);
    assert.equal(file.reviewPrompt, "prompts/custom-review.md");
    assert.equal(file.jira.apiToken, TOKEN);
    assert.equal(file.workflows.feature.sandbox.mode, "docker");
    assert.equal(file.workflows.feature.extra, "keep");
    assert.equal(file.owner, "synthetic");

    const again = readSettings(configPath, {});
    assert.equal(again.ok, true);
    if (!again.ok) return;
    const planted = { ...again.document.file, jira: { ...(again.document.file.jira as object), apiToken: "brand-new-token-value" } };
    const rejected = saveSettings(configPath, { revision: again.document.revision, file: planted }, home, {});
    assert.equal(rejected.ok, false);
    if (rejected.ok) return;
    assert.equal(rejected.status, 400);
    assert.equal(JSON.stringify(rejected.body).includes("brand-new-token-value"), false);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).jira.apiToken, TOKEN);

    const invalid = saveSettings(
      configPath,
      { revision: again.document.revision, file: { ...again.document.file, routes: [{ id: "bad id", trigger: "sample-ready", action: "create" }] } },
      home,
      {},
    );
    assert.equal(invalid.ok, false);
    if (invalid.ok) return;
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.fields?.["routes.0.id"]);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).reviewPrompt, "prompts/custom-review.md");
  });
});
