---
sidebar_position: 1
title: Review-and-revise loop
---

import Admonition from '@theme/Admonition';

# Pattern: review-and-revise loop

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter —
two real model calls per round, up to `maxIterations` rounds. Assumes
you've already read the [quickstart](../quickstart) and
[tutorial](../tutorial).

</Admonition>

A `loop` step bounds iteration with `maxIterations` and, optionally, a
`noProgress` check — a signal that must keep improving or the loop
suspends rather than spinning forever. This pattern uses both: an agent
implements something, a *second* agent reviews it, and the loop repeats
until the reviewer approves.

## The target: `fixtures/loop-demo`

A single unimplemented function with a tricky spec:

```ts title="fixtures/loop-demo/src/mergeIntervals.ts"
export function mergeIntervals(intervals: Interval[]): Interval[] {
  throw new Error('not implemented')
}
```

Merge overlapping `[start, end]` intervals — including ones that merely
*touch* at an endpoint (`[1, 3]` and `[3, 6]` count as overlapping), and
the input may be unsorted. Seven test cases in
`fixtures/loop-demo/test/mergeIntervals.test.ts` pin down the edge
cases.

## The workflow

```yaml title="fixtures/loop-demo/workflow.yaml"
name: loop-review-revise
version: "1"
steps:
  - id: fix-until-approved
    loop:
      until: "review.approved == true"
      budget:
        maxIterations: 5
        noProgress:
          signal: "testResult.numFailedTests"
          rounds: 2
      body:
        - id: prep-feedback
          needs: [review]
          transform: { fn: prepFeedback }
          produces: priorFeedback

        - id: implement
          needs: [priorFeedback]
          agent:
            prompt: { file: "fixtures/loop-demo/prompts/implement.md" }
            schema:
              inline:
                type: object
                properties:
                  summary: { type: string }
                required: [summary]
            tools: [Read, Edit]
          produces: implementResult

        - id: test
          needs: [implementResult]
          command:
            run: "npx vitest run --reporter=json --root fixtures/loop-demo"
            capture: [stdout, exitCode]
            failOn: never
          produces: testRaw

        - id: parse-test
          needs: [testRaw]
          transform: { fn: parseTestResult }
          produces: testResult

        - id: review
          needs: [testResult]
          agent:
            prompt: { file: "fixtures/loop-demo/prompts/review.md" }
            schema:
              inline:
                type: object
                properties:
                  approved: { type: boolean }
                  feedback: { type: string }
                required: [approved, feedback]
            tools: [Read]
          produces: review
```

Five body steps, run in order, every round: prep the previous round's
feedback into a prompt-friendly string, implement (with `Edit` access),
run the real test suite, parse its JSON output into a number, and have
a *second*, read-only agent review the result. `until` checks the
reviewer's verdict; `noProgress`'s signal is the failing-test count —
if it doesn't improve for two consecutive rounds, the loop suspends
instead of grinding forever.

