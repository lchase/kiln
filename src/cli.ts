#!/usr/bin/env node
import { addRepo, renderRepoList, resolveKilnConfig } from "./config.js";
import { answerJob, runStatus, runTick } from "./driver.js";
import { createJob, renderAddedJob } from "./jobs.js";

function usage(): never {
  console.error(
    [
      "Usage: kiln repo add <name> <path> [--test <cmd>] [--config <file>]",
      "       kiln repo list [--config <file>]",
      "       kiln add <workflow> --repo <name> --spec <file.md> [--title <text>] [--after <jobId>]... [--config <file>]",
      "       kiln tick [--config <file>]",
      "       kiln status [jobId] [--config <file>]",
      "       kiln approve <jobId> [--config <file>]",
      "       kiln reject <jobId> [--config <file>]",
      "",
      "repo add registers a checkout. Relative paths are stored relative to the",
      "config directory. ~ is expanded from the home directory.",
      "",
      "add copies the spec into the kiln directory and writes one job file.",
      "The repo and the workflow (workflows/<name>.yaml) must already exist.",
      "--after names jobs that must be done before this one launches.",
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
  title?: string;
  after: string[];
}

function parseFlags(argv: string[]): FlagBag {
  const bag: FlagBag = { positionals: [], after: [] };
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
    if (flags.positionals.length !== 0 || flags.test || flags.repo || flags.spec || flags.title || flags.after.length) {
      usage();
    }
    const config = resolveKilnConfig({ configPath: flags.configPath });
    process.stdout.write(renderRepoList(config));
    return;
  }
  if (sub === "add") {
    const name = flags.positionals[0];
    const repoPath = flags.positionals[1];
    if (!name || !repoPath || flags.positionals.length !== 2 || flags.repo || flags.spec || flags.title || flags.after.length) {
      usage();
    }
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

function addCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  const workflow = flags.positionals[0];
  if (!workflow || flags.positionals.length !== 1 || !flags.repo || !flags.spec || flags.test) usage();
  const config = resolveKilnConfig({ configPath: flags.configPath });
  const { job, jsonPath } = createJob(config, {
    workflow,
    repo: flags.repo,
    specPath: flags.spec,
    ...(flags.title !== undefined ? { title: flags.title } : {}),
    dependsOn: flags.after,
    cwd: process.cwd(),
  });
  process.stdout.write(renderAddedJob(job, jsonPath));
}

function tickCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  if (flags.positionals.length !== 0 || flags.test || flags.repo || flags.spec || flags.title || flags.after.length) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(runTick(config));
}

function statusCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  if (flags.positionals.length > 1 || flags.test || flags.repo || flags.spec || flags.title || flags.after.length) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(runStatus(config, flags.positionals[0]));
}

function gateCommand(choice: "approve" | "reject", argv: string[]): void {
  const flags = parseFlags(argv);
  const jobId = flags.positionals[0];
  if (!jobId || flags.positionals.length !== 1 || flags.test || flags.repo || flags.spec || flags.title || flags.after.length) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(answerJob(config, jobId, choice));
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") usage();
  if (command === "repo") {
    repoCommand(argv.slice(1));
    return;
  }
  if (command === "add") {
    addCommand(argv.slice(1));
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
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
