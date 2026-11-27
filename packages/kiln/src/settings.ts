import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertBranchName, assertCheckoutDirectory, overlaySkillReport, type LoadedKilnConfig, type OverlaySkillReport } from "./config.js";
import { DEFAULT_BRANCH_TEMPLATE, DEFAULT_PR_TITLE } from "./pr-names.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_MAX_SAME_FINGERPRINT,
  DEFAULT_STALL_TIMEOUT_MS,
  KilnConfigFileSchema,
  SECRET_PLACEHOLDER,
  SettingsWriteSchema,
  type EditableKilnSettings,
  type JiraConfig,
  type KilnConfigFile,
  type RepoEntry,
  type RouteConfig,
  type TriggerConfig,
} from "./schemas.js";
import { spendFor } from "./rails.js";
import { sandboxIsEnabled, sandboxPreflightMessage, type SandboxFacts } from "./sandbox.js";
import { resolveBoardTheme, type BoardThemeId } from "./theme.js";
import { effectiveRoutes, effectiveTriggers } from "./triggers.js";
import type { ZodError } from "zod";

/**
 * What `GET /api/settings` returns and `PUT /api/settings` accepts, plus the
 * file path and a content hash. Secret values are not included. `file` is the
 * config with those values replaced by {@link SECRET_PLACEHOLDER}.
 */
export interface SettingsDocument {
  /** Absolute path of `kiln.config.json`. */
  path: string;
  /** SHA-256 of the file bytes. A PUT must send this back. */
  revision: string;
  repos: Record<string, RepoEntry>;
  stallTimeoutMs?: number;
  maxAttempts?: number;
  keepWorktrees?: boolean;
  maxFixRounds?: number;
  maxSameFingerprint?: number;
  dailyDollarCap?: number;
  maxConcurrent?: number;
  adapter?: "mock" | "claude-code";
  sandbox?: {
    mode?: "off" | "docker";
    allowDomains?: string[];
  };
  /** Effective triggers, including built-ins. A PUT sends the config shape. */
  triggers: SettingsTrigger[];
  /** Effective routes, including built-ins. */
  routes: SettingsRoute[];
  /** `token` says where the credential lives. The value is never sent. */
  jira: {
    baseUrl?: string;
    email?: string;
    acceptanceField?: string;
    token: SecretState;
  };
  overlay?: {
    workflows?: string;
    prompts?: string;
    skills?: string;
    skillPaths?: string[];
  };
  /**
   * Skill folders and skill names agents get from the saved overlay. Read-only:
   * a PUT that echoes it writes nothing.
   */
  skillCheck: OverlaySkillReport;
  /**
   * Dollars recorded today (local day). Read-only: `GET`/`PUT /api/settings`
   * add it from the loaded config ({@link settingsStatus}); a PUT that echoes
   * it writes nothing.
   */
  spentToday?: number;
  /** Whether a sandbox is on and, if so, what `kiln sandbox` would report missing. Read-only like `spentToday`. */
  sandboxCheck?: SandboxCheck;
  /** Resolved board theme. Unknown or missing file values are `kiln`. */
  board: { theme: BoardThemeId };
  /** Shown when a field is omitted. Not written back. */
  defaults: {
    deliver: "local";
    prTitle: string;
    branch: string;
    maxAttempts: number;
    stallTimeoutMs: number;
    maxFixRounds: number;
    maxSameFingerprint: number;
    /** Null means new runs are not blocked by spend. */
    dailyDollarCap: null;
    sandboxMode: "off";
    maxConcurrent: number;
    adapter: "claude-code";
  };
  /**
   * Redacted `kiln.config.json`. Secret strings are `SECRET_PLACEHOLDER`.
   * A PUT of `{ revision, file }` writes this object back.
   */
  file: Record<string, unknown>;
}

export interface SandboxCheck {
  on: boolean;
  /** The text `kiln sandbox` prints when a sandboxed run cannot start. Never holds an env value. */
  problem?: string;
}

/** The read-only facts the page shows beside Limits and Sandbox. */
export interface SettingsStatus {
  spentToday: number;
  sandboxCheck: SandboxCheck;
}

