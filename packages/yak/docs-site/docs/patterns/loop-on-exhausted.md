---
sidebar_position: 4
title: "loop: onExhausted fail vs continue"
---

import Admonition from '@theme/Admonition';

# Pattern: loop `onExhausted` fail vs continue

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter —
one real model call per run. Assumes you've already read the
[review-and-revise loop](./review-and-revise-loop) pattern, which covers
`loop` basics and the default `onExhausted: 'suspend'`.

</Admonition>

`onExhausted` decides what a `loop` step does when its budget runs out
before `until` is ever satisfied. The
[review-and-revise loop](./review-and-revise-loop) pattern never actually
hits this — its reviewer always eventually approves — because the
default, `'suspend'`, is what that pattern relies on implicitly by never
exhausting. The other two policies, `'fail'` and `'continue'`, change
what the *run itself* does, not just the loop step.

## The workflows

Same body both times — a single agent step drafting one sentence — with
`until: "false"`. That's a deliberately unsatisfiable condition: this
loop exists to demonstrate `onExhausted`, not to converge on anything,
so exhaustion happens on schedule after exactly one iteration regardless
of what the model writes.

```yaml title="fixtures/loop-on-exhausted/workflow-fail.yaml"
name: loop-on-exhausted-fail
version: "1"
steps:
  - id: draft-until-perfect
    loop:
      until: "false"
      budget:
        maxIterations: 1
      onExhausted: fail
      body:
        - id: draft
          agent:
            prompt: { inline: "Write one short sentence describing what mergesort does." }
            schema:
              inline:
                type: object
                properties:
                  sentence: { type: string }
                required: [sentence]
          produces: draft
```

`workflow-continue.yaml` is identical except `onExhausted: continue`.

## Run both

```bash
npx tsx src/cli/index.ts run fixtures/loop-on-exhausted/workflow-fail.yaml --adapter claude-code
npx tsx src/cli/index.ts run fixtures/loop-on-exhausted/workflow-continue.yaml --adapter claude-code
```

## What actually happened

**`onExhausted: fail`** — the run itself fails, not just the loop step.
`draft-until-perfect` journals a `step.failed` with
`reason: 'budget-exhausted'`, and that propagates straight to
`run.finished { status: 'failed' }`:

```json title="journal.jsonl (tail)"
{"t":"loop.iteration","stepId":"draft-until-perfect","n":1}
{"t":"step.failed","stepId":"draft-until-perfect","failure":{"reason":"budget-exhausted","detail":"loop \"draft-until-perfect\" exhausted (maxIterations) after 1 iterations","recoverable":false}}
{"t":"run.finished","status":"failed"}
```

```
$ npx tsx src/cli/index.ts status <run-id>
run <run-id>:
  draft-until-perfect: failed
    iteration 1/1, tokens 114
```

**`onExhausted: continue`** — same exhaustion (`until` still never true,
same `maxIterations: 1` budget, same `loop.iteration` event), but the
loop step treats it as acceptable rather than fatal. No `step.failed`,
just an ordinary `step.completed` on the loop step id itself, and the
run finishes `ok`:

```json title="journal.jsonl (tail)"
{"t":"loop.iteration","stepId":"draft-until-perfect","n":1}
{"t":"step.completed","stepId":"draft-until-perfect","cached":false}
{"t":"run.finished","status":"ok"}
```

```
$ npx tsx src/cli/index.ts status <run-id>
run <run-id>:
  draft-until-perfect: completed
    iteration 1/1, tokens 0
```

(`tokens 0` here isn't `continue` doing anything special — the body
step's own prompt/schema/budget definition is identical between the two
workflows, so the content-addressed cache recognized the second run's
`draft` call as one it had already paid for in the first run and reused
it, `cached: true` on the body step. A `continue`d loop still runs its
body for real when the cache doesn't already have the answer.)

## Why this matters

`'fail'` is the right call when a loop converging is a hard
precondition for anything downstream to make sense — there's no
reasonable artifact to hand off if the loop never got there.
`'continue'` is for the opposite case: the last iteration's result is
good enough to proceed with even if it's not perfect, and you'd rather
the run finish with a "best effort" artifact than halt entirely. Neither
one asks a human — that's what the default, `'suspend'`, is for (see
the review-and-revise loop pattern and `yak pending`/`--interactive`).

One real limitation worth knowing: a loop body's artifacts
(`draft` here) are only visible to steps *inside* that same loop — spec's
"steps communicate only through named, schema-validated artifacts"
invariant is scoped per-loop, not global. A step after this one in the
workflow couldn't declare `needs: [draft]` to pick up what
`'continue'` left behind; there's currently no way to carry a loop's
last-iteration result to a step outside it.
