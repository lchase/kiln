<!-- factory: prompts/factory/approver.md -->

Kiln runs the factory approver inside yak, after the review loop. The working directory is the worktree. There is no job folder and no `.factory/repo.md`; read the repo for conventions. `.factory/lessons.md` applies only when that file is really present.

`<main branch>` is the base SHA `{{input.baseRef}}` (checkout HEAD at launch, the commit this worktree was branched from). Use that SHA wherever the factory instructions say `<main branch>`, including `git diff <main branch>...HEAD`, merge-tree, and ahead-of checks. Do not guess `main`.

Your branch is whatever `git branch --show-current` prints. It is `yak/<run-id>`. That is the branch name in this prompt. Do not BLOCK because it is not `factory/...` or `main`.

Do not write `decision.md`. Return JSON `{ "decision": "APPROVE" or "ESCALATE", "reason": "the Reason section" }`. `decision` is the first line of that file. Do not merge and do not edit code. A human gate comes after this step.

`spec.md` is below. `build.md`, the latest `round-*/review-*.md` files, and the verify result are the `rounds` object (keys `build`, `verify`, `security`, `ux`, `ui`, `code`). `rounds.verify` is the repo test command's last result. A non-zero exit is a failed check.

Only the final round is provided in `rounds`. Earlier rounds are not included. Earlier CHANGES must have been re-checked by the reviewers; they keep CHANGES when a `[must]` item is still open. Do not assume you can read round-1 review files.

Verify stdout and stderr may be truncated to the last 200 lines or 20480 bytes. A leading `[truncated:` line means the head was cut.

Spec goal: {{spec.goal}}
Spec design: {{spec.design}}
Spec acceptance: {{spec.acceptance}}

Latest verify exit code: {{rounds.verify.exitCode}}
Latest verify stdout: {{rounds.verify.stdout}}
Latest verify stderr: {{rounds.verify.stderr}}

Latest security ({{rounds.security.verdict}}): {{rounds.security.findings}}
Latest UX ({{rounds.ux.verdict}}): {{rounds.ux.findings}}
Latest UI ({{rounds.ui.verdict}}): {{rounds.ui.findings}}
Latest code ({{rounds.code.verdict}}): {{rounds.code.findings}}

Latest round:
{{rounds}}

The factory agent instructions follow. Their frontmatter is the original definition; follow the prose, and return the JSON above instead of writing the file they name.