/**
 * Today's spend and the sandbox check for the loaded config. Docker is probed
 * only when a sandbox is on; tests pass `facts` instead.
 */
export function settingsStatus(config: LoadedKilnConfig, facts?: SandboxFacts, now = new Date()): SettingsStatus {
  const on = sandboxIsEnabled(config);
  const problem = on ? sandboxPreflightMessage(config, facts) : undefined;
  return {
    spentToday: spendFor(config.kilnDir, config.dailyDollarCap, now).usd,
    sandboxCheck: { on, ...(problem ? { problem } : {}) },
  };
}

export interface SettingsTrigger {
  id: string;
  kind: "schedule" | "jira" | "pr";
  enabled: boolean;
  builtin?: boolean;
  cron?: string;
  every?: string;
  repo?: string;
  jql?: string;
  label?: string;
  status?: string;
  /** New review jobs one `review-requests` fire may create. Default 3. */
  maxNew?: number;
  /** Queued or running review jobs at once. Default 5. */
  maxQueued?: number;
}

export interface SettingsRoute extends RouteConfig {
  builtin?: boolean;
}

/** Where the Jira API token lives. The board never returns the value. */
export type SecretState = "set in file" | "set in env" | "not set";

export interface SettingsFailure {
  ok: false;
  status: 400 | 409;
  body: { error: string; fields?: Record<string, string> };
}

export interface SettingsSuccess {
  ok: true;
  document: SettingsDocument;
}

const DEFAULTS: SettingsDocument["defaults"] = {
  deliver: "local",
  prTitle: DEFAULT_PR_TITLE,
  branch: DEFAULT_BRANCH_TEMPLATE,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  maxFixRounds: DEFAULT_MAX_FIX_ROUNDS,
  maxSameFingerprint: DEFAULT_MAX_SAME_FINGERPRINT,
  dailyDollarCap: null,
  sandboxMode: "off",
  maxConcurrent: 2,
  adapter: "claude-code",
};

const TRIGGER_KEYS = ["kind", "enabled", "cron", "every", "repo", "jql", "label", "status", "maxNew", "maxQueued"] as const;
const ROUTE_KEYS = ["trigger", "action", "workflow", "repo"] as const;
const SECRET_KEY = /token|secret|password|credential|api[-_]?key/i;

export function readSettings(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): SettingsSuccess | SettingsFailure {
  const read = readConfigFile(configPath);
  if ("error" in read) return fail(409, read.error);
  const parsed = KilnConfigFileSchema.safeParse(read.raw);
  if (!parsed.success) return fail(409, `Kiln config ${configPath} is invalid.`);
  return { ok: true, document: project(configPath, read.revision, parsed.data, read.raw, env, home) };
}

/**
 * Validate `body`, merge it into the file, and write atomically.
 * Unknown keys already in the file stay. A revision that does not match the
 * bytes on disk is a 409 and writes nothing. `{ revision, file }` replaces
 * the file after the same schema check. Invalid JSON never reaches this
 * function. A secret value other than {@link SECRET_PLACEHOLDER} is rejected
 * and the placeholder keeps the bytes already on disk. The read-only
 * `skillCheck`, `spentToday` and `sandboxCheck` a page echoes back are dropped.
 */
