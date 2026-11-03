/**
 * Masks secrets in text Kiln writes to the event log, the ledger, and a
 * pull request body. One function owns that. A log or a PR is public-shaped
 * even when a test command or a check excerpt is not.
 *
 * Token shapes cover the common issued-credential prefixes. A value is also
 * masked when it belongs to an env assignment, a JSON field, or an auth
 * header whose name contains TOKEN, KEY, SECRET, or PASSWORD.
 */

const SECRET_NAME = /token|key|secret|password/i;

const TOKEN_SHAPES: readonly RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9\-_]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9\-_]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const AUTH_HEADER =
  /\b(authorization|proxy-authorization|x-api-key|x-auth-token)\s*:[^\n]*/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}={0,2}/g;

const ENV_ASSIGN =
  /(^|[\n\r;\s])((?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s#]+)/g;

const JSON_FIELD =
  /"([A-Za-z_][A-Za-z0-9_]*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/** Replace secret-shaped text with `[redacted]`. Idempotent on its own output. */
export function redact(text: string): string {
  let out = text.replace(ENV_ASSIGN, (full, lead: string, prefix: string, name: string, eq: string, value: string) => {
    if (!SECRET_NAME.test(name)) return full;
    return `${lead}${prefix}${name}${eq}[redacted]`;
  });
  out = out.replace(JSON_FIELD, (full, name: string, mid: string, value: string) => {
    if (!SECRET_NAME.test(name)) return full;
    const quote = value.startsWith("'") ? "'" : '"';
    return `"${name}"${mid}${quote}[redacted]${quote}`;
  });
  out = out.replace(AUTH_HEADER, (_full, name: string) => `${name}: [redacted]`);
  out = out.replace(BEARER, "Bearer [redacted]");
  for (const pattern of TOKEN_SHAPES) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

/** Walk a JSON value and redact every string. Object keys that name a secret drop the value. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string" && SECRET_NAME.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactDeep(inner);
  }
  return out;
}
