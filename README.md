# Kiln

Kiln plans work for a product that spans three monorepos: `frontend`, `ai-core`, and `evals-obs`. This is the first slice, the REFINE workflow.

REFINE takes a requirement, checks whether it is ready, and if it is, decomposes it into the contracts between repos and the per-repo tasks that follow those contracts. Contracts are the seams (an API between frontend and ai-core, a trace event between ai-core and evals-obs). They land first. Tasks in different repos depend on the contract, not on each other, and then run independently.

Kiln runs on your machine. It reads the three product checkouts from paths in a local config and runs the coding-agent CLI with the login that CLI already has. Kiln does not store credentials.

This repository is public. Anything specific to a real product stays in a gitignored local directory and is never committed:

- paths to the three repo checkouts
- the real per-repo ownership maps
- real requirements
- generated plans

`examples/` is fictional data for a habit tracker called Pebble. It is not a real company, a real ticket, or a real checkout.

## Local config

Kiln looks for `kiln.config.json` in this order:

1. `./.kiln/kiln.config.json` in the working directory
2. `~/.kiln/kiln.config.json`

`.kiln/` is gitignored in this repo. `~/.kiln/` lives outside the repo. Put real ownership maps and real requirement files in that directory, for example `.kiln/ownership/` and `.kiln/requirements/`.

A valid plan is written to `<kiln-dir>/plans/<requirement-id>.json` and `.md`. When the config file lives in a directory named `.kiln` (`./.kiln/kiln.config.json` or `~/.kiln/kiln.config.json`), that directory is the kiln dir. Any other config path, including `--config` pointing at a file outside `.kiln` and the committed example config, writes plans to `./.kiln/plans`. Plans are never written next to an arbitrary config file, and never into `examples/`.

Copy the shape from `examples/kiln.config.json` and replace the paths. Leave `"example": true` off your copy. Relative paths are resolved from the config file's directory.

```json
{
  "repos": {
    "frontend": {
      "checkout": "/absolute/path/to/your/frontend",
      "ownership": "ownership/frontend.json",
      "test": "npm test"
    },
    "ai-core": {
      "checkout": "/absolute/path/to/your/ai-core",
      "ownership": "ownership/ai-core.json",
      "test": "npm test"
    },
    "evals-obs": {
      "checkout": "/absolute/path/to/your/evals-obs",
      "ownership": "ownership/evals-obs.json",
      "test": "npm test"
    }
  },
  "maxConcurrent": 2,
  "adapter": "claude-code"
}
```

`test` is the shell command yak runs to verify a task in that repo. An empty command is refused. `maxConcurrent` caps how many yak runs may be in flight (default 2). A single `kiln tick` still launches at most one task. `adapter` is `claude-code` (default) or `mock`.

If neither local config exists, Kiln uses `examples/kiln.config.json` only for a file under `examples/requirements/`. Any other requirement without a local config is refused.

## Run the examples

```bash
npm install
npm test
npm run kiln -- refine examples/requirements/thin-jira.md
npm run kiln -- refine examples/requirements/weekly-reflection.md
npm run kiln -- refine examples/requirements/duplicate-habit.md
```

The default planner is rules-based and does not call a model. It prints JSON, then a short markdown rendering, and writes a plan under `.kiln/plans/` when the requirement is ready. A requirement that is not ready prints questions and exits 0. A valid plan exits 0. Invalid planner output exits 1.

## Readiness

Kiln always checks the parsed requirement before it trusts a planner:

- acceptance criteria, at least one
- a scope section
- a user-facing outcome (`## Outcome` or `## User-facing outcome`)

The planner may add further gaps and questions. The result is the union. A planner cannot mark a requirement ready when one of those three is missing.

The rules planner also asks which repo is in scope when the scope text names none of `frontend`, `ai-core`, and `evals-obs`. Lines that say "out of scope" do not count. `## Workflow` may be `feature`, `bug`, `security`, or `prototype`. A single-repo requirement whose text says "bug" is planned as a bug.

One in-scope repo produces no contracts. Every pair of in-scope repos gets one contract. The contract's `owner` is the providing repo (`ai-core` when it is a side, otherwise `evals-obs`). That repo's task publishes the contract and does not depend on it. The other repo's task depends on the contract id. Each task has its own title, description, and acceptance. A criterion that names a repo stays on that repo. A criterion that names no repo goes to one task, not onto every task.

## Point the real planner at a model

`--planner agent` shells out non-interactively and inherits your environment, so Claude uses the login already on this machine. The default command is current Claude Code, with built-in tools turned off so this planning step cannot edit the tree:

```bash
npm run kiln -- refine .kiln/requirements/your-requirement.md --planner agent
```

which runs:

```bash
claude -p --output-format json --json-schema '<schema>' --tools "" \
  --no-session-persistence --permission-prompts none '<prompt>'
```

The prompt includes the requirement, the ownership maps from your local config, the absolute checkout paths, and the JSON schema. Kiln reads a Claude JSON envelope (`structured_output`, or JSON in `result`). Set `KILN_PLANNER=agent` to make the agent the default. `--config <file>` selects a config file other than `.kiln/kiln.config.json` or `~/.kiln/kiln.config.json`. `--agent-bin <bin>` selects a different executable.

## Approve, tick, status

`kiln refine` only writes a plan. Nothing runs until a person approves it:

```bash
npm run kiln -- approve EX-202
npm run kiln -- tick
npm run kiln -- status EX-202
```

`approve` writes `<kiln-dir>/plans/<id>.approved.json`. Unapproved plans are skipped.

`tick` is one stateless pass: read approved plans and the yak journals under each checkout's `.runs/`, decide actions, apply them, exit. It launches at most one ready task, and only when running-plus-suspended runs are below `maxConcurrent`. The launch is detached: `yak run --isolation worktree workflows/feature.yaml` in that task's checkout, tagged `kiln:<planId>/<taskId>`, with stdout in `<kiln-dir>/logs/<plan>/<task>.log`. The child pid is recorded in a breadcrumb until a journal with that tag appears. If the child dies before writing a journal, the task is `launch-failed` and is not launched again. A contract dependency is satisfied when the task that publishes the contract finished ok and its approve gate was not rejected. A task that already has a run is not launched again. A failed run stays failed. A run whose process is gone and whose journal has no `run.finished` is `dead` and does not take a slot.

`status` prints each task's state and the yak run id. A suspended gate prints both an approve and a reject command. Those commands use the node binary and the yak entrypoint from `@lchase/yak`'s `package.json` `bin`, so `yak` does not need to be on `PATH`. An ok task prints its `yak/<run-id>` branch. A dead run prints the `cancel` command to run from the checkout. A launch-failed task prints its log path.

The feature workflow is the factory loop (spec, build, verify, security/ux/code review, approver, human gate, then a commit), ported onto yak. Agent steps include the `Skill` tool. Verify runs the repo's `test` command. After the gate is approved, the run commits its changes on the worktree branch `yak/<run-id>` with message `kiln: <task title>`. A reject skips that commit. The default adapter is `claude-code`. `adapter: "mock"` uses fixture files in the checkout at `test/fixtures/kiln-feature/<step>.json` and does not call a model. Kiln does not push.

Kiln writes a tick lock and, while a launch has not yet produced a journal, a breadcrumb under `<kiln-dir>/launching/`. yak writes `.runs/` and `.yak/` inside the checkout. The first launch adds both paths to that checkout's `.git/info/exclude`.

## Not in this slice

No Jira client. `kiln refine --planner agent` is asked to reply with a plan and nothing else. The coding agent that edits a checkout is the yak run started by `tick`, not the planner.
