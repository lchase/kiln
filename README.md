# Kiln

Kiln plans a change across three repos, `frontend`, `ai-core`, and `evals-obs`, then runs that plan on your machine.

`refine` reads a requirement and writes a plan: the contracts between repos, and a task in each repo that has work. `approve` records that you accept the plan. `tick` starts at most one ready task. `status` shows each task, the command that answers an open gate, and the branch an approved task landed on.

Kiln uses the Claude login already on this machine. It does not store credentials.

This repository is public. Real checkout paths, ownership maps, requirements, and plans stay in gitignored `.kiln/` or in `~/.kiln/`. `examples/` is fictional data for a habit tracker called Pebble.

## Prerequisites

- Node.js >= 22 (the `engines` field in `package.json`)
- git
- Claude Code >= 2.1.259, installed and logged in. `claude auth status` should succeed. `kiln refine --planner agent` passes `--permission-prompts none`, which that version supports.
- Each checkout is a git repo with a commit at `HEAD`. `tick` adds a worktree from that commit. Uncommitted files in the checkout are left as they are; the task edits the worktree, on branch `yak/<run-id>`.

## Local config

Kiln looks for `kiln.config.json` in this order:

1. `./.kiln/kiln.config.json`
2. `~/.kiln/kiln.config.json`

When the config file is inside a `.kiln` directory, plans are written there. Any other config path writes plans to `./.kiln/plans`. Relative paths are resolved from the config file's directory. Leave `"example": true` off your copy. If neither local config exists, Kiln uses `examples/kiln.config.json` only for a file under `examples/requirements/`.

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

`test` is the command yak runs to verify a task in that repo. An empty command is refused. `maxConcurrent` caps how many tasks may be in flight (default 2). `adapter` is `claude-code` (default) or `mock`.

## Ownership maps

Each repo has one JSON file. `repo` matches the config key. `owns` is what that repo is the source of truth for. `exposes` is what the other repos call, and what this repo calls in them.

```json
{
  "repo": "frontend",
  "owns": [
    "Habit list and day view",
    "Client-side routing for the browser app"
  ],
  "exposes": [
    "Calls GET /v1/reflection on ai-core and renders the paragraph"
  ]
}
```

To draft a map, run this inside the repo:

```
Describe this repo for a cross-repo work planner. Output only JSON:
{
  "repo": "<frontend|ai-core|evals-obs>",
  "owns": ["<5-10 short lines: domains, features, and data this repo is the source of truth for>"],
  "exposes": ["<each API, event, schema, or package other repos call or consume, and what it calls in the other two repos>"]
}
Be concrete: name real endpoints, packages, and modules. No marketing language.
```

## Requirement files

A requirement is markdown with frontmatter. Kiln refuses to plan until the body has an outcome, a scope, and at least one acceptance criterion.

```markdown
---
id: EX-202
source: markdown
title: Weekly reflection summary
---

## Outcome

A person can open the app on Sunday and read a short summary of the week.

## Scope

- frontend shows the summary on the home screen.
- ai-core returns it from a new endpoint.
- evals-obs is out of scope.

## Workflow

feature

## Acceptance criteria

- The Sunday screen shows the paragraph from the API.
- A week with no habits shows a calm empty state.
```

`source` is `markdown` or `jira`. `## Workflow` is optional: `feature`, `bug`, `security`, or `prototype`. `## User-facing outcome` is accepted in place of `## Outcome`.

A requirement that is not ready prints questions and exits 0. A valid plan exits 0. Invalid planner output exits 1.

## First real run

```bash
npm install
mkdir -p .kiln/ownership .kiln/requirements
```

Write `.kiln/kiln.config.json`, one ownership file per repo, and a requirement at `.kiln/requirements/<name>.md`. Then:

```bash
npm run kiln -- refine .kiln/requirements/<name>.md --planner agent
```

Read `.kiln/plans/<id>.md`. If the plan is the one you want:

```bash
npm run kiln -- approve <id>
npm run kiln -- tick
npm run kiln -- status <id>
```

