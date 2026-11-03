# Contributing

## Commit messages

Commits on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix: correct off-by-one in loop budget check
feat: add gate skipIf support
feat!: rename loop.maxIterations to loop.budget

BREAKING CHANGE: workflows using maxIterations must rename the field
```

This isn't a style preference — `release-please` (`.github/workflows/release-please.yml`)
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
2. `release-please` opens (or updates) a standing "Release PR" that bumps
   `package.json`/`.release-please-manifest.json` and writes `CHANGELOG.md`,
   based on every unreleased commit since the last release.
3. Merge that PR when you want to ship. The merge itself creates the git
   tag and GitHub Release.
4. That tag push triggers `.github/workflows/publish.yml`, which builds,
   tests, and runs `npm publish` via npm's trusted publishing (OIDC) — no
   stored token, no manual `npm version`/`git tag`/OTP.

If release-please reports "no user facing commits found — skipping," it
means nothing since the last release used a recognized prefix — expected,
not a bug.
