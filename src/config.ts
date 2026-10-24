import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { KilnConfigError } from "./errors.js";
import { loadOwnershipMap } from "./ownership.js";
import { exampleConfigPath, packageRoot } from "./paths.js";
import { REPOS, type OwnershipMap, type Repo } from "./schemas.js";

const RepoEntrySchema = z.object({
  checkout: z.string().min(1),
  ownership: z.string().min(1),
});

export const KilnConfigFileSchema = z.object({
  note: z.string().min(1).optional(),
  example: z.boolean().optional(),
  repos: z.object({
    frontend: RepoEntrySchema,
    "ai-core": RepoEntrySchema,
    "evals-obs": RepoEntrySchema,
  }),
});
export type KilnConfigFile = z.infer<typeof KilnConfigFileSchema>;

export interface LoadedKilnConfig {
  configPath: string;
  /** Directory that holds the config file. */
  configDir: string;
  /** True for the committed fictional Pebble config. */
  example: boolean;
  note?: string;
  checkouts: Record<Repo, string>;
  ownership: OwnershipMap[];
  /**
   * Local kiln directory. The config's own directory when it is named `.kiln`
   * (for example `./.kiln` or `~/.kiln`). Otherwise `<cwd>/.kiln`, so a
   * `--config` path outside `.kiln` still writes plans under `.kiln/`.
   */
  kilnDir: string;
  plansDir: string;
}

export interface LoadKilnConfigOptions {
  /** Working directory. Example-config plans are written to `<cwd>/.kiln/plans`. */
  cwd?: string;
}

export interface ResolveKilnConfigOptions extends LoadKilnConfigOptions {
  /** Explicit config file. Relative paths are resolved from `cwd`. */
  configPath?: string;
  /** Home directory used for `~/.kiln/kiln.config.json`. */
  home?: string;
  /**
   * Requirement being refined. The shipped example config is used only when
   * this path is under `examples/requirements` and no local config exists.
   */
  requirementPath?: string;
}

const CONFIG_NAME = "kiln.config.json";

export function loadKilnConfig(configPath: string, options: LoadKilnConfigOptions = {}): LoadedKilnConfig {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPath = resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KilnConfigError(`Could not read kiln config ${resolvedPath}: ${message}`);
  }
  const parsed = KilnConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KilnConfigError(`Kiln config ${resolvedPath} is invalid: ${parsed.error.message}`);
  }

  const configDir = dirname(resolvedPath);
  const example = parsed.data.example === true;
  const checkouts = {} as Record<Repo, string>;
  const ownership: OwnershipMap[] = [];

  for (const repo of REPOS) {
    const entry = parsed.data.repos[repo];
    const checkout = resolveFrom(configDir, entry.checkout);
    const ownershipPath = resolveFrom(configDir, entry.ownership);
    if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
      throw new KilnConfigError(
        `Checkout for ${repo} does not exist or is not a directory: ${checkout}. Set repos.${repo}.checkout in the local kiln config. Do not commit that file.`,
      );
    }
    checkouts[repo] = checkout;
    ownership.push(loadOwnershipMap(ownershipPath, repo));
  }

  const kilnDir = basename(configDir) === ".kiln" ? configDir : join(cwd, ".kiln");
  return {
    configPath: resolvedPath,
    configDir,
    example,
    note: parsed.data.note,
    checkouts,
    ownership,
    kilnDir,
    plansDir: join(kilnDir, "plans"),
  };
}

/**
 * Local config wins: `./.kiln/kiln.config.json`, then `~/.kiln/kiln.config.json`.
 * The committed example config is only a fallback for files under `examples/requirements`.
 */
export function resolveKilnConfig(options: ResolveKilnConfigOptions = {}): LoadedKilnConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (options.configPath) {
    return loadKilnConfig(resolve(cwd, options.configPath), { cwd });
  }

  const cwdConfig = join(cwd, ".kiln", CONFIG_NAME);
  if (existsSync(cwdConfig)) return loadKilnConfig(cwdConfig, { cwd });

  const homeConfig = join(home, ".kiln", CONFIG_NAME);
  if (existsSync(homeConfig)) return loadKilnConfig(homeConfig, { cwd });

  const requirementPath = options.requirementPath ? resolve(cwd, options.requirementPath) : undefined;
  if (requirementPath && isShippedExampleRequirement(requirementPath)) {
    return loadKilnConfig(exampleConfigPath(), { cwd });
  }

  throw new KilnConfigError(
    [
      "No local kiln config found.",
      `Create ${join(cwd, ".kiln", CONFIG_NAME)} or ${join(home, ".kiln", CONFIG_NAME)}.`,
      "Put the three checkout paths and the real ownership maps there.",
      "Real requirements and generated plans stay in that directory too.",
      "Those directories are gitignored. Do not commit them.",
      `examples/kiln.config.json shows the shape with fictional Pebble data, not real paths.`,
    ].join("\n"),
  );
}

export function isShippedExampleRequirement(requirementPath: string): boolean {
  const examples = join(packageRoot(), "examples", "requirements") + sep;
  return resolve(requirementPath).startsWith(examples);
}

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}
