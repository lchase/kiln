import { PlannerOutputError } from "../errors.js";

/**
 * Pull the model's JSON object out of a coding-agent CLI transcript.
 * Accepts a raw JSON object, a Claude `--output-format json` envelope
 * (`structured_output` or a `result` string), or a Codex `exec --json` JSONL stream.
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

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    try {
      const events = lines.map((line) => JSON.parse(line) as unknown);
      return unwrapEnvelope(events);
    } catch (error) {
      if (error instanceof PlannerOutputError) throw error;
    }
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
    if (value.some(isEvent)) {
      const withStructured = [...value].reverse().find((item) => {
        return isRecord(item) && item.type === "result" && item.structured_output != null;
      });
      if (isRecord(withStructured)) return withStructured.structured_output;
      const text = lastAgentText(value);
      if (text) return parseEmbeddedJson(text);
      throw new PlannerOutputError("Agent event stream did not include a JSON result.");
    }
    return value;
  }

  if (!isRecord(value)) return value;

  if (value.structured_output != null && (value.type === "result" || "result" in value)) {
    return value.structured_output;
  }

  if (typeof value.type === "string" && value.type.startsWith("item.")) {
    const text = textOfItem(value.item);
    if (text) return parseEmbeddedJson(text);
  }

  if (typeof value.result === "string") {
    return parseEmbeddedJson(value.result);
  }

  return value;
}

function lastAgentText(events: unknown[]): string | undefined {
  let text: string | undefined;
  for (const event of events) {
    if (!isRecord(event)) continue;
    const fromItem = textOfItem(event.item);
    if (fromItem && (event.type === "item.completed" || event.type === "item.updated")) {
      text = fromItem;
      continue;
    }
    if (typeof event.result === "string" && event.type === "result") {
      text = event.result;
    }
  }
  return text;
}

function textOfItem(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const itemType = item.type ?? item.item_type;
  if (itemType !== "agent_message" && itemType !== "assistant_message") return undefined;
  return typeof item.text === "string" ? item.text : undefined;
}

function isEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return (
    value.type === "result" ||
    value.type.startsWith("item.") ||
    value.type.startsWith("thread.") ||
    value.type.startsWith("turn.")
  );
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
