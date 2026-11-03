# Contributing

## Commit messages

Commits on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix: correct off-by-one in loop budget check
feat: add gate skipIf support
feat!: rename loop.maxIterations to loop.budget

BREAKING CHANGE: workflows using maxIterations must rename the field
```

This isn't a style preference — `release-please` (repo-root `.github/workflows/release-please.yml`)
parses these prefixes to decide whether a release is needed and what
version bump it gets. A commit with no recognized prefix is silently
excluded from the changelog and doesn't trigger a release.

- `fix:` → patch bump
- `feat:` → minor bump
- `feat!:` or a `BREAKING CHANGE:` footer → major bump
- `chore:`, `docs:`, `refactor:`, `test:` → no release, but still shown in the changelog under their own heading

## Releasing

Nothing is done by hand. The flow:

1. Merge Conventional Commits to `main` as normal.
2. `release-please` opens (or updates) a Release PR that bumps
   `packages/yak/package.json`, the `packages/yak` version in the root
   `package-lock.json`, and repo-root `.release-please-manifest.json`, and
   writes `packages/yak/CHANGELOG.md`, based on every unreleased commit
   since the last release.
3. Merge that PR when you want to ship. The merge itself creates the git
   tag (`yak-v*`) and GitHub Release.
4. That tag push does not publish. release-please tags with
   `GITHUB_TOKEN`, which cannot trigger other workflows, and the tag is
   `yak-v*` rather than `v*`. The release-please workflow dispatches
   repo-root `.github/workflows/publish-yak.yml` on `main` only when a yak
   release was cut. That workflow checks out `main`, typechecks, tests,
   builds, and runs `npm publish -w @lchase/yak --provenance --access public`
   via npm trusted publishing (OIDC): `id-token: write` and `npm >= 11.5.1`.
   There is no `NPM_TOKEN` secret. `workflow_dispatch` remains as a manual
   fallback.

If release-please reports "no user facing commits found — skipping," it
means nothing since the last release used a recognized prefix — expected,
not a bug.
