import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { loadKilnConfig } from "../src/config.js";
import { KilnConfigError } from "../src/errors.js";
import { intakeJobs } from "../src/intake-http.js";
import { writeJob } from "../src/jobs.js";
import { renderConsole } from "../src/serve-page.js";
import { saveSettings } from "../src/settings.js";
import {
  assertWorkflowName,
  installedYakLoadsSkillDirs,
  listWorkflowNames,
  materializeWorkflow,
  workflowStepPlan,
} from "../src/workflow.js";

const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

const SHIPPED = ["feature", "fix", "investigation", "review"];

function kilnHome(): { dir: string; home: string; checkout: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "kiln-overlay-"));
  keep.push(dir);
  const home = join(dir, "home");
  const checkout = join(dir, "web");
  mkdirSync(home, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  const configDir = join(home, ".kiln");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ adapter: "mock", repos: { web: { path: checkout, test: "npm test" } } }, null, 2)}\n`,
  );
  return { dir, home, checkout, configPath };
}

function writeLocalWorkflow(workflowsDir: string, name: string, prompt = "prompts/kiln/spike.md"): void {
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    join(workflowsDir, `${name}.yaml`),
    [
      "name: kiln-spike",
      'version: "1"',
      "inputSchema:",
      "  inline:",
      "    type: object",
      "    additionalProperties: false",
      "    properties:",
      "      title: { type: string }",
      "      spec: { type: string }",
      "      runNonce: { type: string }",
      "      baseRef: { type: string }",
      "    required: [title, spec, runNonce, baseRef]",
      "steps:",
      "  - id: explore",
      "    agent:",
      "      prompt:",
      `        file: ${prompt}`,
      "      tools: [Read, Skill]",
      "",
    ].join("\n"),
  );
}

describe("local workflow overlay", () => {
  it("lists packaged names and treats a missing workflows directory as empty", () => {
    const { home } = kilnHome();
    const missing = join(home, ".kiln", "workflows");
    assert.deepEqual(listWorkflowNames(missing), SHIPPED);
    assert.deepEqual(listWorkflowNames(), SHIPPED);
  });

  it("lists a local workflow next to the shipped names and materializes its overlay prompts", () => {
    const { home, checkout, configPath } = kilnHome();
    const workflowsDir = join(home, ".kiln", "workflows");
    const prompts = join(home, ".kiln", "prompts");
    mkdirSync(join(prompts, "kiln"), { recursive: true });
    mkdirSync(join(prompts, "factory"), { recursive: true });
    writeFileSync(
      join(prompts, "kiln", "spike.md"),
      "<!-- factory: prompts/factory/spec-writer.md -->\nLocal spike preamble.\n",
    );
    writeFileSync(join(prompts, "factory", "spec-writer.md"), "Local factory body.\n");
    writeLocalWorkflow(workflowsDir, "spike");

    const names = listWorkflowNames(workflowsDir);
    assert.deepEqual(names, [...SHIPPED, "spike"].sort());
    assert.equal(assertWorkflowName("spike", workflowsDir), join(workflowsDir, "spike.yaml"));
    assert.deepEqual(workflowStepPlan("spike", workflowsDir), ["explore"]);

    const rendered = materializeWorkflow(join(home, ".kiln"), "jspike", "spike", {
      workflowsDir,
      promptsDir: prompts,
    });
    const text = readFileSync(rendered, "utf8");
    assert.doesNotMatch(text, /file: prompts\//);
    const promptFile = text.match(/file: "([^"]*spike-[0-9a-f]+\.md)"/)?.[1];
    assert.ok(promptFile);
    const combined = readFileSync(promptFile, "utf8");
    assert.match(combined, /Local spike preamble/);
    assert.match(combined, /Local factory body/);
    assert.doesNotMatch(combined, /Write exactly one file/);

    const config = loadKilnConfig(configPath, { home });
    const written = writeJob(config, {
      workflow: "spike",
      repo: "web",
      specText: "# Local spike\n\nLook at the widget.\n",
      title: "Local spike",
      dependsOn: [],
      source: { kind: "prompt", ref: "inline" },
    });
    assert.equal(written.job.workflow, "spike");

    const html = renderConsole("", buildAttention([]), {
      csrf: "abc",
      repos: [{ name: "web", path: checkout }],
      workflows: names,
      section: "pipeline",
    });
    assert.match(html, /data-workflow="spike"/);
    assert.match(html, /data-workflow="feature"/);
  });

  it("accepts a local workflow from the jobs API body", async () => {
    const { home, configPath } = kilnHome();
    writeLocalWorkflow(join(home, ".kiln", "workflows"), "spike");
    const config = loadKilnConfig(configPath, { home });
    const result = await intakeJobs(
      config,
      { repo: "web", workflow: "spike", source: { kind: "prompt", text: "Look at the widget." } },
      home,
    );
    assert.equal(result.ids.length, 1);
  });

  it("rejects a local workflow that reuses a shipped name", () => {
    const { home } = kilnHome();
    const workflowsDir = join(home, ".kiln", "workflows");
    writeLocalWorkflow(workflowsDir, "feature");
    assert.throws(
      () => listWorkflowNames(workflowsDir),
      /Local workflow feature\.yaml reuses a shipped workflow name/,
    );
    assert.throws(
      () => assertWorkflowName("feature", workflowsDir),
      /Copy it to a new name, or override a prompt file under prompts\//,
    );
    assert.throws(() => workflowStepPlan("feature", workflowsDir), /reuses a shipped workflow name/);
  });
});

describe("prompt overlay", () => {
  it("lets a local review prompt shadow the packaged one", () => {
    const { home } = kilnHome();
    const prompts = join(home, ".kiln", "prompts");
    mkdirSync(join(prompts, "kiln"), { recursive: true });
    writeFileSync(join(prompts, "kiln", "review.md"), "Operator review overlay. Cite the widget.\n");
    const rendered = materializeWorkflow(join(home, ".kiln"), "jreview", "review", { promptsDir: prompts });
    const promptFile = readFileSync(rendered, "utf8").match(/file: "([^"]+)"/)?.[1];
    assert.ok(promptFile);
    const text = readFileSync(promptFile, "utf8");
    assert.match(text, /Operator review overlay/);
    assert.doesNotMatch(text, /Kiln runs this review/);
  });

  it("keeps reviewPrompt as the winning overlay for prompts/kiln/review.md", () => {
    const { home } = kilnHome();
    const prompts = join(home, ".kiln", "prompts");
    mkdirSync(join(prompts, "kiln"), { recursive: true });
    writeFileSync(join(prompts, "kiln", "review.md"), "Tree review prompt.\n");
    const shortcut = join(home, "shortcut-review.md");
    writeFileSync(shortcut, "Shortcut review prompt. Cite file and line.\n");
    const rendered = materializeWorkflow(join(home, ".kiln"), "jreview", "review", {
      promptsDir: prompts,
      reviewPrompt: shortcut,
    });
    const promptFile = readFileSync(rendered, "utf8").match(/file: "([^"]+)"/)?.[1];
    assert.ok(promptFile);
    const text = readFileSync(promptFile, "utf8");
    assert.match(text, /Shortcut review prompt/);
    assert.doesNotMatch(text, /Tree review prompt/);
    assert.doesNotMatch(text, /Kiln runs this review/);
  });
});

describe("overlay config", () => {
  it("resolves overlay paths from the config directory and skips missing skill directories", () => {
    const { home, checkout } = kilnHome();
    const configDir = join(home, ".kiln");
    const extra = join(home, "operator-skills");
    mkdirSync(join(extra, "widget"), { recursive: true });
    writeFileSync(join(extra, "widget", "SKILL.md"), "---\nname: widget\ndescription: A fictional skill\n---\nLook at the widget.\n");
    const customWorkflows = join(configDir, "custom-workflows");
    writeLocalWorkflow(customWorkflows, "spike");
    writeFileSync(
      join(configDir, "kiln.config.json"),
      `${JSON.stringify(
        {
          adapter: "mock",
          repos: { web: { path: checkout, test: "npm test" } },
          overlay: {
            workflows: "custom-workflows",
            prompts: "custom-prompts",
            skillPaths: ["../operator-skills", "~/skills"],
          },
        },
        null,
        2,
      )}\n`,
    );
    const loaded = loadKilnConfig(join(configDir, "kiln.config.json"), { home });
    assert.equal(loaded.overlay.workflowsDir, customWorkflows);
    assert.equal(loaded.overlay.promptsDir, join(configDir, "custom-prompts"));
    assert.deepEqual(loaded.overlay.skillDirs, [extra]);
    assert.deepEqual(listWorkflowNames(loaded.overlay.workflowsDir), [...SHIPPED, "spike"].sort());
  });

  it("injects existing skill directories and leaves the YAML alone when none exist", () => {
    const { home, configPath } = kilnHome();
    const skills = join(home, ".kiln", "skills", "widget");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "SKILL.md"), "---\nname: widget\ndescription: A fictional skill\n---\nLook.\n");
    const config = loadKilnConfig(configPath, { home });
    assert.deepEqual(config.overlay.skillDirs, [join(home, ".kiln", "skills")]);
    const rendered = materializeWorkflow(config.kilnDir, "jfeature", "feature", {
      promptsDir: config.overlay.promptsDir,
      workflowsDir: config.overlay.workflowsDir,
      skillDirs: config.overlay.skillDirs,
    });
    const text = readFileSync(rendered, "utf8");
    assert.match(text, new RegExp(`skillDirs:\\n\\s+- "${join(home, ".kiln", "skills")}"`));
    const plain = materializeWorkflow(config.kilnDir, "jplain", "investigation");
    assert.doesNotMatch(readFileSync(plain, "utf8"), /skillDirs:/);
    assert.equal(installedYakLoadsSkillDirs(), true);
  });

  it("rejects a skill path that exists and is not a directory", () => {
    const { home, checkout, configPath } = kilnHome();
    const file = join(home, "not-a-dir");
    writeFileSync(file, "nope\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        repos: { web: { path: checkout } },
        overlay: { skillPaths: [file] },
      })}\n`,
    );
    assert.throws(() => loadKilnConfig(configPath, { home }), KilnConfigError);
  });

  it("follows a symlinked default skills directory once", () => {
    const { dir, home, checkout, configPath } = kilnHome();
    const real = join(dir, "real-skills");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(home, ".kiln", "skills"));
    writeFileSync(
      configPath,
      `${JSON.stringify({
        repos: { web: { path: checkout } },
        overlay: { skillPaths: [real] },
      })}\n`,
    );
    const loaded = loadKilnConfig(configPath, { home });
    assert.deepEqual(loaded.overlay.skillDirs, [join(home, ".kiln", "skills")]);
  });
});

