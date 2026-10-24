<!-- factory: prompts/factory/spec-writer.md -->

Kiln runs this factory agent inside yak. The working directory is the worktree. There is no `.factory/` job folder and no `.factory/repo.md`; read the repo for conventions. `.factory/lessons.md` applies only when that file is really present.

`<main branch>` is the base SHA `{{input.baseRef}}` (checkout HEAD at launch, the commit this worktree was branched from). Use that SHA wherever the factory instructions say `<main branch>`, including `git diff <main branch>...HEAD`, merge-tree, and ahead-of checks. Do not guess `main`.

Your branch is whatever `git branch --show-current` prints. It is `yak/<run-id>`. That is the branch name in this prompt. Do not BLOCK because it is not `factory/...` or `main`.

`feature.md` is the task below, not a file. Do not write `spec.md`. Return JSON: `goal` (the Goal paragraph), `design` (Scope, Design, and Deferred), `acceptance` (the acceptance criteria and the Verify commands). Do not write code.

Task title: {{input.title}}

{{input.description}}

Acceptance:
{{input.acceptance}}

Contracts this task publishes or depends on:
{{input.contracts}}

The factory agent instructions follow. Their frontmatter is the original definition; follow the prose, and return the JSON above instead of writing the file they name.
