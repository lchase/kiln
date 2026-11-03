# yak

**An agentic workflow engine.** *It shaves the yak so you don't.*

**Status:** MVP spec, draft for discussion
**Language:** TypeScript · **Authoring:** YAML · **License intent:** MIT

---

## 1. Thesis

An agentic workflow engine is a **build system whose compilers are nondeterministic**.

Everything follows from that. Build systems already solved the hard parts you keep re-implementing by hand:

| Build system concept | Agentic workflow equivalent |
| --- | --- |
| Target | Step |
| Source / output files | Input / output artifacts |
| Content-addressed cache key | `hash(step def + input artifact contents + prompt version + model)` |
| Incremental rebuild | Resume a run, skipping steps whose inputs didn't change |
| `make -j` | Bounded-concurrency fan-out |
| Build failure | Schema violation, exhausted loop budget, or a gate awaiting a human |

The one thing build systems don't have is **nondeterministic targets that sometimes need to ask you a question**. That is the only genuinely new machinery this project has to invent.

### Design principles

1. **Artifacts are the interface, not conversation.** Steps never see each other's transcripts. They see named, schema-validated files.
2. **The engine owns the loop, not the prompt.** Iteration limits, no-progress detection, and budgets are enforced in code. A prompt that says "stop when done" is not a termination condition.
3. **Context boundaries are declared, not emergent.** Every agent step states what it inherits. Default is nothing.
4. **Suspension is a first-class terminal state.** "I need a human" is a normal outcome, indistinguishable in machinery from "I succeeded."
5. **The graph is data.** The TypeScript DSL emits a serializable IR so a UI, a visualizer, or a YAML frontend can be added later without touching the engine.
6. **Everything on disk, everything greppable.** No hidden state in a database for the MVP.

### Explicit non-goals for MVP

Distributed execution. Multi-tenancy. A server. A visual builder. Cron/scheduling. Cost governance beyond per-run budgets. Multi-role permissions. Agent-to-agent messaging. Vector stores or RAG.

If you need any of these on day one, use Archon or Temporal instead and stop reading.

---

## 1.5 Authoring format: YAML-first

The **IR** is the graph as plain data — the parsed workflow after normalization and defaults. The engine reads only the IR. It never reads your authoring format directly. That indirection is what lets a UI, a YAML file, or an agent all produce runnable workflows later without touching the scheduler.

**The authoring format is YAML.** A published JSON Schema for it gives you editor autocomplete, load-time validation, and — the real payoff — safe agent authoring. Claude can write and edit a schema-validated YAML file far more reliably than a TypeScript module it has to typecheck and import.

Predicates and pure functions are **named references**, never inline code:

```yaml
- id: fix-until-green
  loop:
    body: [implement, test]
    until: "test-result.exitCode == 0"       # expression language
    budget:
      maxIterations: 5
      noProgress: { signal: "test-result.failureCount", rounds: 2 }
    onExhausted: suspend
    freshContext: true

- id: rank
  transform:
    fn: rankAndDedupe                        # resolves to .yak/transforms.ts
    needs: [findings]
    produces: ranked-findings
```

The expression language is deliberately tiny (jexl or CEL — comparisons and field access on artifacts, nothing more). Anything it can't express becomes a named function in `.yak/predicates.ts` or `.yak/transforms.ts`, which keeps the YAML declarative and the logic unit-testable:

```yaml
until: { fn: testsPassAndNoRegressions }
```

The TypeScript snippets throughout §3 describe **the shape of the IR**, not what you type. Read them as the data model.

---

## 2. Layer boundaries

```
┌───────────────────────────────────────────────────────┐
│  Frontends (MVP: CLI only)                            │
│  later: web form, Slack, GitHub comment               │
└──────────────────────────┬────────────────────────────┘
                           │ reads/writes .runs/<id>/
┌──────────────────────────▼────────────────────────────┐
│  Engine                                               │
│  scheduler · artifact store · journal · cache ·       │
│  budget enforcement · suspension                      │
└──────────────────────────┬────────────────────────────┘
                           │ AgentAdapter interface
┌──────────────────────────▼────────────────────────────┐
│  Adapters                                             │
│  claude-code (Agent SDK) · mock · [codex, later]      │
└───────────────────────────────────────────────────────┘
```

The `AgentAdapter` seam is load-bearing. It is what keeps you from being a Claude Code wrapper, and the `mock` adapter is what lets you test graph logic without burning tokens.

---

## 3. Core concepts

### 3.1 Artifact

A named, typed, immutable-per-run value on disk.

```
.runs/<run-id>/artifacts/plan.json
.runs/<run-id>/artifacts/test-output.txt
.runs/<run-id>/artifacts/review-findings.json
```

- Declared with a Zod schema in the workflow.
- Written only by the step that declares `produces`.
- Validated on write. Invalid → schema repair loop (§3.5) → then hard fail.
- Content-hashed. The hash participates in downstream cache keys.
- Large blobs (diffs, logs) stored as files, referenced by path in JSON artifacts.

