---
sidebar_position: 9
title: Web research / lookup
---

import Admonition from '@theme/Admonition';

# Pattern: fan-out research, fan-in report

<Admonition type="caution" title="Spends real API budget">

Like the tutorial, this runs against the real `claude-code` adapter —
three real `WebSearch`/`WebFetch` agent calls, run concurrently.
Assumes you've already read the [quickstart](../quickstart),
[tutorial](../tutorial), and
[fan-out-over-issues](./fan-out-over-issues) (this pattern's `map`
mechanics are identical — the new part is what happens after).

</Admonition>

An `agent` step with `tools: [WebSearch, WebFetch]` can look things up
live — no MCP server, no custom integration, just two built-in tools on
the allowlist. This pattern fans that out over several topics at once
with `map`, then fans back **in**: an ordinary downstream step that
`needs` the whole array and synthesizes it into one HTML report. Fan-in
isn't a distinct primitive in yak — it's just `needs` pointed at a
`map`'s produced artifact.

## The target: `fixtures/web-research`

Three unrelated, generic topics — deliberately unrelated to this repo
or its own dependencies, so the fixture is self-contained and doesn't
need anything outside itself to make sense:

- current adoption trends of the Rust programming language
- recent advances in solid-state batteries for electric vehicles
- the current state of quantum error correction research

## The workflow

```yaml title="fixtures/web-research/workflow.yaml"
name: web-research
version: "1"
steps:
  - id: topics
    transform: { fn: researchTopics }
    produces: topics

  - id: research
    needs: [topics]
    map:
      over: topics
      concurrency: 3
      step:
        id: research-one
        needs: [topics]
        agent:
          prompt:
            inline: >
              Research this topic using WebSearch/WebFetch for current,
              real information — don't rely on memory alone:
              {{topics.topic}}

              Summarize what you find in 2-4 sentences, and list every
              URL you used as a source.
          schema:
            inline:
              type: object
              properties:
                topic: { type: string }
                summary: { type: string }
                sourceUrls: { type: array, items: { type: string } }
              required: [topic, summary, sourceUrls]
          tools: [WebSearch, WebFetch]
    produces: findings

  - id: report
    needs: [findings]
    transform: { fn: renderResearchReport }
    produces: report
```

`topics` is a static, deterministic list — same reasoning as
[fan-out-over-issues](./fan-out-over-issues)'s `issues` step: the point
here is the fan-out/fan-in mechanics, not sourcing the topic list.
`research` fans out over it exactly like that pattern's `map`, three
items running concurrently, each getting the current topic as
`{{topics.topic}}`. No `isolation: worktree` this time — these items
only read the web, nothing edits a file, so there's nothing to isolate
and no need to run the workflow itself with `--isolation worktree`.

