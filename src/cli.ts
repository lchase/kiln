#!/usr/bin/env node
import { addRepo, renderRepoList, resolveKilnConfig } from "./config.js";
import { renderSandboxStatus, runSandboxBuild } from "./sandbox.js";
import { answerJob, retryJob, runStatus, runTick } from "./driver.js";
import { startServe } from "./serve.js";
import { addFromFile } from "./intake/file.js";
import { addFromJira } from "./intake/jira.js";
import { addFromPrompt } from "./intake/prompt.js";
import { importTickets } from "./intake/tickets.js";
import { renderAddedJob } from "./jobs.js";

function usage(): never {
  console.error(
    [
      "Usage: kiln repo add <name> <path> [--test <cmd>] [--deliver local|pr] [--base <branch>] [--config <file>]",
      "       kiln repo list [--config <file>]",
      "       kiln add <workflow> --repo <name> (--spec <file.md> | --prompt <text> | --jira <KEY>) [--title <text>] [--after <jobId>]... [--stack] [--dry-run] [--config <file>]",
      "       kiln import <dir> --repo <name> [--workflow <name>] [--context <file.md>] [--stack] [--dry-run] [--config <file>]",
      "       kiln tick [--config <file>]",
      "       kiln status [jobId] [--config <file>]",
      "       kiln approve <jobId> [--config <file>]",
      "       kiln reject <jobId> [--config <file>]",
      "       kiln retry <jobId> [--config <file>]",
      "       kiln sandbox [build] [--config <file>]",
      "       kiln serve [--port 4100] [--tick <seconds>|--no-tick] [--config <file>]",
      "",
      "repo add registers a checkout. A relative path is stored absolute, resolved",
      "from the working directory. ~ is expanded from the home directory.",
      "",
      "Config, jobs, logs, and deliveries live in one kiln home: --config <file>",
      "if given, otherwise $KILN_HOME/kiln.config.json when KILN_HOME is set,",
      "otherwise ~/.kiln/kiln.config.json. repo add creates that directory.",
      "Run kiln repo add <name> <path> from any directory. A leftover",
      "./.kiln/kiln.config.json is an error until you mv ./.kiln ~/.kiln,",
      "pass --config <file>, or set KILN_HOME.",
      "",
      "add writes one job from a spec file, from --prompt text (--prompt - reads stdin),",
      "or from a Jira Cloud issue (--jira PROJ-123). Pass one of those, not more.",
      "The repo and the workflow (workflows/<name>.yaml) must already exist.",
      "--after names jobs that must be done before this one launches. --stack waits",
      "for one upstream to land and opens the pull request against that branch.",
      "--stack cannot target an investigation job: that workflow does not land a branch.",
      "A Jira Blocks link where this issue is blocked by another key is included",
      "when a kiln job for that key already exists.",
      "--dry-run with --jira prints the job and writes nothing. Running add again",
      "for the same Jira key prints the existing job id and creates nothing.",
      "",
      "import reads a directory of NN-slug.md tickets and writes one job per file.",
      "Blocked-by becomes dependsOn. Re-running the same directory does not duplicate jobs.",
      "--dry-run prints the jobs and writes nothing.",
      "",
      "tick launches at most one ready job. After merged, dependencies must be done.",
      "Stacked jobs launch once the upstream has landed. deliver=pr then pushes",
      "yak/<run-id> and opens a draft pull request. An investigation is done when",
      "its gate is approved. It does not open a pull request. status prints the",
      "derived state, and the findings path once an investigation is approved.",
      "approve and reject answer the human gate. retry launches a failed or dead",
      "job again, the same way tick launches, and clears the attempt ledger.",
      "A landed job that only failed to open its pull request is delivered again.",
      "A running job with no yak event or log output for stallTimeoutMs (default",
      "15 minutes; 0 disables it) is killed and retried. A crash, a non-zero exit,",
      "or a process that is already gone when tick or serve starts (orphaned) retries",
      "after 10s, 20s, 40s, and so on, capped at 5 minutes, up to maxAttempts",
      "(default 3). The job is then dead. A rejected gate is not retried.",
      "Attempts are files under the kiln home, not fields on the job.",
      "Once a pull request is open, tick watches it. A failed check or a review",
      "that requests changes starts a fix on that same branch, up to maxFixRounds",
      "(default 2). Kiln does not merge, approve, or comment. Past that bound the",
      "job is needs-human with reason feedback-exhausted.",
      "",
      "serve listens on 127.0.0.1. The page is a board of workflow stages:",
      "queued, spec, build, review, approve, land, PR review, merged, and needs human.",
      "Empty stages collapse. Approve, reject, retry, and Add job call the same",
      "functions as the CLI. POST sends the page's CSRF token. A request whose",
      "Origin or Host is not this localhost port is rejected. Before each",
      "request and each tick, serve re-reads the kiln config when the file's",
      "mtime or size changed. A file that fails to load keeps the last good",
      "config. A tick runs every 30 seconds unless --no-tick is set, using the",
      "tick lock.",
      "",
      "sandbox prints the resolved mode, allowlist, and anything missing before a",
      "sandboxed run can start. sandbox build builds the yak agent and proxy images",
      "and installs git into the agent image. Sandbox mode stays off until the kiln",
      "config sets it. A run that fails with yak reason sandbox-error is not retried.",
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
  stack: boolean;
  deliver?: "local" | "pr";
  base?: string;
  after: string[];
  port?: number;
  tickSeconds?: number;
  noTick: boolean;
}

function parseFlags(argv: string[]): FlagBag {
  const bag: FlagBag = { positionals: [], after: [], dryRun: false, stack: false, noTick: false };
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
    if (flag === "--stack") {
      bag.stack = true;
      continue;
    }
    if (flag === "--deliver") {
      if (next !== "local" && next !== "pr") usage();
      bag.deliver = next;
      i += 1;
      continue;
    }
    if (flag === "--base") {
      if (!next || next.startsWith("--")) usage();
      bag.base = next;
      i += 1;
      continue;
    }
    if (flag === "--port") {
      if (!next || !/^\d+$/.test(next)) usage();
      const port = Number(next);
      if (port > 65535) usage();
      bag.port = port;
      i += 1;
      continue;
    }
    if (flag === "--tick") {
      if (!next || !/^[1-9]\d*$/.test(next)) usage();
      const seconds = Number(next);
      if (seconds > 86_400) usage();
      bag.tickSeconds = seconds;
      i += 1;
      continue;
    }
    if (flag === "--no-tick") {
      bag.noTick = true;
      continue;
    }
    if (flag?.startsWith("--")) usage();
    if (flag !== undefined) bag.positionals.push(flag);
  }
  return bag;
}

function rejectServeFlags(flags: FlagBag): void {
  if (flags.port !== undefined || flags.tickSeconds !== undefined || flags.noTick) usage();
}

function repoCommand(argv: string[]): void {
  const sub = argv[0];
  const flags = parseFlags(argv.slice(1));
  rejectServeFlags(flags);
  if (sub === "list") {
    if (flags.positionals.length !== 0 || hasIntakeFlags(flags) || flags.test || flags.deliver || flags.base) usage();
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
        ...(flags.deliver !== undefined ? { deliver: flags.deliver } : {}),
        ...(flags.base !== undefined ? { base: flags.base } : {}),
      }),
    );
    return;
  }
  usage();
}