**Rule:** if a value flows between steps and isn't an artifact, it's a bug.

### 3.2 Step

```ts
type Step = {
  id: string
  needs: string[]            // artifact names
  produces: string           // artifact name
  kind: 'agent' | 'command' | 'transform' | 'gate'
  // ...kind-specific fields
}
```

Four kinds in the MVP:

**`agent`** — spawn a fresh coding-agent session.

```ts
agent({
  id: 'plan',
  needs: ['issue'],
  produces: 'plan',
  schema: PlanSchema,
  context: 'fresh',                       // or { inherit: ['issue'] }
  tools: ['Read', 'Grep', 'Glob'],        // deny-by-default
  model: 'default',                       // or override per step
  prompt: ({ issue }) => `...`,
})
```

**`command`** — deterministic shell. No AI.

```ts
command({
  id: 'test',
  needs: ['patch'],
  produces: 'test-result',
  run: 'npm test',
  captureExitCode: true,     // exit != 0 is data, not necessarily failure
})
```

**`transform`** — pure JS over artifacts. Dedupe, filter, rank, reshape. Keeps agents out of glue work they'd do badly and expensively.

```ts
transform({
  id: 'dedupe',
  needs: ['findings'],
  produces: 'unique-findings',
  fn: ({ findings }) => uniqBy(findings, f => `${f.file}:${f.line}`),
})
```

**`gate`** — request human input, then suspend.

```ts
gate({
  id: 'approve-plan',
  needs: ['plan'],
  produces: 'plan-decision',
  schema: z.object({
    decision: z.enum(['approve', 'revise', 'abort']),
    notes: z.string().optional(),
  }),
  render: ({ plan }) => `Approve this plan?\n\n${plan.summary}`,
})
```

### 3.3 Combinators

**`map`** — fan out over a list artifact, bounded concurrency, per-item isolation.

```ts
map({
  id: 'review-files',
  over: 'changed-files',
  concurrency: 8,
  produces: 'per-file-findings',      // array of the sub-step's output
  isolation: 'worktree',              // or 'none'
  step: (file) => agent({ /* ... */ }),
})
```

Partial failure policy is explicit: `onItemFailure: 'skip' | 'fail' | 'retry'`. Failed items land in the output array as `null` with a sidecar error record — never silently dropped.

**`loop`** — wrap a subgraph with a termination condition and a budget. The effective cap is `min(concurrency, global concurrency)`. When that cap is 1 (the default, or a higher `concurrency` clipped by a global cap of 1) the body runs in declared order. When the cap is greater than 1, body steps whose inputs don't come from an earlier sibling run in parallel, and a step may start before an earlier sibling it does not depend on while that sibling is still waiting.

```ts
loop({
  id: 'fix-until-green',
  body: [implementStep, testStep],
  until: ({ 'test-result': r }) => r.exitCode === 0,
  budget: {
    maxIterations: 6,
    maxTokens: 2_000_000,
    noProgress: {
      signal: ({ 'test-result': r }) => r.failureCount,
      rounds: 2,                       // 2 rounds of no improvement → stop
    },
  },
  onExhausted: 'suspend',              // or 'fail' | 'continue'
  freshContext: true,                  // new session each iteration
})
```

`onExhausted: 'suspend'` is the good default. A loop that ran out of budget is exactly the situation where a human should be asked, not where the run should silently report success. **This is the single most important thing the engine does that a prompt cannot.**

### 3.4 Context boundary

Every `agent` step declares one of:

- `context: 'fresh'` — new session, prompt built from the template + declared inputs. **Default.**
- `context: { inherit: ['plan', 'prior-findings'] }` — artifacts inlined into the prompt.
- `context: { session: 'prior-step-id' }` — resume that step's session. Escape hatch; discouraged; the engine warns when a chain exceeds 3.

There is deliberately no way to pass a full transcript forward. That is the context-rot fix, and making it awkward is the point.

### 3.5 Schema repair loop

When an `agent` step returns output that fails its Zod schema:

1. Re-prompt in the same session with the validation errors and the schema. Up to `repairAttempts` (default 2).
2. Still failing → step fails with the raw output preserved at `artifacts/.rejected/<step>.<n>.txt`.

Repair attempts count against the run's token budget and appear in the journal. Never silent.

### 3.6 Interaction policy

**An `agent` step has no channel to ask the human a question.** This is the most opinionated rule in the spec and the one that does the most work.

When an agent would otherwise ask, there are only two real situations, and they get different machinery:

| Situation | Why it happens | Machinery |
| --- | --- | --- |
| **Genuine decision** — scope, tradeoff, priority, permission to push | Only the human holds the information | `gate` at a declared point in the graph |
| **Missing info or missing verifier** — "which file did you mean?", "is this the right approach?" | The step lacks context, or has no way to check its own work | A retrieval step earlier in the graph, or `loop` with an eval predicate |

