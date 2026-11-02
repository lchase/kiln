import type { LoadedKilnConfig } from "./config.js";

/**
 * Claude credential shape, checked before tick or serve launches yak.
 * A missing token is allowed: Claude Code can use a macOS keychain login.
 * A set-but-unusable value is not, because Claude prefers it and then 401s.
 * The text names the variable and never includes the value.
 */
export const AUTH_PREFLIGHT_PREFIX = "Claude credentials are not usable:";

/** Printed on an authentication failure. The attempt is not retried. */
export const AUTH_FAILED_LINE =
  "Claude login rejected (401) — check CLAUDE_CODE_OAUTH_TOKEN / claude login, then Retry";

const OAUTH_PREFIX = "sk-ant-oat";

export function claudeCredentialPreflight(
  env: NodeJS.ProcessEnv,
  adapter: LoadedKilnConfig["adapter"],
): string | undefined {
  if (adapter !== "claude-code") return undefined;
  const lines: string[] = [];
  if (Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
    const value = (env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
    if (!value) {
      lines.push(
        "CLAUDE_CODE_OAUTH_TOKEN is set but empty. Unset it, or export a token from `claude setup-token` (it starts with sk-ant-oat). Kiln will not launch.",
      );
    } else if (!value.startsWith(OAUTH_PREFIX)) {
      lines.push(
        "CLAUDE_CODE_OAUTH_TOKEN is set but does not look like a Claude OAuth token (expected a value starting with sk-ant-oat). Kiln will not launch.",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_API_KEY")) {
    const value = (env.ANTHROPIC_API_KEY ?? "").trim();
    if (!value) {
      lines.push("ANTHROPIC_API_KEY is set but empty. Unset it, or export a key. Kiln will not launch.");
    }
  }
  if (lines.length === 0) return undefined;
  return `${AUTH_PREFLIGHT_PREFIX}\n${lines.join("\n")}`;
}

/**
 * True when yak's failure detail or the run log shows a rejected Claude login.
 * `401`, `Invalid bearer token`, and `Failed to authenticate` are the strings
 * the Claude CLI and the API put on stderr. Yak copies that stderr tail into
 * the `step.failed` detail and prints the same line on its own stderr, which
 * Kiln stores under `<kiln-dir>/logs`.
 */
export function authenticationFailureLine(texts: readonly string[]): string | undefined {
  const haystack = texts.join("\n");
  if (!haystack) return undefined;
  if (/Invalid bearer token|Failed to authenticate|\b401\b/.test(haystack)) return AUTH_FAILED_LINE;
  return undefined;
}
