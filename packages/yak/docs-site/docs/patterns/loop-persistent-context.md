---
sidebar_position: 6
title: "loop: persistent context (freshContext: false)"
---

import Admonition from '@theme/Admonition';

# Pattern: loop with persistent context

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter —
one real model call per round. Assumes you've already read the
[review-and-revise loop](./review-and-revise-loop) pattern, which covers
`loop` basics.

</Admonition>

Every other loop pattern on this site gives each iteration a fresh
model context and threads whatever state the next round needs through
`needs`/`{{ }}` — [review-and-revise loop](./review-and-revise-loop)'s
`prepFeedback` transform exists specifically for that. `freshContext:
false` is the other mode: the loop body's agent step keeps the *same*
adapter session across every iteration, so the model can recall what it
did last round on its own — no artifact threading required.

## The workflow

```yaml title="fixtures/loop-persistent-context/workflow.yaml"
name: loop-persistent-context
version: "1"
steps:
  - id: count-until-four
    loop:
      freshContext: false
      until: "count.n >= 4"
      budget:
        maxIterations: 5
      onExhausted: fail
      body:
        - id: count
          agent:
            prompt:
              inline: >-
                We're counting up by one, one number per turn, starting
                at 1. If this is the very first turn of our
                conversation, answer 1. Otherwise, recall the number you
                answered on your previous turn and answer that number
                plus one. Answer with only the number, nothing else.
            schema:
              inline:
                type: object
                properties:
                  n: { type: number }
                required: [n]
          produces: count
```

One body step, no `needs`. The prompt is identical every round — it
never says "the last number was N" — because the model doesn't need to
be told; `freshContext: false` means it's still in the same
conversation. `until` checks `count.n >= 4`, a schema-validated field on
the step's own output, the same shape every other pattern on this site
uses instead of Archon's magic-string-in-text convergence check.

## Run it

```bash
npx tsx src/cli/index.ts run fixtures/loop-persistent-context/workflow.yaml --adapter claude-code
```

## What actually happened

Four rounds, each producing exactly the artifact you'd expect if the
model were genuinely counting from memory:

```json title="artifacts/count.1.json"
{ "n": 1 }
```
```json title="artifacts/count.2.json"
{ "n": 2 }
```
```json title="artifacts/count.3.json"
{ "n": 3 }
```
```json title="artifacts/count.4.json"
{ "n": 4 }
```

The tell is in `sessions/` — a run of the
[review-and-revise loop](./review-and-revise-loop) pattern writes one
transcript file per body-step *call*; this one writes a single
`sessions/count.jsonl` spanning all four rounds, because every round
reuses the adapter session the previous round opened. `freshContext:
true` (the default, and every other loop pattern on this site) would
have started a new session — and a new transcript — each iteration,
and the model would have had no way to know what number came before
without the workflow telling it.

## Why this matters

`freshContext: false` trades the isolation of a clean context each
round (no risk of the model getting confused by its own prior output,
no growing prompt) for the ability to let the model track its own
running state across iterations — useful when what needs to persist is
conversational, not a single well-typed artifact (a design being
refined through discussion, a multi-turn investigation) rather than
something you'd want to name and validate as its own schema field
anyway. When the state *does* fit a schema, threading it explicitly
through `needs` — as the review-and-revise loop pattern does — keeps
every round's input visible in the journal instead of hidden inside an
opaque session transcript.
