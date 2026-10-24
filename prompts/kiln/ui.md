<!-- factory: prompts/factory/review-ui.md -->

Kiln runs this factory reviewer inside yak. The working directory is the worktree. There is no job folder, no round folder, and no `.factory/repo.md` (so there is no `## UI paths` file; look at the diff). `.factory/lessons.md` applies only when that file is really present.

This step always runs. The factory instructions below already return PASS when no UI changed. Do not write `review-ui.md`. Return JSON `{ "verdict": "PASS" or "CHANGES", "findings": "the rest of that file" }`. `verdict` is the VERDICT line. `spec.md` and `build.md` are the text below. Your previous review is not a separate file.

Spec goal: {{spec.goal}}
Spec design: {{spec.design}}
Spec acceptance: {{spec.acceptance}}

Build ({{build.status}}): {{build.summary}}

Verify ran the repo test command. A non-zero exit is a failure:
exit {{verify.exitCode}}
stdout: {{verify.stdout}}
stderr: {{verify.stderr}}

The factory agent instructions follow. Their frontmatter is the original definition; follow the prose, and return the JSON above instead of writing the file they name.
