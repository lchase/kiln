---
sidebar_position: 2
title: Fan out over a batch of issues
---

import Admonition from '@theme/Admonition';

# Pattern: fan out over a batch of issues

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter —
one real model call per item, run concurrently, plus one for triage.
Assumes you've already read the [quickstart](../quickstart) and
[tutorial](../tutorial).

</Admonition>

A `map` step fans a list out over one item step, run concurrently up to
a `concurrency` cap. `isolation: 'worktree'` gives each item its own git
worktree, so N agents editing files at once never race each other — and
because item worktrees fork off the run's own branch, they need the
run's prior steps to actually be *committed* there first, or they'd fork
from a stale tree. That auto-commit didn't exist in the engine until
this pattern needed it (more on that below).

## The target: `fixtures/batch-issues`

Three independent, unrelated bugs, one per file:
`capitalize.ts`, `clamp.ts`, `isPalindrome.ts` — each with its own test.
None of the three fixes touch another file.

## The workflow

```yaml title="fixtures/batch-issues/workflow.yaml"
name: map-fanout-batch-issues
version: "1"
steps:
  - id: triage
    agent:
      prompt: { file: "fixtures/batch-issues/prompts/triage.md" }
      schema:
        inline:
          type: object
          properties:
            summary: { type: string }
            confidence: { type: number }
          required: [summary, confidence]
      tools: [Read, Glob, Write]
    produces: triage

  - id: issues
    needs: [triage]
    transform: { fn: batchIssues }
    produces: issues

  - id: fix-issue
    needs: [issues]
    map:
      over: issues
      isolation: worktree
      concurrency: 3
      step:
        id: fix-one
        needs: [issues]
        agent:
          prompt:
            inline: >
              Read fixtures/batch-issues/BUGS.md for context on all known
              bugs, then read {{issues.file}} and {{issues.test}}. Fix the
              bug in {{issues.file}} (id: {{issues.id}}) so its test
              passes. Make only the edit needed for this one bug.
          schema:
            inline:
              type: object
              properties:
                summary: { type: string }
              required: [summary]
          tools: [Read, Edit]
    produces: fixResults
```

`triage` reads every file, writes a shared `BUGS.md` describing all
three bugs. `issues` is a static list (deterministic on purpose — the
point here is the fan-out mechanics, not sourcing the batch). `fix-issue`
maps over that list: each item gets the *current* item as an input named
after `over` — `{{issues.file}}` inside the item step is that one
item's `file` field, not the whole array.

Run it under `--isolation worktree` (required — a worktree-isolated
`map` step needs the run itself worktree-isolated too, so item
worktrees have a run branch to fork from):

```bash
npx tsx src/cli/index.ts run fixtures/batch-issues/workflow.yaml --isolation worktree
```

## The gap this pattern found

Building this surfaced a real engine bug, not just a docs gap. Item
worktrees fork from the run branch's `HEAD` — but nothing committed
`triage`'s output there before the fork. Whether/how the engine should
auto-commit before a worktree-isolated `map` fans out had already been
decided, but never implemented. The first real run here proved the gap:
`BUGS.md` existed in the run's own worktree but not in any item's —
each item forked from a tree that predated `triage` entirely.

Fixed in `src/steps/map.ts` / `src/util/git.ts`: right before a
worktree-isolated `map` step forks its items, the engine now stages and
commits whatever's dirty in the run's own worktree, under a fixed
`yak <engine@yak.local>` identity — never after every step, only at that
one trigger point.

## What actually happened

A real run took the triage step further than expected, too. Its first
attempt only had `Read`/`Write` tools — no way to *list* a directory —
so it failed outright:

```json title="triage.json (first attempt, before adding Glob)"
{
  "summary": "Cannot complete task. No directory-listing tool (Bash/Glob/LS) available in this session — only Read (needs exact file path), Write, and unrelated MCP tools...",
  "confidence": 0.2
}
```

Adding `Glob` to `tools` fixed it for real — a genuine tool-scoping
lesson, not a hypothetical one:

```json title="triage.json"
{
  "summary": "Read all three src/test file pairs in fixtures/batch-issues and wrote fixtures/batch-issues/BUGS.md with one section per file describing each bug: capitalize.ts lowercases instead of uppercasing first char; clamp.ts ignores max bound entirely (only does Math.min(value,min)); isPalindrome.ts doesn't normalize case/spaces/punctuation before reversing.",
  "confidence": 0.95
}
```

With the auto-commit fix in place, all three items forked worktrees
that actually contained `BUGS.md`, and all three fixed their bug
concurrently:

```json title="fixResults.json"
[
  { "summary": "Fixed capitalize.ts bug: changed charAt(0).toLowerCase() to charAt(0).toUpperCase() so first letter is properly capitalized. Only that one line changed." },
  { "summary": "Fixed clamp.ts bug: changed `Math.min(value, min)` to `Math.min(Math.max(value, min), max)` so both lower and upper bounds clamp correctly." },
  { "summary": "Fixed isPalindrome.ts by normalizing input (lowercase, strip non-alphanumeric chars) before reverse comparison, matching docstring behavior. Single edit, matches BUGS.md description." }
]
```

Item 2's summary calling out that its fix "matches BUGS.md description"
is the tell — it actually read and used the shared file the auto-commit
made visible, not just its own assigned file.

Verified independently, per item, inside each item's own worktree:

```bash
cd .yak/worktrees/<run-id>/fix-issue/0/fixtures/batch-issues && npx vitest run --root . test/capitalize.test.ts
cd .yak/worktrees/<run-id>/fix-issue/1/fixtures/batch-issues && npx vitest run --root . test/clamp.test.ts
cd .yak/worktrees/<run-id>/fix-issue/2/fixtures/batch-issues && npx vitest run --root . test/isPalindrome.test.ts
```

All three pass. The main working tree was never touched — every edit
happened inside its own item's worktree, exactly the isolation the
pattern is for.

## One caveat: caching and side effects

Re-running the same workflow after `triage` changes but the `issues`
list doesn't will often hit each item's content-addressed cache — same
item, same step definition, same cache key. A cache hit reuses the
*artifact* (the JSON summary) but never replays the *tool calls* that
produced it, so a cached item's fresh worktree can still have the
un-edited file even though its cached summary describes a fix. If
you're re-running a `map` pattern like this one to see it work again
from scratch, clear `.yak/cache` first.
