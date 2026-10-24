import { PlannerOutputError } from "../errors.js";

/**
 * Pull the model's JSON object out of a Claude print-mode transcript.
 * Accepts a raw JSON object, a `--output-format json` envelope
 * (`structured_output` or a `result` string, possibly fenced), or a JSON
 * array of events that includes a `type: "result"` element.
 */
export function extractModelJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new PlannerOutputError("Agent CLI returned empty stdout.");
  }

  try {
    return unwrapEnvelope(JSON.parse(trimmed) as unknown);
  } catch (error) {
    if (error instanceof PlannerOutputError) throw error;
  }

  try {
    return parseEmbeddedJson(trimmed);
  } catch (error) {
    if (error instanceof PlannerOutputError) throw error;
    throw new PlannerOutputError("Agent CLI did not return JSON.");
  }
}

function unwrapEnvelope(value: unknown): unknown {
  if (Array.isArray(value)) {
    const withStructured = [...value].reverse().find((item) => {
      return isRecord(item) && item.type === "result" && item.structured_output != null;
    });
    if (isRecord(withStructured)) return withStructured.structured_output;
    const withResult = [...value].reverse().find((item) => {
      return isRecord(item) && item.type === "result" && typeof item.result === "string";
    });
    if (isRecord(withResult) && typeof withResult.result === "string") {
      return parseEmbeddedJson(withResult.result);
    }
    return value;
  }

  if (!isRecord(value)) return value;

  if (value.structured_output != null && (value.type === "result" || "result" in value)) {
    return value.structured_output;
  }

  if (typeof value.result === "string") {
    return parseEmbeddedJson(value.result);
  }

  return value;
}

function parseEmbeddedJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        throw new PlannerOutputError("Agent CLI returned text that is not JSON.");
      }
    }
    throw new PlannerOutputError("Agent CLI returned text that is not JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