export function saveSettings(
  configPath: string,
  input: unknown,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SettingsSuccess | SettingsFailure {
  if (!isRecord(input)) return fail(400, "Request body must be a JSON object.");
  const { skillCheck: _skillCheck, spentToday: _spentToday, sandboxCheck: _sandboxCheck, ...body } = input;
  const read = readConfigFile(configPath);
  if ("error" in read) return fail(409, "The settings file changed on disk. Reload and try again.");

  const claimed = body.revision;
  if (typeof claimed !== "string" || claimed.length === 0) {
    return fail(400, "Settings are invalid.", { revision: "Reload settings and try again." });
  }
  if (claimed !== read.revision) {
    return fail(409, "The settings file changed on disk. Reload and try again.");
  }

  const secrets = secretWriteErrors(body);
  if (Object.keys(secrets).length > 0) return fail(400, "Settings are invalid.", secrets);

  const prepared = isFileWrite(body) ? fileUpdate(body, read.raw, home, configPath) : formUpdate(body, read.raw, home, configPath);
  if (!prepared.ok) return prepared.failure;

  const again = readConfigFile(configPath);
  if ("error" in again || again.revision !== read.revision) {
    return fail(409, "The settings file changed on disk. Reload and try again.");
  }

  const contents = `${JSON.stringify(prepared.next, null, 2)}\n`;
  writeAtomic(configPath, contents);
  return { ok: true, document: project(configPath, hashContents(contents), prepared.parsed, prepared.next, env, home) };
}

function project(
  path: string,
  revision: string,
  file: KilnConfigFile,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  home: string,
): SettingsDocument {
  const sandbox = editableSandbox(file.sandbox);
  const overlay = file.overlay;
  return {
    path,
    revision,
    repos: file.repos,
    ...(file.stallTimeoutMs !== undefined ? { stallTimeoutMs: file.stallTimeoutMs } : {}),
    ...(file.maxAttempts !== undefined ? { maxAttempts: file.maxAttempts } : {}),
    ...(file.keepWorktrees !== undefined ? { keepWorktrees: file.keepWorktrees } : {}),
    ...(file.maxFixRounds !== undefined ? { maxFixRounds: file.maxFixRounds } : {}),
    ...(file.maxSameFingerprint !== undefined ? { maxSameFingerprint: file.maxSameFingerprint } : {}),
    ...(file.dailyDollarCap !== undefined ? { dailyDollarCap: file.dailyDollarCap } : {}),
    ...(file.maxConcurrent !== undefined ? { maxConcurrent: file.maxConcurrent } : {}),
    ...(file.adapter !== undefined ? { adapter: file.adapter } : {}),
    ...(sandbox ? { sandbox } : {}),
    triggers: effectiveTriggers(file.triggers).map((trigger) => triggerView(trigger)),
    routes: effectiveRoutes(file.routes).map((route) => routeView(route)),
    jira: jiraView(raw.jira, file.jira, env),
    ...(overlay ? { overlay } : {}),
    skillCheck: overlaySkillReport(dirname(path), home, overlay),
    board: { theme: resolveBoardTheme(file.board?.theme) },
    defaults: DEFAULTS,
    file: redactFile(raw),
  };
}

function jiraView(raw: unknown, parsed: JiraConfig | undefined, env: NodeJS.ProcessEnv): SettingsDocument["jira"] {
  const source = isRecord(raw) ? raw : {};
  const baseUrl = text(parsed?.baseUrl ?? source.baseUrl);
  const email = text(parsed?.email ?? source.email);
  const acceptanceField = text(parsed?.acceptanceField ?? source.acceptanceField);
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(email ? { email } : {}),
    ...(acceptanceField ? { acceptanceField } : {}),
    token: tokenState(source.apiToken, env.JIRA_API_TOKEN),
  };
}

function tokenState(fileValue: unknown, envValue: string | undefined): SecretState {
  if (text(envValue)) return "set in env";
  if (text(fileValue)) return "set in file";
  return "not set";
}

function editableSandbox(sandbox: KilnConfigFile["sandbox"]): SettingsDocument["sandbox"] | undefined {
  if (!sandbox) return undefined;
  const mode = sandbox.mode;
  const allowDomains = sandbox.allowDomains;
  if (mode === undefined && allowDomains === undefined) return undefined;
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(allowDomains !== undefined ? { allowDomains } : {}),
  };
}

function checkedConfig(
  next: Record<string, unknown>,
  home: string,
  configPath: string,
  triggers?: readonly { id: string }[],
  routes?: readonly { id: string }[],
): { ok: true; next: Record<string, unknown>; parsed: KilnConfigFile } | { ok: false; failure: SettingsFailure } {
  const file = KilnConfigFileSchema.safeParse(next);
  if (!file.success) return { ok: false, failure: fail(400, "Settings are invalid.", fieldErrors(file.error)) };
  const fields = {
    ...checkoutFields(dirname(configPath), file.data.repos, home),
    ...duplicateIdFields(triggers ?? file.data.triggers ?? [], "triggers"),
    ...duplicateIdFields(routes ?? file.data.routes ?? [], "routes"),
  };
  if (Object.keys(fields).length > 0) return { ok: false, failure: fail(400, "Settings are invalid.", fields) };
  return { ok: true, next, parsed: file.data };
}

