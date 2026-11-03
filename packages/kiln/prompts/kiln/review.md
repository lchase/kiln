Kiln runs this review inside yak. The working directory is an isolated worktree at `{{input.baseRef}}`. That commit is the pull request head. Do not guess a branch name.

Read the change. Return a draft review and nothing else. Do not post the review, approve the pull request, merge it, push, or comment. Do not change product code. Do not create, modify, or delete files. Read-only git and file inspection are allowed.

Return JSON with `markdown` and `findings`. `findings` is a list. Each item has `severity` (`note`, `nit`, `warning`, or `blocking`), `file`, `line`, and `comment`. `comment` is the text a person might post later. `markdown` is the whole draft a person will read, and it must include every finding with its severity, file, line, and suggested comment. If you find nothing, return an empty `findings` list and say so in `markdown`.

Do not invent files or line numbers. If you did not see a line, do not cite it.

Spec title: {{input.title}}

{{input.spec}}

Launch id: {{input.runNonce}}
