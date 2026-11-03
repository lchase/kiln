---
sidebar_position: 3
title: Human-gated release
---

import Admonition from '@theme/Admonition';

# Pattern: human-gated release

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter — one
real model call to implement, plus whatever `--interactive` or `yak
resume` costs you in thinking time. Assumes you've already read the
[quickstart](../quickstart) and [tutorial](../tutorial).

</Admonition>

A `gate` step suspends the run and asks a human a question. Only a
`command` step is ever allowed to perform an escaping side effect — a
push, a publish, a deploy — never an agent tool. This pattern chains the
two: build and test a change, stop at a `gate` for a go/no-go, and only
release on approval.

## The target: `fixtures/release-demo`

One unimplemented function, `titleCase`, plus a `package.json` whose
version the release step is allowed to bump — locally, on this machine,
never pushed anywhere.

## The workflow

```yaml title="fixtures/release-demo/workflow.yaml"
name: gate-release
version: "1"
steps:
  - id: implement
    agent:
      prompt: { file: "fixtures/release-demo/prompts/implement.md" }
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
      run: "npx vitest run --reporter=json --root fixtures/release-demo"
      capture: [stdout, exitCode]
      failOn: never
    produces: testRaw

  - id: parse-test
    needs: [testRaw]
    transform: { fn: parseTestResult }
    produces: testResult

  - id: release-gate
    needs: [implementResult, testResult]
    gate:
      schema:
        inline:
          type: object
          properties:
            decision: { type: string, enum: [approve, reject] }
            notes: { type: string }
          required: [decision]
      render: { file: "fixtures/release-demo/prompts/release-gate.md" }
    produces: releaseDecision

  - id: release
    needs: [releaseDecision]
    skipIf: "releaseDecision.decision != 'approve'"
    command:
      run: "npm --prefix fixtures/release-demo version patch --no-git-tag-version"
      capture: [stdout, stderr, exitCode]
    produces: releaseResult
```

`release-gate` renders the implementer's summary and the real test
results, then suspends. `release` only runs `npm version patch` — a
local, reversible version bump, nothing pushed or published — and only
if the human approved.

## The gap this pattern found

Building this exposed a real hole in the engine, not just a docs gap.
`skipIf` existed, but only on `gate` — it let a gate skip its own pause
when the answer was already obvious, nothing more. There was no way for
a *downstream* step to conditionally not-run based on what a human (or
anything else) had decided. spec.md's own illustrative workflow has this
same gap: its `open-pr` command step runs unconditionally the moment
`pr-decision` exists, regardless of whether the human said `proceed` or
`abort`.

Fixed by moving `skipIf` from `GateStep` onto `BaseStep`, so every step
kind carries it. `command`/`transform`/`agent` steps now skip outright
when the expression is true — no artifact written, no cache entry, just
a `step.completed{skipped: true}` journal entry — instead of running
unconditionally the moment their `needs` are satisfied. Covered by a new
`test/engine/skip.test.ts`, exercised end-to-end in the run below.

## What actually happened

Run it under the real adapter:

```bash
npx tsx src/cli/index.ts run fixtures/release-demo/workflow.yaml --adapter claude-code
```

`implement` and `test` ran for real — 0 failed / 6 total — and
`release-gate` suspended:

```
run 2026-08-18T03-37-13Z-5fb3 suspended — resume with:
  yak resume 2026-08-18T03-37-13Z-5fb3
```

```bash
npx tsx src/cli/index.ts pending
```

```
run 2026-08-18T03-37-13Z-5fb3 suspended:
  release-gate (gate): Release go/no-go for `titleCase`.
```

**Rejecting it**, cold, via `yak resume` — write the answer file by hand,
the way you'd do it after closing your laptop and coming back the next
day:

```bash
mkdir -p .runs/<run-id>/pending
cat > .runs/<run-id>/pending/release-gate.answer.json <<'EOF'
{"decision": "reject", "notes": "demo: rejecting to prove release stays skipped"}
EOF
npx tsx src/cli/index.ts resume <run-id>
```

The run finishes `ok` — not suspended, not failed, just done — and
`release` never fired:

```json title="journal.jsonl (tail, after reject)"
{"t":"step.completed","stepId":"release","cached":false,"skipped":true, ...}
{"t":"run.finished","status":"ok", ...}
```

No `releaseResult` artifact exists. `package.json`'s version is
untouched.

**Approving it**, the other way, with `--interactive` prompting inline
instead of exiting to resume later:

```bash
npx tsx src/cli/index.ts run fixtures/release-demo/workflow.yaml --adapter claude-code --interactive
```

```
Release go/no-go for `titleCase`.

Implementer's summary: Implemented titleCase in fixtures/release-demo/src/titleCase.ts: split
input on whitespace, lowercase each word then capitalize first letter, except small connector
words (a, an, the, of, in, on, and, or, but, to) which stay lowercase unless they are the first
word. Empty string input returns '' unchanged. Satisfies all test cases in titleCase.test.ts.

Test results: 0 failed / 6 total.

Approve to bump the fixture's package.json version (patch, local only —
nothing is pushed or published). Reject to leave it untouched.

decision [approve/reject]: approve
notes (optional, blank to skip): demo: interactive approval, real release
run 2026-08-18T03-44-12Z-b4d8 finished: ok
```

This time `release` genuinely ran:

```json title="releaseResult.json"
{
  "stdout": "v0.1.1\n",
  "stderr": "",
  "exitCode": 0
}
```

`package.json`'s version moved `0.1.0` → `0.1.1`, entirely on the local
working tree — no `git push`, no registry, nothing left the machine.
That's the whole point of the invariant this pattern is built around:
the gate decides, and only an engine-run `command` step ever touches
anything outside the sandbox.

One thing worth noticing in the transcript: `--interactive` with no
terminal attached at all (stdin closed, no piped answer) doesn't hang —
it suspends exactly like the non-interactive path, so scripting or CI
contexts fail safe into "answer me later" rather than blocking forever.