function formUpdate(
  body: Record<string, unknown>,
  raw: Record<string, unknown>,
  home: string,
  configPath: string,
): { ok: true; next: Record<string, unknown>; parsed: KilnConfigFile } | { ok: false; failure: SettingsFailure } {
  const stripped = walkSecrets(body, undefined, "strip");
  if (!isRecord(stripped)) return { ok: false, failure: fail(400, "Request body must be a JSON object.") };
  const relaxed = relaxBlanks(stripped);
  const parsed = SettingsWriteSchema.safeParse(relaxed);
  if (!parsed.success) return { ok: false, failure: fail(400, "Settings are invalid.", fieldErrors(parsed.error)) };

  const { revision: _revision, ...editable } = parsed.data;
  const next = mergeSettings(raw, editable, stripped);
  return checkedConfig(next, home, configPath, editable.triggers, editable.routes);
}

function fileUpdate(
  body: Record<string, unknown>,
  raw: Record<string, unknown>,
  home: string,
  configPath: string,
): { ok: true; next: Record<string, unknown>; parsed: KilnConfigFile } | { ok: false; failure: SettingsFailure } {
  const restored = walkSecrets(body.file, raw, "restore");
  if (!isRecord(restored)) return { ok: false, failure: fail(400, "Settings are invalid.", { file: "Config must be a JSON object." }) };
  return checkedConfig(restored, home, configPath);
}

function mergeSettings(
  raw: Record<string, unknown>,
  settings: EditableKilnSettings,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const previousRepos = isRecord(raw.repos) ? raw.repos : {};
  const repos: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(settings.repos)) {
    const prior = isRecord(previousRepos[name]) ? { ...previousRepos[name] } : {};
    prior.path = entry.path;
    setOptional(prior, "test", entry.test);
    setOptional(prior, "deliver", entry.deliver);
    setOptional(prior, "base", entry.base);
    setOptional(prior, "prTitle", entry.prTitle);
    setOptional(prior, "branch", entry.branch);
    setOptional(prior, "maxAttempts", entry.maxAttempts);
    setOptional(prior, "maxFixRounds", entry.maxFixRounds);
    repos[name] = prior;
  }
  next.repos = repos;
  setOptional(next, "stallTimeoutMs", settings.stallTimeoutMs);
  setOptional(next, "maxAttempts", settings.maxAttempts);
  setOptional(next, "keepWorktrees", settings.keepWorktrees);
  setOptional(next, "maxFixRounds", settings.maxFixRounds);
  setOptional(next, "maxSameFingerprint", settings.maxSameFingerprint);
  setOptional(next, "dailyDollarCap", settings.dailyDollarCap);
  if (Object.hasOwn(body, "maxConcurrent")) {
    if (body.maxConcurrent === null) delete next.maxConcurrent;
    else setOptional(next, "maxConcurrent", settings.maxConcurrent);
  }
  if (Object.hasOwn(body, "adapter")) {
    if (body.adapter === null) delete next.adapter;
    else setOptional(next, "adapter", settings.adapter);
  }
  if (Object.hasOwn(body, "triggers")) {
    const triggers = triggersForFile(settings.triggers ?? []);
    if (triggers.length === 0) delete next.triggers;
    else next.triggers = triggers;
  }
  if (Object.hasOwn(body, "routes")) {
    const routes = routesForFile(settings.routes ?? []);
    if (routes.length === 0) delete next.routes;
    else next.routes = routes;
  }
  if (Object.hasOwn(body, "jira")) next.jira = mergeJira(raw.jira, body.jira);
  if (next.jira === undefined) delete next.jira;
  if (Object.hasOwn(body, "overlay")) next.overlay = mergeOverlay(raw.overlay, body.overlay);
  if (next.overlay === undefined) delete next.overlay;
  if (settings.sandbox) {
    const prior = isRecord(raw.sandbox) ? { ...raw.sandbox } : {};
    setOptional(prior, "mode", settings.sandbox.mode);
    setOptional(prior, "allowDomains", settings.sandbox.allowDomains);
    if (Object.keys(prior).length === 0) delete next.sandbox;
    else next.sandbox = prior;
  }
  if (settings.board) {
    const prior = isRecord(raw.board) ? { ...raw.board } : {};
    prior.theme = settings.board.theme;
    next.board = prior;
  }
  return next;
}

