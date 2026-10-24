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

A valid plan is written to `<config-dir>/plans/<requirement-id>.json` and `.md`. When the committed example config is in use, plans still go to `./.kiln/plans`, not into `examples/`.

Copy the shape from `examples/kiln.config.json` and replace the paths. Leave `"example": true` off your copy. Relative paths are resolved from the config file's directory.

```json
{
  "repos": {
    "frontend": {
      "checkout": "/absolute/path/to/your/frontend",
      "ownership": "ownership/frontend.json"
    },
    "ai-core": {
      "checkout": "/absolute/path/to/your/ai-core",
      "ownership": "ownership/ai-core.json"
    },
    "evals-obs": {
      "checkout": "/absolute/path/to/your/evals-obs",
      "ownership": "ownership/evals-obs.json"
    }
  }
}
```

If neither local config exists, Kiln uses `examples/kiln.config.json` only for a file under `examples/requirements/`. Any other requirement without a local config is refused.

## Run the examples

```bash
npm install
npm test
npm run kiln -- refine examples/requirements/thin-jira.md
npm run kiln -- refine examples/requirements/weekly-reflection.md
npm run kiln -- refine examples/requirements/duplicate-habit.md
```

The default planner is scripted and does not call a model. It prints JSON, then a short markdown rendering, and writes a plan under `.kiln/plans/` when the requirement is ready. A requirement that is not ready prints questions and exits 0. A valid plan exits 0. Invalid planner output exits 1.

## Scripted readiness rubric

The fake planner is ready to decompose only when the markdown has all three:

- `## Acceptance criteria` with at least one bullet
- `## Scope` naming `frontend`, `ai-core`, or `evals-obs` on a line that does not say "out of scope"
- `## Outcome` (or `## User-facing outcome`) saying what a person can see or do

`## Workflow` may be `feature`, `bug`, `security`, or `prototype`. A single-repo requirement whose text says "bug" is planned as a bug. One in-scope repo produces no contracts. Neighboring in-scope repos, in the order frontend → ai-core → evals-obs, produce one contract per seam.

## Point the real planner at a model

`--planner agent` shells out non-interactively and inherits your environment, so Claude or Codex uses the login already on this machine. The default command is current Claude Code, with tools turned off so this planning step cannot edit the tree:

```bash
npm run kiln -- refine .kiln/requirements/your-requirement.md --planner agent
```

which runs:

```bash
claude -p --output-format json --json-schema '<schema>' --tools "" \
  --no-session-persistence --permission-prompts none '<prompt>'
```

The prompt includes the requirement, the ownership maps from your local config, and the absolute checkout paths. Kiln reads a Claude JSON envelope (`structured_output`, or JSON in `result`) or a Codex JSONL stream.

Codex, without write access:

```bash
npm run kiln -- refine .kiln/requirements/your-requirement.md --planner agent \
  --agent-bin codex \
  --agent-args "exec --json --sandbox read-only"
```

`--agent-args` is split on spaces. `{schema}` and `{prompt}` in those arguments are replaced. Set `KILN_PLANNER=agent` to make the agent the default. `--config <file>` selects a config file other than `.kiln/kiln.config.json` or `~/.kiln/kiln.config.json`.

## Not in this slice

No Jira client, and no agent that edits code. The agent CLI is asked to reply with a plan and nothing else. The only files Kiln writes are the plan JSON and markdown under the local kiln directory.
