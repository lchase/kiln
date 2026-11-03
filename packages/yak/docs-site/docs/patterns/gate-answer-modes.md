---
sidebar_position: 8
title: "gate: answering inline vs by hand"
---

# Pattern: answering a gate two ways

Free to run — no `agent` steps, no API key, no cost. Where
[human-gated-release](./human-gated-release) shows *why* a gate exists (only
a `command` step ever does the real release, gated behind human approval),
this page shows the two ways to actually clear one: `--interactive` in the
same terminal, or writing an answer file by hand — the path a script, a
teammate, or you-tomorrow-morning uses.

## The target: `test/workflows/gate-multi.yaml`

Two independent gates, no `agent`/`command` steps around them — nothing
else can fail, so the whole example is about the suspend/resume mechanics
themselves.

```yaml title="test/workflows/gate-multi.yaml"
name: gate-multi
version: "1"
steps:
  - id: approve-a
    gate:
      schema:
        inline:
          type: object
          properties:
            decision: { type: string, enum: [approve, reject] }
            notes: { type: string }
          required: [decision]
      render: { inline: "Approve A?" }
    produces: decision-a

  - id: approve-b
    gate:
      schema:
        inline:
          type: object
          properties:
            decision: { type: string, enum: [approve, reject] }
            notes: { type: string }
          required: [decision]
      render: { inline: "Approve B?" }
    produces: decision-b
```

Neither gate `needs` the other, so both open in the same round.

## Run it

```bash
npx tsx src/cli/index.ts run test/workflows/gate-multi.yaml
```

```
run 2026-08-26T23-28-17Z-cf4a suspended — resume with:
  yak resume 2026-08-26T23-28-17Z-cf4a
```

No `--interactive`, no attached terminal willing to answer — this is
`yak run`'s default. Exit code is `78` (`EX_SUSPEND`), not `1`; it's a
paused state, not a failure. `yak pending` shows every suspended run across
the repo and what each open gate is asking:

```bash
npx tsx src/cli/index.ts pending
```

```
run 2026-08-26T23-28-17Z-cf4a suspended:
  approve-b (gate): Approve B?
  approve-a (gate): Approve A?
```

## Way 1: file-based resume

This is what actually happened under the hood the moment each gate opened —
the engine wrote a **request** file per gate to `<runDir>/pending/`:

```bash
cat .runs/<run-id>/pending/approve-a.request.json
```

```json
{
  "kind": "gate",
  "stepId": "approve-a",
  "runId": "<run-id>",
  "rendered": "Approve A?",
  "answerSchema": {
    "type": "object",
    "properties": {
      "decision": { "type": "string", "enum": ["approve", "reject"] },
      "notes": { "type": "string" }
    },
    "required": ["decision"]
  },
  "context": { "artifacts": [] },
  "openedAt": "2026-08-26T23:28:17.562Z"
}
```

Clearing it is writing an **answer** file at the sibling path
`<stepId>.answer.json`, shaped to `answerSchema` — by hand, from a script,
from whatever wrote the request in the first place:

```bash
RUN=<run-id>
cat > .runs/$RUN/pending/approve-a.answer.json <<'EOF'
{"decision": "approve", "notes": "looks good"}
EOF
cat > .runs/$RUN/pending/approve-b.answer.json <<'EOF'
{"decision": "reject", "notes": "not yet"}
EOF
npx tsx src/cli/index.ts resume $RUN
```

```
run <run-id> finished: ok
```

Both gates cleared in one `resume` call — it reads every currently-open
request from the journal, not just one, and answers whichever already have
an answer file sitting next to them. Each gate's own artifact records
exactly what was decided:

```bash
cat .runs/$RUN/artifacts/decision-a.json   # {"decision":"approve","notes":"looks good"}
cat .runs/$RUN/artifacts/decision-b.json   # {"decision":"reject","notes":"not yet"}
```

A gate answered `reject` doesn't fail the run — `decision` is just data on
an artifact. What a `reject` *does* is a downstream step's own choice, via
`skipIf` reading that artifact (see
[human-gated-release](./human-gated-release) for that wiring). Leave an
answer file missing or malformed, and `resume` throws — the message names
which step and why — and the run stays suspended, untouched, ready to
retry once you fix it.

## Way 2: `--interactive`

Same workflow, but prompted inline instead of exiting to resume later:

```bash
npx tsx src/cli/index.ts run test/workflows/gate-multi.yaml --interactive
```

```
Approve A?

decision [approve/reject]: approve
notes (optional, blank to skip): looks good

Approve B?

decision [approve/reject]: approve
notes (optional, blank to skip): lgtm
run <run-id> finished: ok
```

One invocation answered both — `--interactive` walks every open gate in
the *workflow's declaration order* (`approve-a` then `approve-b`), not
whatever order the scheduler happened to open them in, so a multi-gate
round always prompts the same way twice in a row.

Nothing here is a different suspend mechanism — `--interactive` still
suspends and still writes the same request files; it just immediately
prompts for the answer and writes the answer file itself, then calls
`resume` for you in-process. With stdin closed (a script, CI, no terminal
attached), it doesn't hang — it suspends exactly like the non-interactive
path, so the same run started unattended is always safe to pick up later
with a hand-written answer file.

## The two ways, side by side

| | `--interactive` | file-based `resume` |
|---|---|---|
| When | you're at the terminal right now | later, by you or something else |
| Answers written by | the CLI, from your typed input | whoever/whatever writes `<stepId>.answer.json` |
| Multiple open gates | prompted in declaration order, one call | one `resume` clears every answered gate at once |
| No terminal attached | suspends instead of hanging | (this *is* the no-terminal case) |
