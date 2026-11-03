---
sidebar_position: 0
title: Install & setup
---

# Install & setup

How to actually get `yak` running on your machine, and what you need in
your environment before an agent step will work.

## Prerequisites

- Node 22+
- git

## From source (the real path today)

`yak` isn't published to npm yet (see [Published package](#published-package-not-yet-live)
below), so this is the only working install path right now — the same
one every other page on this site uses.

```bash
git clone git@github.com:lchase/yak.git
cd yak
npm ci
```

Run the CLI straight from source with `tsx`, no build step:

```bash
npx tsx src/cli/index.ts --help
```

```
Usage: yak [options] [command]

An agentic workflow engine

Commands:
  run [options] <workflow>   Run a workflow YAML file
  resume [options] <run-id>  Resume an interrupted run
  status [run-id]            Report a run's per-step status
  pending                    List every run across the repo awaiting a human answer
  graph <workflow>           Emit a workflow's DAG as Mermaid to stdout
  watch [run-id]             Live-tail a run's step statuses in a terminal UI
  artifacts [run-id]         List a map step's per-item artifact files for a run
```

`npx tsx src/cli/index.ts <command>` is what the [tutorial](./tutorial)
and pattern pages invoke throughout — it's the literal CLI entry point
(`src/cli/index.ts`), no indirection. The [quickstart](./quickstart)
uses `npm run dev -- <command>` instead; that's the same thing, `dev`
is just a `package.json` script alias for `tsx src/cli/index.ts`. Use
whichever you prefer, they're identical.

Once you've got it running, head to the [quickstart](./quickstart) for
a free, no-auth run against the `mock` adapter.

## Published package (not yet live)

`@lchase/yak` is reserved on npm but not published — the section below
describes the intended shape once it ships, not something that works
today. When it does, the CLI resolves to a `yak` binary (per
`package.json`'s `bin` field):

```bash
# once published
npm install -g @lchase/yak
yak run my-workflow.yaml

# or without installing globally
npx @lchase/yak run my-workflow.yaml
```

Until then, use the from-source steps above.

## Adapter auth

Which environment variables you need depends entirely on which
`--adapter` you pass to `yak run`:

- **`mock`** — no auth needed. It returns canned, deterministic
  responses; this is what the [quickstart](./quickstart) uses.
- **`claude-code`** — the real adapter, a real Claude Agent SDK call.
  It needs one of these set in your environment before you run:
  - `ANTHROPIC_API_KEY`, or
  - `CLAUDE_CODE_OAUTH_TOKEN`

  Without one of these set, a `claude-code`-adapter run fails at the
  agent step rather than at startup — set it up front rather than
  discovering it mid-run. The [tutorial](./tutorial) and the
  [human-gated release pattern](./patterns/human-gated-release) both
  use this adapter and spend real API budget.
