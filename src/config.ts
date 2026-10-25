import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { KilnConfigError } from "./errors.js";
import { KilnConfigFileSchema, type RepoEntry } from "./schemas.js";

export interface LoadedKilnConfig {
  configPath: string;
  /** Directory that holds the config file. Relative repo paths resolve from here. */
  configDir: string;
  note?: string;
  /** Repo name → checkout path (absolute) and optional verify command. */
  repos: Record<string, { path: string; test?: string }>;
  /**
   * Local kiln directory. The config's own directory when it is named `.kiln`
   * (for example `./.kiln` or `~/.kiln`). Otherwise `<cwd>/.kiln`.
   */
  kilnDir: string;
  jobsDir: string;
  /** In-flight cap for `kiln tick`. Default 2. */
  maxConcurrent: number;
  /** Passed to `yak run --adapter`. Default `claude-code`. */
  adapter: "mock" | "claude-code";
}

export interface LoadKilnConfigOptions {
  /** Working directory used when the config file is not inside `.kiln`. */
  cwd?: string;
  /** Home directory used to expand `~`. */
  home?: string;
}

export interface ResolveKilnConfigOptions extends LoadKilnConfigOptions {
  /** Explicit config file. Relative paths are resolved from `cwd`. */
  configPath?: string;
}

const CONFIG_NAME = "kiln.config.json";
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadKilnConfig(configPath: string, options: LoadKilnConfigOptions = {}): LoadedKilnConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
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
  const repos: LoadedKilnConfig["repos"] = {};
  for (const [name, entry] of Object.entries(parsed.data.repos)) {
    assertRepoName(name);
    const checkout = resolveConfiguredPath(configDir, entry.path, home);
    if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
      throw new KilnConfigError(
        `Checkout for ${name} does not exist or is not a directory: ${checkout}. Set repos.${name}.path in the kiln config.`,
      );
    }
    repos[name] = { path: checkout, ...(entry.test ? { test: entry.test } : {}) };
  }

  const kilnDir = basename(configDir) === ".kiln" ? configDir : join(cwd, ".kiln");
  return {
    configPath: resolvedPath,
    configDir,
    note: parsed.data.note,
    repos,
    kilnDir,
    jobsDir: join(kilnDir, "jobs"),
    maxConcurrent: parsed.data.maxConcurrent ?? 2,
    adapter: parsed.data.adapter ?? "claude-code",
  };
}

/**
 * Local config wins: `./.kiln/kiln.config.json`, then `~/.kiln/kiln.config.json`.
 */
export function resolveKilnConfig(options: ResolveKilnConfigOptions = {}): LoadedKilnConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (options.configPath) {
    return loadKilnConfig(resolve(cwd, options.configPath), { cwd, home });
  }

  const cwdConfig = join(cwd, ".kiln", CONFIG_NAME);
  if (existsSync(cwdConfig)) return loadKilnConfig(cwdConfig, { cwd, home });

  const homeConfig = join(home, ".kiln", CONFIG_NAME);
  if (existsSync(homeConfig)) return loadKilnConfig(homeConfig, { cwd, home });

  throw new KilnConfigError(
    [
      "No kiln config found.",
      `Run kiln repo add <name> <path> to create ${join(cwd, ".kiln", CONFIG_NAME)},`,
      `or create ${join(home, ".kiln", CONFIG_NAME)}.`,
      "Those directories are gitignored. Do not commit checkout paths.",
    ].join("\n"),
  );
}

export interface AddRepoOptions extends ResolveKilnConfigOptions {
  name: string;
  /** Path as the user typed it. Relative paths are stored relative to the config directory. */
  repoPath: string;
  test?: string;
}

/** Create or update one repo entry. Returns the text to print. */
export function addRepo(options: AddRepoOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  assertRepoName(options.name);
  if (options.test !== undefined && !options.test.trim()) {
    throw new KilnConfigError("The test command is empty. Omit --test, or pass a command.");
  }

  const configPath = configPathForWrite(options);
  const configDir = dirname(configPath);
  const storedPath = pathToStore(options.repoPath, configDir, cwd, home);
  const checkout = resolveConfiguredPath(configDir, storedPath, home);
  if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
    throw new KilnConfigError(`Checkout for ${options.name} does not exist or is not a directory: ${checkout}.`);
  }

  const raw = readConfigObject(configPath);
  const repos = repoMap(raw);
  const previous = repos[options.name];
  const entry: RepoEntry = { path: storedPath };
  const previousTest =
    previous && typeof previous === "object" && previous !== null && "test" in previous
      ? previous.test
      : undefined;
  const test = options.test ?? (typeof previousTest === "string" ? previousTest : undefined);
  if (test) entry.test = test;
  repos[options.name] = entry;
  raw.repos = repos;

  const parsed = KilnConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KilnConfigError(`Kiln config ${configPath} is invalid: ${parsed.error.message}`);
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  const lines = [`added ${options.name}`, `path ${checkout}`];
  if (entry.test) lines.push(`test ${entry.test}`);
  lines.push(`wrote ${configPath}`);
  return `${lines.join("\n")}\n`;
}

export function renderRepoList(config: LoadedKilnConfig): string {
  const names = Object.keys(config.repos).sort();
  if (names.length === 0) return "no repos\n";
  const lines = names.map((name) => {
    const repo = config.repos[name];
    if (!repo) return name;
    return repo.test ? `${name}  ${repo.path}  test ${repo.test}` : `${name}  ${repo.path}`;
  });
  return `${lines.join("\n")}\n`;
}

export function assertRepoName(name: string): void {
  if (!REPO_NAME.test(name)) {
    throw new KilnConfigError(
      `Repo name ${JSON.stringify(name)} must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens.`,
    );
  }
}

function configPathForWrite(options: ResolveKilnConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (options.configPath) return resolve(cwd, options.configPath);
  const cwdConfig = join(cwd, ".kiln", CONFIG_NAME);
  if (existsSync(cwdConfig)) return cwdConfig;
  const homeConfig = join(home, ".kiln", CONFIG_NAME);
  if (existsSync(homeConfig)) return homeConfig;
  return cwdConfig;
}

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return { repos: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KilnConfigError(`Could not read kiln config ${configPath}: ${message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new KilnConfigError(`Kiln config ${configPath} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function repoMap(raw: Record<string, unknown>): Record<string, unknown> {
  const repos = raw.repos;
  if (repos === undefined) return {};
  if (typeof repos !== "object" || repos === null || Array.isArray(repos)) {
    throw new KilnConfigError("Kiln config repos must be an object.");
  }
  return repos as Record<string, unknown>;
}

export function resolveConfiguredPath(configDir: string, value: string, home: string): string {
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
}

function pathToStore(userPath: string, configDir: string, cwd: string, home: string): string {
  if (userPath === "~" || userPath.startsWith("~/")) return userPath;
  if (isAbsolute(userPath)) return userPath;
  const absolute = resolve(cwd, userPath);
  const stored = relative(configDir, absolute);
  return stored === "" ? "." : stored;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}
