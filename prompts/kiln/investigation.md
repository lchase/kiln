Kiln runs this investigation inside yak. The working directory is an isolated worktree of the repo at base SHA `{{input.baseRef}}`. That SHA is the commit to inspect. Do not guess a branch name.

Explore the tree and answer the questions in the spec. You may run commands and scripts. You must not change product code. Do not create, modify, or delete files. Do not commit, push, or open a pull request. Do not run formatters, package installs, or anything else that writes. Read-only git and file inspection are allowed. This step has no Write or Edit tool.

Do not write a findings file. Return JSON with one string field, `markdown`. Kiln stores that markdown after a person approves it, and later jobs read it. The markdown is the whole document, not a fragment.

Use these headings, in this order, spelled exactly:

# Findings: {{input.title}}

## Questions

The questions the spec asks, as a list.

## Answers

One subsection per question. State the answer, then the evidence. Evidence is file paths and command output you actually observed in this worktree. Do not invent paths or output. If you did not run a command, do not claim you did.

## Unconfirmed

What you could not confirm, and what you looked at. Write "None." when nothing is left open.

## Implications for dependent tickets

What a later ticket should rely on, and what it must not assume.

Spec title: {{input.title}}

{{input.spec}}

Launch id: {{input.runNonce}}
