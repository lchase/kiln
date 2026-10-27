import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { KilnConfigError } from "./errors.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_STALL_TIMEOUT_MS,
  KilnConfigFileSchema,
  type JiraConfig,
  type RepoEntry,
  type SandboxSettings,
} from "./schemas.js";

export interface LoadedKilnConfig {
  configPath: string;
  /** Directory that holds the config file. Relative repo paths in the file resolve from here. */
  configDir: string;
  note?: string;
  /**
   * Repo name → checkout. `deliver` defaults to `local`. `base` is unset when
   * the config omits it; tick discovers origin's default branch then.
   */
  repos: Record<string, { path: string; test?: string; deliver: "local" | "pr"; base?: string }>;
  /**
   * Kiln home. Jobs, logs, deliveries, launching, launch-errors, attempts,
   * feedback, and specs live here: the directory of the config file
   * (`--config`'s directory, `$KILN_HOME`, or `~/.kiln`).
   */
  kilnDir: string;
  jobsDir: string;
  /** In-flight cap for `kiln tick`. Default 2. */
  maxConcurrent: number;
  /**
   * Quiet time before a running job is killed. Default 15 minutes.
   * `<= 0` disables stall detection.
   */
  stallTimeoutMs: number;
  /** Transient failures before the job is dead. Default 3. */
  maxAttempts: number;
  /** Pull request fix rounds before needs-human. Default 2. */
  maxFixRounds: number;
  /** Passed to `yak run --adapter`. Default `claude-code`. */
  adapter: "mock" | "claude-code";
  /** Global sandbox settings. Every field is optional; omitted mode is off. */
  sandbox: SandboxSettings;
  /** Per-workflow sandbox overrides, keyed by workflow name. */
  workflowSandbox: Record<string, SandboxSettings>;
  /**
   * Jira Cloud credentials from the config file, with empty strings removed.
   * Environment variables override these at intake time. Absent when unset.
   */
  jira?: JiraConfig;
}

export interface LoadKilnConfigOptions {
  /**
   * Working directory. `resolveKilnConfig` uses it for relative `--config`
   * and `KILN_HOME`. `loadKilnConfig` ignores it: the kiln home is the
   * config file's directory.
   */
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
    repos[name] = {
      path: checkout,
      ...(entry.test ? { test: entry.test } : {}),
      deliver: entry.deliver ?? "local",
      ...(entry.base ? { base: entry.base } : {}),
    };
  }

  const kilnDir = configDir;
  const jira = jiraFromFile(parsed.data.jira);
  return {
    configPath: resolvedPath,
    configDir,
    note: parsed.data.note,
    repos,
    kilnDir,
    jobsDir: join(kilnDir, "jobs"),
    maxConcurrent: parsed.data.maxConcurrent ?? 2,
    stallTimeoutMs: parsed.data.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    maxAttempts: parsed.data.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    maxFixRounds: parsed.data.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS,
    adapter: parsed.data.adapter ?? "claude-code",
    sandbox: parsed.data.sandbox ?? {},
    workflowSandbox: workflowSandboxFrom(parsed.data.workflows),
    ...(jira ? { jira } : {}),
  };
}

/**
 * One kiln home: `--config <file>` if given, else `$KILN_HOME/kiln.config.json`
 * when `KILN_HOME` is set, else `~/.kiln/kiln.config.json`.
 */
export function resolveKilnConfig(options: ResolveKilnConfigOptions = {}): LoadedKilnConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (options.configPath) {
    return loadKilnConfig(resolve(cwd, options.configPath), { cwd, home });
  }

  const configPath = defaultConfigPath(options);
  assertNoStaleCwdConfig(cwd, configPath);
  if (!existsSync(configPath)) {
    throw new KilnConfigError(
      [
        "No kiln config found.",
        `Run kiln repo add <name> <path> from any directory to create ${configPath}.`,
        "Set KILN_HOME or pass --config <file> to use a different kiln home.",
        "Do not commit checkout paths.",
      ].join("\n"),
    );
  }
  return loadKilnConfig(configPath, { cwd, home });
}

export interface AddRepoOptions extends ResolveKilnConfigOptions {
  name: string;
  /** Path as the user typed it. A relative path is stored absolute, resolved from `cwd`. */
  repoPath: string;
  test?: string;
  /** `local` (default) or `pr`. Omitted on update keeps the stored value. */
  deliver?: "local" | "pr";
  /** Pull request base branch. Omitted on update keeps the stored value. */
  base?: string;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Create or update one repo entry. Returns the text to print. */
export function addRepo(options: AddRepoOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  assertRepoName(options.name);
  if (options.test !== undefined && !options.test.trim()) {
    throw new KilnConfigError("The test command is empty. Omit --test, or pass a command.");
  }
  if (options.base !== undefined) assertBranchName(options.base);

  const configPath = configPathForWrite(options);
  const configDir = dirname(configPath);
  const storedPath = pathToStore(options.repoPath, cwd, home);
  const checkout = resolveConfiguredPath(configDir, storedPath, home);
  if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
    throw new KilnConfigError(`Checkout for ${options.name} does not exist or is not a directory: ${checkout}.`);
  }

