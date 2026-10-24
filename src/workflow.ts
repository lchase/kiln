import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { planBasename } from "./plans.js";
import { packageRoot } from "./paths.js";

const FACTORY_DIRECTIVE = /^<!--\s*factory:\s*(prompts\/factory\/[a-z0-9-]+\.md)\s*-->/;
const EXPECTED_PROMPTS = 7;

/**
 * Yak reads `prompt.file` with `path.resolve(cwd, file)`, and Kiln launches
 * yak with cwd set to the product checkout. Rewrite the feature workflow so
 * each agent prompt is an absolute file under the kiln directory: the Kiln
 * preamble plus the verbatim factory prompt. The content hash is part of the
 * filename, so a prompt edit changes the path yak caches on.
 */
export function materializeFeatureWorkflow(kilnDir: string, planId: string, taskId: string): string {
  const sourcePath = join(packageRoot(), "workflows", "feature.yaml");
  const source = readFileSync(sourcePath, "utf8");
  const destDir = renderedFeatureDir(kilnDir, planId, taskId);
  mkdirSync(destDir, { recursive: true });

  let count = 0;
  const rendered = source.replace(/file: prompts\/kiln\/([a-z0-9-]+)\.md/g, (_full, name: string) => {
    count += 1;
    const rel = `prompts/kiln/${name}.md`;
    const absolute = writeCombinedPrompt(rel, destDir);
    return `file: ${yamlDoubleQuote(absolute)}`;
  });
  if (count !== EXPECTED_PROMPTS) {
    throw new Error(
      `Feature workflow has ${count} prompts/kiln refs; expected ${EXPECTED_PROMPTS}. Refusing to launch a partial prompt set.`,
    );
  }
  if (rendered.includes("file: prompts/")) {
    throw new Error(`Rendered feature workflow still has a checkout-relative prompt path.`);
  }

  const workflowPath = join(destDir, "feature.yaml");
  writeFileSync(workflowPath, rendered);
  return workflowPath;
}

export function renderedFeatureDir(kilnDir: string, planId: string, taskId: string): string {
  return join(kilnDir, "rendered", planBasename(planId), planBasename(taskId));
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
