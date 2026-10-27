# Kiln

Kiln runs a workflow against a git checkout. Register any repo, add a job from a markdown spec, a prompt, a directory of tickets, or a Jira Cloud issue, and tick. Tick launches ready jobs in yak worktrees. Status shows each job. Approve or reject answers a human gate. `kiln serve` opens that same derived state in a browser on this machine.

A ready spec is the input. Kiln does not build or iterate requirements.

This repository is public. Checkout paths and jobs stay in `~/.kiln/` (or `$KILN_HOME` when that is set). Do not commit them.

## Install

```bash
npm i -g @lchase/kiln
kiln repo add web /absolute/path/to/web --test "npm test"
kiln repo list
```

Run `kiln repo add <name> <path>` from any directory. The first run creates `~/.kiln/kiln.config.json`. Jobs, logs, and deliveries live in that same directory, whichever directory you run `kiln` from. Set `KILN_HOME` or pass `--config <file>` to use a different kiln home.

If `./.kiln/kiln.config.json` is still in the working directory and the home config does not exist, kiln stops. Move it with `mv ./.kiln ~/.kiln`, or pass `--config` / set `KILN_HOME`. Kiln does not move it for you.

`kiln` is the command. The subcommands in the rest of this file are the same ones. Examples that say `npm run kiln --` are the in-checkout form.

## Develop from a checkout

```bash
npm install
npm run build
npm link
kiln repo list
```

`npm link` puts this checkout's `kiln` on your PATH. The bin is `dist/cli.js`, so build before linking, and rebuild after source changes. `npm run kiln --` builds and runs without a global link.

Workflows (`workflows/*.yaml`) and prompts (`prompts/`) are read from the package that contains the running file, next to its `package.json`. A global install and `npm link` both resolve them from that package, not from the directory you ran `kiln` in.

## Prerequisites

- Node.js >= 22 (the `engines` field in `package.json`)
- git
- Claude Code, installed and logged in, for a real run. `adapter: "mock"` does not call a model.
- `gh`, installed and logged in, only when a repo uses `deliver: "pr"`.

