import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertBranchName, assertCheckoutDirectory } from "./config.js";
import { DEFAULT_BRANCH_TEMPLATE, DEFAULT_PR_TITLE } from "./pr-names.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_MAX_SAME_FINGERPRINT,
  DEFAULT_STALL_TIMEOUT_MS,
  KilnConfigFileSchema,
  SettingsWriteSchema,
  type EditableKilnSettings,
  type KilnConfigFile,
  type RepoEntry,
} from "./schemas.js";
import type { ZodError } from "zod";

/**
 * What `GET /api/settings` returns and `PUT /api/settings` accepts, plus the
 * file path and a content hash. Jira and other secrets are not part of this.
 */
export interface SettingsDocument {
  /** Absolute path of `kiln.config.json`. */
  path: string;
  /** SHA-256 of the file bytes. A PUT must send this back. */
  revision: string;
  repos: Record<string, RepoEntry>;
  stallTimeoutMs?: number;
  maxAttempts?: number;
  maxFixRounds?: number;
  maxSameFingerprint?: number;
  dailyDollarCap?: number;
  sandbox?: {
    mode?: "off" | "docker";
    allowDomains?: string[];
  };
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
  };
}

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
};

export function readSettings(configPath: string): SettingsSuccess | SettingsFailure {
  const read = readConfigFile(configPath);
  if ("error" in read) return fail(409, read.error);
  const parsed = KilnConfigFileSchema.safeParse(read.raw);
  if (!parsed.success) return fail(409, `Kiln config ${configPath} is invalid.`);
  return { ok: true, document: project(configPath, read.revision, parsed.data) };
}

/**
 * Validate `body`, merge it into the file, and write atomically.
 * Unknown keys already in the file stay. A revision that does not match the
 * bytes on disk is a 409 and writes nothing.
 */
export function saveSettings(configPath: string, body: unknown, home = homedir()): SettingsSuccess | SettingsFailure {
  if (!isRecord(body)) return fail(400, "Request body must be a JSON object.");
  const read = readConfigFile(configPath);
  if ("error" in read) return fail(409, "The settings file changed on disk. Reload and try again.");

  const claimed = body.revision;
  if (typeof claimed !== "string" || claimed.length === 0) {
    return fail(400, "Settings are invalid.", { revision: "Reload settings and try again." });
  }
  if (claimed !== read.revision) {
    return fail(409, "The settings file changed on disk. Reload and try again.");
  }

  const parsed = SettingsWriteSchema.safeParse(body);
  if (!parsed.success) return fail(400, "Settings are invalid.", fieldErrors(parsed.error));

  const { revision: _revision, ...editable } = parsed.data;
  const fields = checkoutFields(dirname(configPath), editable, home);
  if (Object.keys(fields).length > 0) return fail(400, "Settings are invalid.", fields);

  const next = mergeSettings(read.raw, editable);
  const file = KilnConfigFileSchema.safeParse(next);
  if (!file.success) return fail(400, "Settings are invalid.", fieldErrors(file.error));

  const again = readConfigFile(configPath);
  if ("error" in again || again.revision !== read.revision) {
    return fail(409, "The settings file changed on disk. Reload and try again.");
  }

  const contents = `${JSON.stringify(next, null, 2)}\n`;
  writeAtomic(configPath, contents);
  return { ok: true, document: project(configPath, hashContents(contents), file.data) };
}

function project(path: string, revision: string, file: KilnConfigFile): SettingsDocument {
  const sandbox = editableSandbox(file.sandbox);
  return {
    path,
    revision,
    repos: file.repos,
    ...(file.stallTimeoutMs !== undefined ? { stallTimeoutMs: file.stallTimeoutMs } : {}),
    ...(file.maxAttempts !== undefined ? { maxAttempts: file.maxAttempts } : {}),
    ...(file.maxFixRounds !== undefined ? { maxFixRounds: file.maxFixRounds } : {}),
    ...(file.maxSameFingerprint !== undefined ? { maxSameFingerprint: file.maxSameFingerprint } : {}),
    ...(file.dailyDollarCap !== undefined ? { dailyDollarCap: file.dailyDollarCap } : {}),
    ...(sandbox ? { sandbox } : {}),
    defaults: DEFAULTS,
  };
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

function mergeSettings(raw: Record<string, unknown>, settings: EditableKilnSettings): Record<string, unknown> {
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
  setOptional(next, "maxFixRounds", settings.maxFixRounds);
  setOptional(next, "maxSameFingerprint", settings.maxSameFingerprint);
  setOptional(next, "dailyDollarCap", settings.dailyDollarCap);
  if (settings.sandbox) {
    const prior = isRecord(raw.sandbox) ? { ...raw.sandbox } : {};
    setOptional(prior, "mode", settings.sandbox.mode);
    setOptional(prior, "allowDomains", settings.sandbox.allowDomains);
    if (Object.keys(prior).length === 0) delete next.sandbox;
    else next.sandbox = prior;
  }
  return next;
}

function checkoutFields(configDir: string, settings: EditableKilnSettings, home: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, entry] of Object.entries(settings.repos)) {
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

function setOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function readConfigFile(
  configPath: string,
): { revision: string; raw: Record<string, unknown> } | { error: string } {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { error: "The settings file changed on disk. Reload and try again." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `Kiln config ${configPath} is invalid.` };
  }
  if (!isRecord(parsed)) return { error: `Kiln config ${configPath} must be a JSON object.` };
  return { revision: hashContents(text), raw: parsed };
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
