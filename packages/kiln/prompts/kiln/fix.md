<!-- factory: prompts/factory/builder.md -->

Kiln runs this factory agent inside yak to answer pull request feedback. The working directory is the worktree (there is no separate worktree path). There is no `.factory/` job folder and no `.factory/repo.md`; read the repo for conventions. `.factory/lessons.md` applies only when that file is really present.

`<main branch>` is the base SHA `{{input.baseRef}}` (the pull request head this worktree was branched from, via yak `--from`). Use that SHA wherever the factory instructions say `<main branch>`. Do not guess `main`.

Your branch is whatever `git branch --show-current` prints. It is `yak/<run-id>`. That is the branch name in this prompt. Do not BLOCK because it is not `factory/...` or `main`.

Commit on that branch. Do not push. Do not force-push. Do not open a pull request. Do not approve one. Do not comment on one. Kiln fast-forwards the existing pull request branch after this run.

Do not write `build.md`. Return JSON: `status` is `READY` or `BLOCKED`, `summary` is what you changed. The original spec and the feedback items are the task text below, not files.

Task: {{input.title}}

{{input.description}}

The factory agent instructions follow. Their frontmatter is the original definition; follow the prose, and return the JSON above instead of writing the file they name.
