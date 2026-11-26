# Security

## Reporting a vulnerability

Report it privately. Open the repository's Security tab and choose "Report a vulnerability". Do not open a public
issue or pull request for it.

Kiln and yak run AI agents against a git checkout on the operator's machine, so these are in scope and worth
reporting:

- Text an outsider controls (a pull request, a review comment, a Jira issue) that makes an agent run a command,
  read a file outside its worktree, or post something the operator did not approve.
- A way out of the Docker sandbox, or around its egress allowlist.
- A secret (a Claude, GitHub, Jira, or npm credential) written to a job file, a log, the event log, or a pull request.
- A way to publish `@lchase/kiln` or `@lchase/yak` without the maintainer.

Include the version (`kiln --version`), the config that matters (sandbox mode, deliver mode), and steps to
reproduce.

## Supported versions

Fixes go into the latest release of each package. Older versions are not patched.
