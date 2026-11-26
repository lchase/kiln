# Roadmap

This file covers both packages: `@lchase/kiln` (the factory) and `@lchase/yak` (the workflow engine). It lists what
to build next and why, in order. It is a plan, not a promise.

The ordering follows one idea. Generating code is cheap now. What limits a software factory is how safely it can run
agent-written code, and how much of the operator's time each job costs in review. So containment and measurement come
first, autonomy comes after the numbers justify it, and new surfaces (desktop app, hosted mode) come last.

## Where things stand

Already built, so not on this roadmap:

- Intake from a spec file, a prompt, a tickets folder, and Jira. Triggers and routes start work without `kiln add`.
- The `feature`, `investigation`, `review`, and `fix` workflows, with local workflow, prompt, and skill overlays.
- `kiln serve`: a localhost board with an inbox, job detail, Add job, Settings, and desktop notifications.
- Delivery as a draft pull request, stacked jobs, and a bounded fix loop fed by CI failures and review comments.
- Retries with failure classes, loop breakers, a daily dollar cap, pause, and revise with a note.
- An append-only event log, an intervention ledger, and an Evidence section in the pull request body.
- An opt-in Docker sandbox for agent steps, with an egress allowlist enforced by a proxy.

## Decisions

**Sandbox providers belong in yak.** `sandbox: docker | none` is a field on yak's agent and command steps, and yak's
`claude-code` adapter builds the `docker run` arguments. Kiln only resolves its config and injects that field into
the rendered workflow. A provider interface therefore goes in yak. Kiln gains new `sandbox.mode` values and
preflight checks.

**Kiln is an open source, single-operator, local-first tool.** One person runs it on their own machine, for work
repos and personal repos alike. State stays derived from files in the kiln home. A hosted worker fleet, multi-tenant
scheduling, and org-wide administration are out of scope. A remote sandbox is a place to run one step, not a second
control plane.

Two things follow. Nothing specific to one employer goes in this repository: that belongs in the local overlay.
And one operator needs to keep work and personal use apart, which `KILN_HOME` already allows (one kiln home each,
with its own repos, credentials, sandbox settings, and dollar cap).

**The operator merges.** Kiln opens draft pull requests and pushes fixes to them. It does not merge, approve, or push
a base branch. Nothing below changes that.

## Now

### 1. Close the gaps in the Docker sandbox

The sandbox contains the agent, but not the code the agent writes.

- The `review` workflow reads other people's pull requests. Its agent no longer has a shell, but with the sandbox
  off its Read, Grep, and Glob tools are not confined to the worktree. Force the sandbox on for `review` whatever
  the config says.
- `verify` runs the repo's test command on the host. That executes agent-written code outside the sandbox, which is
  the largest hole. Run it in the container. Yak's command sandbox needs to forward `KILN_TEST` and the truncate
  wrapper, and needs a network policy other than `--network none` for test suites that install or fetch.
- A linked worktree's `.git` points outside the `/workspace` mount, so `git` inside the container cannot see the
  repository. The reviewers are told to run `git diff`. Mount the common git dir read-only.
- Podman works only when `docker` is aliased to it. Detect the runtime, or accept `sandbox.mode: "podman"`.

Done when a sandboxed feature job runs spec through approver, including the tests, with no agent-written code
executing on the host, on both Docker and Podman.

### 2. A sandbox provider interface in yak

Replace the hard-wired `docker run` call with a small interface: prepare a workspace from a commit, run a step in it,
stream its output, return the resulting branch and artifacts, and tear it down. Ship two providers behind it: `none`
(today's host run) and `container` (Docker and Podman). No behaviour changes. This is the seam item 4 needs.

### 3. Quality metrics from the event log

The board deliberately shows no quality numbers, because none are recorded. The event log already has the inputs.
Derive, per job and per repo: first-pass approval rate, build and review rounds, fix rounds after the pull request
opens, human interventions, dollars, and time from queued to merged. Show them in `kiln ledger` and on the board.

Done when a change to a prompt or a workflow can be judged by comparing these numbers before and after.

## Next

### 4. One remote sandbox provider

Start with a spike that scores candidates against the same checklist: runs the Claude Code CLI with our own token,
supports an egress allowlist, start time, cost per job, and whether state can be destroyed on demand. Candidates:
E2B, Daytona, Upstash Box, Modal, and Cloudflare Sandboxes. Then build one.

A remote sandbox cannot mount a local worktree. Code goes in as a pushed branch or a git bundle and comes back as a
branch. Credentials are short-lived and scoped to that branch. Land, push, and `gh` stay on the host.

### 5. Spec readiness check at intake

Kiln does not refine requirements, and that stays true. It can still refuse to waste a run. Flag a spec that has no
testable acceptance criteria, names no behaviour, or is too large for one pull request, before the job is queued.
The operator can override.

### 6. Replay evals

Record enough of a finished job (spec, base commit, workflow version) to run it again. `kiln replay` reruns a set of
past jobs against a changed prompt, workflow, or model and compares verdicts, rounds, cost, and diff size. This makes
overlay and prompt changes testable instead of a matter of taste.

### 7. Bug and security workflows

`bug` reproduces first: a failing test that shows the defect must exist before the fix is written. `security` takes a
finding or an advisory as its spec and adds a regression test.

### 8. Risk-based gates

Every feature job stops at a human gate today. Score each job from its diff size, the paths it touches, the reviewer
verdicts, and whether each acceptance criterion maps to a passing test. On repos that opt in, a low-risk job skips
the gate and goes straight to a draft pull request. This waits for item 3: the metrics have to show the reviewers
can be trusted before a gate is removed.

## Later

### 9. Desktop app

A thin wrapper around the serve board (Electron or Tauri), not a second UI. It adds what a browser tab cannot:
starting and stopping `kiln serve` from a tray icon, native notifications, and deep links from a pull request or a
Jira issue to its job. Worth doing once the board has settled.

### 10. A learning loop

Rejection reasons, revise notes, and reviewer findings that repeat in one repo are already in the event log. Distil
them into a per-repo profile that the spec and build prompts read, with the operator approving each addition.

### 11. Webhook ingress

Jira and GitHub are polled. A webhook can call the same issue-to-event function, but it needs a listener that is not
localhost-only, and that needs authentication. Do it only if polling latency becomes a real problem.

### 12. Multi-repo jobs

One spec that spans repos is split by hand into jobs joined with `--after`. A workspace job would plan the split and
keep the pull requests linked.

## Not planned

- Requirement refinement or product discovery. A ready spec is the input.
- Merging, approving, or commenting on the operator's behalf, beyond the review drafts the operator approves.
- A hosted, multi-user Kiln.
