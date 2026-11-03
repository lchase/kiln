---
sidebar_position: 5
title: "map: onItemFailure fail vs retry"
---

import Admonition from '@theme/Admonition';

# Pattern: map `onItemFailure` fail vs retry

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter —
one real model call, only in the `retry` variant (see below). Assumes
you've already read [fan out over a batch of issues](./fan-out-over-issues),
which covers `map` basics and the default `onItemFailure: 'skip'`.

</Admonition>

`onItemFailure` decides what a `map` step does when at least one item
fails. `'skip'` (the default, and what the fan-out-over-issues pattern
relies on implicitly by never hitting a failure) drops the failed item
to `null` in the results array and moves on. The other two policies,
`'fail'` and `'retry'`, change that.

## The workflows

Both fan out over a static 3-item list. Item 2 is deliberately
unsatisfiable — deterministically, so the outcome never depends on
model behavior, same trick the [loop onExhausted](./loop-on-exhausted)
pattern uses:

```yaml title="fixtures/map-on-item-failure/workflow-fail.yaml"
name: map-on-item-failure-fail
version: "1"
steps:
  - id: checks
    transform: { fn: batchChecks }
    produces: checks

  - id: run-checks
    needs: [checks]
    map:
      over: checks
      concurrency: 3
      onItemFailure: fail
      step:
        id: run-one-check
        command:
          run: 'echo "checking item $MAP_ITEM_INDEX: $MAP_ITEM"; [ "$MAP_ITEM_INDEX" != "2" ]'
          capture: [stdout, stderr, exitCode]
    produces: checkResults

  - id: summarize
    needs: [checkResults]
    agent:
      prompt:
        inline: >
          Here are the results of 3 automated checks, one per item, as a
          JSON array (a null entry means that check never produced a
          result): {{checkResults}}. Write one short sentence summarizing
          how many passed.
      schema:
        inline:
          type: object
          properties:
            summary: { type: string }
          required: [summary]
    produces: summary
```

`workflow-retry.yaml` is identical except `onItemFailure: retry`.

Two things worth calling out that the earlier fan-out pattern didn't
need:

- **The item step here is `command`, not `agent`.** A `map` fans out
  over any step kind, and a shell check is a genuinely common thing to
  parallelize — this pattern happens to also need full determinism, and
  a shell `test` gives that for free in a way an agent's judgment
  wouldn't.
- **`$MAP_ITEM_INDEX` / `$MAP_ITEM`** are real, engine-provided
  environment variables a `command` map item gets — the shell analog of
  an agent item's `{{...}}` prompt templating (`src/steps/command.ts`'s
  `runCommandStep`, called with them from `map.ts`). `$MAP_ITEM` here is
  the item's JSON, `$MAP_ITEM_INDEX` its position — used above to make
  index 2 the one that always fails.
- **`summarize`'s `schema` is inline** (`{ inline: {...} }`), not a
  `.yak/schemas.ts` key — the two forms are interchangeable per-step;
  this page just happens to use the other one. (A named key resolves
  against a fixed path, `.yak/schemas.ts` relative to the run's `cwd` —
  see [standalone
  transform](./standalone-transform#why-transform-is-its-own-step-kind)
  for that mechanism; inline is the only way to skip it.)

## Run both

```bash
npx tsx src/cli/index.ts run fixtures/map-on-item-failure/workflow-fail.yaml
npx tsx src/cli/index.ts run fixtures/map-on-item-failure/workflow-retry.yaml --adapter claude-code
```

## What actually happened

**`onItemFailure: fail`** — items 0 and 1 pass, item 2 fails once, and
because the policy is `'fail'`, that's enough to fail the whole `map`
step immediately (no retry attempted at all) — which fails the run.
`summarize` never gets scheduled; it needs `checkResults`, which the
map step never wrote (a `'fail'`-policy map returns before writing its
`produces` artifact):

```
$ npx tsx src/cli/index.ts status <run-id>
run <run-id>:
  checks: completed
  run-checks: failed
  summarize: pending
```

```json title="journal.jsonl (tail)"
{"t":"step.failed","stepId":"run-checks[2]","iteration":2,"failure":{"reason":"command-failed","detail":"command \"...\" exited with code 1","recoverable":false}}
{"t":"step.failed","stepId":"run-checks","failure":{"reason":"command-failed","detail":"map \"run-checks\": at least one item failed under onItemFailure: 'fail'","recoverable":false}}
{"t":"run.finished","status":"failed"}
```

**`onItemFailure: retry`** — item 2 fails, retries twice more (three
attempts total — the engine's fixed retry count, not configurable per
`map` step), fails all three times since the failure is structural, not
flaky. That exhausts retry's budget, so it falls back to `'skip'`'s
terminal state: `null` in the results array, and — critically — the
`map` step itself still completes `ok`. The run proceeds, and
`summarize` runs for real:

```
$ npx tsx src/cli/index.ts status <run-id>
run <run-id>:
  checks: cached
  run-checks: completed
  summarize: completed
```

```json title="journal.jsonl (tail)"
{"t":"map.item.retried","mapStepId":"run-checks","itemIndex":2,"attempt":1,"error":"command \"...\" exited with code 1"}
{"t":"map.item.retried","mapStepId":"run-checks","itemIndex":2,"attempt":2,"error":"command \"...\" exited with code 1"}
{"t":"step.completed","stepId":"run-checks","cached":false}
{"t":"step.started","stepId":"summarize"}
{"t":"step.completed","stepId":"summarize","artifact":"summary","artifactHash":"..."}
{"t":"run.finished","status":"ok"}
```

```json title="checkResults.json"
[
  { "stdout": "checking item 0: {\"id\":\"check-a\"}\n", "stderr": "", "exitCode": 0 },
  { "stdout": "checking item 1: {\"id\":\"check-b\"}\n", "stderr": "", "exitCode": 0 },
  null
]
```

```json title="summary.json"
{ "summary": "Two checks passed. One produced no result." }
```

The real agent step read the array — `null` included — and reported
accurately on it, no special-casing needed on yak's side for the gap in
the data.

(Items 0 and 1 show `cached: true` in the retry run's journal — same
underlying reason as the loop pattern's cache note: identical item-step
definition and content between the two workflow files, so the second
run reused what the first already paid for.)

## Why this matters

`'fail'` is right when *any* item failing means the batch as a whole
isn't trustworthy — a release gate fed by N checks, say, where partial
credit is meaningless. `'retry'` is for the opposite: transient,
plausibly-flaky failures (a flaky network call, a rate limit) where a
second or third attempt might genuinely succeed, and a `null` for the
one item that never does is an acceptable, visible gap rather than a
reason to fail everything else. Neither policy retries *this* pattern's
item to success — its failure is structural, not flaky — but the
mechanics (two `map.item.retried` events, then the same `'skip'`
fallback the default policy always used) are identical to a real
flaky-failure case; a genuinely intermittent check would just have some
chance of succeeding on attempt 2 or 3 instead of failing all three
deterministically.
