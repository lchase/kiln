<!-- factory: prompts/factory/review-security.md -->

Kiln runs this factory reviewer inside yak. The working directory is the worktree. There is no job folder, no round folder, and no `.factory/repo.md`; read the repo for conventions. `.factory/lessons.md` applies only when that file is really present.

`<main branch>` is the base SHA `{{input.baseRef}}` (checkout HEAD at launch, the commit this worktree was branched from). Use that SHA wherever the factory instructions say `<main branch>`, including `git diff <main branch>...HEAD`, merge-tree, and ahead-of checks. Do not guess `main`.

Your branch is whatever `git branch --show-current` prints. It is `yak/<run-id>`. That is the branch name in this prompt. Do not BLOCK because it is not `factory/...` or `main`.

Do not write `review-security.md`. Return JSON `{ "verdict": "PASS" or "CHANGES", "findings": "the rest of that file" }`. `verdict` is the VERDICT line. `spec.md` and `build.md` are the text below. Your previous review is not a separate file.

Spec goal: {{spec.goal}}
Spec design: {{spec.design}}
Spec acceptance: {{spec.acceptance}}

Build ({{build.status}}): {{build.summary}}

Verify ran the repo test command. A non-zero exit is a failure:
exit {{verify.exitCode}}
stdout: {{verify.stdout}}
stderr: {{verify.stderr}}

Verify stdout and stderr may be truncated to the last 200 lines or 20480 bytes. A leading `[truncated:` line means the head was cut.

The factory agent instructions follow. Their frontmatter is the original definition; follow the prose, and return the JSON above instead of writing the file they name.