A step that can't proceed **fails with a typed reason**:

```ts
type StepFailure = {
  reason: 'needs-decision' | 'needs-context' | 'schema-invalid'
        | 'budget-exhausted' | 'tool-denied' | 'adapter-error'
  detail: string
  recoverable: boolean
}
```

The workflow routes `needs-decision` to a gate and everything else to a repair loop or a hard stop. Forcing that routing to be declared is the point: "why is this thing asking me?" gets answered at design time instead of at 11pm.

**Genuinely interactive procedures** — a Socratic doc review, a guided PRD interview — are not an exception. They're `loop(agent → gate)` with a turn cap:

```yaml
- id: grill
  loop:
    body: [ask, answer]        # ask = agent, answer = gate
    until: "ask.satisfied == true"
    budget: { maxIterations: 12 }
    onExhausted: continue
```

No new primitive. A named `interview` combinator is worth adding later as sugar over exactly this.

---

## 4. Execution model

### 4.1 Run directory

```
.runs/2026-08-08T14-03-11Z-a3f9/
  workflow.json          # frozen IR of the graph as executed
  journal.jsonl          # append-only event log — source of truth
  artifacts/
    issue.json
    plan.json
    ...
  pending/
    approve-plan.request.json    # written by a gate
    approve-plan.answer.json     # written by any frontend
  sessions/
    plan.jsonl           # raw adapter transcript, for debugging only
  cache/                 # symlinks/hardlinks into the global cache
```

`.runs/` is gitignored by default. A `--publish` flag copies selected artifacts into a committed `.workflow-artifacts/` directory for PR review.

### 4.2 Journal

Append-only JSONL. Every event: `step.started`, `step.completed`, `step.failed`, `artifact.written`, `budget.consumed`, `gate.opened`, `gate.answered`, `loop.iteration`, `run.suspended`, `run.finished`.

The journal is the only durable state. Resume replays it. The TUI tails it. Observability is a `tail -f`, not an integration.

### 4.3 Scheduling

1. Topologically sort the IR.
2. Any step whose `needs` are all satisfied is eligible.
3. Run eligible steps concurrently up to a global `concurrency` cap (default 4; agent steps are memory- and rate-limit-hungry).
4. On step completion, write artifact → validate → journal → re-evaluate eligibility.

Cycles in the static graph are rejected at load time. Iteration only comes from `loop`, which is a bounded combinator, not a back edge. **The graph is acyclic by construction — that's how you make "loops can't spiral" a type-level guarantee rather than a prompt instruction.**

### 4.4 Cache and resume

Two keys per step, stored separately:

```
semanticKey   = sha256(step id + input artifact hashes + adapter id + model id)
definitionKey = sha256(prompt file contents + tools + schema + budget + engine version)
```

Default (`cache: strict`): a mismatch on either key re-runs the step and everything downstream.

`cache: loose` on a step reuses the artifact when only the `definitionKey` moved, and marks it `stale: true` in the journal and in `yak status`. Useful for cosmetic prompt edits; visible rather than silent.

Two supporting rules:

- **Prompts live in their own `.md` files**, referenced by path. `git blame` and PR review then work on prompts, and only the steps that reference a changed prompt invalidate.
- **Never interpolate churn** — dates, run ids, hostnames, absolute paths — into a prompt template. It poisons `definitionKey` on every run. Artifact values interpolated into a prompt are already covered by `semanticKey`.

There is deliberately **no global "ignore prompt drift" flag**. The iteration escape hatch is `yak run --from <step-id>`, which is explicit and per-invocation rather than a mode you forget you turned on.

`yak resume <run-id>`:
- Replay journal, mark completed steps.
- For each, recompute the cache key. Match → reuse the artifact. Mismatch → re-run it and everything downstream.
- `command` and `transform` steps are cheap to re-run; `agent` steps are where this pays for itself.

`yak run --from <step-id>` forces re-execution from a point, for iterating on a prompt.

**Contrast worth knowing:** Claude Code's dynamic workflows replay in *agent start order* — cached results stop at the first agent that didn't finish, and everything started after it re-runs even if it completed. Content-addressed caching avoids that class of waste, at the cost of you having to be honest about what a step's inputs actually are.

### 4.5 Suspension and resumption (the gate protocol)

1. A `gate` step (or an exhausted `loop`) writes `pending/<step-id>.request.json`:

```json
{
  "stepId": "approve-plan",
  "runId": "2026-08-08T14-03-11Z-a3f9",
  "rendered": "Approve this plan?\n\n...",
  "answerSchema": { "...JSON Schema..." },
  "context": { "artifacts": ["plan"] },
  "openedAt": "2026-08-08T14:09:02Z"
}
```

2. Engine journals `run.suspended`, prints a resume command, exits **78** (`EX_SUSPEND`).
3. Any frontend writes `pending/<step-id>.answer.json` matching the schema.
4. `yak resume <run-id>` validates the answer, writes it as the gate's output artifact, and continues.

