#!/usr/bin/env node
import { addRepo, renderRepoList, resolveKilnConfig } from "./config.js";
import { answerJob, runStatus, runTick } from "./driver.js";
import { addFromFile } from "./intake/file.js";
import { addFromJira } from "./intake/jira.js";
import { addFromPrompt } from "./intake/prompt.js";
import { importTickets } from "./intake/tickets.js";
import { renderAddedJob } from "./jobs.js";

function usage(): never {
  console.error(
    [
      "Usage: kiln repo add <name> <path> [--test <cmd>] [--config <file>]",
      "       kiln repo list [--config <file>]",
      "       kiln add <workflow> --repo <name> (--spec <file.md> | --prompt <text> | --jira <KEY>) [--title <text>] [--after <jobId>]... [--dry-run] [--config <file>]",
      "       kiln import <dir> --repo <name> [--workflow <name>] [--context <file.md>] [--dry-run] [--config <file>]",
      "       kiln tick [--config <file>]",
      "       kiln status [jobId] [--config <file>]",
      "       kiln approve <jobId> [--config <file>]",
      "       kiln reject <jobId> [--config <file>]",
      "",
      "repo add registers a checkout. Relative paths are stored relative to the",
      "config directory. ~ is expanded from the home directory.",
      "",
      "add writes one job from a spec file, from --prompt text (--prompt - reads stdin),",
      "or from a Jira Cloud issue (--jira PROJ-123). Pass one of those, not more.",
      "The repo and the workflow (workflows/<name>.yaml) must already exist.",
      "--after names jobs that must be done before this one launches. A Jira Blocks",
      "link where this issue is blocked by another key is included when a kiln job",
      "for that key already exists.",
      "--dry-run with --jira prints the job and writes nothing. Running add again",
      "for the same Jira key prints the existing job id and creates nothing.",
      "",
      "import reads a directory of NN-slug.md tickets and writes one job per file.",
      "Blocked-by becomes dependsOn. Re-running the same directory does not duplicate jobs.",
      "--dry-run prints the jobs and writes nothing.",
      "",
      "tick launches at most one ready job: dependencies done, under maxConcurrent.",
      "status prints the derived state. approve and reject answer the human gate.",
    ].join("\n"),
  );
  process.exit(2);
}

interface FlagBag {
  positionals: string[];
  configPath?: string;
  test?: string;
  repo?: string;
  spec?: string;
  prompt?: string;
  jira?: string;
  title?: string;
  workflow?: string;
  context?: string;
  dryRun: boolean;
  after: string[];
}

function parseFlags(argv: string[]): FlagBag {
  const bag: FlagBag = { positionals: [], after: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--config") {
      if (!next || next.startsWith("--")) usage();
      bag.configPath = next;
      i += 1;
      continue;
    }
    if (flag === "--test") {
      if (!next || next.startsWith("--")) usage();
      bag.test = next;
      i += 1;
      continue;
    }
    if (flag === "--repo") {
      if (!next || next.startsWith("--")) usage();
      bag.repo = next;
      i += 1;
      continue;
    }
    if (flag === "--spec") {
      if (!next || next.startsWith("--")) usage();
      bag.spec = next;
      i += 1;
      continue;
    }
    if (flag === "--prompt") {
      if (!next || next.startsWith("--")) usage();
      bag.prompt = next;
      i += 1;
      continue;
    }
    if (flag === "--jira") {
      if (!next || next.startsWith("--")) usage();
      bag.jira = next;
      i += 1;
      continue;
    }
    if (flag === "--workflow") {
      if (!next || next.startsWith("--")) usage();
      bag.workflow = next;
      i += 1;
      continue;
    }
    if (flag === "--context") {
      if (!next || next.startsWith("--")) usage();
      bag.context = next;
      i += 1;
      continue;
    }
    if (flag === "--dry-run") {
      bag.dryRun = true;
      continue;
    }
    if (flag === "--title") {
      if (!next || next.startsWith("--")) usage();
      bag.title = next;
      i += 1;
      continue;
    }
    if (flag === "--after") {
      if (!next || next.startsWith("--")) usage();
      bag.after.push(next);
      i += 1;
      continue;
    }
    if (flag?.startsWith("--")) usage();
    if (flag !== undefined) bag.positionals.push(flag);
  }
  return bag;
}