describe("settings overlay", () => {
  it("refuses workflow and skill bodies and keeps an overlay already in the file", () => {
    const { home, checkout, configPath } = kilnHome();
    const original = {
      adapter: "mock",
      repos: { web: { path: checkout, test: "npm test" } },
      overlay: { skillPaths: ["/home/operator/skills"] },
      workflows: { feature: { sandbox: { mode: "off" } } },
    };
    const contents = `${JSON.stringify(original, null, 2)}\n`;
    writeFileSync(configPath, contents);
    const revision = createHash("sha256").update(contents).digest("hex");
    const rejected = saveSettings(
      configPath,
      {
        revision,
        repos: { web: { path: checkout, test: "npm test" } },
        overlay: { skills: "name: secret\n" },
        workflows: { spike: "name: spike\nsteps: []\n" },
      },
      home,
    );
    assert.equal(rejected.ok, false);
    if (rejected.ok) return;
    assert.equal(rejected.body.fields?.overlay, "Unknown field.");
    assert.equal(rejected.body.fields?.workflows, "Unknown field.");
    assert.equal(readFileSync(configPath, "utf8"), contents);

    const saved = saveSettings(
      configPath,
      { revision, repos: { web: { path: checkout, test: "npm test" } }, maxAttempts: 4 },
      home,
    );
    assert.equal(saved.ok, true);
    const file = JSON.parse(readFileSync(configPath, "utf8")) as {
      overlay: { skillPaths: string[] };
      workflows: { feature: { sandbox: { mode: string } } };
      maxAttempts: number;
    };
    assert.deepEqual(file.overlay.skillPaths, ["/home/operator/skills"]);
    assert.equal(file.workflows.feature.sandbox.mode, "off");
    assert.equal(file.maxAttempts, 4);
  });
});
