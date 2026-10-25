# Kiln

Kiln runs a workflow against a git checkout. Register any repo, add a job from a markdown spec, a prompt, or a directory of tickets, and tick. Tick launches ready jobs in yak worktrees. Status shows each job. Approve or reject answers a human gate.

A ready spec is the input. Kiln does not build or iterate requirements.

This repository is public. Checkout paths and jobs stay in gitignored `.kiln/` or `~/.kiln/`. Do not commit them.

## Prerequisites

- Node.js >= 22 (the `engines` field in `package.json`)
- git
- Claude Code, installed and logged in, for a real run. `adapter: "mock"` does not call a model.

Each checkout is a git repo with a commit at `HEAD`. `tick` adds a worktree from that commit. Uncommitted files in the checkout are left as they are. The job edits the worktree, on branch `yak/<run-id>`. Kiln does not push.

## Register repos

```bash
npm install
npm run kiln -- repo add web /absolute/path/to/web --test "npm test"
npm run kiln -- repo add api /absolute/path/to/api --test "npm test"
npm run kiln -- repo list
```

`npm run kiln` builds first. `npm run kiln -- repo add` writes `./.kiln/kiln.config.json` (or updates `~/.kiln/kiln.config.json` when that file already exists). A relative path is stored relative to the config file's directory. `~` is expanded from the home directory. `test` is optional on the entry and required before tick can launch a job in that repo.

```json
{
  "repos": {
    "web": { "path": "../web", "test": "npm test" },
    "api": { "path": "~/src/api", "test": "npm test" }
  },
  "maxConcurrent": 2,
  "adapter": "claude-code"
}
```

`repos` is an open map. Any name is allowed. `maxConcurrent` caps how many jobs may be in flight (default 2). `adapter` is `claude-code` (default) or `mock`.

## Add a job

A job is one workflow run. The workflow name is a file `workflows/<name>.yaml`. `feature` is the factory loop. Bug, investigation, and security workflows are next. A later `pr-review` workflow is not in this repo yet.

```bash
npm run kiln -- add feature --repo web --spec spec.md --title "Show a Sunday summary"
npm run kiln -- add feature --repo api --spec api-spec.md --after <job-id>
```

`--title` defaults to the first `#` heading in the spec, then the file name. `--after` may be repeated. Those jobs must already exist. Kiln copies the spec to `.kiln/specs/<id>.md` and writes `.kiln/jobs/<id>.json`:

```json
{
  "id": "j20261025020600ab12",
  "repo": "web",
  "workflow": "feature",
  "spec": "specs/j20261025020600ab12.md",
  "title": "Show a Sunday summary",
  "dependsOn": ["j20261025020500cd34"],
  "source": { "kind": "file", "ref": "/home/dev/specs/sunday.md" },
  "createdAt": "2026-10-25T02:06:00.000Z"
}
```

`dependsOn` is omitted when the job has no `--after`. `source` records which intake created the job. Jobs written before intake omit `source` and still run. State is not stored.

## Intake

Every intake writes the same job: `id`, `repo`, `workflow`, `spec`, `title`, optional `dependsOn`, and `source`. `source` is `{ "kind": "file" | "prompt" | "tickets", "ref": "..." }`. Status prints `source <kind> <ref>` when the job has one. Tick, reconcile, and status do not special-case an intake. The adapters are `src/intake/file.ts`, `src/intake/prompt.ts`, and `src/intake/tickets.ts`.

Jira is the next adapter. It is not implemented here.

### File

```bash
npm run kiln -- add feature --repo web --spec spec.md --title "Show a Sunday summary"
```

This copies the markdown file into the kiln directory. `source.kind` is `file`. `source.ref` is the absolute path of the file that was copied. `--title` defaults to the first `#` heading, then the file name. `--after` may be repeated, and those jobs must already exist.

### Prompt

```bash
npm run kiln -- add feature --repo web --prompt "Show a quiet empty state"
npm run kiln -- add feature --repo api --prompt - < notes.md
```

`--prompt -` reads stdin. The text is stored as that job's spec. The title defaults to the first non-empty line, truncated to 80 characters. `source.kind` is `prompt`. `source.ref` is `inline` for an argument and `stdin` when the prompt is read from stdin. `--title` and `--after` work the same way as file intake. Pass either `--spec` or `--prompt`, not both.

### Tickets

```bash
npm run kiln -- import ./tickets --repo web
npm run kiln -- import ./tickets --repo web --workflow feature --context spec.md --dry-run
```

`import` reads a directory of `NN-slug.md` files, the shape a Matt Pocock-style `/to-tickets` pass writes. Each file starts with `# NN: Title`, a `**What to build:**` paragraph, and a `**Blocked by:**` line. That line is followed by `None…` or by bullets such as `- 01: Probe the unconfirmed platform facts`. Kiln matches the `NN` number to a filename in the same directory (`01` and `1` are the same number). YAML front matter is also accepted, with `title`, `type`, and `blocked-by` (`blocked-by:` as a list, a flow list, or a single number).

