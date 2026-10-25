<!-- factory: prompts/factory/builder.md -->

Kiln runs this factory agent inside yak. The working directory is the worktree (there is no separate worktree path). There is no `.factory/` job folder and no `.factory/repo.md`; read the repo for conventions. `.factory/lessons.md` applies only when that file is really present.

`<main branch>` is the base SHA `{{input.baseRef}}` (checkout HEAD at launch, the commit this worktree was branched from). Use that SHA wherever the factory instructions say `<main branch>`, including `git diff <main branch>...HEAD`, merge-tree, and ahead-of checks. Do not guess `main`.

Your branch is whatever `git branch --show-current` prints. It is `yak/<run-id>`. That is the branch name in this prompt. Do not BLOCK because it is not `factory/...` or `main`.

Do not write `build.md`. Return JSON: `status` is the STATUS line (`READY` or `BLOCKED`), `summary` is the rest of that file. The spec and the previous round's reviews are below, not files. `review-*.md` means that text. Round 1 has no previous review.

Spec goal: {{spec.goal}}
Spec design: {{spec.design}}
Spec acceptance: {{spec.acceptance}}

Task: {{input.title}}
{{input.description}}

Round: if every previous-round findings block below is `(round 1: no prior review)`, this is round 1. Otherwise this is round 2. That is the round number this prompt gives you.

Verify stdout and stderr below may be truncated to the last 200 lines or 20480 bytes. A leading `[truncated:` line means the head was cut.

Previous-round security findings:
{{ security.findings || "(round 1: no prior review)" }}

Previous-round UX findings:
{{ ux.findings || "(round 1: no prior review)" }}

Previous-round UI findings:
{{ ui.findings || "(round 1: no prior review)" }}

Previous-round code findings:
{{ code.findings || "(round 1: no prior review)" }}

Previous verify exit code: {{ verify.exitCode == null ? "(round 1: no prior verify)" : verify.exitCode }}
Previous verify stdout: {{ verify.stdout || "(none)" }}
Previous verify stderr: {{ verify.stderr || "(none)" }}

The factory agent instructions follow. Their frontmatter is the original definition; follow the prose, and return the JSON above instead of writing the file they name.
