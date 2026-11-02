import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { jobBasename, packageRoot } from "./paths.js";

const FACTORY_DIRECTIVE = /^<!--\s*factory:\s*(prompts\/factory\/[a-z0-9-]+\.md)\s*-->/;
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FEATURE_PROMPTS = 7;
const INVESTIGATION_PROMPTS = 1;
const FIX_PROMPTS = 1;

/** Prompt files Kiln rewrites before launch. A mismatch refuses the launch. */
const PROMPT_COUNTS: Record<string, number> = {
  feature: FEATURE_PROMPTS,
  investigation: INVESTIGATION_PROMPTS,
  fix: FIX_PROMPTS,
};

export interface LaunchInput {
  title: string;
  specText: string;
  baseRef: string;
  runNonce: string;
}

/**
 * Values Kiln can pass into a workflow. A workflow's inputSchema lists the
 * ones it uses. `description` and `acceptance` stay so
 * `workflows/feature.yaml` can keep its schema: both are the spec text.
 */
const INPUT_VALUES: Record<string, (input: LaunchInput) => string> = {
  title: (input) => input.title,
  spec: (input) => input.specText,
  baseRef: (input) => input.baseRef,
  runNonce: (input) => input.runNonce,
  description: (input) => input.specText,
  acceptance: (input) => input.specText,
};

/** Workflow names from `workflows/*.yaml`, sorted. */
export function listWorkflowNames(): string[] {
  const dir = join(packageRoot(), "workflows");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".yaml") && !name.startsWith("."))
    .map((name) => name.slice(0, -".yaml".length))
    .filter((name) => WORKFLOW_NAME.test(name))
    .sort();
}

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
 *
 * A preamble that starts with `<!-- factory: prompts/factory/<file>.md -->`
 * is combined with that factory body. A prompt without that directive is
 * stored as itself. `prompts/kiln/investigation.md` uses the second form.
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
  const expected = PROMPT_COUNTS[workflowName];
  if (expected !== undefined && count !== expected) {
    throw new Error(
      `${workflowName} workflow has ${count} prompts/kiln refs; expected ${expected}. Refusing to launch a partial prompt set.`,
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

/**
 * Leaf step ids under the root `steps:` block, in file order.
 * A step that contains nested `- id:` entries is a loop or map container
 * and is omitted; its nested ids are the ones a run actually starts.
 */
export function workflowLeafSteps(yaml: string): string[] {
  const lines = yaml.split("\n");
  let inSteps = false;
  const nodes: { id: string; indent: number }[] = [];
  for (const line of lines) {
    if (!inSteps) {
      if (line === "steps:" || line.startsWith("steps:")) inSteps = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const match = /^(\s*)- id:\s*([A-Za-z0-9._-]+)\s*(?:#.*)?$/.exec(line);
    if (!match?.[2]) continue;
    nodes.push({ id: match[2], indent: match[1]?.length ?? 0 });
  }
  const leaves: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const next = nodes[index + 1];
    if (!node) continue;
    if (next && next.indent > node.indent) continue;
    leaves.push(node.id);
  }
  return leaves;
}

/** Leaf step ids from a yak `workflow.json` `steps` array. Loop and map containers expand to their body. */
export function leafStepIds(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const ids: string[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null || !("id" in step)) continue;
    const id = step.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const kind = "kind" in step ? step.kind : undefined;
    if (kind === "loop" && "body" in step) {
      ids.push(...leafStepIds(step.body));
      continue;
    }
    if (kind === "map" && "step" in step) {
      ids.push(...leafStepIds([step.step]));
      continue;
    }
    ids.push(id);
  }
  return ids;
}

/** Leaf steps of a packaged workflow. An unknown name is an empty plan, not an error. */
export function workflowStepPlan(name: string): string[] {
  if (!WORKFLOW_NAME.test(name)) return [];
  const path = join(packageRoot(), "workflows", `${name}.yaml`);
  if (!existsSync(path)) return [];
  return workflowLeafSteps(readFileSync(path, "utf8"));
}

/** True when the workflow runs the repo test command. Investigation does not. */
export function workflowNeedsTestCommand(workflowYaml: string): boolean {
  return /\bKILN_TEST\b/.test(workflowYaml) || workflowYaml.includes("KILN_VERIFY_WRAPPER");
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
  let combined: string;
  if (!directive?.[1]) {
    combined = `${preamble.trimEnd()}\n`;
  } else {
    const factoryRel = directive[1];
    const factoryPath = join(root, factoryRel);
    const factoryRoot = join(root, "prompts", "factory") + sep;
    if (!factoryPath.startsWith(factoryRoot)) {
      throw new Error(`${preambleRel} factory path ${factoryRel} escapes prompts/factory.`);
    }
    const factory = readFileSync(factoryPath, "utf8");
    combined = `${preamble.trimEnd()}\n\n${factory.trimStart()}`;
  }
  const digest = createHash("sha256").update(combined).digest("hex").slice(0, 16);
  const outPath = join(destDir, `${basename(preambleRel, ".md")}-${digest}.md`);
  writeFileSync(outPath, combined);
  return outPath;
}

function yamlDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