That order is the default. `concurrency` defaults to `1`, and the
effective cap is `min(concurrency, the run's global concurrency)`. When
that cap is 1, each body step finishes before the next one starts — a
later step does not jump ahead of an earlier sibling that is still
waiting, even if it does not read that sibling's artifact. Raising the
effective cap above 1 runs steps that don't read an earlier sibling in
the same round, and a step may then start before an earlier sibling it
does not depend on — see [parallel reviewers](#parallel-reviewers) below.

`prep-feedback`'s `needs: [review]` looks backwards — `review` is
produced by the *last* step in this same body. That's not a cycle: a
loop body's `needs` can point at a step later in its own body, and at
runtime it resolves to *last round's* value (`undefined` on round one).
A placeholder whose whole expression is `undefined` throws, so
`{{ review.feedback }}` fails on the first round. `{{ review || "no prior feedback yet" }}`
does not: validation reads `review` (a string literal is not a root), and `||`
supplies the default when that artifact is missing. A bare name on the
other side of `||`, such as `{{ review || secrity }}`, is checked too —
`secrity` has to be a declared input. A transform can do the same check
in code — that's what this fixture's `prepFeedback` does.
`fn: prepFeedback` resolves against a fixed path, `.yak/transforms.ts`
relative to the run's `cwd` — see
[standalone transform](./standalone-transform#why-transform-is-its-own-step-kind)
for that mechanism in full:

```ts title=".yak/transforms.ts"
export function prepFeedback(inputs: Record<string, unknown>): unknown {
  const review = inputs['review'] as Review | undefined
  return review === undefined ? '(first attempt — no prior feedback yet)' : review.feedback
}
```

## Parallel reviewers

The fixture above stays sequential on purpose: `implement` reads
`priorFeedback`, `test` reads `implementResult`, and so on, so each step
waits on the one before it. A review-and-revise loop whose reviewers
don't read each other is the case `concurrency` is for. They all need
the build and not each other, so once the build finishes they start
together. The
approver lists every review in `needs`, so it waits until this round's
reviews exist — a later step still sees this round, not the previous
one. A reviewer that reads its *own* last round (a backward `needs`,
same position or later in the body) uses the `||` default, because
round one has no prior artifact:

```yaml
- id: revise
  loop:
    concurrency: 4
    until: "approval.approved == true"
    budget:
      maxIterations: 4
    body:
      - id: build
        command: { run: "npm test", failOn: never }
        produces: buildResult

      - id: security
        needs: [buildResult, security]
        agent:
          prompt:
            inline: |
              Review the security of {{ buildResult }}.
              Prior findings: {{ security || "none yet" }}
          tools: [Read]
        produces: security

      - id: ux
        needs: [buildResult]
        agent:
          prompt: { inline: "Review the UX of {{ buildResult }}." }
          tools: [Read]
        produces: ux

      - id: ui
        needs: [buildResult]
        agent:
          prompt: { inline: "Review the UI of {{ buildResult }}." }
          tools: [Read]
        produces: ui

      - id: code
        needs: [buildResult]
        agent:
          prompt: { inline: "Review the code in {{ buildResult }}." }
          tools: [Read]
        produces: code

      - id: approver
        needs: [security, ux, ui, code]
        agent:
          prompt:
            inline: |
              Security: {{ security }}
              UX: {{ ux }}
              UI: {{ ui }}
              Code: {{ code }}
          tools: [Read]
        produces: approval
```

`security`, `ux`, `ui`, and `code` all wait on `build` and not on each
other, so with `concurrency: 4` the four reviews run in one round.
`security`'s `needs: [security]` points at itself — same body position,
so it resolves to last round (`undefined` on round one) and the
`|| "none yet"` default keeps the prompt from throwing. `approver`
waits on all four, then reads this round's values. The effective cap is
`min(concurrency, the run's global concurrency)`. When that cap is 1 —
`concurrency` left unset, or a higher value clipped by a global cap of
1 — the body runs in declared order, exactly as the fixture above does.
When the cap is greater than 1, a step may overtake an earlier sibling
that is not ready yet and that it does not depend on. In a body
`[a, b needs a, c]` at cap 2, `c` starts with `a` while `b` is still
waiting on `a`.

Reviewers that declare a write-capable tool (`Edit`, `Write`, `Bash`)
and can actually overlap share one working directory. Command steps
share that directory too and may write files there, so a command that
can overlap another body step gets the same warning. `concurrency: 1`,
or dropping the write tool, clears it.

## Run it

```bash
npx tsx src/cli/index.ts run fixtures/loop-demo/workflow.yaml
npx tsx src/cli/index.ts status
```

## What actually happened

A real run of this pattern took **two rounds**, not one — and the
reason why is the entire point of having a reviewer instead of just
checking exit codes.

**Round 1**: the implementation passed all 7 tests —
`testResult.1.json` showed `numFailedTests: 0`. A test-status check
alone would have called that done. The reviewer didn't:

```json title="review.1.json"
{
  "approved": false,
  "feedback": "Tests pass, algorithm logic correct (sort, `<=` for touching endpoints, chain merge all fine). But bug: mutates caller's input array.\n\n`sorted = [...intervals]` only shallow-copies outer array — inner tuples still same references as `intervals` elements. `result` starts with `sorted[0]`, same reference as `intervals[k]`. Later `last[1] = Math.max(...)` mutates that shared tuple in place — caller's original `intervals` array gets silently modified.\n\nFix: push a copy, not the reference."
}
```

A real bug the test suite never checked for — none of the 7 tests
inspect whether the *input* array got mutated, only the return value.

**Round 2**: `implement` got that exact feedback via `priorFeedback`,
made the one-line fix it described, and the reviewer approved:

```json title="review.2.json"
{
  "approved": true,
  "feedback": "Logic correct: sort by start, <= merges touching endpoints, Math.max handles nested intervals. Input not mutated (spread + new tuples). Clean, matches all 7 cases."
}
```

`noProgress`'s signal (failing-test count) was `0` on both rounds here
— it never got the chance to matter, because the reviewer's judgment
caught something the test count couldn't. That's what a second agent
buys you over a bare `test → loop-if-red` shape: it can reject work a
test suite calls green.
