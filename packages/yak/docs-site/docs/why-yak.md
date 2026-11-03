---
sidebar_position: -1
title: Why yak
---

<p align="center">
  <img src="/yak/img/yak-mascot.png" alt="yak mascot" width="320" />
</p>

# Most orchestrators bolt resume on. yak starts there.

If you already want agent orchestration — bounded loops, gates,
artifact-based steps — you've probably looked at Archon, or reached for
Temporal/DBOS/Restate underneath a hand-rolled step contract. yak's
pitch is narrow: it treats agent steps like **build targets**, not
opaque function calls.

Steps are targets, artifacts are files, cache keys are content hashes,
resume is incremental rebuild. Every run journals to disk — nothing in
memory, nothing in a database — so when a step fails three steps into a
five-step run, resuming re-runs exactly one step, not five. Most
orchestration tools treat an agent call as an opaque black box that
reruns the whole pipeline from scratch on any failure. yak doesn't.

## When you should use something else

**Archon**: if its YAML already covers your reference workflow with
acceptable ergonomics — bounded loops, `interactive: true` gates, bash
nodes, worktree isolation — use Archon. Don't switch for switching's
sake.

**Temporal, DBOS, or Restate**: if you need waits measured in days, or
multiple people participating in one run, put one of those underneath
instead and keep only the step-contract layer as your own code. yak's
suspend/resume is built for a single human answering a gate, not
long-horizon or multi-party durability.

yak is for single-operator, hands-off agent workflows where the failure
mode you're guarding against is a flaky step burning tokens on a full
rerun — not a multi-day or multi-person wait.

## Where the name comes from

**Yak shaving** is old hacker jargon for the thing that happens when you
sit down to do one task and discover it depends on another task, which
depends on another, until you're doing something absurdly far removed
from what you actually meant to do.

The term traces back to a 1991 *Ren & Stimpy* episode, "Yak Shaving
Day" — a fictional holiday where Ren shaves a yak and hangs the
shavings on a clothesline as a stocking substitute, for reasons the
episode never really explains. MIT hackers picked up "yak shaving" in
the mid-90s for exactly that feeling: you want to wax your car, but the
hose is at your neighbor's, whose ladder you need to return, which
reminds you a library book is overdue, which needs your library card,
which you can't find without your wallet, which is in the coat you lent
someone... and now, several unrelated errands deep, you are — for
reasons that felt logical one step at a time — shaving a yak.

Every workflow engine deals in yak shaving whether it says so or not:
the retry logic, the artifact bookkeeping, the "did the last run
actually finish or did it just look like it did" debugging, none of
which is the task you actually wanted an agent to do. yak's tagline —
*it shaves the yak so you don't* — is the pun: the engine absorbs the
scheduling/caching/journaling yak-shaving so a workflow author's own
steps can just be the task they meant to automate in the first place.

## See it for yourself

The [quickstart](./quickstart) runs the reference workflow against a
mock adapter in under a minute — free, no API key, just proving the
engine (scheduling, caching, journaling, resume) actually works. The
[tutorial](./tutorial) goes further: a real run, with a real model,
actually fixing an actual bug.
