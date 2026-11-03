<p align="center">
  <img src="docs-site/static/img/yak-mascot.png" alt="yak mascot" width="320" />
</p>

# yak

An agentic workflow engine. *It shaves the yak so you don't.*

Reads a YAML DAG, runs steps (shell commands, pure transforms, coding-agent
invocations, human gates), and journals everything to disk so runs resume
exactly where they stopped.

## Install

```bash
npm install -g @lchase/yak
```

## Quickstart

```bash
yak run path/to/workflow.yaml
```

See `docs-site/docs/quickstart.md` (free, no API key, uses a mock adapter)
and `docs-site/docs/tutorial.md` (a real run that finds and fixes an actual
bug) for a guided walkthrough — also live at
[lchase.github.io/yak/docs/tutorial](https://lchase.github.io/yak/docs/tutorial).

## Capabilities

- **Step kinds:** `command` (streamed shell exec, capture stdout/stderr/
  exitCode, optional `idleTimeoutMs` — SIGTERM then SIGKILL after a grace
  period), `transform` (named pure function from `.yak/transforms.ts`),
  `agent` (prompt from `{ file }`/`{ inline }`, Zod schema validation via
  `.yak/schemas.ts`, schema repair loop with retries), `loop` (bounded by
  `maxIterations`, plus a no-progress exhaustion check), `map`
  (concurrency cap, per-item failure policy, optional
  `isolation: 'worktree'`), and `gate` (human decision point,
  schema-validated answer, optional `skipIf`).
- **Suspend/resume:** a `gate` or an exhausted budget suspends the run
  rather than failing it. `yak pending` lists every run across the repo
  awaiting a human answer; `yak resume <run-id>` replays and continues;
  `--interactive` prompts through open gates inline instead of exiting to
  resume later. `yak cancel <run-id>` terminates a live run's process tree
  and journals a clean `failed`/`cancelled` terminal state, so any
  out-of-process supervisor has a supported kill.
- **Worktree isolation:** `yak run --isolation worktree` runs the whole
  workflow inside a fresh git worktree forked from `HEAD`. `--from <ref>`
  forks that worktree from another commit (`origin/main`, a branch, a
  SHA) without moving the checkout; the ref is resolved once and resume
  reuses that commit. `map` steps can additionally isolate each item
  into its own sibling worktree forked from the run worktree.
- **Introspection:** `yak graph <workflow>` emits a workflow's DAG as
  Mermaid; `yak watch [<run-id>]` live-tails a run's step statuses in a
  terminal UI; `yak artifacts [<run-id>]` lists a `map` step's per-item
  artifact files; `yak status [<run-id>]` reports per-step state
  (`completed`/`cached`/`stale`/`failed`/`pending`).
- **Caching:** content-addressed — re-runs only what a workflow or
  artifact change actually invalidates, everything else is reused from a
  prior run.
- **Journal:** append-only event log of every step's lifecycle is the
  only durable state — no database.
- **Adapters:** `mock` (fixture-driven, deterministic, free) and
  `claude-code` (real, wraps `@anthropic-ai/claude-agent-sdk`, also works
  against any Anthropic-compatible local model server via
  `ANTHROPIC_BASE_URL`). Selected with `yak run --adapter mock|claude-code`.

Full behavior reference: `spec.md`. Release process and commit
conventions: `CONTRIBUTING.md`.
