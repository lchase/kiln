import { spawn } from "node:child_process";
import { z } from "zod";
import { PlannerOutputError } from "../errors.js";
import { expectSchema, type Planner, type PlannerContext } from "../planner.js";
import { PlanSchema, ReadinessSchema, REPOS, type Plan, type Readiness } from "../schemas.js";
import { extractModelJson } from "./extract-json.js";

export interface AgentRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface AgentCliPlannerOptions {
  /** Executable to spawn. Defaults to `claude`. */
  bin?: string;
  /** Arguments before the prompt. When set, these replace the default Claude flags. The prompt is appended. */
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Non-interactive Claude Code invocation. `--tools ""` disables built-in
 * tools so this planning step cannot edit the tree.
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
    const args = this.args ? [...this.args, prompt] : [...defaultClaudeArgs(jsonSchema), prompt];
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
          `Could not run ${this.bin}. Install it, or pass --planner rules to use the rules-based planner.`,
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
    "Kiln already rejects a requirement that is missing acceptance criteria, scope, or a user-facing outcome.",
    "Add any further gaps. It is ready only when all three are present:",
    "- acceptance criteria",
    "- scope: which of frontend, ai-core, and evals-obs are in scope, and which are out",
    "- a user-facing outcome: what a person can see or do when the work is done",
    "",
    'If it is ready, return {"ready":true,"missing":[],"questions":[]}.',
    "If it is not ready, return ready false, list the absent items in missing using only",
    "acceptance-criteria, scope, and user-facing-outcome, and write one specific question per gap.",
    "",
    ...localContext(context),
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
    "Each contract is published by one task in its owner repo. That task does not depend on the contract.",
    "Tasks in the other repo depend on the contract id, so the seam lands before they run.",
    "",
    "Rules:",
    "- requirementId is the requirement's id.",
    "- Every task has its own title, description, and acceptance. Acceptance is specific to that task, not a copy of the whole requirement.",
    "- A contract joins exactly two different repos. between is an array of those two repos. kind is api, event, or schema.",
    "- owner is one of those two repos. Exactly one task in the owner repo does not depend on the contract id. That task publishes it.",
    "- Use api for a frontend ↔ ai-core seam (owner ai-core) and event for an ai-core ↔ evals-obs seam (owner ai-core).",
    "- A change that touches one repo has contracts: [].",
    "- Every pair of repos that both have tasks has a contract for that pair.",
    "- dependsOn names a task id or a contract id. The other side of a contract depends on that contract id.",
    "- A task does not depend on a contract its repo is not a side of.",
    "- A task does not depend on a task in another repo unless that task publishes the contract between them.",
    "- A task's repo is the one repo it changes. workflow is feature, bug, security, or prototype.",
    "- Do not invent repos. Use only frontend, ai-core, and evals-obs.",
    "- Task ids and contract ids are unique, non-empty strings in one namespace.",
    "- This is a planning step. Do not propose edits to a working tree.",
    "",
    ...localContext(context),
    "Requirement:",
    JSON.stringify(context.requirement, null, 2),
    "",
    "JSON Schema:",
    JSON.stringify(jsonSchema, null, 2),
  ].join("\n");
}

function localContext(context: PlannerContext): string[] {
  const lines = [
    "Local checkouts on this machine:",
    ...REPOS.map((repo) => `- ${repo}: ${context.checkouts[repo]}`),
    "",
  ];
  if (context.example) {
    lines.push(
      "These checkouts and ownership maps are fictional example data, not a real company.",
      "",
    );
  }
  lines.push("Ownership maps:", JSON.stringify(context.ownership, null, 2), "");
  return lines;
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
      // The agent CLI uses the login already on this machine. Kiln stores no credentials.
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
