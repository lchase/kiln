---
sidebar_position: 4
title: CLI command reference
---

# CLI command reference

Every `yak` command, one worked example each, with real captured
output. Not a flags table — for that, `yak <command> --help` or
`src/cli/index.ts`. This is "when would I reach for this" plus what it
actually prints.

`run` and `resume` below use the free `mock` adapter — nothing here
spends API budget. If you want to see `run`/`resume` against a real
model instead, the [tutorial](./tutorial) and the
[human-gated release pattern](./patterns/human-gated-release) both do,
with their own captured transcripts.

## `run`

Starts a workflow. This is the one command every other page on this
site leads with.

```bash
npx tsx src/cli/index.ts run test/workflows/agent-fixture-workflow.yaml --adapter mock
```

```
run 2026-08-20T04-41-58Z-4faf finished: ok
```

## `status`

Per-step status for a run — `completed`, `pending`, `failed`, `cached`,
and so on. Reach for this any time you want a quick answer to "where is
this run right now" without opening the journal by hand.

```bash
npx tsx src/cli/index.ts status 2026-08-20T04-41-58Z-4faf
```

```
run 2026-08-20T04-41-58Z-4faf:
  triage: completed
  plan: completed
  check: completed
  summarize: completed
```

Omit the run id to default to the most recently started run:

```bash
npx tsx src/cli/index.ts status
```

```
run 2026-08-20T04-41-58Z-4faf:
  triage: completed
  plan: completed
  check: completed
  summarize: completed
```

A `loop` step's status line also reports its budget (iteration count
against `maxIterations`, plus the `noProgress` signal if configured) —
see the [review-and-revise loop pattern](./patterns/review-and-revise-loop)
for that in context.

## `pending`

Lists every run across the whole repo that's suspended and waiting on a
human answer — not just the most recent one. Reach for this after
stepping away from a machine with multiple runs in flight, to find every
gate waiting on you at once.

```bash
npx tsx src/cli/index.ts pending
```

Against a run suspended at a `gate` step:

```
run 2026-08-20T04-42-18Z-24d8 suspended:
  approve (gate): Approve this change?
```

With nothing suspended anywhere:

```
nothing pending
```

## `resume`

Answers a suspended `gate` and continues the run. Write the answer file
yourself, the way you would after closing your laptop and coming back
later — `resume` doesn't prompt you interactively (`run --interactive`
does that; see the
[human-gated release pattern](./patterns/human-gated-release)).

```bash
mkdir -p .runs/2026-08-20T04-42-18Z-24d8/pending
cat > .runs/2026-08-20T04-42-18Z-24d8/pending/approve.answer.json <<'EOF'
{"decision": "approve"}
EOF
npx tsx src/cli/index.ts resume 2026-08-20T04-42-18Z-24d8
```

```
run 2026-08-20T04-42-18Z-24d8 finished: ok
```

An answer that doesn't satisfy the gate's schema is rejected outright,
without touching the run:

```
run 2026-08-20T04-42-18Z-24d8 still has unresolved pending requests:
  approve: invalid answer
    decision: Required
```

## `cancel`

Terminates a live run from outside the process that launched it — for a
supervisor (a reconciler, a batch orchestrator, or a human who started a
detached `yak run` and walked away) that needs a supported kill instead of
tracking pids and calling `kill(2)`.

```bash
npx tsx src/cli/index.ts cancel 2026-08-20T04-42-18Z-24d8
```

```
run 2026-08-20T04-42-18Z-24d8 cancelled
```

It SIGTERMs the run's process group (the agent subprocess included),
escalates to SIGKILL if the tree hasn't exited after a grace period, then
journals a terminal `run.finished { status: 'failed', reason: 'cancelled' }`
so `yak pending`, `yak status`, `yak watch`, and any other journal reader
see a clean terminal state. The isolation worktree and its `yak/<run-id>`
branch are left in place for normal cleanup.

`cancel` is idempotent: a run that has already finished is reported and
left untouched. A run whose recorded process is already gone (a stale pid,
or a journal written before this feature landed) still gets the terminal
`run.finished` written — that is the point of a supported cancel.

## `graph`

Emits a workflow's DAG as Mermaid, straight to stdout — paste it into
anything that renders Mermaid to see the shape before running it. Works
on an unvalidated workflow file too, deliberately: graphing an invalid
workflow to see *why* it's invalid is the point.

```bash
npx tsx src/cli/index.ts graph test/workflows/agent-fixture-workflow.yaml
```

```
flowchart TD
  triage[triage]
  plan[plan]
  triage -->|triage| plan
  check[check]
  plan -->|plan| check
  summarize[summarize]
  plan -->|plan| summarize
  check -->|check-result| summarize
```

A `map` step's items render as a `subgraph`, distinct from the
surrounding steps:

```
flowchart TD
  issues[issues]
  subgraph review
  review-one[review-one]
  issues -->|issues| review-one
  end
  issues -->|issues| review
```

## `artifacts`

Lists which item indices of a `map` step currently have a file on disk
— reads straight off the filesystem, so a still-running or interrupted
fan-out shows exactly the items that landed so far, not just a finished
run's assembled array. Reach for this mid-`map` to check fan-out
progress without waiting for the whole thing to finish.

```bash
npx tsx src/cli/index.ts artifacts 2026-08-20T04-42-52Z-ce75
```

```
run 2026-08-20T04-42-52Z-ce75:
  review (findings): items [0, 1, 2]
```

On a run with no `map` step:

```
run 2026-08-20T04-41-58Z-4faf:
  (no map steps with a produced artifact)
```

See the [fan-out pattern](./patterns/fan-out-over-issues) for what a
real, agent-driven `map` step looks like.

## `watch`

Live-tails a run's step statuses in a terminal UI, polling the journal
every 300ms — reach for this instead of repeated `status` calls when you
want to watch a long run progress without re-typing the command. It
exits on its own once the run reaches a terminal state (`ok`, `failed`,
or `suspended`); against an already-finished run it prints the final
state once and returns immediately.

```bash
npx tsx src/cli/index.ts watch 2026-08-20T04-41-58Z-4faf
```

```
triage: completed
plan: completed
check: completed
summarize: completed
run ok
```

## Reused output vs. fresh runs

`run`/`resume` above are fresh `mock`-adapter runs made for this page.
`status`, `pending`, `artifacts`, `graph`, and `watch` are all mechanical
reads against those same run directories — no adapter call involved, so
there was nothing to reuse from a prior page. Every command and every
flag shown here was checked directly against `src/cli/index.ts` (the
current 7-command surface: `run`, `resume`, `status`, `pending`, `graph`,
`watch`, `artifacts`) rather than spec.md's §6, which predates `watch`
and `artifacts`.
