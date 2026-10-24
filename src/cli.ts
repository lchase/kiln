#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveKilnConfig } from "./config.js";
import { approvePlan, runStatus, runTick } from "./driver.js";
import { PlanValidationError } from "./errors.js";
import { parseRequirement } from "./parse-requirement.js";
import { writePlanFiles } from "./plans.js";
import { AgentCliPlanner } from "./planners/agent-cli.js";
import { RulesPlanner } from "./planners/rules.js";
import type { Planner } from "./planner.js";
import { refine } from "./refine.js";
import { renderRefineResult } from "./render.js";

interface RefineFlags {
  file: string;
  planner: "rules" | "agent";
  configPath?: string;
  agentBin?: string;
}

function usage(): never {
  console.error(
    [
      "Usage: kiln refine <requirement.md> [options]",
      "       kiln approve <planId> [--config <file>]",
      "       kiln tick [--config <file>]",
      "       kiln status [planId] [--config <file>]",
      "",
      "refine options:",
      "  --planner rules|agent    Rules-based planner (default) or a coding-agent CLI",
      "  --config <file>          kiln.config.json. Default: ./.kiln/, then ~/.kiln/",
      "  --agent-bin <bin>        Agent executable (default: claude). Uses your login.",
      "",
      "refine prints JSON, then a markdown rendering. A valid plan is written under",
      "a .kiln directory. Questions and valid plans both exit 0.",
      "",
      "approve records human approval of a plan. tick launches at most one ready",
      "task per invocation, in a yak worktree, and only for an approved plan.",
      "status shows each task's state, the yak run id, and both approve and",
      "reject commands for an open gate.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseRefineFlags(argv: string[]): RefineFlags {
  if (argv[0] !== "refine" || !argv[1] || argv[1].startsWith("--")) usage();
  const flags: RefineFlags = {
    file: argv[1],
    planner: process.env.KILN_PLANNER === "agent" ? "agent" : "rules",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--planner" && (next === "rules" || next === "fake" || next === "agent")) {
      flags.planner = next === "agent" ? "agent" : "rules";
      i += 1;
      continue;
    }
    if (flag === "--config" && next) {
      flags.configPath = next;
      i += 1;
      continue;
    }
    if (flag === "--agent-bin" && next) {
      flags.agentBin = next;
      i += 1;
      continue;
    }
    usage();
  }
  return flags;
}

function takeConfig(argv: string[]): { configPath?: string; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--config" && next && !next.startsWith("--")) {
      configPath = next;
      i += 1;
      continue;
    }
    if (flag?.startsWith("--")) usage();
    if (flag !== undefined) rest.push(flag);
  }
  return { configPath, rest };
}

function plannerFrom(flags: RefineFlags): Planner {
  if (flags.planner === "rules") return new RulesPlanner();
  return new AgentCliPlanner({ bin: flags.agentBin });
}

async function refineCommand(argv: string[]): Promise<void> {
  const flags = parseRefineFlags(argv);
  const path = resolve(flags.file);
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not read ${path}: ${message}`);
    process.exit(2);
  }
  const config = resolveKilnConfig({
    configPath: flags.configPath,
    requirementPath: path,
  });
  if (config.example) {
    console.error(
      `Using ${config.configPath} (fictional example data). Real checkout paths, ownership maps, requirements, and plans belong in .kiln/ or ~/.kiln/ and must not be committed.`,
    );
  }
  const requirement = parseRequirement(markdown, path);
  const result = await refine(requirement, plannerFrom(flags), { config });
  const rendered = renderRefineResult(requirement, result);
  const json = JSON.stringify(result, null, 2);
  if (result.kind === "plan") {
    const written = writePlanFiles(config.plansDir, requirement.id, json, rendered);
    console.error(`Wrote ${written.jsonPath}`);
    console.error(`Wrote ${written.markdownPath}`);
  }
  process.stdout.write(`${json}\n\n${rendered}`);
}

function driverCommand(command: "approve" | "tick" | "status", argv: string[]): void {
  const { configPath, rest } = takeConfig(argv);
  const config = resolveKilnConfig({ configPath });
  if (command === "approve") {
    const planId = rest[0];
    if (!planId || rest.length !== 1) usage();
    process.stdout.write(approvePlan(config, planId));
    return;
  }
  if (command === "tick") {
    if (rest.length !== 0) usage();
    process.stdout.write(runTick(config));
    return;
  }
  const planId = rest[0];
  if (rest.length > 1) usage();
  process.stdout.write(runStatus(config, planId));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") usage();
  if (command === "refine") {
    await refineCommand(argv);
    return;
  }
  if (command === "approve" || command === "tick" || command === "status") {
    driverCommand(command, argv.slice(1));
    return;
  }
  usage();
}

main().catch((error: unknown) => {
  if (error instanceof PlanValidationError) {
    console.error(JSON.stringify({ kind: "invalid-plan", issues: error.issues }, null, 2));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