  const raw = readConfigObject(configPath);
  const repos = repoMap(raw);
  const previous = repos[options.name];
  const entry: RepoEntry = { path: storedPath };
  const previousTest = previousString(previous, "test");
  const test = options.test ?? previousTest;
  if (test) entry.test = test;
  const deliver = options.deliver ?? previousDeliver(previous);
  if (deliver) entry.deliver = deliver;
  const base = options.base ?? previousString(previous, "base");
  if (base) entry.base = base;
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
  if (entry.deliver) lines.push(`deliver ${entry.deliver}`);
  if (entry.base) lines.push(`base ${entry.base}`);
  lines.push(`wrote ${configPath}`);
  return `${lines.join("\n")}\n`;
}

export function renderRepoList(config: LoadedKilnConfig): string {
  const names = Object.keys(config.repos).sort();
  if (names.length === 0) return "no repos\n";
  const lines = names.map((name) => {
    const repo = config.repos[name];
    if (!repo) return name;
    const bits = [name, repo.path];
    if (repo.test) bits.push(`test ${repo.test}`);
    if (repo.deliver === "pr") bits.push("deliver pr");
    if (repo.base) bits.push(`base ${repo.base}`);
    return bits.join("  ");
  });
  return `${lines.join("\n")}\n`;
}

export function assertBranchName(name: string): void {
  if (!BRANCH_NAME.test(name) || name.includes("..") || name.endsWith("/") || name.includes("//")) {
    throw new KilnConfigError(
      `--base ${JSON.stringify(name)} must be a branch name (letters, digits, dots, underscores, hyphens, and slashes).`,
    );
  }
}

export function assertRepoName(name: string): void {
  if (!REPO_NAME.test(name)) {
    throw new KilnConfigError(
      `Repo name ${JSON.stringify(name)} must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens.`,
    );
  }
}

function defaultConfigPath(options: ResolveKilnConfigOptions): string {
  return join(kilnHomeDirectory(options), CONFIG_NAME);
}

/** `$KILN_HOME` when set, otherwise `~/.kiln`. A relative `KILN_HOME` resolves from `cwd`. */
function kilnHomeDirectory(options: ResolveKilnConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const fromEnv = process.env.KILN_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return resolve(cwd, fromEnv);
  const home = options.home ?? homedir();
  return join(home, ".kiln");
}

function configPathForWrite(options: ResolveKilnConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.configPath) return resolve(cwd, options.configPath);
  const configPath = defaultConfigPath(options);
  assertNoStaleCwdConfig(cwd, configPath);
  return configPath;
}

/**
 * A leftover `./.kiln/kiln.config.json` used to be a second kiln home.
 * Fail instead of ignoring it when the machine home has no config yet.
 */
function assertNoStaleCwdConfig(cwd: string, homeConfig: string): void {
  const cwdConfig = join(cwd, ".kiln", CONFIG_NAME);
  if (!existsSync(cwdConfig)) return;
  if (resolve(cwdConfig) === resolve(homeConfig)) return;
  if (existsSync(homeConfig)) return;
  throw new KilnConfigError(
    `Found ${cwdConfig} but no home config at ${homeConfig}. mv ./.kiln ~/.kiln or pass --config / set KILN_HOME.`,
  );
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

function previousString(previous: unknown, key: string): string | undefined {
  if (typeof previous !== "object" || previous === null || !(key in previous)) return undefined;
  const value = (previous as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function previousDeliver(previous: unknown): "local" | "pr" | undefined {
  const value = previousString(previous, "deliver");
  if (value === "local" || value === "pr") return value;
  return undefined;
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

function pathToStore(userPath: string, cwd: string, home: string): string {
  if (userPath === "~" || userPath.startsWith("~/")) return userPath;
  if (isAbsolute(userPath)) return userPath;
  return resolve(cwd, userPath);
}

function workflowSandboxFrom(
  workflows: Record<string, { sandbox?: SandboxSettings }> | undefined,
): Record<string, SandboxSettings> {
  if (!workflows) return {};
  const out: Record<string, SandboxSettings> = {};
  for (const [name, entry] of Object.entries(workflows)) {
    if (entry.sandbox) out[name] = entry.sandbox;
  }
  return out;
}

function jiraFromFile(jira: JiraConfig | undefined): JiraConfig | undefined {
  if (!jira) return undefined;
  const baseUrl = jira.baseUrl?.trim();
  const email = jira.email?.trim();
  const apiToken = jira.apiToken?.trim();
  if (!baseUrl && !email && !apiToken) return undefined;
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(email ? { email } : {}),
    ...(apiToken ? { apiToken } : {}),
  };
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}
