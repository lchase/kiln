import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  review: 1,
};

/** Workflow name for a draft pull-request review. It ends at a gate and does not open a pull request. */
export const REVIEW_WORKFLOW = "review";

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

/** Shipped names plus local `workflows/*.yaml`, sorted. A reused shipped name throws. */
export function listWorkflowNames(workflowsDir?: string): string[] {
  const packaged = workflowNamesIn(join(packageRoot(), "workflows"));
  const local = workflowsDir ? workflowNamesIn(workflowsDir) : [];
  assertNoShippedCollision(local, packaged);
  return [...packaged, ...local].sort();
}

export function assertWorkflowName(name: string, workflowsDir?: string): string {
  if (!WORKFLOW_NAME.test(name)) {
    throw new Error(
      `Workflow name ${JSON.stringify(name)} must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens.`,
    );
  }
  const packaged = join(packageRoot(), "workflows", `${name}.yaml`);
  const local = workflowsDir ? join(workflowsDir, `${name}.yaml`) : undefined;
  const hasPackaged = existsSync(packaged);
  const hasLocal = local !== undefined && existsSync(local);
  if (hasLocal && hasPackaged) assertNoShippedCollision([name], [name]);
  if (hasLocal && local) return local;
  if (hasPackaged) return packaged;
  const expected = local ? `${packaged} or ${local}` : packaged;
  throw new Error(`Unknown workflow ${name}. Expected ${expected}.`);
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
export interface MaterializeOptions {
  /**
   * Absolute file for `prompts/kiln/review.md`. Wins over the local prompts
   * tree and over the packaged file. The same lookup as every other prompt.
   */
  reviewPrompt?: string;
  /** Local prompts directory. A file here wins over the packaged prompt at the same relative path. */
  promptsDir?: string;
  /** Local workflows directory. A shipped name in this directory is an error. */
  workflowsDir?: string;
  /** Existing skill directories, injected on every agent step. Empty leaves the YAML unchanged. */
  skillDirs?: readonly string[];
}

export function materializeWorkflow(
  kilnDir: string,
  jobId: string,
  workflowName: string,
  options: MaterializeOptions = {},
): string {
  const sourcePath = assertWorkflowName(workflowName, options.workflowsDir);
  const source = readFileSync(sourcePath, "utf8");
  const destDir = join(kilnDir, "rendered", jobBasename(jobId));
  mkdirSync(destDir, { recursive: true });

  let count = 0;
  let rendered = source.replace(/file: prompts\/kiln\/([a-z0-9-]+)\.md/g, (_full, name: string) => {
    count += 1;
    const rel = `prompts/kiln/${name}.md`;
    const absolute = writeCombinedPrompt(rel, destDir, options);
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
  if (options.skillDirs && options.skillDirs.length > 0) {
    rendered = injectSkillDirs(rendered, options.skillDirs);
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

/**
 * Leaf steps of a packaged or local workflow. An unknown name is an empty
 * plan. A local file that reuses a shipped name throws.
 */
export function workflowStepPlan(name: string, workflowsDir?: string): string[] {
  if (!WORKFLOW_NAME.test(name)) return [];
  const packaged = join(packageRoot(), "workflows", `${name}.yaml`);
  const local = workflowsDir ? join(workflowsDir, `${name}.yaml`) : undefined;
  const hasPackaged = existsSync(packaged);
  const hasLocal = local !== undefined && existsSync(local);
  if (hasLocal && hasPackaged) assertNoShippedCollision([name], [name]);
  const path = hasLocal && local ? local : hasPackaged ? packaged : undefined;
  if (!path) return [];
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

/** Text Kiln searches for in the installed `@lchase/yak` bundle. Keep the property access in yak. */
export const YAK_SKILL_DIRS_MARKER = "raw.agent.skillDirs";

/** True when the installed yak keeps `agent.skillDirs` instead of dropping it while loading YAML. */
export function installedYakLoadsSkillDirs(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@lchase/yak/package.json");
    const dist = readFileSync(join(dirname(pkgPath), "dist", "index.js"), "utf8");
    return dist.includes(YAK_SKILL_DIRS_MARKER);
  } catch {
    return false;
  }
}

/**
 * Insert `skillDirs` under every `agent:` block that does not already set it.
 * Command steps and gates are left alone. An empty list leaves the YAML unchanged.
 */
export function injectSkillDirs(yaml: string, skillDirs: readonly string[]): string {
  if (skillDirs.length === 0) return yaml;
  const lines = yaml.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    out.push(line);
    const match = /^(\s*)agent:\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const base = match[1]?.length ?? 0;
    if (blockHasKey(lines, index + 1, base, "skillDirs")) continue;
    const pad = " ".repeat(childIndent(lines, index + 1, base));
    out.push(`${pad}skillDirs:`);
    for (const dir of skillDirs) out.push(`${pad}  - ${yamlDoubleQuote(dir)}`);
  }
  return out.join("\n");
}

function writeCombinedPrompt(preambleRel: string, destDir: string, options: MaterializeOptions): string {
  const preamble = readPromptFile(preambleRel, options);
  const directive = preamble.match(FACTORY_DIRECTIVE);
  let combined: string;
  if (!directive?.[1]) {
    combined = `${preamble.trimEnd()}\n`;
  } else {
    const factoryRel = directive[1];
    const factory = readPromptFile(factoryRel, options);
    combined = `${preamble.trimEnd()}\n\n${factory.trimStart()}`;
  }
  const digest = createHash("sha256").update(combined).digest("hex").slice(0, 16);
  const outPath = join(destDir, `${basename(preambleRel, ".md")}-${digest}.md`);
  writeFileSync(outPath, combined);
  return outPath;
}

/**
 * Local prompts tree, then the packaged file. `reviewPrompt` is the overlay
 * file for `prompts/kiln/review.md` and wins over both when it is set.
 */
function readPromptFile(rel: string, options: MaterializeOptions): string {
  if (!/^prompts\/[a-z0-9-]+\/[a-z0-9-]+\.md$/.test(rel)) {
    throw new Error(`Prompt path ${rel} is not under prompts/.`);
  }
  if (rel === "prompts/kiln/review.md" && options.reviewPrompt) {
    if (!existsSync(options.reviewPrompt) || !statSync(options.reviewPrompt).isFile()) {
      throw new Error("Review prompt file was not found.");
    }
    return readFileSync(options.reviewPrompt, "utf8");
  }
  if (options.promptsDir) {
    const local = resolve(options.promptsDir, rel.slice("prompts/".length));
    const root = options.promptsDir.endsWith(sep) ? options.promptsDir : options.promptsDir + sep;
    if (local !== options.promptsDir && !local.startsWith(root)) {
      throw new Error(`${rel} escapes the local prompts directory.`);
    }
    if (existsSync(local) && statSync(local).isFile()) return readFileSync(local, "utf8");
  }
  const packaged = join(packageRoot(), rel);
  const packagedRoot = join(packageRoot(), "prompts") + sep;
  if (!packaged.startsWith(packagedRoot)) {
    throw new Error(`${rel} escapes prompts/.`);
  }
  if (!existsSync(packaged) || !statSync(packaged).isFile()) {
    throw new Error(`Prompt file was not found: ${rel}.`);
  }
  return readFileSync(packaged, "utf8");
}

function workflowNamesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    if (code === "ENOTDIR") throw new Error(`Workflow directory ${dir} is not a directory.`);
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".yaml") && !name.startsWith("."))
    .map((name) => name.slice(0, -".yaml".length))
    .filter((name) => WORKFLOW_NAME.test(name))
    .sort();
}

function assertNoShippedCollision(local: readonly string[], packaged: readonly string[]): void {
  const shipped = new Set(packaged);
  const collisions = local.filter((name) => shipped.has(name));
  if (collisions.length === 0) return;
  const names = collisions.map((name) => `${name}.yaml`).join(", ");
  throw new Error(
    `Local workflow ${names} reuses a shipped workflow name. Copy it to a new name, or override a prompt file under prompts/.`,
  );
}

function childIndent(lines: string[], start: number, base: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (indent <= base) break;
    return indent;
  }
  return base + 2;
}

function blockHasKey(lines: string[], start: number, base: number, key: string): boolean {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (indent <= base) return false;
    if (new RegExp(`^\\s*${key}:\\s*`).test(line)) return true;
  }
  return false;
}

function yamlDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