`report` is the fan-**in**: a plain `transform` step whose `needs:
[findings]` receives the entire three-item array `research` produced.
Nothing special registers it as a "fan-in step" — it's the same
mechanism any step uses to read any artifact. `fn: renderResearchReport`
resolves against the same fixed `.yak/transforms.ts` every `transform`
step does — see [standalone
transform](./standalone-transform#why-transform-is-its-own-step-kind)
if that's new.

```ts title=".yak/transforms.ts"
export function renderResearchReport(inputs: Record<string, unknown>): unknown {
  const findings = inputs['findings'] as (ResearchFinding | null)[]

  const sections = findings
    .filter((f): f is ResearchFinding => f !== null)
    .map((f) => `<section>
    <h2>${escapeHtml(f.topic)}</h2>
    <p>${escapeHtml(f.summary)}</p>
    <ul>${f.sourceUrls.map((u) => `<li><a href="${escapeHtml(u)}">${escapeHtml(u)}</a></li>`).join('')}</ul>
  </section>`)
    .join('\n')

  return `<!doctype html>...${sections}...`
}
```

The `(ResearchFinding | null)[]` type and the `.filter(f => f !== null)`
aren't defensive boilerplate — they're load-bearing. `map`'s default
`onItemFailure: 'skip'` means a failed item lands as `null` in
`findings`, not a thrown error, so the report has to tolerate a gap the
same way [map onItemFailure](./map-on-item-failure)'s `summarize` step
does.

## Run it

```bash
npx tsx src/cli/index.ts run fixtures/web-research/workflow.yaml --adapter claude-code
```

## The gap this pattern found

Building this exposed a real engine bug, not just a docs gap. The first
real run had one item — the quantum error correction topic, the one
with the longest, most URL-heavy answer — fail outright, and it took
the *whole run* down instead of `onItemFailure: 'skip'` quietly dropping
that one item:

```
Claude Code returned an error result: Failed to provide valid structured output after 5 attempts
```

The other two items had already succeeded by then; the run still died.
The cause: the Claude Agent SDK sometimes reports a structured-output
failure by throwing an error out of its message stream mid-iteration,
not by returning a normal `result` message with
`subtype: 'error_max_structured_output_retries'`. yak's adapter already
mapped that *subtype* to a clean `StepFailure` — but only checked for it
after the `for await` loop finished normally. A mid-stream throw skipped
that mapping entirely and propagated as a plain, unwrapped `Error`,
which `map.ts`'s per-item handling doesn't recognize (it only catches
`AgentStepFailedError`) — so instead of one item being marked
`'failed'` and skipped, the *engine* itself failed.

Fixed in `src/adapters/claude-code.ts`: the `for await` loop over the
SDK's message stream is now wrapped in its own `try`/`catch`, and
anything thrown *during* iteration gets wrapped as
`AgentStepFailedError({ reason: 'adapter-error', recoverable: true })` —
the same typed-failure path every other agent error already goes
through. `query()` throwing outright (a real spawn/infra failure — the
CLI binary missing, bad options) is deliberately left unwrapped; only a
failure *after* the stream started really running is a per-turn failure
eligible for `onItemFailure`/retry treatment. Covered by a new test in
`test/adapters/claude-code.test.ts` distinguishing the two cases.

## What actually happened

After the fix, a re-run succeeded end to end — all three items real,
concurrent `WebSearch`/`WebFetch` calls:

```json title="findings.json (excerpt)"
[
  {
    "topic": "Rust adoption trends",
    "summary": "Rust enterprise adoption rose to 48.8% in 2025, Linux kernel made it permanent core language, big tech expanding use.",
    "sourceUrls": ["https://commandlinux.com/statistics/rust-programming-language-adoption/"]
  },
  {
    "topic": "Recent advances in solid-state batteries for electric vehicles",
    "summary": "GBT pushing mass production of all-solid-state EV cells in 2026, first A-sample cells passing needle penetration, extrusion, and thermal shock tests without fire or explosion. Energy density targets 400-500 Wh/kg now...",
    "sourceUrls": ["https://electrek.co/2026/04/15/solid-state-ev-batteries-coming-sooner-than-expected/", "..."]
  },
  {
    "topic": "Current state of quantum error correction research (2026)",
    "summary": "2026 sees multiple hardware platforms independently demonstrate below-threshold error correction with exponential error suppression as qubit count scales...",
    "sourceUrls": ["https://thequantuminsider.com/2026/06/13/microsoft-and-quantinuum-report-on-major-gains-in-quantum-error-correction/", "..."]
  }
]
```

```
$ npx tsx src/cli/index.ts status <run-id>
run <run-id>:
  topics: cached
  research: completed
  report: completed
```

`report.json` holds the synthesized HTML — one `<section>` per topic,
every claim still carrying its source links, ready to open in a
browser:

```bash
node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.runs/<run-id>/artifacts/report.json')))" > report.html
open report.html
```

## Where this generalizes

Nothing here is specific to research topics. Same shape covers:

- **Multi-source investigation** — fan out over a list of questions or
  data sources, fan in to one synthesized answer.
- **GitHub issue triage** — a `command` step runs `gh issue list --json
  ...` (an escaping side effect belongs in `command`, never an agent
  tool — see [human-gated-release](./human-gated-release)) to produce
  the fan-out list, instead of a static `transform` like this pattern's
  `topics` step.
- **Jira or any other external system with no built-in tool** — a
  `command` step hits the REST API directly (curl + a token from env),
  writes the response as an artifact, and a research agent `needs` it
  alongside its own `WebSearch` findings — no MCP server required for
  this to work today.