`status` prints an approve command and a reject command for an open gate. Run the approve command. It uses node and the yak entrypoint, so `yak` does not need to be on `PATH`. When the task finishes, `status` prints `branch yak/<run-id>` in that task's checkout. Kiln does not push.

`tick` launches at most one task and returns. Run it again until nothing is left to launch, by hand or on a timer:

```bash
while true; do npm run kiln -- tick; sleep 30; done
```

`maxConcurrent` (default 2) is how many tasks may be in flight at once. A later tick starts the next task while an earlier one is still running.

`--planner agent` runs Claude with cwd set to the frontend checkout and `--add-dir` for the other two. The tools are `Read`, `Grep`, and `Glob`. There is no Bash, Edit, Write, or WebFetch. The prompt tells it to inspect routes, API clients, and schemas before it chooses contracts, and to cite file paths in task descriptions. Set `KILN_PLANNER=agent` to make that the default. `--agent-bin <bin>` selects a different executable. `--config <file>` selects a config other than `.kiln/kiln.config.json` or `~/.kiln/kiln.config.json`.

The same Claude invocation, with the schema and prompt filled in, is:

```bash
claude -p --output-format json --json-schema '<schema>' \
  --tools "Read,Grep,Glob" \
  --no-session-persistence --permission-prompts none \
  --add-dir /absolute/path/to/ai-core \
  --add-dir /absolute/path/to/evals-obs \
  '<prompt>'
```

## What tick and status report

`tick` reads approved plans and the yak journals under each checkout's `.runs/`, decides, and exits. The launch is detached: `yak run --isolation worktree` in the task's checkout, tagged `kiln:<planId>/<taskId>`, with logs in `<kiln-dir>/logs/<plan>/<task>.log`. A dependency is satisfied when the upstream task finished ok and its approval artifact says approve. A reject is `rejected`. An ok run with no readable approval artifact is `ok-undecided` and does not unblock dependents. A failed run stays failed. A run whose process is gone is `dead`; status prints the `cancel` command to run from the checkout. A launch that died before writing a journal is `launch-failed` and prints its log path.

The task runs the factory loop from Lawrence Chase's factory plugin v0.7.0 (MIT): spec, then up to two rounds of build, verify, and the security, ux, ui, and code reviewers, then the approver, a human gate, and a commit. The prompts in `prompts/factory/` are those agent files, copied verbatim. `prompts/kiln/` is a short preamble per step that maps the factory's job-folder files (`.factory/repo.md`, `spec.md`, `build.md`, `round-N/review-*.md`, `decision.md`) onto the artifacts yak passes in, and tells the agent to return JSON instead of writing a file. Models come from the factory frontmatter: `opus` for spec, build, security, and the approver; `sonnet` for ux, ui, and code. Every agent has the Skill tool, and the code reviewer calls the smart-review skill.

`kiln tick` writes a per-run copy of the workflow under the kiln directory, with absolute prompt paths, before it starts yak. Yak resolves `prompt.file` from the checkout's working directory, which does not contain this repo.

Verify runs the repo's `test` command with `failOn: never`, so a red test is an artifact the reviewers and the next round's builder see, not a failed run. One round is build, verify, security, ux, ui, code. A `CHANGES` verdict or a non-zero verify starts another build, at most twice. The reviewers run one after another. The UI reviewer always runs; its prompt returns PASS when nothing UI changed. After an approved gate, the run commits on `yak/<run-id>` with message `kiln: <task title>`. A reject skips that commit. `adapter: "mock"` reads fixtures at `test/fixtures/kiln-feature/<step>.json` (`spec`, `build`, `security`, `ux`, `ui`, `code`, `approver`) and does not call a model.

The first launch adds `.runs/` and `.yak/` to that checkout's `.git/info/exclude`.

## Examples

The default planner is rules-based and does not call a model. It is what the examples and `npm test` use.

```bash
npm test
npm run kiln -- refine examples/requirements/thin-jira.md
npm run kiln -- refine examples/requirements/weekly-reflection.md
npm run kiln -- refine examples/requirements/duplicate-habit.md
```

## Not included

No Jira client. The planner does not edit the checkouts. The coding agent that edits a checkout is the yak run started by `tick`.
