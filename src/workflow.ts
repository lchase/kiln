import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { jobBasename, packageRoot } from "./paths.js";

const FACTORY_DIRECTIVE = /^<!--\s*factory:\s*(prompts\/factory\/[a-z0-9-]+\.md)\s*-->/;
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FEATURE_PROMPTS = 7;

export interface LaunchInput {
  title: string;
  specText: string;
  baseRef: string;
  runNonce: string;
}

/**
 * Values Kiln can pass into a workflow. A workflow's inputSchema lists the
 * ones it uses. `description`, `acceptance`, and `contracts` stay so
 * `workflows/feature.yaml` can keep its current schema: the spec text fills
 * the first two, and contracts is `none`.
 */
const INPUT_VALUES: Record<string, (input: LaunchInput) => string> = {
  title: (input) => input.title,
  spec: (input) => input.specText,
  baseRef: (input) => input.baseRef,
  runNonce: (input) => input.runNonce,
  description: (input) => input.specText,
  acceptance: (input) => input.specText,
  contracts: () => "none",
};

export function assertWorkflowName(name: string): string {
  if (!WORKFLOW_NAME.test(name)) {
    throw new Error(
      `Workflow name ${JSON.stringify(name)} must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens.`,
    );
  }
  const path = join(packageRoot(), "workflows", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`Unknown workflow ${name}. Expected ${path}.`);
  }
  return path;
}

/**
 * Yak reads `prompt.file` with `path.resolve(cwd, file)`, and Kiln launches
 * yak with cwd set to the product checkout. Rewrite `prompts/kiln/<name>.md`
 * to an absolute file under the kiln directory: the Kiln preamble plus the
 * verbatim factory prompt. The content hash is part of the filename, so a
 * prompt edit changes the path yak caches on.
 */
export function materializeWorkflow(kilnDir: string, jobId: string, workflowName: string): string {
  const sourcePath = assertWorkflowName(workflowName);
  const source = readFileSync(sourcePath, "utf8");
  const destDir = join(kilnDir, "rendered", jobBasename(jobId));
  mkdirSync(destDir, { recursive: true });

  let count = 0;
  const rendered = source.replace(/file: prompts\/kiln\/([a-z0-9-]+)\.md/g, (_full, name: string) => {
    count += 1;
    const rel = `prompts/kiln/${name}.md`;
    const absolute = writeCombinedPrompt(rel, destDir);
    return `file: ${yamlDoubleQuote(absolute)}`;
  });
  if (workflowName === "feature" && count !== FEATURE_PROMPTS) {
    throw new Error(
      `Feature workflow has ${count} prompts/kiln refs; expected ${FEATURE_PROMPTS}. Refusing to launch a partial prompt set.`,
    );
  }
  if (rendered.includes("file: prompts/")) {
    throw new Error(`Rendered ${workflowName} workflow still has a checkout-relative prompt path.`);
  }

  const workflowPath = join(destDir, `${workflowName}.yaml`);
  writeFileSync(workflowPath, rendered);
  return workflowPath;
}

/** The subset of {@link INPUT_VALUES} that this workflow's inputSchema declares. */
export function workflowInputs(workflowYaml: string, input: LaunchInput): Record<string, string> {
  const names = declaredInputProperties(workflowYaml);
  const out: Record<string, string> = {};
  for (const name of names) {
    const fill = INPUT_VALUES[name];
    if (!fill) {
      throw new Error(
        `Workflow input "${name}" is not a Kiln launch input. Kiln passes title, spec, baseRef, and runNonce (and KILN_TEST in the environment).`,
      );
    }
    out[name] = fill(input);
  }
  return out;
}

function declaredInputProperties(yaml: string): string[] {
  const at = yaml.indexOf("\ninputSchema:");
  const start = at >= 0 ? at : yaml.startsWith("inputSchema:") ? 0 : -1;
  if (start < 0) {
    throw new Error("Workflow has no inputSchema. Kiln passes title, spec, baseRef, and runNonce.");
  }
  const slice = yaml.slice(start);
  const props = slice.match(/\n[^\n]*properties:\n([\s\S]*?)\n[^\n]*required:/);
  if (!props?.[1]) {
    throw new Error("Workflow inputSchema has no properties block.");
  }
  const names = [...props[1].matchAll(/(?:^|\n)\s+([A-Za-z_][A-Za-z0-9_-]*):/g)].map(
    (match) => match[1] ?? "",
  );
  if (names.length === 0 || names.some((name) => name.length === 0)) {
    throw new Error("Workflow inputSchema lists no input properties.");
  }
  return names;
}

function writeCombinedPrompt(preambleRel: string, destDir: string): string {
  const root = packageRoot();
  const preamblePath = join(root, preambleRel);
  const preamble = readFileSync(preamblePath, "utf8");
  const directive = preamble.match(FACTORY_DIRECTIVE);
  if (!directive?.[1]) {
    throw new Error(`${preambleRel} must start with <!-- factory: prompts/factory/<file>.md -->`);
  }
  const factoryRel = directive[1];
  const factoryPath = join(root, factoryRel);
  const factoryRoot = join(root, "prompts", "factory") + sep;
  if (!factoryPath.startsWith(factoryRoot)) {
    throw new Error(`${preambleRel} factory path ${factoryRel} escapes prompts/factory.`);
  }
  const factory = readFileSync(factoryPath, "utf8");
  const combined = `${preamble.trimEnd()}\n\n${factory.trimStart()}`;
  const digest = createHash("sha256").update(combined).digest("hex").slice(0, 16);
  const outPath = join(destDir, `${basename(preambleRel, ".md")}-${digest}.md`);
  writeFileSync(outPath, combined);
  return outPath;
}

function yamlDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
