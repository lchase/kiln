# yak

An agentic workflow engine. Reads a YAML DAG, runs steps (shell commands,

pure transforms, coding-agent invocations, human gates), and journals

everything to disk so runs resume exactly where they stopped.

## Mental model

This is a build system whose compilers are nondeterministic. Steps are

targets, artifacts are files, cache keys are content hashes, resume is

incremental rebuild. When unsure how something should behave, ask what

Make or Bazel would do.

## Invariants — do not violate without discussing first

- The graph is acyclic. Iteration comes only from the `loop` combinator,

  which is bounded by a budget. Never add back edges.

- Steps communicate only through named, schema-validated artifacts on disk.

  Never pass transcripts or in-memory objects between steps.

- Agent steps have no channel to ask the human anything. If a step cannot

  proceed it fails with a typed `StepFailure`; the workflow routes it.

- Side effects that escape the sandbox (push, PR, deploy) are `command`

  steps run by the engine, never agent tools.

- The journal is the only durable state. No database.

## Conventions

- TypeScript, ESM, Node 22. `vitest` for tests.

- No `any`. Parse at the boundary with zod, then trust the types.

- Every engine behavior gets a test using the `mock` adapter — never a

  test that calls a real model.

## Current milestone

M0: engine core with zero AI. See §14 of the spec.