function mergeJira(current: unknown, patch: unknown): Record<string, unknown> | undefined {
  const prior = isRecord(current) ? { ...current } : {};
  if (isRecord(patch)) {
    applyText(prior, patch, "baseUrl");
    applyText(prior, patch, "email");
    applyText(prior, patch, "acceptanceField");
  }
  return Object.keys(prior).length > 0 ? prior : undefined;
}

function mergeOverlay(current: unknown, patch: unknown): Record<string, unknown> | undefined {
  const prior = isRecord(current) ? { ...current } : {};
  if (!isRecord(patch)) return Object.keys(prior).length > 0 ? prior : undefined;
  applyText(prior, patch, "workflows");
  applyText(prior, patch, "prompts");
  applyText(prior, patch, "skills");
  if (Object.hasOwn(patch, "skillPaths")) {
    const paths = Array.isArray(patch.skillPaths)
      ? patch.skillPaths.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];
    if (paths.length === 0) delete prior.skillPaths;
    else prior.skillPaths = paths;
  }
  return Object.keys(prior).length > 0 ? prior : undefined;
}

function applyText(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (!Object.hasOwn(source, key)) return;
  const value = text(source[key]);
  if (!value) delete target[key];
  else target[key] = value;
}

function triggersForFile(submitted: readonly TriggerConfig[]): TriggerConfig[] {
  return omitBuiltins(submitted, effectiveTriggers(undefined), TRIGGER_KEYS);
}

function routesForFile(submitted: readonly RouteConfig[]): RouteConfig[] {
  return omitBuiltins(submitted, effectiveRoutes(undefined), ROUTE_KEYS);
}

function omitBuiltins<T extends { id: string }>(
  submitted: readonly T[],
  builtins: readonly T[],
  keys: readonly (keyof T)[],
): T[] {
  const byId = new Map(builtins.map((item) => [item.id, item]));
  return submitted.filter((item) => {
    const builtin = byId.get(item.id);
    return !builtin || fingerprint(item, keys) !== fingerprint(builtin, keys);
  });
}

function fingerprint<T extends { id: string }>(item: T, keys: readonly (keyof T)[]): string {
  const parts = [`id=${item.id}`];
  for (const key of keys) {
    const value = item[key];
    if (value === undefined || value === true) continue;
    parts.push(`${String(key)}=${String(value)}`);
  }
  return parts.join("\n");
}

function triggerView(trigger: TriggerConfig): SettingsTrigger {
  const builtin = effectiveTriggers(undefined).some((item) => item.id === trigger.id);
  const view: SettingsTrigger = { id: trigger.id, kind: trigger.kind, enabled: trigger.enabled !== false };
  if (builtin) view.builtin = true;
  for (const key of TRIGGER_KEYS) {
    if (key === "kind" || key === "enabled") continue;
    const value = trigger[key];
    if (value !== undefined) view[key] = value as never;
  }
  return view;
}

function routeView(route: RouteConfig): SettingsRoute {
  const builtin = effectiveRoutes(undefined).some((item) => item.id === route.id);
  return { ...route, ...(builtin ? { builtin: true } : {}) };
}

function duplicateIdFields(items: readonly { id: string }[], prefix: string): Record<string, string> {
  const seen = new Set<string>();
  const fields: Record<string, string> = {};
  items.forEach((item, index) => {
    if (seen.has(item.id)) fields[`${prefix}.${index}.id`] = `Id ${item.id} is already used.`;
    else seen.add(item.id);
  });
  return fields;
}

function checkoutFields(configDir: string, repos: Record<string, RepoEntry>, home: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, entry] of Object.entries(repos)) {
    try {
      assertCheckoutDirectory(name, configDir, entry.path, home);
    } catch (error) {
      fields[`repos.${name}.path`] = error instanceof Error ? error.message : String(error);
    }
    if (entry.base === undefined) continue;
    try {
      assertBranchName(entry.base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fields[`repos.${name}.base`] = message.replace(/^--base\s+\S+\s+/, "Base ");
    }
  }
  return fields;
}