One file becomes one job. Blocked-by becomes `dependsOn` on the imported job ids. An unknown number is an error that names the ticket file, and no new job is written.

`--workflow` defaults to `feature`. Kiln switches a ticket to `investigation` only when `workflows/investigation.yaml` exists and the ticket is a spike: front matter `type` is `spike`, `investigation`, or `research` (the word after a colon counts, as in `wayfinder:research`), the title contains spike or probe, or the text says "no product code". A body that only mentions an upstream spike stays on the requested workflow. `investigation` is not in this repo, so a spike ticket stays on the requested workflow and Kiln prints a warning.

`--context` defaults to `spec.md` in the parent of the ticket directory when that file is present. The text is appended to every job spec as a `## Background` section. A context file larger than 40KB is not copied in. The spec names its path instead.

Import is idempotent. The key is the ticket directory plus the filename, stored as `source.ref` (an absolute path) with `source.kind` `tickets`. Running import again on the same directory does not create a second job for a file already imported. The report says how many jobs are new and how many are unchanged. `--dry-run` prints each ticket, its workflow, and its dependencies, and writes nothing.

`examples/spec.md` is a fictional spec you can copy.

## Tick, status, approve

```bash
npm run kiln -- tick
npm run kiln -- status
npm run kiln -- approve <job-id>
npm run kiln -- reject <job-id>
```

`tick` launches at most one ready job and returns. Run it again until nothing is left to launch:

```bash
while true; do npm run kiln -- tick; sleep 30; done
```

A job is ready when every job in `dependsOn` is `done` and the number of jobs in flight is under `maxConcurrent`. A rejected gate does not unblock the next job. An ok run with no readable approval does not either.

`npm run kiln -- status` lists jobs across repos. When a job has `source`, status prints `source <kind> <ref>`. For `needs-human` it prints `approve: kiln approve <id>` and `reject: kiln reject <id>`. Run those as `npm run kiln -- approve <id>` and `npm run kiln -- reject <id>`. For `done` it prints `branch yak/<run-id>` in that repo's checkout. For `blocked` on a dependency id that has no job file, it prints `blocked on missing job <id>`.

State is derived from the yak journal and gate files:

| State | Meaning |
| --- | --- |
| `queued` | Dependencies are done, and the job has not started |
| `blocked` | A dependency is not `done`. A missing job id is named |
| `running` | Yak is alive, or the launch process is alive and has not written a journal |
| `needs-human` | The run is suspended on an open gate |
| `approved` | The gate says approve and the run has not finished. This still holds a slot |
| `rejected` | The run finished ok and the gate says reject |
| `failed` | The run failed, the launch died before a journal, or the run finished ok with no readable approval |
| `dead` | The journal's process is gone. Status prints the cancel command |
| `done` | The run finished ok and the gate says approve. This is the only state that unblocks dependents |

## What a feature job runs

`npm run kiln -- tick` starts `yak run --isolation worktree` in the repo, tagged `kiln:<jobId>`, with logs in `<kiln-dir>/logs/<jobId>.log`. Kiln passes `title`, the spec text as `description` and `acceptance`, `baseRef` (checkout `HEAD` at launch), and `runNonce`. The test command is `KILN_TEST`.

The job runs the factory loop from Lawrence Chase's factory plugin v0.7.0 (MIT), copied from commit `4c84a2ce7fbde5ac298c0de9f0b90141eac4ed98`: spec, then up to two rounds of build, verify, and the security, ux, ui, and code reviewers, then the approver, a human gate, and a commit. The prompts in `prompts/factory/` are those agent files, copied verbatim. `prompts/kiln/` maps the factory's job-folder files onto the artifacts yak passes in. `npm run kiln -- tick` writes a per-run copy of the workflow under the kiln directory, with absolute prompt paths, before it starts yak.

Verify runs the repo's `test` command with `failOn: never`. Stdout and stderr stored from verify are cut to the last 200 lines or 20KB. One round is build, then verify, then the four reviewers. `concurrency: 4` starts security, ux, ui, and code together after verify. Build stays first. The approver runs after the loop. Each reviewer needs `spec`, `build`, and `verify`, and inherits `input` so the preamble can still read `baseRef`. Yak warns that those four Bash steps share one working tree and may race. That warning is expected: the reviewer preambles say to use the verify output and not re-run tests, builds, or anything else that writes. Git diff and file reads stay allowed. A `CHANGES` verdict, a `BLOCKED` build, or a non-zero verify starts another build, at most twice. The loop then continues to the approver. After an approved gate, the run commits on `yak/<run-id>` with message `kiln: <title>`. A reject skips that commit. `adapter: "mock"` reads fixtures at `test/fixtures/kiln-feature/<step>.json` and does not call a model.

The first launch adds `.runs/` and `.yak/` to that checkout's `.git/info/exclude`.

## Not included

No requirement refinement. Jira is the next intake adapter and is not implemented. Bug, investigation, security, and pr-review workflows are not in this repo yet. Kiln does not push. Dependency blocking is unchanged: a job stays blocked until every id in `dependsOn` is `done`.
