import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";
import { yakCliPath } from "../src/report.js";
import { materializeWorkflow, workflowInputs } from "../src/workflow.js";

const root = packageRoot();
const keep: string[] = [];

function yak(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [yakCliPath(), ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

describe("feature workflow", () => {
  it("keeps the factory prompt bodies verbatim under an MIT header", () => {
    const names = [
      "spec-writer",
      "builder",
      "review-security",
      "review-ux",
      "review-ui",
      "review-code",
      "approver",
    ];
    for (const name of names) {
      const text = readFileSync(join(root, "prompts", "factory", `${name}.md`), "utf8");
      const marker = "The body below this header is unchanged.\n-->\n\n";
      const at = text.indexOf(marker);
      assert.ok(at > 0, name);
      assert.match(text, /MIT License/);
      assert.match(text, /Copyright \(c\) 2026 Lawrence Chase/);
      assert.match(text, new RegExp(`plugins/factory/agents/${name}\\.md`));
      assert.match(text, /4c84a2ce7fbde5ac298c0de9f0b90141eac4ed98/);
      assert.doesNotMatch(text, /blob\/main/);
      assert.match(text, /v0\.7\.0/);
      const body = text.slice(at + marker.length);
      assert.doesNotMatch(body, /Kiln/);
      assert.match(body, new RegExp(`^---\\nname: ${name}\\n`));
    }
    const code = readFileSync(join(root, "prompts", "factory", "review-code.md"), "utf8");
    assert.match(code, /smart-review:smart-review/);
    assert.match(code, /model: sonnet/);
    const ui = readFileSync(join(root, "prompts", "factory", "review-ui.md"), "utf8");
    assert.match(ui, /No UI files changed/);
    assert.match(ui, /model: sonnet/);
    const spec = readFileSync(join(root, "prompts", "factory", "spec-writer.md"), "utf8");
    assert.match(spec, /model: opus/);
  });

  it("validates feature.yaml from the repo, and the rendered workflow from a checkout cwd", () => {
    const source = yak(["run", "workflows/feature.yaml", "--adapter", "mock", "--isolation", "none"], root);
    assert.equal(source.status, 1, source.stderr);
    assert.match(source.stderr, /--input does not satisfy the workflow's inputSchema/);
    assert.match(source.stderr, /baseRef/);
    assert.doesNotMatch(source.stderr, /prompt references/);
    assert.doesNotMatch(source.stderr, /needs artifact/);
    assert.doesNotMatch(source.stdout, /run .* started/);

    const foreign = mkdtempSync(join(tmpdir(), "kiln-yak-cwd-"));
    keep.push(foreign);
    const relative = yak(
      ["run", join(root, "workflows", "feature.yaml"), "--adapter", "mock", "--isolation", "none"],
      foreign,
    );
    assert.equal(relative.status, 1, relative.stderr);
    assert.match(relative.stderr, /prompts\/kiln\/spec\.md/);
    assert.doesNotMatch(relative.stderr, /run .* started/);

    const kilnDir = join(foreign, "kiln");
    const rendered = materializeWorkflow(kilnDir, "jvalidate", "feature");
    const renderedText = readFileSync(rendered, "utf8");
    assert.doesNotMatch(renderedText, /file: prompts\//);
    assert.match(renderedText, /file: "\//);
    const specFile = renderedText.match(/file: "([^"]*spec-[0-9a-f]+\.md)"/)?.[1];
    assert.ok(specFile);
    const combined = readFileSync(specFile, "utf8");
    assert.match(combined, /Do not write code/);
    assert.doesNotMatch(combined, /input\.contracts/);
    assert.match(combined, /\{\{input\.baseRef\}\}/);
    assert.match(combined, /git branch --show-current/);
    assert.match(combined, /Write exactly one file, `<job folder>\/spec\.md`/);
    const factory = readFileSync(join(root, "prompts", "factory", "spec-writer.md"), "utf8");
    assert.ok(combined.endsWith(factory.trimStart()));
    assert.match(renderedText, /build\.status == "READY"/);
    assert.match(renderedText, /KILN_VERIFY_WRAPPER/);
    const toolLines = [...renderedText.matchAll(/tools: \[([^\]]+)\]/g)].map((match) => match[1]);
    assert.deepEqual(toolLines, [
      "Read, Grep, Glob, Bash, Write, Skill",
      "Read, Grep, Glob, Bash, Write, Edit, Skill",
      "Read, Grep, Glob, Bash, Skill",
      "Read, Grep, Glob, Bash, Skill",
      "Read, Grep, Glob, Bash, Skill",
      "Read, Grep, Glob, Bash, Skill",
      "Read, Grep, Glob, Bash, Write, Skill",
    ]);
    const buildFile = renderedText.match(/file: "([^"]*build-[0-9a-f]+\.md)"/)?.[1];
    const approverFile = renderedText.match(/file: "([^"]*approver-[0-9a-f]+\.md)"/)?.[1];
    assert.ok(buildFile);
    assert.ok(approverFile);
    assert.match(readFileSync(buildFile, "utf8"), /this is round 1/);
    assert.match(readFileSync(buildFile, "utf8"), /signal, no exit code/);
    assert.match(readFileSync(approverFile, "utf8"), /Only the final round is provided/);
    const codeFile = renderedText.match(/file: "([^"]*code-[0-9a-f]+\.md)"/)?.[1];
    assert.ok(codeFile);
    assert.match(
      readFileSync(codeFile, "utf8"),
      /Use the verify output provided; do not re-run tests, builds, or anything that writes to the working tree\. Read-only git and file inspection only\./,
    );

    const run = yak(
      [
        "run",
        rendered,
        "--adapter",
        "mock",
        "--isolation",
        "none",
        "--input",
        "title=Sunday",
        "--input",
        "description=Show the week",
        "--input",
        "acceptance=The paragraph is visible",
        "--input",
        "runNonce=pebble-nonce",
        "--input",
        "baseRef=0123456789abcdef0123456789abcdef01234567",
      ],
      foreign,
    );
    assert.match(`${run.stdout}\n${run.stderr}`, /run \S+ started/);
    assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /prompt references/);
    assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /needs artifact/);
    assert.match(run.stderr, /no such file or directory|ENOENT|mock fixture/);
  });

  it("fills the feature schema from the spec text and does not invent extra fields", () => {
    const source = readFileSync(join(root, "workflows", "feature.yaml"), "utf8");
    const input = workflowInputs(source, {
      title: "Sunday summary",
      specText: "# Sunday summary\n\nShow the paragraph.",
      baseRef: "0123456789abcdef0123456789abcdef01234567",
      runNonce: "nonce-1",
    });
    assert.equal(input.title, "Sunday summary");
    assert.equal(input.description, "# Sunday summary\n\nShow the paragraph.");
    assert.equal(input.acceptance, input.description);
    assert.equal("contracts" in input, false);
    assert.equal(input.baseRef, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(input.runNonce, "nonce-1");
    assert.equal("spec" in input, false);
  });
});