function fieldErrors(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      const prefix = issue.path.length ? `${issue.path.map(String).join(".")}.` : "";
      for (const key of issue.keys) {
        const field = `${prefix}${key}`;
        if (!fields[field]) fields[field] = "Unknown field.";
      }
      continue;
    }
    const key = issue.path.length ? issue.path.map(String).join(".") : "body";
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

function secretWriteErrors(value: unknown, path = ""): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(value)) {
    value.forEach((item, index) => Object.assign(fields, secretWriteErrors(item, path ? `${path}.${index}` : String(index))));
    return fields;
  }
  if (!isRecord(value)) return fields;
  for (const [key, item] of Object.entries(value)) {
    if (path === "" && key === "revision") continue;
    const next = path ? `${path}.${key}` : key;
    if (isSecretKey(key)) {
      if (item === SECRET_PLACEHOLDER || item === undefined) continue;
      if (typeof item === "string" && item.trim() === "") continue;
      fields[next] = secretMessage(key);
      continue;
    }
    Object.assign(fields, secretWriteErrors(item, next));
  }
  return fields;
}

function secretMessage(key: string): string {
  if (/token/i.test(key)) return "Set JIRA_API_TOKEN in the environment. The board does not store a token.";
  return "The board does not accept this value. Keep it in the file or the environment.";
}

function redactFile(value: unknown): Record<string, unknown> {
  const redacted = walkSecrets(value, undefined, "redact");
  return isRecord(redacted) ? redacted : {};
}

function walkSecrets(value: unknown, previous: unknown, mode: "redact" | "restore" | "strip"): unknown {
  if (Array.isArray(value)) {
    const prior = Array.isArray(previous) ? previous : [];
    return value.map((item, index) => walkSecrets(item, prior[index], mode));
  }
  if (!isRecord(value)) return value;
  const prior = isRecord(previous) ? previous : {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
      const kept = secretValue(item, prior[key], mode);
      if (kept !== undefined) out[key] = kept;
      continue;
    }
    out[key] = walkSecrets(item, prior[key], mode);
  }
  return out;
}

function secretValue(value: unknown, previous: unknown, mode: "redact" | "restore" | "strip"): unknown {
  const filled = typeof value === "string" && value.trim().length > 0;
  if (mode === "redact") return filled ? SECRET_PLACEHOLDER : value;
  if (value === SECRET_PLACEHOLDER) return typeof previous === "string" && previous.trim() ? previous : undefined;
  if (!filled) return undefined;
  return mode === "strip" ? value : undefined;
}

function relaxBlanks(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  if (next.maxConcurrent === null) delete next.maxConcurrent;
  if (next.adapter === null) delete next.adapter;
  if (isRecord(next.jira)) next.jira = withoutBlankStrings(next.jira);
  if (isRecord(next.overlay)) next.overlay = withoutBlankStrings(next.overlay);
  return next;
}

function withoutBlankStrings(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      if (value.trim()) out[key] = value.trim();
      continue;
    }
    if (key === "skillPaths" && Array.isArray(value)) {
      const paths = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
      if (paths.length > 0) out[key] = paths;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isFileWrite(body: Record<string, unknown>): boolean {
  return Object.hasOwn(body, "file") && Object.keys(body).every((key) => key === "file" || key === "revision");
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function setOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function readConfigFile(
  configPath: string,
): { revision: string; raw: Record<string, unknown> } | { error: string } {
  let textBody: string;
  try {
    textBody = readFileSync(configPath, "utf8");
  } catch {
    return { error: "The settings file changed on disk. Reload and try again." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    return { error: `Kiln config ${configPath} is invalid.` };
  }
  if (!isRecord(parsed)) return { error: `Kiln config ${configPath} must be a JSON object.` };
  return { revision: hashContents(textBody), raw: parsed };
}

function hashContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function writeAtomic(configPath: string, contents: string): void {
  const tmp = join(dirname(configPath), `.${basename(configPath)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, configPath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function fail(status: 400 | 409, error: string, fields?: Record<string, string>): SettingsFailure {
  return {
    ok: false,
    status,
    body: fields && Object.keys(fields).length > 0 ? { error, fields } : { error },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
