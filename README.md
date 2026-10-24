# Kiln

Kiln plans work for a product that spans three monorepos: `frontend`, `ai-core`, and `evals-obs`. This is the first slice, the REFINE workflow.

REFINE takes a requirement, checks whether it is ready, and if it is, decomposes it into the contracts between repos and the per-repo tasks that follow those contracts. Contracts are the seams (an API between frontend and ai-core, a trace event between ai-core and evals-obs). They land first. Tasks in different repos depend on the contract, not on each other, and then run independently.

`examples/` and `ownership/` are invented placeholder data for a fictional habit tracker called Pebble. They are not a real company, a real ticket, or a real repository layout.

## Run

```bash
npm install
npm test
npm run kiln -- refine examples/requirements/thin-jira.md
npm run kiln -- refine examples/requirements/weekly-reflection.md
npm run kiln -- refine examples/requirements/duplicate-habit.md
```

The default planner is scripted and does not call a model. It prints JSON, then a short markdown rendering. A requirement that is not ready prints questions and exits 0. A valid plan exits 0. Invalid planner output exits 1.

## Scripted readiness rubric

The fake planner is ready to decompose only when the markdown has all three:

- `## Acceptance criteria` with at least one bullet
- `## Scope` naming `frontend`, `ai-core`, or `evals-obs` on a line that does not say "out of scope"
- `## Outcome` (or `## User-facing outcome`) saying what a person can see or do

`## Workflow` may be `feature`, `bug`, `security`, or `prototype`. A single-repo requirement whose text says "bug" is planned as a bug. One in-scope repo produces no contracts. Neighboring in-scope repos, in the order frontend → ai-core → evals-obs, produce one contract per seam.

## Point the real planner at a model

`--planner agent` shells out non-interactively. The default command is current Claude Code, with tools turned off so the planner cannot edit the tree:

```bash
npm run kiln -- refine examples/requirements/weekly-reflection.md --planner agent
```

which runs:

```bash
claude -p --output-format json --json-schema '<schema>' --tools "" \
  --no-session-persistence --permission-prompts none '<prompt>'
```

The prompt includes the requirement and the ownership maps. Kiln reads a Claude JSON envelope (`structured_output`, or JSON in `result`) or a Codex JSONL stream.

Codex, without write access:

```bash
npm run kiln -- refine examples/requirements/weekly-reflection.md --planner agent \
  --agent-bin codex \
  --agent-args "exec --json --sandbox read-only"
```

`--agent-args` is split on spaces. `{schema}` and `{prompt}` in those arguments are replaced. Set `KILN_PLANNER=agent` to make the agent the default. `--ownership <dir>` swaps the placeholder maps for another directory of `<repo>.json` files.

## Not in this slice

No Jira client, no persistence beyond the files you pass in, and no agent that edits code. The agent CLI is asked to reply with a plan and nothing else.
