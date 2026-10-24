import { spawn } from "node:child_process";
import { z } from "zod";
import { PlannerOutputError } from "../errors.js";
import { expectSchema, type Planner, type PlannerContext } from "../planner.js";
import { PlanSchema, ReadinessSchema, type Plan, type Readiness } from "../schemas.js";
import { extractModelJson } from "./extract-json.js";

export interface AgentRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface AgentCliPlannerOptions {
  /** Executable to spawn. Defaults to `claude`. */
  bin?: string;
  /**
   * Arguments before the prompt. `{schema}` is replaced with the JSON Schema
   * for this step. `{prompt}` is replaced with the prompt; if it is absent,
   * the prompt is appended as the last argument.
   * When omitted, Kiln uses the Claude Code print-mode flags below.
   */
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Non-interactive Claude Code invocation. `--tools ""` disables built-in
 * tools so this planning step cannot edit the tree. Swap `bin` / `args` for
 * another agent CLI (see the README for Codex).
 */
export function defaultClaudeArgs(jsonSchema: unknown): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(jsonSchema),
    "--tools",
    "",
    "--no-session-persistence",
    "--permission-prompts",
    "none",
  ];
}

export class AgentCliPlanner implements Planner {
  private readonly bin: string;
  private readonly args: string[] | undefined;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: AgentCliPlannerOptions = {}) {
    this.bin = options.bin ?? "claude";
    this.args = options.args;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async assessReadiness(context: PlannerContext): Promise<Readiness> {
    const jsonSchema = toJsonSchema(ReadinessSchema);
    const value = await this.complete(jsonSchema, buildAssessPrompt(context, jsonSchema));
    return expectSchema(ReadinessSchema, value, "Readiness");
  }

  async decompose(context: PlannerContext): Promise<Plan> {
    const jsonSchema = toJsonSchema(PlanSchema);
    const value = await this.complete(jsonSchema, buildDecomposePrompt(context, jsonSchema));
    return expectSchema(PlanSchema, value, "Plan");
  }

  private async complete(jsonSchema: Record<string, unknown>, prompt: string): Promise<unknown> {
    const args = this.args
      ? applyArgTemplates(this.args, jsonSchema, prompt)
      : [...defaultClaudeArgs(jsonSchema), prompt];
    let result: AgentRunResult;
    try {
      result = await runProcess(this.bin, args, {
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        throw new PlannerOutputError(
          `Could not run ${this.bin}. Install it, or pass --planner fake to use the scripted planner.`,
        );
      }
      throw new PlannerOutputError(message);
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new PlannerOutputError(`${this.bin} exited ${result.code}: ${detail}`);
    }
    return extractModelJson(result.stdout);
  }
}

export function applyArgTemplates(args: string[], jsonSchema: unknown, prompt: string): string[] {
  const schemaText = JSON.stringify(jsonSchema);
  let usedPrompt = false;
  const next = args.map((arg) => {
    let value = arg.replaceAll("{schema}", schemaText);
    if (value.includes("{prompt}")) {
      usedPrompt = true;
      value = value.replaceAll("{prompt}", prompt);
    }
    return value;
  });
  if (!usedPrompt) next.push(prompt);
  return next;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

function buildAssessPrompt(context: PlannerContext, jsonSchema: unknown): string {
  return [
    "You are Kiln's planner. Reply with one JSON object and no markdown fence. Do not edit files. Do not call tools.",
    "",
    "KILN_STEP: assess",
    "",
    "Decide whether this requirement is ready to decompose into repository tasks.",
    "It is ready only when all three are present:",
    "- acceptance criteria",
    "- scope: which of frontend, ai-core, and evals-obs are in scope, and which are out",
    "- a user-facing outcome: what a person can see or do when the work is done",
    "",
    'If it is ready, return {"ready":true,"missing":[],"questions":[]}.',
    "If it is not ready, return ready false, list the absent items in missing using only",
    "acceptance-criteria, scope, and user-facing-outcome, and write one specific question per gap.",
    "",
    "Ownership maps follow. They are placeholder example data for a fictional product, not a real company.",
    JSON.stringify(context.ownership, null, 2),
    "",
    "Requirement:",
    JSON.stringify(context.requirement, null, 2),
    "",
    "JSON Schema:",
    JSON.stringify(jsonSchema, null, 2),
  ].join("\n");
}

function buildDecomposePrompt(context: PlannerContext, jsonSchema: unknown): string {
  return [
    "You are Kiln's planner. Reply with one JSON object and no markdown fence. Do not edit files. Do not call tools.",
    "",
    "KILN_STEP: decompose",
    "",
    "Decompose the requirement into a plan. The plan centers on the seams between repos.",
    "Contracts land first. A task in one repo depends on the contract ids it implements,",
    "not on a task in another repo, so the repos can proceed independently once the seam exists.",
    "",
    "Rules:",
    "- requirementId is the requirement's id.",
    "- acceptance copies the requirement's acceptance criteria and is non-empty.",
    "- A contract joins exactly two different repos. kind is api, event, or schema.",
    "- Use api for a frontend ↔ ai-core seam and event for an ai-core ↔ evals-obs seam.",
    "- A change that touches one repo has contracts: [].",
    "- Every repo named on a contract has a task in that repo whose contractRefs include it.",
    "- dependsOn lists those contract ids before any task ids. It may name a task id or a contract id.",
    "- dependsOn must not name a task in another repo.",
    "- A task's repo is the one repo it changes. workflow is feature, bug, security, or prototype.",
    "- Do not invent repos. Use only frontend, ai-core, and evals-obs.",
    "- Task ids and contract ids are unique, non-empty strings in one namespace.",
    "- This is a planning step. Do not propose edits to a working tree.",
    "",
    "Ownership maps follow. They are placeholder example data for a fictional product, not a real company.",
    JSON.stringify(context.ownership, null, 2),
    "",
    "Requirement:",
    JSON.stringify(context.requirement, null, 2),
    "",
    "JSON Schema:",
    JSON.stringify(jsonSchema, null, 2),
  ].join("\n");
}

function runProcess(
  bin: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Agent CLI timed out after ${options.timeoutMs}ms.`)));
    }, options.timeoutMs);
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
        }),
      );
    });
  });
}
