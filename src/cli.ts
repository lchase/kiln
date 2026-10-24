#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlanValidationError, PlannerOutputError } from "./errors.js";
import { parseRequirement, RequirementParseError } from "./parse-requirement.js";
import { AgentCliPlanner } from "./planners/agent-cli.js";
import { FakePlanner } from "./planners/fake.js";
import type { Planner } from "./planner.js";
import { refine } from "./refine.js";
import { renderRefineResult } from "./render.js";

interface Flags {
  file: string;
  planner: "fake" | "agent";
  ownership?: string;
  agentBin?: string;
  agentArgs?: string;
}

function usage(): never {
  console.error(
    [
      "Usage: kiln refine <requirement.md> [options]",
      "",
      "Options:",
      "  --planner fake|agent     Scripted planner (default) or a coding-agent CLI",
      "  --ownership <dir>        Directory of <repo>.json ownership maps",
      "  --agent-bin <bin>        Agent executable (default: claude)",
      "  --agent-args <args>      Arguments for the agent, split on spaces.",
      "                           {schema} and {prompt} are replaced.",
      "                           Default is Claude print mode with tools disabled.",
      "",
      "Prints JSON, then a markdown rendering. Questions and valid plans both exit 0.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseFlags(argv: string[]): Flags {
  if (argv[0] !== "refine" || !argv[1] || argv[1].startsWith("--")) usage();
  const flags: Flags = {
    file: argv[1],
    planner: process.env.KILN_PLANNER === "agent" ? "agent" : "fake",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--planner" && (next === "fake" || next === "agent")) {
      flags.planner = next;
      i += 1;
      continue;
    }
    if (flag === "--ownership" && next) {
      flags.ownership = next;
      i += 1;
      continue;
    }
    if (flag === "--agent-bin" && next) {
      flags.agentBin = next;
      i += 1;
      continue;
    }
    if (flag === "--agent-args" && next) {
      flags.agentArgs = next;
      i += 1;
      continue;
    }
    usage();
  }
  return flags;
}

function plannerFrom(flags: Flags): Planner {
  if (flags.planner === "fake") return new FakePlanner();
  return new AgentCliPlanner({
    bin: flags.agentBin,
    args: flags.agentArgs?.split(/\s+/).filter(Boolean),
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const path = resolve(flags.file);
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not read ${path}: ${message}`);
    process.exit(2);
  }
  const requirement = parseRequirement(markdown, path);
  const result = await refine(requirement, plannerFrom(flags), {
    ownershipDir: flags.ownership ? resolve(flags.ownership) : undefined,
  });
  const rendered = renderRefineResult(requirement, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n${rendered}`);
}

main().catch((error: unknown) => {
  if (error instanceof PlanValidationError) {
    console.error(JSON.stringify({ kind: "invalid-plan", issues: error.issues }, null, 2));
    process.exit(1);
  }
  if (error instanceof PlannerOutputError || error instanceof RequirementParseError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