Each checkout is a git repo with a commit at `HEAD`. `tick` adds a worktree and leaves uncommitted files in the checkout as they are. The job edits the worktree, on branch `yak/<run-id>`. With the default `deliver: "local"`, Kiln does not push. `deliver: "pr"` pushes that branch and opens a draft pull request. See [Delivery and dependencies](#delivery-and-dependencies).

## Sandbox

Sandbox mode is off. Set it in the kiln config when agent steps should run inside yak's Docker sandbox instead of on the machine. A workflow block overrides the global one field by field. `mode` omitted means off at that layer. `allowDomains`, when set, replaces the list.

```json
{
  "sandbox": { "mode": "docker" },
  "workflows": {
    "investigation": { "sandbox": { "mode": "off" } }
  }
}
```

`image` overrides `yak-agent-sandbox:latest`. Leave it unset to use that tag.

With mode `docker`, tick injects `sandbox: docker` and `allowedDomains` under every agent step in the rendered workflow. The default allowlist is exact hostnames, matched by the proxy as `dstdomain` (a subdomain is not implied):

- `api.anthropic.com`
- `registry.npmjs.org`
- `github.com`
- `api.github.com`
- `codeload.github.com`
- `objects.githubusercontent.com`
- `raw.githubusercontent.com`

That is the Anthropic API, the npm registry, and the GitHub hosts a fetch or install dials. It is not the open internet.

| Step | Where it runs |
| --- | --- |
| feature: spec, build, security, ux, ui, code, approver | Docker sandbox |
| investigation: explore | Docker sandbox |
| fix: build | Docker sandbox. A pull-request fix uses the same allowlist. |
| feature: verify | Host. It runs `KILN_TEST` through Kiln's truncate wrapper. Yak's command sandbox does not forward that environment and uses `--network none`. |
| approve gates | Host. A person answers them. |
| feature: land, fix: land | Host. `git commit` uses the host git identity. Publishing the fix branch is the kiln process. |
| Pull request open, `git push`, `gh pr view`, feedback reads | Host kiln process. They are not workflow steps. |

`kiln sandbox` prints the resolved mode, the allowlist, and anything still missing. `kiln sandbox build` builds the images yak ships but does not publish, from the tag that matches the installed `@lchase/yak`:

```bash
docker build -t yak-agent-sandbox:latest https://github.com/lchase/yak.git#yak-v0.8.0:docker/agent-sandbox
docker build -t yak-agent-sandbox-proxy:latest https://github.com/lchase/yak.git#yak-v0.8.0:docker/agent-proxy
```

The agent image is `node:22-slim` plus the Claude CLI at `/app/claude-cli`. It has no git. `kiln sandbox build` adds `git` and `ca-certificates` and tags that result `yak-agent-sandbox:latest` as well. The proxy image is `yak-agent-sandbox-proxy:latest` (squid on port 3128). Yak mounts the worktree at `/workspace` and puts the container on an `--internal` network whose only egress is that proxy.

A linked worktree's `.git` file points at the checkout's common git dir, which is outside that mount. `git` inside the container cannot see the repository until yak mounts that dir too. Land stays on the host, where the worktree link works.

Podman works when `docker` is aliased to `podman`. Yak 0.8.0 falls back from the `bridge` egress network to `podman` when `bridge` is absent. `YAK_SANDBOX_EGRESS_NETWORK` overrides that name.

On macOS, Claude subscription auth lives in the keychain. Yak forwards only `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` into the container, and never a `~/.claude` directory. Kiln checks that one of those variables is set before a sandboxed run. It does not print or write the value.

Outside the sandbox, an unset `CLAUDE_CODE_OAUTH_TOKEN` is allowed: Claude Code can use the keychain. A variable that is set but empty, or a `CLAUDE_CODE_OAUTH_TOKEN` that does not start with `sk-ant-oat`, makes `kiln tick` and `kiln serve` refuse to launch. The message names the variable and does not include the value. A later 401, `Invalid bearer token`, or `Failed to authenticate` in the yak failure or the kiln log is `auth-failed`. That attempt is not retried. The board says `Claude login rejected (401) — check CLAUDE_CODE_OAUTH_TOKEN / claude login, then Retry`. `kiln retry` is the way back after the token is fixed.

```bash
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN
kiln sandbox build
```

Then set the kiln config to `"sandbox": { "mode": "docker" }`.

`kiln tick` and `kiln serve` name what is missing when sandbox mode is on: the docker binary, the docker daemon, each image, and the credential. They also refuse an installed `@lchase/yak` that does not pass `allowedDomains` from the agent step into the sandbox proxy. `@lchase/yak` 0.8.0 does. An older package drops `sandbox`, `image`, and `allowedDomains` while loading YAML and opens the proxy with only `api.anthropic.com`, so the job would run on the host with the open internet. Kiln leaves that job failed until `kiln retry`, after the installed package is 0.8.0 or newer.

A step that fails with yak reason `sandbox-error` goes to Needs human. The card shows the failure detail. Kiln does not schedule an automatic retry for it. The card of a sandboxed job shows `sandbox · docker` in the same monospace metadata as the rest of the board.

## Register repos

```bash
npm install
npm run kiln -- repo add web /absolute/path/to/web --test "npm test"
npm run kiln -- repo add api /absolute/path/to/api --test "npm test"
npm run kiln -- repo list
```

`npm run kiln` builds first. `kiln repo add <name> <path>` writes `~/.kiln/kiln.config.json`. When `KILN_HOME` is set it writes `$KILN_HOME/kiln.config.json`. `--config <file>` writes that file instead, and jobs live in the file's directory. A relative path is stored absolute, resolved from the working directory at add time. `~` is expanded from the home directory. `test` is optional on the entry and required before tick can launch a job in that repo.

`repo add` prints the deliver mode in effect and the command that changes it. The default is `local`, and that default is not written into the file until you pass `--deliver`. `kiln repo add <existing-name> <path> --deliver pr` updates that repo in place: a flag you omit keeps the stored test command, deliver mode, base, `prTitle`, and `branch`. `kiln repo list` prints `deliver local` or `deliver pr` for every repo.

```json
{
  "repos": {
    "web": { "path": "/absolute/path/to/web", "test": "npm test" },
    "api": { "path": "~/src/api", "test": "npm test" }
  },
  "maxConcurrent": 2,
  "adapter": "claude-code"
}
```

`repos` is an open map. Any name is allowed. `maxConcurrent` caps how many jobs may be in flight (default 2). `adapter` is `claude-code` (default) or `mock`.

## Add a job

A job is one workflow run. The workflow name is a file `workflows/<name>.yaml`. `feature` is the factory loop. `investigation` answers a spike and stops for a person to approve the findings. `fix` is the pull request feedback run: the same builder, on the open pull request head, committing onto a new `yak/<run-id>` that Kiln fast-forwards onto the existing branch. Bug and security workflows are next.

```bash
npm run kiln -- add feature --repo web --spec spec.md --title "Show a Sunday summary"
npm run kiln -- add feature --repo api --spec api-spec.md --after <job-id>
npm run kiln -- add feature --repo web --jira PROJ-123
npm run kiln -- add feature --repo web --spec spec.md --issue ABC-123
```

`--title` defaults to the first `#` heading in the spec, then the file name. `--issue KEY` stores an issue id matching `KEY-123` (uppercased). `--after` may be repeated. Those jobs must already exist. Kiln copies the spec to `~/.kiln/specs/<id>.md` and writes `~/.kiln/jobs/<id>.json`:

```json
{
  "id": "j20261025020600ab12",
  "repo": "web",
  "workflow": "feature",
  "spec": "specs/j20261025020600ab12.md",
  "title": "Show a Sunday summary",
  "issue": "ABC-123",
  "dependsOn": ["j20261025020500cd34"],
  "source": { "kind": "file", "ref": "/home/dev/specs/sunday.md" },
  "createdAt": "2026-10-25T02:06:00.000Z"
}
```

`dependsOn` is omitted when the job has no `--after`. `issue` is omitted when intake had no key. `stack: true` is set by `--stack` and is omitted otherwise. `source` records which intake created the job. Jobs written before intake omit `source` and still run. State is not stored. The pull request url is not stored on the job; Kiln writes it under `~/.kiln/deliveries/`.

## Intake

Every intake writes the same job: `id`, `repo`, `workflow`, `spec`, `title`, optional `issue`, optional `dependsOn`, and `source`. `source` is `{ "kind": "file" | "prompt" | "tickets" | "jira", "ref": "..." }`. Status prints `source <kind> <ref>` when the job has one. Tick, reconcile, and status do not special-case an intake. The adapters are `src/intake/file.ts`, `src/intake/prompt.ts`, `src/intake/tickets.ts`, and `src/intake/jira.ts`.

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

`--prompt -` reads stdin. The text is stored as that job's spec. The title defaults to the first non-empty line, truncated to 80 characters. `source.kind` is `prompt`. `source.ref` is `inline` for an argument and `stdin` when the prompt is read from stdin. `--title` and `--after` work the same way as file intake. Pass one of `--spec`, `--prompt`, or `--jira`.

### Tickets

```bash
npm run kiln -- import ./tickets --repo web
npm run kiln -- import ./tickets --repo web --workflow feature --context spec.md --dry-run
```

`import` reads a directory of `NN-slug.md` files, the shape a Matt Pocock-style `/to-tickets` pass writes. Each file starts with `# NN: Title`, a `**What to build:**` paragraph, and a `**Blocked by:**` line. That line is followed by `None…` or by bullets such as `- 01: Probe the unconfirmed platform facts`. Kiln matches the `NN` number to a filename in the same directory (`01` and `1` are the same number). YAML front matter is also accepted, with `title`, `type`, `issue`, and `blocked-by` (`blocked-by:` as a list, a flow list, or a single number). `issue` must be a `KEY-123` id. A heading or title that already starts with `ABC-123:`, `ABC-123 `, or `[ABC-123]` sets the same field. A numbered heading such as `# 01: Title` does not. The stored title keeps that prefix; the pull request template strips it.

One file becomes one job. Blocked-by becomes `dependsOn` on the imported job ids. An unknown number is an error that names the ticket file, and no new job is written.

`--workflow` defaults to `feature`. Kiln switches a ticket to `investigation` when the ticket is a spike: front matter `type` is `spike`, `investigation`, or `research` (the word after a colon counts, as in `wayfinder:research`), the title contains spike or probe, or the text says "no product code". A body that only mentions an upstream spike stays on the requested workflow.

`--context` defaults to `spec.md` in the parent of the ticket directory when that file is present. The text is appended to every job spec as a `## Background` section. A context file larger than 40KB is not copied in. The spec names its path instead.

Import is idempotent. The key is the ticket directory plus the filename, stored as `source.ref` (an absolute path) with `source.kind` `tickets`. Running import again on the same directory does not create a second job for a file already imported. The report says how many jobs are new and how many are unchanged. `--dry-run` prints each ticket, its workflow, and its dependencies, and writes nothing.

### Jira

```bash
npm run kiln -- add feature --repo web --jira PROJ-123
npm run kiln -- add feature --repo web --jira PROJ-123 --after <job-id> --dry-run
```

`--jira` reads one Jira Cloud issue over REST API v3 and writes the same job as the other intakes. `source.kind` is `jira`. `source.ref` is the issue key (`PROJ-123`). The job's `issue` is that key. The title is the issue summary, or `--title` when you pass one. The spec heading stays `# PROJ-123: <summary>`, then a `Source:` line with the issue's browse URL, then the description converted from Atlassian document format to markdown. `--issue` on the same command must be that key.

Set `JIRA_BASE_URL` (for example `https://acme.atlassian.net`), `JIRA_EMAIL`, and `JIRA_API_TOKEN`. Each value falls back to the optional `jira` block in the kiln config (`~/.kiln/kiln.config.json`, or `$KILN_HOME/kiln.config.json` when `KILN_HOME` is set, or the file passed with `--config`). Environment variables override the block:

```json
"jira": {
  "baseUrl": "https://acme.atlassian.net",
  "email": "dev@example.com",
  "apiToken": "<token>"
}
```

Create a token at <https://id.atlassian.com/manage-profile/security/api-tokens>. Kiln sends it as Basic auth and does not write it into the job, the spec, or error text. A missing value is an error that names `JIRA_BASE_URL`, `JIRA_EMAIL`, or `JIRA_API_TOKEN`.

A Blocks link where this issue is blocked by another key becomes `dependsOn` when a kiln job with `source` `jira` and that key already exists. Otherwise Kiln prints a warning naming the key and still creates the job. `--after` is merged with those ids. Issue type Spike or Research uses the same rule as a spike ticket and is imported as `investigation`. Running add again for the same key prints the existing job id and creates nothing. `--dry-run` prints the job and writes nothing.

`examples/spec.md` is a fictional spec you can copy.

## Serve

```bash
kiln serve
kiln serve --port 4100 --tick 30
kiln serve --no-tick
```

`kiln serve` listens on `127.0.0.1` only (port 4100 unless `--port` is set). It reads the same derived state as `kiln status` and calls the same approve, reject, and retry functions. Nothing new is stored.

`/` is the operator board, using the factory dashboard's dark charcoal layout. Columns are workflow stages taken from the job's yaml steps and the current yak step. Queued is first: jobs whose derived state is queued or blocked, with the subtitle `waiting · deps` and dimmer text. A blocked card names the jobs it is waiting on. Spec holds a job only while the spec step is the one running. Then Build (`builder · opus`), Review (`sec · ux · ui · code`), Approve (`approver · opus`), Land, PR review, Done, Merged, and Needs human. Done (`local`) is a landed job with no pull request: `deliver=local`, or an investigation. The card says `landed locally · yak/<run-id>`. Merged (`pr`) is a done job whose pull request exists. The card says `merged · PR #N`. An empty board shows Done and does not label that column Merged. Both columns appear when the kiln has one of each. A card's repo line includes the deliver mode, `web · local` or `web · pr`. An investigation adds Explore. Needs human stays at the right and holds open gates, dead runs, failures that are not waiting on an automatic retry, invalid job files, and rejections. A failed job with `nextRetryAt` still set stays in the column of the step it was on (Build, Review, and so on), dimmer, with one line `retrying 7:35 PM · attempt 1/3 · stalled` in the browser's local time. It is not in the needs-you count. When that retry starts, the card is a normal running card again. An empty column is a narrow strip with the name written down it. The header clock and any timestamps in the drawer use the browser's local time; stored values stay ISO UTC. The bottom toolbar switches between that and always-expanded columns; the choice is stored in `localStorage`. Repo chips across the top filter the cards. A card shows the job id, repo, title, branch, pull request, and one row per review round (security, ux, ui, code). A card in PR review also shows each feedback round as its own row: `CI failed`, `changes requested`, then `pushed` or `fixed` once that round lands. A fix that is still running is a normal running card. Only `feedback-exhausted` (and feedback Kiln could not classify) moves to Needs human, with your call. The drawer lists each feedback round's checks and comments, with links. A blocked card names what it is waiting on. Clicking a card opens a drawer. Approve, Reject, and Retry sit in the drawer header when the job is gated or failed. The drawer lists the spec, build, decision, each review, and investigation findings, and the selected file is rendered on the right. `/board` is the same page. The document title is `(N) Kiln`, where N is the needs-you count from the attention view (gates, dead runs, failures with no automatic retry left, and open pull requests). A job waiting out its backoff is not included, and it does not fire the desktop notification. The page polls every 3 seconds. After you opt in from the toolbar, a desktop notification fires when that count goes up. Kiln does not record factory quality averages, so the header does not invent round or human-fix numbers.

`GET /jobs/<id>/findings` renders the approved findings markdown as text. HTML in that file is escaped. The page is read-only.

`GET /api/jobs` and `GET /api/jobs/<id>` return that view as JSON, including the attention sections. `POST /api/jobs/<id>/approve`, `POST /api/jobs/<id>/reject`, and `POST /api/jobs/<id>/retry` call the same functions as the CLI. A browser POST from another origin is rejected. The page and the stylesheet ship inside the package (`assets/serve.css`, read from the package root).

`kiln retry <jobId>` relaunches a failed or dead job with the same launch tick uses, and clears `<kiln-dir>/attempts/<job-id>.json`. A landed job that only failed to open its pull request is delivered again instead. The board's Retry button calls that same function.

By default, serve runs `kiln tick` once when it starts and then every 30 seconds. `--tick <seconds>` changes the interval. `--no-tick` leaves the factory where it is. The tick uses the same lock as `kiln tick`, so a second tick exits with "another kiln tick is running" instead of launching twice. There is no intake form in this UI yet.

The Jira API token is not rendered. Do not commit checkout paths or job files.

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

A job is ready when its dependencies are met and the number of jobs in flight is under `maxConcurrent`. The default is after merged: every job in `dependsOn` is `done`. `--stack` is met when that one upstream has landed. A rejected gate does not unblock the next job. An ok run with no readable approval does not either. An authentication failure does not either: reason `auth-failed` stays in Needs human until `kiln retry`.

`stallTimeoutMs` (default `900000`, 15 minutes), `maxAttempts` (default `3`), and `maxFixRounds` (default `2`) live in the kiln config. `stallTimeoutMs` of `0` or below turns stall detection off. A running job with no yak journal event and no log output for that long is killed, process tree included, and marked failed with reason `stalled`. A process that is already gone when `kiln tick` or `kiln serve` starts is `orphaned`. An agent or launch crash is `crashed`. A non-zero exit that is not a gate rejection is `failed`. Those four retry on their own after `10s × 2^(n-1)`, capped at 5 minutes. A rejected gate, a cancelled run, and an ok run with no readable approval do not. After `maxAttempts` the job is `dead`. Each attempt is a file under `<kiln-dir>/attempts/<job-id>.json`, so state stays derived. Status prints `attempts`, `reason`, and `next retry` from the same view `readStatus` returns. On the board, a dead card in Needs human shows `attempt N/M` and the reason. A failure that still has a scheduled retry stays in its stage column instead, with `retrying` and the local time.

While a `deliver=pr` job is `in-review`, tick reads that pull request with `gh`: check runs for the head, reviews, and unresolved review comments. The operator's inline comments and unresolved threads count; a top-level note counts only when it starts with `/kiln`, and that prefix is left out of the fix prompt. Comments from `kiln` or a `[bot]` login are ignored, and a resolved thread does not start a round. Pending checks are ignored. A completed failing check on a head that no round has recorded, or review feedback newer than the last round, starts `workflows/fix.yaml` with `yak run --from` that head. The prompt is the original spec plus the failing check names (with a short log excerpt) and the review comment bodies, including file and line. The agent commits on `yak/<run-id>` and does not push. Kiln fast-forwards the open pull request branch. It does not open a second pull request, force-push, merge, approve, or comment. The same head and the same feedback do not start two runs. Each round is a file under `<kiln-dir>/feedback/<job-id>.json`. A stall or crash during a fix uses the attempt ledger above. After `maxFixRounds` the job is `needs-human` with reason `feedback-exhausted`. Feedback Kiln cannot classify is `needs-human` with reason `feedback-ambiguous`. The person merges the pull request.

`npm run kiln -- status` lists jobs across repos. When a job has `source`, status prints `source <kind> <ref>`. For `needs-human` it prints `approve: kiln approve <id>` and `reject: kiln reject <id>`. Run those as `npm run kiln -- approve <id>` and `npm run kiln -- reject <id>`. For `done` and `in-review` it prints the branch. `deliver=local` prints `branch yak/<run-id>`. `deliver=pr` prints the remote branch name recorded on the delivery, and the pull request url once one exists. `auth-failed` prints `Claude login rejected (401) — check CLAUDE_CODE_OAUTH_TOKEN / claude login, then Retry`. For an investigation whose findings file exists, it prints `findings <path>`. That path is `findingsPath` on the same status view `kiln serve` renders, and the console links it. For `blocked` on a dependency id that has no job file, it prints `blocked on missing job <id>`. While an upstream pull request is open, it prints `waiting for PR #N to merge`. `npm run kiln -- retry <id>` relaunches a failed or dead job, or delivers again when the only failure is opening the pull request, and clears the attempt ledger.

State is derived from the yak journal, the gate files, and (for `deliver=pr`) `gh pr view`:

| State | Meaning |
| --- | --- |
| `queued` | Dependencies are met, and the job has not started |
| `blocked` | An after-merged dependency is not `done`, or a stacked dependency has not landed. A missing job id is named |
| `running` | Yak is alive, or the launch process is alive and has not written a journal |
| `needs-human` | The run is suspended on an open gate, or pull request feedback is exhausted (`feedback-exhausted`) or ambiguous (`feedback-ambiguous`) |
| `approved` | The gate says approve and the run has not finished. This still holds a slot |
| `rejected` | The run finished ok and the gate says reject |
| `failed` | The run failed, the launch died before a journal, the run finished ok with no readable approval, a pull request could not be opened, a Claude login was rejected (`auth-failed`, not retried), or a transient failure is waiting to retry |
| `dead` | The attempt budget is used up. Before the next tick, a journal whose process is already gone is also `dead`. Status prints the cancel command when a process is gone, and `kiln retry <id>` once attempts are exhausted |
| `in-review` | `deliver=pr` and the run has landed. The pull request is open, or the next tick still has to open it |
| `done` | `deliver=local`: the run finished ok and the gate says approve. `deliver=pr`: that pull request has merged. An investigation is `done` when the gate says approve, including when the repo is `deliver=pr`. It does not enter `in-review` |

## What a feature job runs

`npm run kiln -- tick` starts `yak run --isolation worktree --from <sha>` in the repo, tagged `kiln:<jobId>`, with logs in `<kiln-dir>/logs/<jobId>.log`. Kiln passes `title`, the spec text as `description` and `acceptance`, `baseRef` (the commit the worktree is cut from), and `runNonce`. For `deliver=local` that commit is checkout `HEAD`. For `deliver=pr` it is `origin/<base>` after `git fetch`, or the upstream branch tip when the job is stacked. The test command is `KILN_TEST`. `--from` is that same commit. Yak cuts the worktree from it and leaves the checkout's `HEAD` and files where they are.

The job runs the factory loop from Lawrence Chase's factory plugin v0.7.0 (MIT), copied from commit `4c84a2ce7fbde5ac298c0de9f0b90141eac4ed98`: spec, then up to two rounds of build, verify, and the security, ux, ui, and code reviewers, then the approver, a human gate, and a commit. The prompts in `prompts/factory/` are those agent files, copied verbatim. `prompts/kiln/` maps the factory's job-folder files onto the artifacts yak passes in. `npm run kiln -- tick` writes a per-run copy of the workflow under the kiln directory, with absolute prompt paths, before it starts yak.

Verify runs the repo's `test` command with `failOn: never`. Stdout and stderr stored from verify are cut to the last 200 lines or 20KB. One round is build, then verify, then the four reviewers. `concurrency: 4` starts security, ux, ui, and code together after verify. Build stays first. The approver runs after the loop. Each reviewer needs `spec`, `build`, and `verify`, and inherits `input` so the preamble can still read `baseRef`. The reviewer prompts run `git diff <main branch>...HEAD`, so Bash stays. The kiln preambles tell them to use the verify output and not re-run tests, builds, or anything else that writes. Yak 0.8.0 still warns: it treats Bash as write-capable (`WRITE_CAPABLE_TOOLS` in `src/ir/validate.ts`) and has no way to mark a shell step read-only. The only fixes yak offers are `concurrency: 1` or dropping Bash. Neither is right here. Parallel reviews stay, and silencing that warning needs a yak change. A `CHANGES` verdict, a `BLOCKED` build, or a non-zero verify starts another build, at most twice. The loop then continues to the approver. After an approved gate, the run commits on `yak/<run-id>` with message `kiln: <title>`. A reject skips that commit. `adapter: "mock"` reads fixtures at `test/fixtures/kiln-feature/<step>.json` and does not call a model.

The first launch adds `.runs/` and `.yak/` to that checkout's `.git/info/exclude`.

## What an investigation job runs

A spike, probe, or research ticket runs `workflows/investigation.yaml`. One agent explores the worktree. It may run commands and scripts. It must not change product code: the step has no Write or Edit tool, and the prompt forbids creating, editing, deleting, committing, and pushing. The agent returns a markdown document with four sections: Questions, Answers (each answer includes evidence: file paths and command output), Unconfirmed, and Implications for dependent tickets.

The run then suspends on a human gate. There is no build, review, verify, or land step. `npm run kiln -- approve <job-id>` stores that markdown at `<kiln-dir>/findings/<job-id>.md` and the job is `done`. Writing the same text again does not change the file. `npm run kiln -- reject <job-id>` is `rejected` and writes no findings file. A rejected investigation does not unblock a dependent.

`deliver=pr` does not change this. Kiln does not push the investigation branch and does not run `gh pr create`.

A later job whose `dependsOn` includes that investigation receives the findings in the spec yak sees. Kiln appends a `## Findings from <title>` section for each investigation dependency. The copy under `<kiln-dir>/specs/` is left as it was. After merged still waits until the investigation is `done`. `--stack` onto an investigation is an error: there is no branch to target.

`adapter: "mock"` reads `test/fixtures/kiln-investigation/explore.json` from the checkout. The prompt is `prompts/kiln/investigation.md`. The published package includes `prompts` and `workflows`.

## Delivery and dependencies

`deliver` is set on the repo. The default is `local`: the job is `done` when the run lands on `yak/<run-id>`, and Kiln does not push. Existing repos and tests stay on that path. `kiln repo add` prints that mode. `kiln repo list` shows it. The board card does too.

```bash
npm run kiln -- repo add web /absolute/path/to/web --test "npm test" --deliver pr --base main
```

`deliver` is `local` or `pr`. `base` is the pull request base branch. When `base` is omitted, Kiln uses origin's default branch, from `refs/remotes/origin/HEAD` after `git fetch`. Running `repo add` again for the same name updates the entry in place.

With `deliver=pr`, the tick after an approved land pushes the local `yak/<run-id>` ref to a readable remote branch and runs `gh pr create --draft --head <that name>`. Yak keeps the local branch. The delivery record stores the remote name, and later ticks, including a fix round that fast-forwards the open pull request, use that name. A name already recorded for this run is reused, including an older record that stored `yak/<run-id>`.

The default remote name is `<issue>-<slug>` when the job has an issue, and `kiln/<slug>-<short id>` otherwise. `slug` is the title in kebab case, at most 50 characters, with a leading issue prefix removed. `short id` is the four hex digits at the end of a kiln job id. A remote branch that already points at a different commit gets `-<short id>` appended, or the full job id when the short id is already on the name. A branch that already points at this commit is ours.

The default pull request title is `[ABC-123] Title` when `issue` is set: template `[{issue}] {title}`. Before that template is applied, a leading `ABC-123:`, `ABC-123 `, or `[ABC-123]` is stripped, so a Jira `KEY: summary` title is not written twice. A job with no issue keeps its title, and a repo `prTitle` template is ignored in that case. Set `prTitle` on the repo (`{issue}` and `{title}`) for another convention. Set `branch` (`{issue}`, `{slug}`, `{jobId}`) for another remote name.

```json
"web": {
  "path": "/absolute/path/to/web",
  "test": "npm test",
  "deliver": "pr",
  "base": "main",
  "prTitle": "[{issue}] {title}",
  "branch": "{issue}-{slug}"
}
```

The body is the spec's first paragraph, the line `Kiln job: <id>`, and the security, ux, ui, code, and approver verdicts. The branch, pull request number, and url are written to `~/.kiln/deliveries/<job-id>.json`, not the job file. A later tick looks up an existing pull request for that remote branch and does not push when origin already has the same commit. Deleting the delivery file and ticking again finds that pull request by the remote name. Kiln does not merge, and it does not push the base branch. An investigation is not delivered this way: approve stores findings and the job is `done`.

If `gh` is missing or not authenticated, that job becomes `failed` and status prints what to run (`gh auth login`, then `kiln tick`). The rest of the tick still runs. The next tick tries again.

`done` for `deliver=pr` is `gh pr view --json state,mergedAt`. A squash merge counts. Kiln does not ask git whether the landed commit is an ancestor of the base.

### After merged and stacked

The default is after merged. A job stays `blocked` until every upstream is `done`. Status says `waiting for PR #N to merge` while an upstream pull request is open. A `deliver=pr` worktree is cut from `origin/<base>` after `git fetch`, not from checkout `HEAD`.

`--stack` on `kiln add` or `kiln import` waits for one upstream to be approved and landed, then cuts the worktree from that upstream's local `yak/<run-id>` branch. The pull request targets the upstream's remote branch name. `stack` with any count other than one dependency is an error at add time, and the upstream job has to be in the same repo. Stacking onto an investigation is an error, because that job does not land a branch. Stacked work does not wait for the upstream pull request to merge.

```bash
npm run kiln -- add feature --repo web --spec spec.md --after <job-id> --stack
npm run kiln -- import ./tickets --repo web --stack
```

## Not included

No requirement refinement. Bug and security workflows are not in this repo yet. Kiln does not merge, approve, or comment on pull requests, and it does not push the base branch.
