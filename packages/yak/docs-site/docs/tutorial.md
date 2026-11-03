---
sidebar_position: 2
title: Tutorial
---

import Admonition from '@theme/Admonition';

# Tutorial: fix a real bug

<Admonition type="caution" title="Spends real API budget">

Unlike the quickstart, this page runs against the real `claude-code`
adapter — a real Claude Agent SDK call, real tokens, real cost. You'll
need `ANTHROPIC_API_KEY` set. Everything else on this site is free to
follow along with; this is the one exception.

</Admonition>

The quickstart proved the engine runs. This proves it's useful: yak
finds and fixes an actual bug in a real (if small) codebase, on its own,
using the same reference shape as the quickstart — just with a real
model behind the `agent` steps instead of canned mock responses.

## The target: `fixtures/todo-app`

The repo ships with a tiny todo-list app that has one real, intentional
bug. Look at it yourself first if you want to spoil the ending:

```bash
cat fixtures/todo-app/src/todoList.ts
```

`pendingTodos` filters `t.done` instead of `!t.done` — it returns
completed todos, not pending ones. There's a test that catches it:

```bash
cd fixtures/todo-app && npx vitest run --root .
cd ../..
```

```
❯ test/todoList.test.ts:13:30
AssertionError: expected 'buy milk' to be 'walk dog'
```

## The workflow

`fixtures/todo-app/workflow.yaml` defines the same
`agent → agent → command → transform` shape the quickstart ran, aimed at
this bug:

1. **triage** — reads the source and the failing test, summarizes the
   bug.
2. **plan** — actually fixes it (this step has `Edit` tool access), then
   summarizes what it changed.
3. **check** — reruns the fixture's test suite.
4. **summarize** — reports whether the check passed.

## Run it

```bash
npx tsx src/cli/index.ts run fixtures/todo-app/workflow.yaml
```

No `--adapter` flag — `claude-code` is the default. This takes longer
than the quickstart's mock run (it's a real model call) and will print:

```
run <run-id> finished: ok
```

## Check what it actually did

```bash
cat .runs/<run-id>/artifacts/triage.json
cat .runs/<run-id>/artifacts/plan.json
cat .runs/<run-id>/artifacts/summary.json
```

A real run of this tutorial produced:

```json title="triage.json"
{
  "summary": "Read src/todoList.ts and test/todoList.test.ts. Bug found: `pendingTodos` (line 16) filters with `t.done`, which returns completed todos instead of pending ones — inverted condition. Fix: change to `!t.done`.",
  "confidence": 0.97
}
```

```json title="summary.json"
{
  "planSummary": "Fixed inverted filter bug in pendingTodos function by changing t.done to !t.done",
  "stepCount": 3,
  "checked": true
}
```

`checked: true` means the `check` step's test run passed — verify it
yourself too:

```bash
cd fixtures/todo-app && npx vitest run --root .
cd ../..
```

```
✓ test/todoList.test.ts (1 test)
```

The bug is fixed, for real, by an agent that only had a prompt and
`Edit`/`Read` tool access — no hand-holding beyond the workflow
definition itself.

## What made this work

The `plan` step's prompt didn't just ask for a description — it told the
agent to edit the file:

```yaml title="fixtures/todo-app/workflow.yaml"
- id: plan  # excerpt — full file also has name/version at top and the triage/check/summarize steps
  agent:
    prompt: { file: "fixtures/todo-app/prompts/plan.md" }
    schema:
      inline:
        type: object
        properties:
          summary: { type: string }
          steps: { type: array, items: { type: string } }
        required: [summary, steps]
    context: { inherit: [triage] }
    tools: [Read, Edit]
```

`tools: [Read, Edit]` is the allowlist — yak's adapter runs
`bypassPermissions` inside this scope (CLAUDE.md's sandbox-first
stance), so anything on that list executes without a human approving
each call. Nothing outside it is available; there's no `Bash`, no way to
`git push` or open a PR from inside this step. Escaping side effects
like that stay engine-run `command` steps, never agent tools — the
`check` step above is exactly that boundary in practice.

## Where to go from here

That's the whole site. For everything this tutorial didn't cover — the
full step-kind reference, `loop` and `map`, gates and suspend/resume,
worktree isolation — read `spec.md` in the
[repo](https://github.com/lchase/yak), which stays the source of truth
until a proper reference exists.