The MVP frontend is `yak run --interactive`, which prompts inline in the terminal instead of exiting. Same protocol underneath — the interactive path just writes both files itself.

**This is the piece that fixes "I'm the glue."** A workflow becomes hands-free where it can be and precisely interruptive where it can't, and the interruption point is a file that Slack, a web form, or a GitHub comment can satisfy later without the engine knowing they exist.

---

## 5. Adapter interface

```ts
interface AgentAdapter {
  id: string
  run(req: {
    prompt: string
    systemPrompt?: string
    tools: string[]
    cwd: string
    model?: string
    schema?: JSONSchema
    sessionId?: string          // resume a prior session
    signal: AbortSignal
  }): Promise<{
    output: unknown            // parsed if schema given, else string
    sessionId: string
    tokens: { input: number; output: number }
    filesChanged: string[]
    stopReason: 'complete' | 'max_turns' | 'error' | 'aborted'
  }>
}
```

MVP implementations:

- **`claude-code`** — wraps the Claude Agent SDK `query()`. Maps `tools` to the SDK's `tools` option (the availability allowlist, not the approval-only `allowedTools`), `schema` to structured output, streams messages into `sessions/<step>.jsonl`. `permissionMode` is a fixed `bypassPermissions` engine-wide (no per-step IR field) — the only mode that needs no `canUseTool` callback, since agent steps have no channel to ask a human (§3.6). `tools` genuinely restricts what the model can call independent of `permissionMode`; only `allowedTools`, which yak doesn't use for this purpose, is nullified by `bypassPermissions`.
- **`mock`** — reads canned responses from a fixtures directory keyed by step id. Makes the whole test suite deterministic and free. **Build this second, before the real adapter, not last.**

Later: `codex-cli`, `openai-agents`.

### 5.1 Sandbox and permission boundary

**The boundary is the container, not the permission prompt.**

Narrow tool allowlists are the wrong tool here. Headless runs have nobody to ask, so an unlisted tool becomes either a silent capability loss or a stalled run. Instead:

- Agent steps execute inside a container (or, minimally, a worktree plus an OS sandbox profile) with the filesystem scoped to the worktree and network egress on an allowlist.
- **Inside** that boundary, permissions are broad. Denials should be rare, which is what makes `tool-denied` → hard fail (§9, #7) a useful signal rather than a constant nuisance.
- A `PreToolUse`-style hook still blocks reads of `.env` and credential paths regardless of permission mode. Belt and braces — verify the ordering guarantee against current Agent SDK docs before relying on it.

**Companion rule — escaping side effects belong to the engine, not the agent:**

| Effect | Owner |
| --- | --- |
| Read, edit, run tests, build, lint, local git commit | Agent step, inside the sandbox |
| `git push`, `gh pr create`, Slack post, deploy, any shared-state mutation | `command` step, run by the engine outside the sandbox, gated |

The agent produces a patch; the engine pushes it. This keeps "the agent has full permissions" and "the agent cannot do anything irreversible" simultaneously true. Any step kind that violates this table is a design bug.

---

## 6. CLI surface (MVP)

```
yak run <workflow> [--input k=v] [--interactive] [--isolation worktree] [--from <ref>] [--tag <string>]
yak resume <run-id>
yak status [<run-id>]          # what's running, what's pending a human
yak pending                    # every run across the repo awaiting input
yak graph <workflow>           # emit Mermaid
yak artifacts <run-id>         # list + cat artifacts
yak replay <run-id> --from <step-id>
```

`yak pending` is the daily-driver command: one place that answers "what is waiting on me?"

`yak run` prints `run <run-id> started` (and, under `--isolation worktree`, the branch `yak/<run-id>`) to **stderr** the moment `run.started` is journalled, before any step runs — so an out-of-process launcher can capture the id without waiting for a terminal state. stdout carries only the terminal-state line.

`--from <ref>` is valid only with `--isolation worktree`. The ref is resolved with `git rev-parse --verify <ref>^{commit}` before the run starts; an unknown ref errors and creates no worktree and no run. The resolved commit is stored on `run.started` as `worktreeBase`, and resume reuses that commit without resolving the ref again. Omit `--from` to fork from `HEAD`. Map item worktrees are unchanged: they still fork from the run worktree.

---

## 7. Reference workflow (the acceptance test)

Port your existing defect-fix process. If this doesn't feel better than doing it by hand, the project has failed.

```ts
export default workflow('fix-defect', {
  input: z.object({ issueRef: z.string() }),
  steps: [
    agent({ id: 'triage', needs: ['input'], produces: 'triage',
            schema: TriageSchema, tools: ['Read','Grep','Glob'] }),

    gate({ id: 'confirm-scope', needs: ['triage'], produces: 'scope-decision',
           schema: z.object({ decision: z.enum(['proceed','narrow','abort']),
                              notes: z.string().optional() }),
           skipIf: ({ triage }) => triage.confidence > 0.85 }),   // hands-free when obvious

    agent({ id: 'plan', needs: ['triage','scope-decision'], produces: 'plan',
            schema: PlanSchema }),

    loop({
      id: 'implement',
      body: [
        agent({ id: 'code', needs: ['plan','test-result'], produces: 'patch',
                tools: ['Read','Edit','Write','Bash'], context: 'fresh' }),
        command({ id: 'test', needs: ['patch'], produces: 'test-result',
                  run: 'npm test', captureExitCode: true }),
      ],
      until: ({ 'test-result': r }) => r.exitCode === 0,
      budget: { maxIterations: 5,
                noProgress: { signal: r => r.failureCount, rounds: 2 } },
      onExhausted: 'suspend',
    }),

    map({ id: 'review', over: 'changed-files', concurrency: 5,
          produces: 'findings', step: f => agent({ /* reviewer */ }) }),

    transform({ id: 'rank', needs: ['findings'], produces: 'ranked-findings',
                fn: rankAndDedupe }),

    gate({ id: 'approve-pr', needs: ['ranked-findings','plan'],
           produces: 'pr-decision', schema: ApprovalSchema }),

    command({ id: 'open-pr', needs: ['pr-decision'], produces: 'pr-url',
              skipIf: ({ 'pr-decision': d }) => d.decision !== 'approve',
              run: 'gh pr create --fill' }),
  ],
})
```

Note what this buys you over the same thing as a skill: the loop cannot exceed 5 iterations, the reviewers never pollute the implementer's context, `confirm-scope` self-skips when triage is confident, `open-pr` never fires unless the human actually approved, and if you close your laptop during the review fan-out, `yak resume` picks up without redoing the implementation.

---

## 8. Milestones

| M | Scope | Done when |
| --- | --- | --- |
| **M0** | IR, loader, topo-sort, artifact store, journal, `command` + `transform`, resume + content cache | A pure-shell workflow (lint → test → build) runs, resumes, and skips cached steps. **Zero AI.** |
| **M1** | `mock` adapter, `agent` step, Zod validation, schema repair | The reference workflow runs end to end against fixtures, deterministically, in CI. |
| **M2** | `claude-code` adapter via Agent SDK, token accounting, per-step tools/model | The reference workflow runs for real on one actual defect. |
| **M3** | `loop` with budgets + no-progress, `map` with concurrency and failure policy | The implement loop terminates correctly on both success and exhaustion. |
| **M4** | `gate`, suspend/resume protocol, `yak pending`, `--interactive` | You can close the laptop mid-run and answer the question tomorrow. |
| **M5** | Worktree isolation, `yak graph`, journal-tailing TUI | Five runs in parallel with no file conflicts. |

M0 having **zero AI in it** is deliberate. If the engine can't reliably cache, resume, and journal a boring shell pipeline, adding nondeterministic steps will only hide the bugs.

Realistic sizing: M0–M2 is a long weekend if you're fluent in the ecosystem. M3–M4 is where the real design work is.

---

## 9. Decisions

### Resolved

1. **Language: TypeScript.** Richest Agent SDK surface, matches the skills ecosystem, concepts transfer to Archon.
2. **Authoring: YAML-first**, with a constrained expression language and named-function escape hatches. See §1.5. The IR stays a separate concept so a UI or agent-authoring path can be added later.
3. **Artifacts: gitignored by default**, with `--publish` for selective promotion into `.workflow-artifacts/`. Revisit when the eval corpus question (§9 open, #5) comes up — the two are coupled.
4. **Prompt versioning: two-tier cache keys**, prompts in separate `.md` files, no global drift flag. See §4.4.
5. **No `skill()` step kind in the MVP.** Skills are one source of prompt text among several (inline YAML, a `.md` file, a `SKILL.md`). Treat `SKILL.md` as a prompt file the loader can read — that's a resolver detail, not a step kind. What actually matters is the interaction policy in §3.6.

### Resolved — round two

6. **Failure is opt-in per step.** Default `failOn: 'exitCode'` (a failing `gh pr create` must stop the run). Steps feeding a loop predicate declare `failOn: 'never'`, making the exit code data. **Loader-enforced:** if any predicate or downstream step reads `<step>.exitCode` while that step still has `failOn: 'exitCode'`, that's a load-time error.

7. **Sandbox-first permissions.** Broad permissions inside a scoped container; `tool-denied` is a hard fail. Escaping side effects are engine-run `command` steps, not agent tools. See §5.1.

8. **Clean runs by default.** Worktree and branch names encode the run id, not just the issue id, so concurrent runs of the same workflow on the same input can't clobber each other. `--continue-from <run-id>` opts into artifact reuse.

9. **Budget ceilings suspend, not fail.** A run that hit a token or dollar cap is by definition a decision only the human can make. Same reasoning as `onExhausted: 'suspend'`.

10. **Eval corpus: export path descoped from M4, not built.** M4's map (`.scratch/yak-m4/map.md`) ruled `yak export --evals` out of scope, and the post-M5 gaps map (`.scratch/yak-post-m5/map.md`) confirmed that scoping rather than reopening it — this is a future candidate, not a live decision. `.runs/` stays gitignored in the meantime, so gate answers, schema repairs, and loop exhaustions from every run before this ships are lost to the eval corpus permanently.

    If built: `yak export --evals` would write normalized JSONL to a committed `.yak/evals/` — one record per gate answer, schema repair, and loop exhaustion, storing hashes and the verdict rather than raw prompts and artifacts.

    **Design goal this unlocks: gates should be demotable.** Once a gate has enough labeled examples, write a check step that predicts the verdict, run it in shadow mode beside the real gate, and promote it to `skipIf` when agreement holds. This is the mechanism by which a workflow becomes progressively more hands-free instead of permanently needing a human at the same six points.

11. **Workflow discovery:** `.yak/workflows/` in-repo, `~/.yak/workflows/` for personal. **Repo wins on name collision.**

12. **`skipIf` lives on `BaseStep`, not just `gate`.** Surfaced by the yak cookbook map's human-gated-release pattern (`.scratch/yak-cookbook/issues/05-pattern-gate-release.md`): nothing let a downstream step conditionally not-run off a prior gate's answer — this very reference workflow's `open-pr` step had exactly that gap until §7 was updated to match. `command`/`transform`/`agent` steps now skip outright (no artifact, no cache write) when the expression is true; `gate` keeps its original skip-the-pause-and-auto-answer behavior unchanged.

### Naming

**`yak`.** From *yak shaving* — the chain of unrelated prerequisite tasks standing between you and the thing you actually sat down to do. That chain is precisely what this engine automates, and its recursive nature is why `maxIterations` exists.

Tagline disambiguates the direction: *it shaves the yak so you don't.*

Bare npm names in this space are almost universally squatted; publish scoped (`@you/yak`) and keep `yak` as the binary. Category collisions were the real filter — `gofer`, `golem`, `mule`, `doit`, and `intern` were all ruled out for colliding with existing tools in or near this category.

---

## 10. Honest kill criteria

Stop and adopt something existing if:

- **Archon's YAML covers the reference workflow with acceptable ergonomics.** It already has bounded loops, `interactive: true` gates, bash nodes, and worktree isolation. Run your real defect through it before writing M0.
- **You need waits measured in days, or multiple people participating.** Put Temporal / DBOS / Restate underneath rather than building a scheduler, and keep only the step-contract layer as your own code.
- **You find yourself building a UI in month two.** That's the signal that the workflows are not actually hands-free and the gate design needs rethinking, not a dashboard.

The parts of this spec that are genuinely yours and worth keeping under any outcome: **the step contract, the artifact protocol, the loop budget object, and the suspension file format.** Those four are portable across every engine mentioned. Everything else is replaceable.

---

## 11. Project coordinates

| | |
| --- | --- |
| Repo | `github.com/lchase/yak` |
| npm package | `@lchase/yak` (publish with `--access public`) |
| Binary | `yak` — declared via `bin`, independent of the scoped package name |
| Docs | README until M4; no domain purchase before the engine survives its bake-off |

---

## 12. Repo scaffold

```
yak/
├── package.json
├── tsconfig.json
├── CLAUDE.md                     # see §15
├── src/
│   ├── cli/
│   │   ├── index.ts              # commander entrypoint
│   │   └── commands/             # run.ts resume.ts status.ts pending.ts graph.ts artifacts.ts
│   ├── ir/
│   │   ├── types.ts              # §13 — the data model, write this first
│   │   ├── load.ts               # YAML -> raw
│   │   ├── normalize.ts          # defaults, desugaring
│   │   └── validate.ts           # schema + static checks (incl. the failOn/exitCode rule)
│   ├── engine/
│   │   ├── scheduler.ts          # topo sort, eligibility, concurrency
│   │   ├── journal.ts            # append-only JSONL, replay
│   │   ├── artifacts.ts          # read/write/validate/hash
│   │   ├── cache.ts              # semanticKey / definitionKey
│   │   ├── budget.ts             # iteration, token, no-progress
│   │   └── suspend.ts            # gate request/answer protocol
│   ├── steps/
│   │   └── command.ts transform.ts agent.ts gate.ts map.ts loop.ts
│   ├── adapters/
│   │   └── types.ts mock.ts claude-code.ts
│   ├── expr/
│   │   └── eval.ts               # jexl wrapper + { fn } resolution
│   └── util/
│       └── hash.ts fs.ts git.ts
├── test/
│   ├── fixtures/                 # canned adapter responses for the mock
│   └── workflows/                # test workflow YAML
└── .yak/                         # this repo's own workflows, dogfooded
    ├── workflows/
    ├── prompts/
    ├── predicates.ts
    └── transforms.ts
```

### Dependencies

| Purpose | Pick | Why |
| --- | --- | --- |
| Runtime | Node 22 LTS + `tsx` (dev), `tsup` (build) | Broadest install base for a CLI others will consume. Bun is faster and is what Archon uses — swap if you don't care about non-Bun users. |
| YAML | `yaml` (eemeli) | Comment-preserving round-trip; you'll want that when a UI or agent edits workflows. |
| Schemas | `zod` + `zod-to-json-schema` + `ajv` | Zod for named-ref (`.yak/schemas.ts`) artifact validation and JSON Schema generation for the adapter; `ajv` validates inline (`{ inline: JSONSchema }`) schemas directly — structural only, no coercion/transform. |
| Expressions | `jexl` | Tiny, safe, no `eval`. Covers `test-result.exitCode == 0` and little else, which is the point. |
| CLI | `commander` | Boring and ubiquitous. |
| Concurrency | `p-limit` | One primitive, no scheduler framework. |
| Agent | `@anthropic-ai/claude-agent-sdk` | M2 only. Keep behind the adapter interface. |
| Test | `vitest` | Fast, ESM-native. |
| Color | `picocolors` | No `ink` until M5. |

Deliberately absent: an ORM, a queue, a DI container, a state-machine library. The journal is the database and the topo sort is the state machine.

---

## 13. Core types

Write `src/ir/types.ts` first. Everything else is a function over these.

```ts
export type StepId = string
export type ArtifactName = string

/** Either a jexl expression string, or a named function in .yak/predicates.ts */
export type Expr = string | { fn: string }

export interface Budget {
  maxIterations: number
  maxTokens?: number
  maxUsd?: number
  noProgress?: { signal: Expr; rounds: number }
}

export interface BaseStep {
  id: StepId
  needs?: ArtifactName[]
  produces?: ArtifactName
  cache?: 'strict' | 'loose'          // default 'strict'
  skipIf?: Expr                        // command/transform/agent: skip entirely, no
                                        // artifact, no cache write. gate: skip the
                                        // pause, auto-answer from schema defaults.
}

export interface AgentStep extends BaseStep {
  kind: 'agent'
  prompt: { file: string } | { inline: string }
  schema?: string | { inline: JSONSchema }  // key in .yak/schemas.ts (Zod,
                                             // full power), or an inline
                                             // JSON Schema (ajv, structural
                                             // only — no coercion/transform)
  context?: 'fresh' | { inherit: ArtifactName[] } | { session: StepId }
  tools?: string[]
  model?: string
  repairAttempts?: number              // default 2
}

export interface CommandStep extends BaseStep {
  kind: 'command'
  run: string
  cwd?: string
  failOn?: 'exitCode' | 'never'        // default 'exitCode' — see §9 #6
  capture?: ('stdout' | 'stderr' | 'exitCode')[]
}

export interface TransformStep extends BaseStep {
  kind: 'transform'
  fn: string                           // key in .yak/transforms.ts
}

export interface GateStep extends BaseStep {
  kind: 'gate'
  schema: string | { inline: JSONSchema }
  render: { file: string } | { inline: string }
}

export interface MapStep extends BaseStep {
  kind: 'map'
  over: ArtifactName
  step: Step
  concurrency?: number                 // default 4
  isolation?: 'worktree' | 'none'      // default 'worktree'
  onItemFailure?: 'skip' | 'fail' | 'retry'   // default 'skip'
}

export interface LoopStep extends BaseStep {
  kind: 'loop'
  body: Step[]
  until: Expr
  budget: Budget
  concurrency?: number                 // default 1. Effective cap is
                                       // min(concurrency, global). Cap 1 runs
                                       // the body in declared order. Cap > 1
                                       // may let a step overtake an earlier
                                       // not-ready sibling it doesn't depend on
  onExhausted?: 'suspend' | 'fail' | 'continue'   // default 'suspend'
  freshContext?: boolean               // default true
}

export type Step =
  | AgentStep | CommandStep | TransformStep
  | GateStep | MapStep | LoopStep

export interface Workflow {
  name: string
  version: string
  inputSchema?: string | { inline: JSONSchema }   // same SchemaSpec shape as
                                                   // AgentStep/GateStep.schema
  steps: Step[]
}

// `input` is a reserved artifact name. `yak run --input k=v` (repeatable)
// is parsed to an object, validated against `inputSchema` when one is
// declared, and written as `artifacts/input.json` before any step runs —
// so any step may `needs: [input]` without a producer, and no step may
// `produces: input`. Its hash feeds downstream cache keys like any other
// artifact.

export interface StepFailure {
  reason:
    | 'needs-decision' | 'needs-context' | 'schema-invalid'
    | 'budget-exhausted' | 'tool-denied' | 'adapter-error' | 'command-failed'
  detail: string
  recoverable: boolean
}
```

### Journal events

```ts
export type JournalEvent =
  | { t: 'run.started';      runId: string; workflow: string; inputHash: string; adapter: AdapterId
                             isolation: RunIsolation }
  | { t: 'step.started';     stepId: StepId; iteration?: number
                             semanticKey: string; definitionKey: string }
  | { t: 'step.completed';   stepId: StepId; iteration?: number; artifact?: ArtifactName
                             artifactHash?: string; cached: boolean; stale?: boolean; skipped?: boolean }
  | { t: 'step.failed';      stepId: StepId; iteration?: number; failure: StepFailure }
  | { t: 'artifact.written'; name: ArtifactName; hash: string; bytes: number }
  | { t: 'budget.consumed';  stepId: StepId; tokens: number; usd?: number }
  | { t: 'loop.iteration';   stepId: StepId; n: number; signal?: unknown }
  | { t: 'map.item.retried'; mapStepId: StepId; itemIndex: number; attempt: number; error: string }
  | { t: 'gate.opened';      stepId: StepId; requestPath: string }
  | { t: 'gate.answered';    stepId: StepId; skipped?: boolean }
  | { t: 'run.suspended';    reason: 'gate' | 'budget' | 'exhausted'
                             loopStepId?: StepId; iteration?: number
                             tripped?: 'maxIterations' | 'maxTokens' | 'noProgress' }
  | { t: 'run.finished';     status: 'ok' | 'failed' | 'suspended' }

// every event also carries: { at: string /* ISO */, runId: string }
```

### Engine loop

```
load YAML -> normalize -> validate (reject cycles, failOn contradictions)
freeze IR to .runs/<id>/workflow.json
replay journal (resume only) -> completed set

while eligible steps remain:
  eligible = steps whose `needs` are all satisfied and not yet completed
  take up to `concurrency`, run in parallel:
    compute semanticKey + definitionKey
    if cached and keys match (or cache:loose and only definitionKey moved):
        emit step.completed{cached:true}; continue
    execute by kind
    on success: validate artifact -> write -> hash -> journal
    on gate:    write pending request -> journal gate.opened -> mark run suspended
    on failure: journal step.failed -> abort or route per policy

if suspended: print resume command, exit 78
else exit 0 / 1
```

---

## 14. M0 task list

M0 has **zero AI**. If the engine can't cache and resume a boring shell pipeline, adding nondeterministic steps will only hide the bugs.

| # | Task | Done when |
| --- | --- | --- |
| 1 | `src/ir/types.ts` | Compiles. No logic yet. |
| 2 | `src/ir/load.ts` + `normalize.ts` | A YAML file parses into a `Workflow` with defaults applied. |
| 3 | `src/ir/validate.ts` | Rejects: unknown step kinds, duplicate ids, missing `needs` producers, cycles, and a step read via `.exitCode` while `failOn: 'exitCode'`. Each has a test. |
| 4 | `src/util/hash.ts` + `engine/artifacts.ts` | Write, read, hash, and Zod-validate an artifact on disk. |
| 5 | `engine/journal.ts` | Append events; replay a journal into a completed-set. |
| 6 | `engine/cache.ts` | Both keys computed; `strict` and `loose` behave per §4.4. |
| 7 | `steps/command.ts` + `steps/transform.ts` | Shell exec with capture; named transform resolution. |
| 8 | `engine/scheduler.ts` | Topo sort + `p-limit` concurrency + wiring 4–7 together. |
| 9 | `cli/commands/run.ts`, `resume.ts`, `status.ts` | The acceptance test below passes. |

### M0 acceptance test

`test/workflows/ci.yaml`:

```yaml
name: ci
version: "1"
steps:
  - id: install
    command: { run: "npm ci" }
    produces: install-result

  - id: lint
    needs: [install-result]
    command: { run: "npm run lint", capture: [stdout, exitCode], failOn: never }
    produces: lint-result

  - id: test
    needs: [install-result]
    command: { run: "npm test", capture: [stdout, exitCode], failOn: never }
    produces: test-result

  - id: summarize
    needs: [lint-result, test-result]
    transform: { fn: summarizeChecks }
    produces: summary
```

Three behaviors must hold:

1. **Cache** — `yak run ci.yaml` twice; the second run reports every step `cached: true` and finishes in under a second.
2. **Invalidation** — touch a source file, re-run; `install` stays cached, `lint` and `test` re-run, `summarize` re-runs.
3. **Resume** — `SIGINT` during `test`; `yak resume <run-id>` reuses `install` and `lint`, re-runs only `test` and `summarize`.

`lint` and `test` run concurrently — that's the fan-out path exercised without needing `map` yet.

---

### Dogfooding note

Once M0 passes, put `ci.yaml` in this repo's own `.yak/workflows/` and use `yak` to run yak's CI. Every ergonomic problem you'd otherwise discover in month three shows up in week one.
