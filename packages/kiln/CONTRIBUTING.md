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

`.release-please-manifest.json` is the last released version (`0.1.0` until
the first release PR). `package.json` carries the same version. After that
baseline, nothing is tagged by hand:

1. Merge Conventional Commits to `main` as normal.
2. `release-please` opens (or updates) a standing Release PR that bumps
   `package.json`, `package-lock.json`, and `.release-please-manifest.json`,
   and writes `CHANGELOG.md`, from every unreleased commit since the last
   release.
3. Merge that PR when you want to ship. The merge creates the git tag
   (`kiln-v*`) and the GitHub Release.
4. That tag push does not run publish. release-please tags with
   `GITHUB_TOKEN`, which cannot trigger other workflows, and the tag is
   `kiln-v*` rather than `v*`. The release-please workflow dispatches
   `.github/workflows/publish.yml` on `main` only when a release was cut.
5. `publish.yml` checks out `main`, typechecks, tests, builds, and runs
   `npm publish --provenance --access public`. Auth is npm trusted
   publishing (OIDC): the job sets `id-token: write` and installs
   `npm >= 11.5.1`. There is no `NPM_TOKEN` secret.

If release-please reports "no user facing commits found — skipping," it
means nothing since the last release used a recognized prefix — expected,
not a bug.

The first publish of `@lchase/kiln` cannot be that workflow. Trusted
publishing is configured on a package that already exists, and this repo
starts at `0.1.0` with no npm release yet. Publish `0.1.0` once from a
checkout of `main` (`npm publish --access public`, as the `@lchase` scope
owner), then add a GitHub Actions trusted publisher for `publish.yml` that
is allowed to run `npm publish`. Later releases are the flow above.