function repoCommand(argv: string[]): void {
  const sub = argv[0];
  const flags = parseFlags(argv.slice(1));
  if (sub === "list") {
    if (flags.positionals.length !== 0 || hasIntakeFlags(flags) || flags.test) usage();
    const config = resolveKilnConfig({ configPath: flags.configPath });
    process.stdout.write(renderRepoList(config));
    return;
  }
  if (sub === "add") {
    const name = flags.positionals[0];
    const repoPath = flags.positionals[1];
    if (!name || !repoPath || flags.positionals.length !== 2 || hasIntakeFlags(flags)) usage();
    process.stdout.write(
      addRepo({
        configPath: flags.configPath,
        name,
        repoPath,
        ...(flags.test !== undefined ? { test: flags.test } : {}),
      }),
    );
    return;
  }
  usage();
}

async function addCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const workflow = flags.positionals[0];
  const selected = [flags.spec !== undefined, flags.prompt !== undefined, flags.jira !== undefined].filter(Boolean).length;
  if (
    !workflow ||
    flags.positionals.length !== 1 ||
    !flags.repo ||
    selected !== 1 ||
    flags.test ||
    flags.workflow ||
    flags.context ||
    (flags.dryRun && flags.jira === undefined)
  ) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  if (flags.jira !== undefined) {
    const result = await addFromJira(config, {
      workflow,
      repo: flags.repo,
      key: flags.jira,
      ...(flags.title !== undefined ? { title: flags.title } : {}),
      dependsOn: flags.after,
      dryRun: flags.dryRun,
    });
    process.stdout.write(result.report);
    if (result.warnings.length > 0) process.stderr.write(`${result.warnings.join("\n")}\n`);
    return;
  }
  const { job, jsonPath } =
    flags.spec !== undefined
      ? addFromFile(config, {
          workflow,
          repo: flags.repo,
          specPath: flags.spec,
          ...(flags.title !== undefined ? { title: flags.title } : {}),
          dependsOn: flags.after,
          cwd: process.cwd(),
        })
      : addFromPrompt(config, {
          workflow,
          repo: flags.repo,
          prompt: flags.prompt ?? "",
          ...(flags.title !== undefined ? { title: flags.title } : {}),
          dependsOn: flags.after,
        });
  process.stdout.write(renderAddedJob(job, jsonPath));
}

function importCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  const dir = flags.positionals[0];
  if (
    !dir ||
    flags.positionals.length !== 1 ||
    !flags.repo ||
    flags.spec ||
    flags.prompt ||
    flags.title ||
    flags.after.length > 0 ||
    flags.test
  ) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  const result = importTickets(config, {
    dir,
    repo: flags.repo,
    ...(flags.workflow !== undefined ? { workflow: flags.workflow } : {}),
    ...(flags.context !== undefined ? { contextPath: flags.context } : {}),
    dryRun: flags.dryRun,
    cwd: process.cwd(),
  });
  process.stdout.write(result.report);
  if (result.warnings.length > 0) process.stderr.write(`${result.warnings.join("\n")}\n`);
}

function tickCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  if (flags.positionals.length !== 0 || flags.test || hasIntakeFlags(flags)) usage();
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(runTick(config));
}

function statusCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  if (flags.positionals.length > 1 || flags.test || hasIntakeFlags(flags)) usage();
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(runStatus(config, flags.positionals[0]));
}

function gateCommand(choice: "approve" | "reject", argv: string[]): void {
  const flags = parseFlags(argv);
  const jobId = flags.positionals[0];
  if (!jobId || flags.positionals.length !== 1 || flags.test || hasIntakeFlags(flags)) usage();
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(answerJob(config, jobId, choice));
}

function hasIntakeFlags(flags: FlagBag): boolean {
  return Boolean(
    flags.repo ||
      flags.spec ||
      flags.prompt ||
      flags.jira ||
      flags.title ||
      flags.workflow ||
      flags.context ||
      flags.dryRun ||
      flags.after.length > 0,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") usage();
  if (command === "repo") {
    repoCommand(argv.slice(1));
    return;
  }
  if (command === "add") {
    await addCommand(argv.slice(1));
    return;
  }
  if (command === "import") {
    importCommand(argv.slice(1));
    return;
  }
  if (command === "tick") {
    tickCommand(argv.slice(1));
    return;
  }
  if (command === "status") {
    statusCommand(argv.slice(1));
    return;
  }
  if (command === "approve") {
    gateCommand("approve", argv.slice(1));
    return;
  }
  if (command === "reject") {
    gateCommand("reject", argv.slice(1));
    return;
  }
  usage();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
