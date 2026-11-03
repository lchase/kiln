---
sidebar_position: 1
title: Quickstart
---

# Quickstart

Clone, install, and run yak's reference workflow end to end — no API key,
no cost. This uses the `mock` adapter, so every agent step returns a
canned, deterministic response; it exists to prove the engine itself
works (scheduling, caching, journaling, resume) before you spend real
budget on a real run. The [tutorial](./tutorial) does that part, fixing
an actual bug with the real `claude-code` adapter.

## Prerequisites

- Node 22+
- git

## Clone and install

```bash
git clone git@github.com:lchase/yak.git
cd yak
npm install
```

yak isn't published to npm yet, so this is a source checkout, not
`npm install -g yak` — that changes once it ships.

## Run the reference workflow

```bash
npm run dev -- run test/workflows/agent-fixture-workflow.yaml --adapter mock
```

This runs the `agent → agent → command → transform` reference shape —
triage an issue, plan a fix, run a check command, summarize the result —
against the `mock` adapter. You should see:

```
run 2026-08-14T04-31-43Z-d8a2 finished: ok
```

(Your run id will differ — it's generated per run, timestamp plus a
random suffix.)

## Look at what it did

Every run writes its artifacts to `.runs/<run-id>/artifacts/`, one JSON
file per step's output:

```bash
cat .runs/<run-id>/artifacts/summary.json
```

```json
{
  "planSummary": "Add null check to password field",
  "stepCount": 2,
  "checked": true
}
```

Check any run's step-by-step state at any time:

```bash
npm run dev -- status <run-id>
```

## Run it again

```bash
npm run dev -- run test/workflows/agent-fixture-workflow.yaml --adapter mock
npm run dev -- status
```

```
run <new-run-id>:
  triage: cached
  plan: cached
  check: cached
  summarize: cached
```

Same workflow, second run, new run id — but every step reports `cached`
instead of re-executing, because nothing about the workflow or its
inputs changed. This is the thing most agent-orchestration tools don't
give you for free: content-addressed caching and journal-based resume,
not just a retry loop. See [why that matters](/) if you haven't
already.

## Next: fix a real bug

The quickstart proves the engine runs. The [tutorial](./tutorial) proves
yak does something useful: it walks through fixing an actual bug in a
real (if small) codebase, using the real `claude-code` adapter — the
only page on this site that spends real API budget.