async function addCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  rejectServeFlags(flags);
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
    flags.deliver ||
    flags.base ||
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
      ...(flags.stack ? { stack: true } : {}),
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
          ...(flags.stack ? { stack: true } : {}),
          cwd: process.cwd(),
        })
      : addFromPrompt(config, {
          workflow,
          repo: flags.repo,
          prompt: flags.prompt ?? "",
          ...(flags.title !== undefined ? { title: flags.title } : {}),
          dependsOn: flags.after,
          ...(flags.stack ? { stack: true } : {}),
        });
  process.stdout.write(renderAddedJob(job, jsonPath));
}

function importCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  rejectServeFlags(flags);
  const dir = flags.positionals[0];
  if (
    !dir ||
    flags.positionals.length !== 1 ||
    !flags.repo ||
    flags.spec ||
    flags.prompt ||
    flags.title ||
    flags.after.length > 0 ||
    flags.test ||
    flags.deliver ||
    flags.base
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
    ...(flags.stack ? { stack: true } : {}),
    cwd: process.cwd(),
  });
  process.stdout.write(result.report);
  if (result.warnings.length > 0) process.stderr.write(`${result.warnings.join("\n")}\n`);
}

function sandboxCommand(argv: string[]): void {
  const build = argv[0] === "build";
  const flags = parseFlags(build ? argv.slice(1) : argv);
  rejectServeFlags(flags);
  if (flags.positionals.length !== 0 || flags.test || hasIntakeFlags(flags) || flags.deliver || flags.base || flags.stack) {
    usage();
  }
  if (build) {
    runSandboxBuild();
    process.stdout.write("built yak-agent-sandbox:latest and yak-agent-sandbox-proxy:latest\n");
    return;
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(renderSandboxStatus(config));
}

function tickCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  rejectServeFlags(flags);
  if (flags.positionals.length !== 0 || flags.test || hasIntakeFlags(flags) || flags.deliver || flags.base || flags.stack) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(runTick(config));
}

function statusCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  rejectServeFlags(flags);
  if (flags.positionals.length > 1 || flags.test || hasIntakeFlags(flags) || flags.deliver || flags.base || flags.stack) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(runStatus(config, flags.positionals[0]));
}

function retryCommand(argv: string[]): void {
  const flags = parseFlags(argv);
  rejectServeFlags(flags);
  const jobId = flags.positionals[0];
  if (!jobId || flags.positionals.length !== 1 || flags.test || hasIntakeFlags(flags) || flags.deliver || flags.base || flags.stack) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(retryJob(config, jobId));
}

function gateCommand(choice: "approve" | "reject", argv: string[]): void {
  const flags = parseFlags(argv);
  rejectServeFlags(flags);
  const jobId = flags.positionals[0];
  if (!jobId || flags.positionals.length !== 1 || flags.test || hasIntakeFlags(flags) || flags.deliver || flags.base || flags.stack) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  process.stdout.write(answerJob(config, jobId, choice));
}

async function serveCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (
    flags.positionals.length !== 0 ||
    flags.test ||
    hasIntakeFlags(flags) ||
    flags.deliver ||
    flags.base ||
    flags.stack ||
    (flags.noTick && flags.tickSeconds !== undefined)
  ) {
    usage();
  }
  const config = resolveKilnConfig({ configPath: flags.configPath });
  const port = flags.port ?? 4100;
  const tickSeconds = flags.noTick ? undefined : (flags.tickSeconds ?? 30);
  await startServe({
    config,
    port,
    ...(tickSeconds !== undefined ? { tickSeconds } : {}),
  });
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
      flags.stack ||
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
  if (command === "retry") {
    retryCommand(argv.slice(1));
    return;
  }
  if (command === "sandbox") {
    sandboxCommand(argv.slice(1));
    return;
  }
  if (command === "serve") {
    await serveCommand(argv.slice(1));
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
